// Una "Session" = un número de WhatsApp conectado, con su propia sesión, grupos, reglas,
// mensaje a contactos y renta (fecha de vencimiento). El bot maneja muchas a la vez.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers
} = require('@whiskeysockets/baileys');
const { parseContacts, fillTemplate } = require('./contacts');
const { handleBinCommand } = require('./bin');
const { loadKnowledge } = require('./knowledge');
let KB = null;
const knowledgeRules = () => (KB || (KB = loadKnowledge(path.join(__dirname, 'conocimiento'))));

const DAY = 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = s => String(s || '').replace(/\D/g, '');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const reEscape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// palabras de 1-3 letras: coincidencia exacta (palabra completa). Más largas: por contenido (para plurales).
const matchTerm = (low, term) => term.length <= 3
  ? new RegExp('(^|[^a-z0-9])' + reEscape(term) + '($|[^a-z0-9])').test(low)
  : low.includes(term);
const today = () => new Date().toLocaleDateString('es-MX', { timeZone: 'America/Cancun' });
let cachedVersion = null;
async function waVersion() {
  if (cachedVersion && Date.now() - cachedVersion.at < 6 * 60 * 60 * 1000) return cachedVersion.version;
  try { const { version } = await fetchLatestBaileysVersion(); cachedVersion = { version, at: Date.now() }; return version; }
  catch { return cachedVersion?.version; }
}

const DEFAULTS = {
  name: '', client: '', notes: '', phone: '',
  createdAt: 0, expiresAt: 0, active: true,
  groupJids: [], intervalMinutes: 60,
  scheduledMessage: '📢 Aviso del grupo: mantengamos el orden y respetemos las reglas.',
  enabled: true, blockedWords: [], blockLinks: true, maxMessagesPerWindow: 6, windowSeconds: 10,
  warningsBeforeKick: 1, adminNumbers: [], profileStatus: '', binCommandEnabled: true,
  kickMessage: '🚨 EXPULSIÓN AUTOMÁTICA\n═══════════════════\n\n👤 Usuario: {nombre}\n┝ Alias: {alias}\n┕ ID: {id}\n\n🛡️ Expulsado por: {motivo}',
  telegramBridgeEnabled: false, telegramGroupJid: '',
  autoReplyEnabled: false, autoReplyGroups: false, autoReplyCooldownMin: 360,
  autoReplyGroupHint: '👋 ¡Aquí ando! Pregúntame por precios, funciones o algo de ciberseguridad 🙌',
  autoReplyWelcome: '👋 ¡Hola! Gracias por escribir. En un momento te atendemos. Cuéntanos en qué podemos ayudarte.',
  autoReplyMedia: '📎 ¡Gracias por tu {tipo}! Para atenderte mejor, ¿me lo escribes en un mensajito? Así te respondo volando 🙌',
  autoReplyRules: [],
  defaultCountryCode: '52', broadcastMessage: 'Hola {nombre} 👋',
  broadcastDailyLimit: 30, broadcastMinDelaySec: 60, broadcastMaxDelaySec: 120
};
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch (e) { console.error('[Multi Bot] Archivo dañado, se usan valores por defecto: ' + file); return fallback; }
}
const emptyBroadcast = () => ({ status: 'idle', message: '', queue: [], sent: 0, notOnWhatsApp: 0, failed: 0, total: 0, day: '', sentToday: 0, lastError: '' });

class Session {
  constructor(dir, id) {
    this.id = id;
    this.dir = dir;
    this.authDir = path.join(dir, 'auth');
    this.cfgFile = path.join(dir, 'config.json');
    this.bcFile = path.join(dir, 'broadcast.json');
    this.config = { ...DEFAULTS, ...readJson(this.cfgFile, {}) };
    this.broadcast = { ...emptyBroadcast(), ...readJson(this.bcFile, {}) };
    this.sock = null; this.connection = 'Desconectado'; this.qr = ''; this.pairingCode = '';
    this.registered = false; this.lastError = ''; this.needsRelink = false;
    this.connecting = false; this.retryTimer = null; this.retries = 0; this.stopped = false;
    this.groupList = []; this.recent = new Map(); this.warnings = new Map(); this.logs = [];
    this.greeted = new Map(); this.lastAuto = new Map();
    this.lastSent = Date.now(); this.sendingAvisos = false; this.bcRunning = false;
  }

  // ---- utilidades ----
  save() { if (this.deleted) return; try { fs.writeFileSync(this.cfgFile, JSON.stringify(this.config, null, 2)); } catch (e) { console.error(`[${this.id}] No se pudo guardar config: ${e.message}`); } }
  saveBroadcast() { if (this.deleted) return; try { fs.writeFileSync(this.bcFile, JSON.stringify(this.broadcast)); } catch (e) { console.error(`[${this.id}] No se pudo guardar envío: ${e.message}`); } }
  log(s) {
    this.logs.unshift(new Date().toLocaleString('es-MX', { timeZone: 'America/Cancun' }) + ' — ' + s);
    this.logs = this.logs.slice(0, 80);
    console.info(`[${this.config.name || this.id}] ${s}`);
  }
  get label() { return this.config.name || this.config.phone || this.id; }
  get expired() { return this.config.expiresAt > 0 && Date.now() > this.config.expiresAt; }
  get rentalOk() { return this.config.active && !this.expired; }
  get daysLeft() { return this.config.expiresAt ? Math.ceil((this.config.expiresAt - Date.now()) / DAY) : null; }
  get isConnected() { return Boolean(this.sock) && this.connection === 'Conectado'; }
  isManagedGroup(jid) { return this.config.groupJids.includes(jid); }
  // Protegido si está en "Números protegidos" (por teléfono) o si es administrador del grupo.
  isProtected(groupJid, ...ids) {
    const list = this.config.adminNumbers.map(digits);
    for (const id of ids.filter(Boolean)) {
      if (list.includes(digits(String(id).split('@')[0].split(':')[0]))) return true;
    }
    const g = this.groupList.find(x => x.id === groupJid);
    const p = g?.participants?.find(x => ids.includes(x.id) || ids.includes(x.lid) || ids.includes(x.phoneNumber) || ids.includes(x.jid));
    return Boolean(p && (p.admin === 'admin' || p.admin === 'superadmin'));
  }

  // ---- conexión ----
  async connect() {
    if (this.connecting || this.sock || this.stopped) return;
    this.connecting = true;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.connection = 'Conectando'; this.needsRelink = false;
    let socket;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      this.registered = Boolean(state.creds.registered);
      socket = makeWASocket({ version: await waVersion(), auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false });
      this.sock = socket;
      socket.ev.on('creds.update', async () => {
        if (this.sock !== socket) return;
        await saveCreds();
        this.registered = Boolean(state.creds.registered);
      });
      socket.ev.on('connection.update', async u => {
        if (this.sock !== socket) return;
        if (u.qr) { this.qr = await QRCode.toDataURL(u.qr); this.connection = 'Escanea el QR'; }
        if (u.connection === 'open') {
          this.connection = 'Conectado'; this.qr = ''; this.pairingCode = ''; this.retries = 0; this.lastError = '';
          this.registered = true;
          const me = digits(String(socket.user?.id || '').split(':')[0].split('@')[0]);
          if (me && this.config.phone !== me) { this.config.phone = me; this.save(); }
          this.log('WhatsApp conectado.');
          this.refreshGroups();
          this.applyProfileStatus();
          this.runBroadcast();
        }
        if (u.connection === 'close') {
          const err = u.lastDisconnect?.error;
          const code = Number(err?.output?.statusCode ?? err?.statusCode ?? 0);
          this.sock = null; this.qr = ''; this.connection = 'Desconectado';
          this.lastError = `${code || ''} ${err?.message || ''}`.trim();
          if (this.stopped) return;
          if ([401, 403, 440].includes(code)) {
            // Sesión cerrada, número baneado o sesión abierta en otro lado: hay que volver a vincular.
            this.needsRelink = true;
            if (this.broadcast.status === 'running') { this.broadcast.status = 'paused'; this.saveBroadcast(); }
            this.connection = code === 440 ? 'Sesión abierta en otro lado' : 'Sesión cerrada';
            this.log(`WhatsApp cerró la sesión (${code}). Usa “Desvincular y conectar otro número”.`);
          } else if (code === 408 && !this.registered) {
            this.connection = 'QR vencido';
            this.log('El QR venció sin escanearse. Toca “Generar QR” para intentar de nuevo.');
          } else {
            this.scheduleReconnect(code === 515 ? 0 : null);
          }
        }
      });
      socket.ev.on('groups.update', () => this.refreshGroups());
      socket.ev.on('group-participants.update', () => this.refreshGroups());
      socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (this.sock !== socket || type !== 'notify') return;
        for (const m of messages) {
          await this.handleBin(m).catch(e => this.log('Error en .bin: ' + e.message));
          await this.autoReply(m).catch(e => this.log('Error en respuesta automática: ' + e.message));
          await this.moderate(m).catch(e => this.log('Error de moderación: ' + e.message));
        }
      });
    } catch (e) {
      if (socket && this.sock === socket) this.sock = null;
      this.connection = 'Desconectado'; this.lastError = e.message;
      this.log('Error al iniciar: ' + e.message);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  scheduleReconnect(delayMs = null) {
    if (this.retryTimer || this.stopped) return;
    const delay = delayMs ?? Math.min(60_000, 5_000 * 2 ** Math.min(this.retries, 4));
    this.retries++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
  }

  async requestPairingCode(phone) {
    if (!this.sock || this.connection !== 'Escanea el QR') throw new Error('Espera a que aparezca el QR y vuelve a intentar.');
    const code = String(await this.sock.requestPairingCode(digits(phone))).toUpperCase();
    this.pairingCode = code;
    return code;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    const s = this.sock; this.sock = null;
    if (s) try { s.end(undefined); } catch {}
    this.connection = 'Desconectado';
  }

  // Borra la sesión de WhatsApp (para cambiar de número o tras un ban) y muestra un QR nuevo.
  async resetSession() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    const s = this.sock; this.sock = null;
    if (s) { try { await s.logout(); } catch {} try { s.end(undefined); } catch {} }
    for (let i = 0; i < 20 && this.connecting; i++) await sleep(300);
    fs.rmSync(this.authDir, { recursive: true, force: true });
    Object.assign(this, { connection: 'Desconectado', qr: '', pairingCode: '', registered: false, needsRelink: false, lastError: '', groupList: [], retries: 0, stopped: false });
    this.config.phone = ''; this.save();
    if (this.broadcast.status === 'running') { this.broadcast.status = 'paused'; this.saveBroadcast(); this.log('El envío a contactos quedó en pausa. Reanúdalo cuando el número esté listo.'); }
    this.log('Sesión borrada. Escanea el QR nuevo o usa el código de vinculación.');
    await sleep(800);
    this.connect();
  }

  async refreshGroups() {
    try { if (this.sock) this.groupList = Object.values(await this.sock.groupFetchAllParticipating()); }
    catch (e) { this.log('No se pudieron cargar grupos: ' + e.message); }
  }

  async applyProfileStatus() {
    if (!this.isConnected || !this.config.profileStatus) return;
    try { await this.sock.updateProfileStatus(this.config.profileStatus.slice(0, 139)); this.log('Descripción del perfil actualizada.'); }
    catch (e) { this.log('No se pudo actualizar la descripción: ' + e.message); }
  }

  // ---- moderación ----
  innerMsg(m) {
    let msg = m.message;
    for (let i = 0; i < 5 && msg; i++) {
      const inner = msg.ephemeralMessage || msg.viewOnceMessage || msg.viewOnceMessageV2 || msg.documentWithCaptionMessage || msg.editedMessage;
      if (!inner?.message) break;
      msg = inner.message;
    }
    if (msg?.protocolMessage?.editedMessage) msg = msg.protocolMessage.editedMessage;
    return msg || {};
  }
  mediaKind(m) {
    const msg = this.innerMsg(m);
    if (msg.imageMessage) return 'imagen';
    if (msg.videoMessage) return 'video';
    if (msg.audioMessage) return 'audio';
    if (msg.stickerMessage) return 'sticker';
    if (msg.documentMessage) return 'documento';
    return '';
  }
  getText(m) {
    let msg = m.message;
    for (let i = 0; i < 5 && msg; i++) {
      const inner = msg.ephemeralMessage || msg.viewOnceMessage || msg.viewOnceMessageV2 || msg.documentWithCaptionMessage || msg.editedMessage;
      if (!inner?.message) break;
      msg = inner.message;
    }
    const edited = msg?.protocolMessage?.editedMessage;
    if (edited) msg = edited;
    return msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || msg?.videoMessage?.caption || msg?.documentMessage?.caption || '';
  }

  async moderate(m) {
    const c = this.config;
    const jid = m.key.remoteJid;
    if (!this.rentalOk || !c.enabled || !jid?.endsWith('@g.us') || m.key.fromMe || !this.isManagedGroup(jid)) return;
    const sender = m.key.participant || '';
    // WhatsApp a veces identifica al participante con un ID interno (@lid); se revisan también sus alias.
    if (!sender || this.isProtected(jid, sender, m.key.participantPn, m.key.participantAlt, m.key.participantLid)) return;
    const text = this.getText(m).toLowerCase();
    const hasLink = /(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(text);
    const blocked = c.blockedWords.some(w => w && text.includes(w.toLowerCase()));
    const now = Date.now(), key = jid + ':' + sender;
    const arr = (this.recent.get(key) || []).filter(t => now - t < c.windowSeconds * 1000);
    arr.push(now); this.recent.set(key, arr);
    const flood = arr.length > c.maxMessagesPerWindow;
    if (!(blocked || (c.blockLinks && hasLink) || flood)) return;
    const reason = blocked ? 'palabra prohibida' : (c.blockLinks && hasLink) ? 'enlace no autorizado' : 'flood/spam';
    // Si es una edición, se borra el mensaje original.
    const target = m.message?.protocolMessage?.editedMessage && m.message.protocolMessage.key
      ? { ...m.message.protocolMessage.key, participant: sender } : m.key;
    try { await this.sock.sendMessage(jid, { delete: target }); } catch (e) { this.log('No pude borrar mensaje: ' + e.message); }
    const count = (this.warnings.get(key) || 0) + 1; this.warnings.set(key, count);
    try {
      if (count > c.warningsBeforeKick) {
        await this.sock.groupParticipantsUpdate(jid, [sender], 'remove');
        this.warnings.delete(key);
        const num = digits((m.key.participantPn || sender).split('@')[0].split(':')[0]) || sender.split('@')[0];
        const nombre = (m.pushName && m.pushName.trim()) || num || 'Usuario';
        const tpl = c.kickMessage || '⛔ Usuario expulsado por {motivo}.';
        const txt = tpl.replace(/\{nombre\}/gi, nombre).replace(/\{numero\}/gi, num)
          .replace(/\{id\}/gi, num).replace(/\{alias\}/gi, '@' + num).replace(/\{motivo\}/gi, reason);
        this.log(`Expulsado ${num}: ${reason}`);
        await this.sock.sendMessage(jid, { text: txt, mentions: [sender] });
      } else {
        await this.sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]}, mensaje eliminado por ${reason}. Una infracción más puede causar expulsión.`, mentions: [sender] });
        this.log(`Advertencia a ${sender.split('@')[0]}: ${reason}`);
      }
    } catch (e) { this.log('Error de moderación. ¿El bot es administrador del grupo? ' + e.message); }
  }

  // ---- comando .bin (info pública de los primeros 6-8 dígitos) ----
  async handleBin(m) {
    const jid = m.key.remoteJid;
    const text = this.getText(m);
    if (!jid || !/^\s*[.!/]bin\b/i.test(text)) return;
    if (!this.rentalOk || !this.config.binCommandEnabled) return;
    if (jid.endsWith('@g.us') && !this.isManagedGroup(jid)) return;
    if (!jid.endsWith('@g.us') && !/@(s\.whatsapp\.net|lid)$/.test(jid)) return; // ignora estados y canales
    const reply = await handleBinCommand(text, m.key.participant || jid);
    if (!reply || !this.isConnected) return;
    await this.sock.sendMessage(jid, { text: reply }, { quoted: m });
    this.log('Respondí .bin en ' + (this.groupList.find(g => g.id === jid)?.subject || jid.split('@')[0]) + '.');
  }

  // ¿El mensaje menciona (@) a este número, o responde a un mensaje del bot?
  mentionsMe(m) {
    const msg = this.innerMsg(m);
    const ctx = msg?.extendedTextMessage?.contextInfo || msg?.imageMessage?.contextInfo
      || msg?.videoMessage?.contextInfo || msg?.contextInfo || {};
    const me = new Set();
    const add = v => { const n = digits(String(v || '').split('@')[0].split(':')[0]); if (n) me.add(n); };
    add(this.config.phone);
    add(this.sock?.user?.id);
    add(this.sock?.user?.lid);
    for (const j of (ctx.mentionedJid || [])) if (me.has(digits(String(j).split('@')[0].split(':')[0]))) return true;
    if (ctx.participant && me.has(digits(String(ctx.participant).split('@')[0].split(':')[0]))) return true;
    return false;
  }

  // ---- respuestas automáticas (atención a clientes en privado) ----
  async autoReply(m) {
    const c = this.config;
    const jid = m.key.remoteJid;
    if (!this.rentalOk || !c.autoReplyEnabled || !jid || m.key.fromMe) return;
    const isGroup = jid.endsWith('@g.us');
    const isPrivate = /@(s\.whatsapp\.net|lid)$/.test(jid);
    if (isGroup) { if (!c.autoReplyGroups || !this.isManagedGroup(jid) || !this.mentionsMe(m)) return; } // en grupos: activado, grupo marcado y que lo mencionen
    else if (!isPrivate) return;                             // ni estados ni canales
    const text = this.getText(m).trim();
    if (/^\s*[.!/]bin\b/i.test(text)) return;                // .bin lo atiende su propia función
    const kind = this.mediaKind(m);
    if (!text && !kind) return;                              // sin texto ni archivo: nada que atender
    const now = Date.now();
    const flKey = isGroup ? jid + ':' + (m.key.participant || '') : jid;
    if (now - (this.lastAuto.get(flKey) || 0) < 5000) return; // anti-rebote
    let reply = null;
    if (text) {                                              // 1) palabra clave (aplica en privado y en grupo)
      const low = norm(text);
      const rule = [...(c.autoReplyRules || []), ...knowledgeRules()].find(r => r.match &&
        String(r.match).split(/[,|]/).map(t => norm(t.trim())).filter(Boolean).some(t => matchTerm(low, t)));
      if (rule) reply = rule.reply;
    }
    if (!reply && isPrivate && kind && !text) reply = c.autoReplyMedia || null;  // 2) foto/audio: solo en privado
    if (!reply && isPrivate) {                               // 3) bienvenida: solo en privado (con descanso)
      const cd = Math.max(0, Number(c.autoReplyCooldownMin) || 0) * 60000;
      if (now - (this.greeted.get(jid) || 0) >= cd) { reply = c.autoReplyWelcome; this.greeted.set(jid, now); }
    }
    if (!reply && isGroup) {                                 // lo mencionaron pero sin palabra clave
      if (!/\?|\¿/.test(text)) return;                        // si no es una pregunta (un "no", "ok"...), no responde
      reply = c.autoReplyGroupHint || '👋 ¿En qué te ayudo?';  // si es pregunta, un mensaje corto
    }
    if (!reply || !this.isConnected) return;
    // variantes: si la respuesta trae "||", elige una al azar para sonar más natural
    if (reply.includes('||')) {
      const opts = reply.split('||').map(x => x.trim()).filter(Boolean);
      if (opts.length) reply = opts[Math.floor(Math.random() * opts.length)];
    }
    const tipo = kind === 'imagen' ? 'foto' : (kind || 'mensaje');
    reply = reply.replace(/\{tipo\}/gi, tipo).replace(/\\n/g, '\n');  // \n en el texto = salto de línea real
    this.lastAuto.set(flKey, now);
    const who = jid.split('@')[0];
    const am = /^audio:/i.exec(reply);                       // respuesta tipo audio:nombre.ogg
    if (am) {
      const name = path.basename(reply.slice(am[0].length).trim());
      let fp = null;
      for (const d of [path.join(__dirname, 'audios'), __dirname]) { const c = path.join(d, name); if (fs.existsSync(c)) { fp = c; break; } }
      if (!fp) { this.log('Audio no encontrado: ' + name + ' (súbelo al repo).'); return; }
      const mp3 = /\.mp3$/i.test(fp);
      await this.sock.sendMessage(jid, { audio: fs.readFileSync(fp), mimetype: mp3 ? 'audio/mpeg' : 'audio/ogg; codecs=opus', ptt: true });
      this.log('Audio (' + name + ') enviado a ' + who + '.');
      return;
    }
    const vm = /^video:/i.exec(reply);                       // respuesta tipo video:nombre.mp4  (o  video:nombre.mp4 | texto)
    if (vm) {
      const rest = reply.slice(vm[0].length).trim();
      const [fileRaw, ...capParts] = rest.split('|');
      const name = path.basename(fileRaw.trim());
      const caption = capParts.join('|').trim();
      let fp = null;
      for (const d of [path.join(__dirname, 'videos'), __dirname]) { const c = path.join(d, name); if (fs.existsSync(c)) { fp = c; break; } }
      if (!fp) { this.log('Video no encontrado: ' + name + ' (súbelo al repo).'); return; }
      await this.sock.sendMessage(jid, { video: fs.readFileSync(fp), mimetype: 'video/mp4', caption: caption || undefined });
      this.log('Video (' + name + ') enviado a ' + who + '.');
      return;
    }
    await this.sock.sendMessage(jid, { text: String(reply) });
    this.log('Respuesta automática enviada a ' + who + '.');
  }

  // ---- puente de Telegram ----
  async forwardTelegram(text) {
    if (!this.isConnected || !this.rentalOk) return;
    const jid = this.config.telegramGroupJid;
    if (!jid || !jid.endsWith('@g.us')) return;
    await this.sock.sendMessage(jid, { text: String(text) });
    this.log('Mensaje de Telegram reenviado al grupo.');
  }

  // ---- avisos programados (lo llama un reloj global cada minuto) ----
  async tickAvisos() {
    const c = this.config;
    if (this.sendingAvisos || !this.isConnected || !this.rentalOk || !c.enabled || !c.groupJids.length || !c.scheduledMessage) return;
    if (Date.now() - this.lastSent < c.intervalMinutes * 60 * 1000) return;
    this.lastSent = Date.now(); this.sendingAvisos = true;
    try {
      for (const [i, jid] of [...c.groupJids].entries()) {
        if (i > 0) await sleep(3000 + Math.random() * 4000);
        if (!this.isConnected) break;
        const name = this.groupList.find(g => g.id === jid)?.subject || jid;
        try { await this.sock.sendMessage(jid, { text: c.scheduledMessage }); this.log(`Aviso enviado a ${name}.`); }
        catch (e) { this.log(`Error al enviar aviso a ${name}: ${e.message}`); }
      }
    } finally { this.sendingAvisos = false; }
  }

  // ---- mensaje a contactos ----
  startBroadcast(text) {
    if (['running', 'paused'].includes(this.broadcast.status)) return { error: 'Ya hay un envío en curso.' };
    const { contacts, invalid } = parseContacts(String(text || ''), this.config.defaultCountryCode);
    const queue = contacts.filter(x => x.number !== this.config.phone);
    if (!queue.length) { this.broadcast.lastError = 'No se encontraron números válidos.'; this.saveBroadcast(); return { error: this.broadcast.lastError }; }
    const prevToday = this.broadcast.day === today() ? this.broadcast.sentToday : 0;
    this.broadcast = { ...emptyBroadcast(), status: 'running', message: this.config.broadcastMessage, queue, total: queue.length, day: today(), sentToday: prevToday };
    this.saveBroadcast();
    this.log(`Envío a contactos iniciado: ${queue.length} números${invalid ? ` (${invalid} inválidos descartados)` : ''}.`);
    this.runBroadcast();
    return { ok: true };
  }
  setBroadcastStatus(status) {
    const b = this.broadcast;
    if (status === 'paused' && b.status === 'running') { b.status = 'paused'; this.log('Envío a contactos en pausa.'); }
    else if (status === 'running' && b.status === 'paused') { b.status = 'running'; this.log('Envío a contactos reanudado.'); this.runBroadcast(); }
    else if (status === 'cancelled' && ['running', 'paused'].includes(b.status)) { b.status = 'cancelled'; b.queue = []; this.log('Envío a contactos cancelado.'); }
    this.saveBroadcast();
  }
  async runBroadcast() {
    if (this.bcRunning) return;
    this.bcRunning = true;
    try { await this._runBroadcast(); }
    catch (e) { this.log('Error en envío a contactos: ' + e.message); }
    finally { this.bcRunning = false; }
  }
  async _runBroadcast() {
    const b = () => this.broadcast, c = this.config;
    while (b().status === 'running' && b().queue.length && !this.stopped) {
      if (!this.isConnected || !this.rentalOk) { await sleep(30_000); continue; }
      if (b().day !== today()) { b().day = today(); b().sentToday = 0; this.saveBroadcast(); }
      if (b().sentToday >= c.broadcastDailyLimit) { await sleep(5 * 60_000); continue; }
      const item = b().queue[0];
      try {
        const [res] = await this.sock.onWhatsApp(item.number);
        if (!res?.exists) b().notOnWhatsApp++;
        else { await this.sock.sendMessage(res.jid, { text: fillTemplate(b().message, item.name) }); b().sent++; b().sentToday++; }
        b().queue.shift();
      } catch (e) {
        b().lastError = e.message;
        if (!this.isConnected) { this.saveBroadcast(); continue; }
        b().failed++; b().queue.shift();
        this.log(`No se pudo enviar a +${item.number}: ${e.message}`);
      }
      if (!b().queue.length) { b().status = 'done'; this.log(`Envío a contactos terminado: ${b().sent} enviados.`); }
      this.saveBroadcast();
      const min = c.broadcastMinDelaySec, max = Math.max(min, c.broadcastMaxDelaySec);
      if (b().queue.length) await sleep((min + Math.random() * (max - min)) * 1000);
    }
  }

  // ---- renta ----
  extend(days) {
    const base = Math.max(Date.now(), this.config.expiresAt || 0);
    this.config.expiresAt = base + days * DAY;
    this.config.active = true;
    this.save();
    this.log(`Renta extendida ${days} días. Vence el ${new Date(this.config.expiresAt).toLocaleDateString('es-MX', { timeZone: 'America/Cancun' })}.`);
  }
}

module.exports = { Session, DAY };
