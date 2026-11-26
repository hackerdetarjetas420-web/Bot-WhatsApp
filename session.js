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
const { loadKnowledge, loadKnowledgeFiles } = require('./knowledge');
const tgUser = require('./telegram-user');
// Caché de conocimiento. La clave '*' es la general (conocimiento*.txt de la raíz).
// Un número con "knowledgeFile" carga SOLO sus archivos, aislado del resto.
const KB_CACHE = new Map();
function kbGeneral() {
  if (!KB_CACHE.has('*')) KB_CACHE.set('*', loadKnowledge(__dirname));
  return KB_CACHE.get('*');
}
function kbForFiles(names) {
  const clean = names.map(s => String(s).trim()).filter(Boolean);
  const key = clean.map(s => s.toLowerCase()).sort().join('|');
  if (!key) return kbGeneral();
  if (!KB_CACHE.has(key)) KB_CACHE.set(key, loadKnowledgeFiles(__dirname, clean));
  return KB_CACHE.get(key);
}

const DAY = 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = s => String(s || '').replace(/\D/g, '');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const reEscape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// palabras de 1-3 letras: coincidencia exacta (palabra completa). Más largas: por contenido (para plurales).
const matchTerm = (low, term) => term.length <= 3
  ? new RegExp('(^|[^a-z0-9])' + reEscape(term) + '($|[^a-z0-9])').test(low)
  : low.includes(term);

// ---- Comprensión sin IA: sinónimos, errores de escritura y memoria del tema ----
// La primera palabra de cada grupo es la "canónica"; las demás se convierten a ella.
const SYN_GROUPS = [
  ['precio', 'costo', 'cuesta', 'cuestan', 'cuanto sale', 'cuanto cobran', 'cuanto es', 'tarifa', 'tarifas', 'valor', 'precios', 'costos'],
  ['cita', 'agendar', 'reservar', 'reservacion', 'turno', 'apartar', 'citas'],
  ['horario', 'horarios', 'a que hora', 'hora de atencion', 'cuando abren', 'cuando atienden', 'abierto'],
  ['ubicacion', 'direccion', 'donde estan', 'donde quedan', 'donde se ubican', 'domicilio', 'como llegar'],
  ['telefono', 'numero', 'celular', 'whatsapp', 'contacto'],
  ['servicio', 'servicios', 'tratamientos', 'que ofrecen', 'que hacen', 'que manejan'],
  ['pago', 'pagos', 'tarjeta', 'efectivo', 'transferencia', 'formas de pago', 'metodos de pago'],
  ['promocion', 'promociones', 'oferta', 'ofertas', 'descuento', 'descuentos', 'promo', 'promos']
];
const SYN_MAP = (() => {
  const list = [];
  for (const g of SYN_GROUPS) for (const w of g.slice(1)) list.push([w, g[0]]);
  return list.sort((a, b) => b[0].length - a[0].length);   // frases largas primero
})();
const STOPWORDS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'y', 'o', 'a', 'al', 'por', 'para', 'con', 'que', 'es', 'me', 'mi', 'su', 'se', 'lo', 'le', 'quiero', 'quisiera', 'necesito', 'saber', 'tienen', 'hay', 'ya']);
const GENERIC_WORDS = new Set(['precio', 'cita', 'horario', 'ubicacion', 'telefono', 'servicio', 'pago', 'promocion', 'hola', 'gracias', 'info', 'informacion']);
const canon = t => {
  let x = ' ' + norm(t).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  for (const [from, to] of SYN_MAP) x = x.split(' ' + from + ' ').join(' ' + to + ' ');
  return x.trim();
};
const tokens = t => canon(t).split(' ').filter(w => w && !STOPWORDS.has(w));
// Distancia de edición con tope (para "presio", "ortodonsia", "kiero"...)
const lev = (a, b, max) => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
// Suena igual aunque se escriba distinto: "sita" = "cita", "bernes" = "viernes", "kiero" = "quiero"
const phon = w => w.replace(/qu/g, 'k').replace(/c(?=[aoulr])/g, 'k').replace(/c/g, 's').replace(/z/g, 's').replace(/v/g, 'b').replace(/h/g, '').replace(/ll/g, 'y').replace(/ñ/g, 'n').replace(/(.)\1+/g, '$1');
const wordMatch = (qw, tw) => {
  if (qw === tw) return true;
  if (qw.length >= 3 && tw.length >= 3 && phon(qw) === phon(tw)) return true;
  if (tw.length < 5 || qw.length < 4) return false;            // palabras cortas: solo exactas
  const max = tw.length >= 9 ? 2 : 1;
  return lev(qw, tw, max) <= max;
};
// Elige la mejor regla. Prioriza la coincidencia más específica y, si el mensaje es corto
// ("¿y cuánto cuesta?"), usa el tema de la conversación (ctx) para completar lo que falta.
function findRule(rules, text, ctx) {
  const low = norm(text);
  const qWords = tokens(text);
  const useCtx = Array.isArray(ctx) && ctx.length && qWords.length > 0 && qWords.length <= 6;
  let best = null, bestScore = 0;
  for (const r of rules) {
    if (!r.match) continue;
    for (const raw of String(r.match).split(/[,|]/)) {
      const term = norm(raw.trim());
      if (!term) continue;
      let score = 0;
      if (matchTerm(low, term)) score = 1000 + term.length;                  // coincidencia exacta
      else {
        const tw = tokens(term);
        if (!tw.length) continue;
        let fromText = 0, fromCtx = 0, ok = true;
        for (const w of tw) {
          if (qWords.some(q => wordMatch(q, w))) fromText++;
          else if (useCtx && ctx.includes(w)) fromCtx++;
          else { ok = false; break; }
        }
        if (!ok || !fromText) continue;
        score = fromCtx ? 2000 + term.length : 500 + term.length;            // con tema de la plática, gana
      }
      if (score > bestScore) { bestScore = score; best = r; }
    }
  }
  return best;
}
const topicWordsOf = rule => {
  for (const raw of String(rule.match || '').split(/[,|]/)) {
    const w = tokens(raw).filter(x => x.length >= 5 && !GENERIC_WORDS.has(x));
    if (w.length) return w;
  }
  return [];
};
const today = () => new Date().toLocaleDateString('es-MX', { timeZone: 'America/Cancun' });
let cachedVersion = null;
async function waVersion() {
  if (cachedVersion && Date.now() - cachedVersion.at < 6 * 60 * 60 * 1000) return cachedVersion.version;
  try { const { version } = await fetchLatestBaileysVersion(); cachedVersion = { version, at: Date.now() }; return version; }
  catch { return cachedVersion?.version; }
}

// Groserías/insultos para la regla de respeto (detección, no se usan para responder así).
const DEFAULT_RUDE = ['pendejo','pendeja','pendejos','estupido','estupida','idiota','imbecil','tarado','baboso','menso','mensa',
  'puto','puta','putos','putas','pinche','pinches','culero','culera','cabron','cabrona','cabrones','mamada','mamadas',
  'chinga','chingas','chinga tu','chingada','chingado','verga','vergas','joto','jotos','marica','maricon','maricones',
  'mierda','perra','perro','zorra','malparido','gonorrea','hijo de','hdp','hp','vrg','ctm','pndj','mrd','estupidez','estupideces'];

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
  autoReplyFallback: '',
  knowledgeFile: '',
  tgBridgeEnabled: false,
  tgBot: '',
  tgCommand: '{texto}',
  tgDoneText: '', tgWaitWords: '',
  ownerWelcome: '🤖 ¡Hola! Soy tu bot asistente 🙌\n\nEstoy entrenado con la información que cargamos para este número. Le respondo a tus clientes al instante, 24/7: dudas, servicios, precios, citas y más.\n\nPuedes probarme haciéndome preguntas como si fueras un cliente, por ejemplo:\n• "¿Qué servicios tienen?"\n• "¿Cuánto cuesta?"\n• "Quiero una cita"\n\nSi quieres que aprenda algo nuevo o cambie una respuesta, avísale a quien configura el bot. ¡Aquí ando para ayudarte! 💪',
  respectEnabled: true,
  respectMessage: '🙅 Disculpa, no puedo seguir una conversación vulgar. Te pido respeto para poder ayudarte 🙏 Si quieres que te siga atendiendo, hablemos con cordialidad.',
  respectCooldownMin: 10,
  rudeWords: [],
  defaultCountryCode: '52', broadcastMessage: 'Hola {nombre} 👋',
  broadcastDailyLimit: 30, broadcastMinDelaySec: 60, broadcastMaxDelaySec: 120
};
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch (e) { console.error('[Multi Bot] Archivo dañado, se usan valores por defecto: ' + file); return fallback; }
}
const emptyBroadcast = () => ({ status: 'idle', message: '', media: null, queue: [], sent: 0, notOnWhatsApp: 0, failed: 0, total: 0, day: '', sentToday: 0, lastError: '' });

class Session {
  constructor(dir, id) {
    this.id = id;
    this.dir = dir;
    this.authDir = path.join(dir, 'auth');
    this.cfgFile = path.join(dir, 'config.json');
    this.bcFile = path.join(dir, 'broadcast.json');
    this.msgFile = path.join(dir, 'mensajes.json');
    this.config = { ...DEFAULTS, ...readJson(this.cfgFile, {}) };
    this.broadcast = { ...emptyBroadcast(), ...readJson(this.bcFile, {}) };
    this.msgLog = (() => { const v = readJson(this.msgFile, []); return Array.isArray(v) ? v : []; })();
    this.sock = null; this.connection = 'Desconectado'; this.qr = ''; this.pairingCode = '';
    this.registered = false; this.lastError = ''; this.needsRelink = false;
    this.connecting = false; this.retryTimer = null; this.retries = 0; this.stopped = false;
    this.groupList = []; this.recent = new Map(); this.warnings = new Map(); this.logs = [];
    this.greeted = new Map(); this.lastAuto = new Map(); this.rudeWarned = new Map(); this.topics = new Map();
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
  // Registro de mensajes: guarda qué preguntó el cliente y qué contestó el bot (para revisarlo en el panel).
  recordMsg(who, q, a) {
    if (this.deleted) return;
    this.msgLog.unshift({ at: Date.now(), who: String(who || ''), q: String(q || '').slice(0, 500), a: String(a || '').slice(0, 1000) });
    if (this.msgLog.length > 200) this.msgLog = this.msgLog.slice(0, 200);
    try { fs.writeFileSync(this.msgFile, JSON.stringify(this.msgLog)); } catch (e) { console.error(`[${this.id}] No se pudo guardar el registro de mensajes: ${e.message}`); }
  }
  clearMsgLog() { this.msgLog = []; try { fs.writeFileSync(this.msgFile, '[]'); } catch {} }
  get label() { return this.config.name || this.config.phone || this.id; }
  get expired() { return this.config.expiresAt > 0 && Date.now() > this.config.expiresAt; }
  get rentalOk() { return this.config.active && !this.expired; }
  get daysLeft() { return this.config.expiresAt ? Math.ceil((this.config.expiresAt - Date.now()) / DAY) : null; }
  get isConnected() { return Boolean(this.sock) && this.connection === 'Conectado'; }
  isManagedGroup(jid) { return this.config.groupJids.includes(jid); }
  // Conocimiento de ESTE número: si tiene "knowledgeFile" usa solo esos archivos (aislado); si no, el general.
  knowledge() {
    const f = String(this.config.knowledgeFile || '').trim();
    return f ? kbForFiles(f.split(',')) : kbGeneral();
  }
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
  // ¿Es dueño/admin del bot? Solo los números de "Números protegidos / admin" pueden usar comandos de dueño (.ban).
  // Compara por los últimos 10 dígitos para no fallar por el prefijo de México (52 vs 521).
  isAdmin(...ids) {
    const tail = s => digits(s).slice(-10);
    const list = (this.config.adminNumbers || []).map(tail).filter(Boolean);
    for (const id of ids.filter(Boolean)) {
      const n = tail(String(id).split('@')[0].split(':')[0]);
      if (n && list.includes(n)) return true;
    }
    return false;
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
          if (!this.stopped) this.log(`Conexión cerrada. Código: ${code || '?'} · ${err?.message || 'sin detalle'}`);
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
          await this.handleBan(m).catch(e => this.log('Error en .ban: ' + e.message));
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

  // Muestra "escribiendo..." (o "grabando audio...") un ratito antes de responder, para que se vea natural.
  async showTyping(jid, text, mode = 'composing') {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(mode, jid);
      const base = mode === 'recording' ? 1500 : 700;
      const ms = Math.min(4500, base + String(text || '').length * 28);
      await sleep(ms);
    } catch {}
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

  // ---- comando de dueño: .ban (expulsa a alguien del grupo; solo admins) ----
  async handleBan(m) {
    const c = this.config;
    const jid = m.key.remoteJid;
    const text = this.getText(m);
    if (!jid || !/^\s*[.!/]ban\b/i.test(text)) return;          // solo mensajes que empiezan con .ban
    if (!this.rentalOk || !jid.endsWith('@g.us') || !this.isManagedGroup(jid)) return; // solo en grupos administrados
    const sender = m.key.participant || '';
    // Solo el dueño/admins (los números de "Números protegidos / admin") pueden usar .ban. A los demás los ignora.
    if (!this.isAdmin(sender, m.key.participantPn, m.key.participantAlt, m.key.participantLid)) return;
    if (!this.isConnected) return;
    // Objetivo: respondiendo a su mensaje, o mencionándolo con @
    const inner = this.innerMsg(m);
    const ctx = inner?.extendedTextMessage?.contextInfo || inner?.contextInfo || {};
    let target = ctx.participant || (ctx.mentionedJid && ctx.mentionedJid[0]) || null;
    if (!target) {
      await this.sock.sendMessage(jid, { text: '⚠️ Para sacar a alguien: responde a su mensaje y escribe *.ban* (o menciónalo: .ban @persona).' }, { quoted: m });
      return;
    }
    // No permitir banear a otro admin/dueño
    if (this.isAdmin(target)) {
      await this.sock.sendMessage(jid, { text: '🛡️ Esa persona es admin del bot, no la puedo sacar.' }, { quoted: m });
      return;
    }
    try {
      await this.sock.groupParticipantsUpdate(jid, [target], 'remove');
      const num = digits(String(target).split('@')[0].split(':')[0]);
      const tpl = c.kickMessage || '⛔ Usuario expulsado por {motivo}.';
      const txt = tpl.replace(/\{nombre\}/gi, num || 'Usuario').replace(/\{numero\}/gi, num)
        .replace(/\{id\}/gi, num).replace(/\{alias\}/gi, '@' + num).replace(/\{motivo\}/gi, 'expulsado por un administrador');
      await this.sock.sendMessage(jid, { text: txt, mentions: [target] });
      this.log('.ban por admin ' + sender.split('@')[0] + ' → sacó a ' + num);
    } catch (e) {
      await this.sock.sendMessage(jid, { text: '❌ No pude sacarla. Revisa que el *bot sea administrador* del grupo.' }, { quoted: m });
      this.log('Error al banear: ' + e.message);
    }
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
    // Mismo mensaje entregado dos veces por WhatsApp (reconexiones): se atiende una sola vez.
    if (m.key.id) {
      this.seenIds = this.seenIds || new Map();
      const sk = jid + ':' + m.key.id;
      if (this.seenIds.has(sk)) return;
      this.seenIds.set(sk, Date.now());
      if (this.seenIds.size > 2000) { const cut = Date.now() - 10 * 60000; for (const [k, t] of this.seenIds) if (t < cut) this.seenIds.delete(k); }
    }
    const isGroup = jid.endsWith('@g.us');
    const isPrivate = /@(s\.whatsapp\.net|lid)$/.test(jid);
    if (isGroup) { if (!c.autoReplyGroups || !this.isManagedGroup(jid) || !this.mentionsMe(m)) return; } // en grupos: activado, grupo marcado y que lo mencionen
    else if (!isPrivate) return;                             // ni estados ni canales
    const text = this.getText(m).trim();
    if (/^\s*[.!/](bin|ban)\b/i.test(text)) return;          // .bin y .ban los atienden sus propias funciones
    const kind = this.mediaKind(m);
    if (!text && !kind) return;                              // sin texto ni archivo: nada que atender
    const now = Date.now();
    const flKey = isGroup ? jid + ':' + (m.key.participant || '') : jid;
    if (now - (this.lastAuto.get(flKey) || 0) < 5000) return; // anti-rebote
    // 0) regla de respeto: si el mensaje trae groserías, pide un trato cordial (con descanso para no repetir)
    if (c.respectEnabled !== false && text) {
      const lowR = norm(text);
      const rude = [...DEFAULT_RUDE, ...(c.rudeWords || [])].map(w => norm(w)).filter(Boolean).some(w => matchTerm(lowR, w));
      if (rude) {
        const cd = Math.max(0, Number(c.respectCooldownMin) || 0) * 60000;
        if (now - (this.rudeWarned.get(flKey) || 0) >= cd && this.isConnected) {
          this.rudeWarned.set(flKey, now);
          this.lastAuto.set(flKey, now);
          const msg = (c.respectMessage || '🙏 Te pido respeto para poder ayudarte.').replace(/\\n/g, '\n');
          await this.showTyping(jid, msg);
          await this.sock.sendMessage(jid, { text: msg });
          this.log('Pedí respeto a ' + jid.split('@')[0] + ' (mensaje ofensivo).');
        }
        return;                                                // no sigue con la respuesta normal
      }
    }
    // 0.5) si quien escribe es el DUEÑO (su número está en "admin"), no le vendas: preséntate y explícale.
    const isOwner = isPrivate && this.isAdmin(jid, m.key.participant, m.key.participantPn);
    if (isOwner && text) {
      const lowO = norm(text);
      const esSaludo = /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ola|holi|que onda|menu|info|inicio|empezar|start|probar|prueba|test|quien eres|que sabes|que puedes hacer|ayuda)\b/.test(lowO) || (lowO.length <= 4 && !/^[.!/]/.test(text.trim()));
      if (esSaludo && c.ownerWelcome) {
        if (now - (this.greeted.get(jid) || 0) >= 60000 && this.isConnected) {  // 1 min para no repetir seguido
          this.greeted.set(jid, now); this.lastAuto.set(flKey, now);
          const msg = c.ownerWelcome.replace(/\\n/g, '\n');
          await this.showTyping(jid, msg);
          await this.sock.sendMessage(jid, { text: msg });
          this.log('Presentación de dueño enviada a ' + jid.split('@')[0] + '.');
        }
        return;
      }
      // si no es saludo, sigue el flujo normal para que el dueño pueda probar preguntas
    }
    let reply = null, fromTg = false;
    // Puente de Telegram: manda el mensaje a un bot de Telegram y usa su respuesta (si está activado).
    if (c.tgBridgeEnabled && c.tgBot && text && isPrivate) {
      this.tgBusy = this.tgBusy || new Set();
      this.tgBusyAt = this.tgBusyAt || new Map();
      if (this.tgBusy.has(jid)) {
        // Este cliente ya tiene una consulta en curso: no se lanza otra (evita duplicados y mezclas).
        if (now - (this.tgBusyAt.get(jid) || 0) > 20000 && this.isConnected) {
          this.tgBusyAt.set(jid, now);
          await this.sock.sendMessage(jid, { text: '⏳ Sigo procesando tu consulta anterior. En cuanto termine te la envío.' });
        }
        this.log('Consulta ignorada de ' + jid.split('@')[0] + ': ya tiene otra en proceso.');
        return;
      }
      this.tgBusy.add(jid);
      try {
        try { await this.sock.sendPresenceUpdate('composing', jid); } catch {}
        const cmd = String(c.tgCommand || '{texto}').replace(/\{texto\}/gi, () => text);
        const who0 = jid.split('@')[0];
        this.log('Consulta enviada a Telegram (' + c.tgBot + ') por ' + who0 + '.');
        const r = await tgUser.relay(c.tgBot, cmd, {
          doneText: c.tgDoneText,
          waitWords: String(c.tgWaitWords || '').split(',').map(x => x.trim()).filter(Boolean),
          onLate: async late => {     // respuesta que llegó pasado el tiempo: va al MISMO chat de origen
            if (!this.isConnected) { this.log('⚠️ Respuesta tardía de Telegram para ' + who0 + ' descartada: WhatsApp desconectado.'); return; }
            await this.sock.sendMessage(jid, { text: '⏱️ Respuesta a tu consulta anterior:\n\n' + late });
            this.log('Respuesta tardía de Telegram enviada a ' + who0 + '.');
          },
          onGiveUp: why => this.log('Telegram: no llegó el resultado para ' + who0 + '. ' + why)
        });
        this.lastAuto.set(flKey, now);
        if (r.status === 'ok') { reply = r.text; fromTg = true; this.log('Respuesta de Telegram recibida para ' + who0 + '.'); }
        else if (r.status === 'pending') {
          this.log('Telegram tarda para ' + who0 + ': se sigue esperando.');
          if (this.isConnected) await this.sock.sendMessage(jid, { text: '⏳ Tu consulta sigue en proceso. Te envío el resultado en cuanto esté listo.' });
          return;
        } else if (r.status === 'failed') {
          this.log('Telegram falló para ' + who0 + ': ' + (tgUser.lastError() || 'sin detalle'));
          return;
        } else {
          this.log('Puente Telegram no disponible: ' + (tgUser.lastError() || 'sin detalle') + ' (se usa la respuesta normal).');
        }
      } finally { this.tgBusy.delete(jid); }
    }
    if (!reply && text) {                                    // 1) palabra clave (exacta, sinónimos, errores de escritura y tema de la plática)
      this.topics = this.topics || new Map();
      const tp = this.topics.get(flKey);
      const ctx = tp && Date.now() - tp.at < 10 * 60000 ? tp.words : [];
      const rule = findRule([...(c.autoReplyRules || []), ...this.knowledge()], text, ctx);
      if (rule) {
        reply = rule.reply;
        const tw = topicWordsOf(rule);
        if (tw.length) this.topics.set(flKey, { words: tw, at: Date.now() });
        if (this.topics.size > 2000) { const cut = Date.now() - 10 * 60000; for (const [k, v] of this.topics) if (v.at < cut) this.topics.delete(k); }
      }
    }
    if (!reply && isPrivate && kind && !text) reply = c.autoReplyMedia || null;  // 2) foto/audio: solo en privado
    if (!reply && isPrivate) {                               // 3) bienvenida: solo en privado (con descanso)
      const cd = Math.max(0, Number(c.autoReplyCooldownMin) || 0) * 60000;
      if (now - (this.greeted.get(jid) || 0) >= cd) { reply = (isOwner && c.ownerWelcome) ? c.ownerWelcome : c.autoReplyWelcome; this.greeted.set(jid, now); }
    }
    if (!reply && isPrivate && text && c.autoReplyFallback) reply = c.autoReplyFallback;  // no entendió: ofrece opciones
    if (!reply && isGroup) {                                 // lo mencionaron pero sin palabra clave
      if (!/\?|\¿/.test(text)) return;                        // si no es una pregunta (un "no", "ok"...), no responde
      reply = c.autoReplyGroupHint || '👋 ¿En qué te ayudo?';  // si es pregunta, un mensaje corto
    }
    if (fromTg && reply && !this.isConnected) { this.log('⚠️ Respuesta de Telegram descartada: WhatsApp está desconectado.'); return; }
    if (!reply || !this.isConnected) return;
    // variantes: si la respuesta trae "||", elige una al azar para sonar más natural
    if (!fromTg && reply.includes('||')) {
      const opts = reply.split('||').map(x => x.trim()).filter(Boolean);
      if (opts.length) reply = opts[Math.floor(Math.random() * opts.length)];
    }
    const tipo = kind === 'imagen' ? 'foto' : (kind || 'mensaje');
    if (!fromTg) reply = reply.replace(/\{tipo\}/gi, tipo).replace(/\\n/g, '\n');  // \n en el texto = salto de línea real
    this.lastAuto.set(flKey, now);
    const who = jid.split('@')[0];
    const am = fromTg ? null : /^audio:/i.exec(reply);                       // respuesta tipo audio:nombre.ogg
    if (am) {
      const name = path.basename(reply.slice(am[0].length).trim());
      let fp = null;
      for (const d of [path.join(__dirname, 'audios'), __dirname]) { const c = path.join(d, name); if (fs.existsSync(c)) { fp = c; break; } }
      if (!fp) { this.log('Audio no encontrado: ' + name + ' (súbelo al repo).'); return; }
      const mp3 = /\.mp3$/i.test(fp);
      await this.showTyping(jid, name, 'recording');          // muestra "grabando audio..."
      await this.sock.sendMessage(jid, { audio: fs.readFileSync(fp), mimetype: mp3 ? 'audio/mpeg' : 'audio/ogg; codecs=opus', ptt: true });
      this.log('Audio (' + name + ') enviado a ' + who + '.');
      this.recordMsg(who, text || ('[' + tipo + ']'), reply);
      return;
    }
    const vm = fromTg ? null : /^video:/i.exec(reply);                       // respuesta tipo video:nombre.mp4  (o  video:nombre.mp4 | texto)
    if (vm) {
      const rest = reply.slice(vm[0].length).trim();
      const [fileRaw, ...capParts] = rest.split('|');
      const name = path.basename(fileRaw.trim());
      const caption = capParts.join('|').trim();
      let fp = null;
      for (const d of [path.join(__dirname, 'videos'), __dirname]) { const c = path.join(d, name); if (fs.existsSync(c)) { fp = c; break; } }
      if (!fp) { this.log('Video no encontrado: ' + name + ' (súbelo al repo).'); return; }
      await this.showTyping(jid, caption || 'video', 'recording');  // muestra "grabando video..."
      await this.sock.sendMessage(jid, { video: fs.readFileSync(fp), mimetype: 'video/mp4', caption: caption || undefined });
      this.log('Video (' + name + ') enviado a ' + who + '.');
      this.recordMsg(who, text || ('[' + tipo + ']'), reply);
      return;
    }
    await this.showTyping(jid, reply);                        // muestra "escribiendo..." antes del texto
    await this.sock.sendMessage(jid, { text: String(reply) });
    this.log('Respuesta automática enviada a ' + who + '.');
    this.recordMsg(who, text || ('[' + tipo + ']'), reply);
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
  startBroadcast(text, extra = {}) {
    if (['running', 'paused'].includes(this.broadcast.status)) return { error: 'Ya hay un envío en curso.' };
    const { contacts, invalid } = parseContacts(String(text || ''), this.config.defaultCountryCode);
    const queue = contacts.filter(x => x.number !== this.config.phone);
    if (!queue.length) { this.broadcast.lastError = 'No se encontraron números válidos.'; this.saveBroadcast(); return { error: this.broadcast.lastError }; }
    const prevToday = this.broadcast.day === today() ? this.broadcast.sentToday : 0;
    this.broadcast = { ...emptyBroadcast(), status: 'running', message: this.config.broadcastMessage + (extra.link ? '\n\n' + extra.link : ''), media: extra.media || null, queue, total: queue.length, day: today(), sentToday: prevToday };
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
  broadcastContent(item) {
    const text = fillTemplate(this.broadcast.message, item.name);
    const m = this.broadcast.media;
    if (!m) return { text };
    if (!m.file || !fs.existsSync(m.file)) throw new Error('No se encontró el archivo adjunto.');
    const buf = fs.readFileSync(m.file);
    if (m.kind === 'image') return { image: buf, caption: text };
    if (m.kind === 'video') return { video: buf, mimetype: m.mimetype, caption: text };
    return { document: buf, mimetype: m.mimetype, fileName: m.name, caption: text };
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
        else { await this.sock.sendMessage(res.jid, this.broadcastContent(item)); b().sent++; b().sentToday++; }
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
