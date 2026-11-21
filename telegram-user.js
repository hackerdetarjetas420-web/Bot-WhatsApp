// Puente con CUENTA DE USUARIO de Telegram (MTProto, vía gramjs).
// Permite que el bot de WhatsApp le escriba a un bot de Telegram y traiga su respuesta.
// Credenciales: TELEGRAM_API_ID y TELEGRAM_API_HASH (de my.telegram.org).
// La sesión (login) se guarda en disco para no volver a loguear en cada reinicio.
const fs = require('fs');
const path = require('path');

let TelegramClient, StringSession, Api;
try {
  ({ TelegramClient, Api } = require('telegram'));
  ({ StringSession } = require('telegram/sessions'));
} catch (e) {
  console.warn('[TG-Usuario] La librería "telegram" (gramjs) no está instalada todavía.');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const API_ID = () => Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = () => process.env.TELEGRAM_API_HASH || '';

let SESSION_FILE = null;
let client = null;
let connecting = false;
let login = null;            // estado temporal del login: { client, phone, phoneCodeHash }
let statusText = 'Sin configurar';

function init(dataDir) {
  SESSION_FILE = path.join(dataDir, 'tg-user-session.txt');
  // Intenta conectar con la sesión guardada al arrancar (sin bloquear).
  if (ready() === false && savedSession()) connectSaved().catch(() => {});
}

function savedSession() {
  try { return SESSION_FILE && fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : ''; }
  catch { return ''; }
}
function writeSession(str) {
  try { fs.writeFileSync(SESSION_FILE, str); } catch (e) { console.error('[TG-Usuario] No se pudo guardar la sesión: ' + e.message); }
}

function configured() { return Boolean(TelegramClient && API_ID() && API_HASH()); }
function ready() { return Boolean(client && client.connected); }
function status() { return statusText; }

async function connectSaved() {
  if (!configured() || connecting) return ready();
  const sess = savedSession();
  if (!sess) { statusText = 'Falta iniciar sesión'; return false; }
  connecting = true;
  try {
    const c = new TelegramClient(new StringSession(sess), API_ID(), API_HASH(), { connectionRetries: 3, baseLogger: silentLogger() });
    await c.connect();
    const ok = await c.isUserAuthorized();
    if (!ok) { statusText = 'La sesión caducó, vuelve a iniciar sesión'; try { await c.disconnect(); } catch {} return false; }
    client = c;
    const me = await c.getMe().catch(() => null);
    statusText = 'Conectado' + (me?.firstName ? ' como ' + me.firstName : '');
    console.info('[TG-Usuario] ' + statusText);
    return true;
  } catch (e) {
    statusText = 'Error al conectar: ' + (e?.message || e);
    console.error('[TG-Usuario] ' + statusText);
    return false;
  } finally { connecting = false; }
}

function silentLogger() {
  try { const { Logger } = require('telegram/extensions/Logger'); const l = new Logger(); l.log = () => {}; return l; } catch { return undefined; }
}

// Paso 1 del login: enviar el código al teléfono.
async function sendCode(phone) {
  if (!configured()) return { error: 'Faltan TELEGRAM_API_ID / TELEGRAM_API_HASH (ponlos en Render).' };
  try {
    const c = new TelegramClient(new StringSession(''), API_ID(), API_HASH(), { connectionRetries: 3, baseLogger: silentLogger() });
    await c.connect();
    const res = await c.sendCode({ apiId: API_ID(), apiHash: API_HASH() }, String(phone).trim());
    login = { client: c, phone: String(phone).trim(), phoneCodeHash: res.phoneCodeHash };
    statusText = 'Código enviado, escribe el código';
    return { ok: true };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// Paso 2: confirmar con el código (y contraseña si hay verificación en dos pasos).
async function signIn(code, password) {
  if (!login || !login.client) return { error: 'Primero pide el código.' };
  const c = login.client;
  try {
    await c.invoke(new Api.auth.SignIn({
      phoneNumber: login.phone,
      phoneCodeHash: login.phoneCodeHash,
      phoneCode: String(code).trim()
    }));
  } catch (e) {
    const msg = e?.errorMessage || e?.message || String(e);
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      if (!password) return { needPassword: true };
      try {
        await c.signInWithPassword({ apiId: API_ID(), apiHash: API_HASH() }, {
          password: async () => String(password),
          onError: (err) => { throw err; }
        });
      } catch (e2) { return { error: 'Contraseña de 2 pasos incorrecta: ' + (e2?.message || e2) }; }
    } else {
      return { error: msg };
    }
  }
  // Login OK: guardar sesión y dejar el cliente activo.
  try {
    const sessStr = c.session.save();
    writeSession(sessStr);
    client = c;
    login = null;
    const me = await c.getMe().catch(() => null);
    statusText = 'Conectado' + (me?.firstName ? ' como ' + me.firstName : '');
    console.info('[TG-Usuario] Sesión iniciada. ' + statusText);
    return { ok: true };
  } catch (e) { return { error: 'Inició pero no se pudo guardar la sesión: ' + (e?.message || e) }; }
}

async function logout() {
  try { if (client) await client.invoke(new Api.auth.LogOut()); } catch {}
  try { if (client) await client.disconnect(); } catch {}
  client = null;
  try { if (SESSION_FILE && fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {}
  statusText = 'Sesión cerrada';
}

// Último motivo por el que relay() no devolvió texto (para mostrarlo en el registro del panel).
let lastErr = '';
function lastError() { return lastErr; }

// Palabras que delatan un mensaje de "espera" (el bot aún no terminó). Se pueden cambiar desde el panel.
const DEFAULT_WAIT = ['procesando', 'consultando', 'cargando', 'iniciando', 'buscando', 'verificando', 'analizando',
  'un momento', 'espera', 'processing', 'loading', 'searching', 'please wait', 'wait', '⏳', '⌛'];

// ¿El texto ya es el resultado final? Si hay "doneText" (frase fija del resultado), manda esa frase.
function isFinal(text, o) {
  const low = String(text || '').trim().toLowerCase();
  if (!low) return false;
  if (o.doneText) return low.includes(String(o.doneText).toLowerCase());
  return !(low.length < 160 && o.waitWords.some(w => low.includes(w)));
}

// Candado: solo UNA consulta a la vez mientras se reclama su "boleto" (el primer mensaje del bot tras enviarla).
let lockChain = Promise.resolve();
function lock() {
  let release; const gate = new Promise(r => { release = r; });
  const prev = lockChain;
  lockChain = prev.then(() => gate);
  return prev.then(() => release);
}
const claimed = new Set();   // mensajes del bot que ya pertenecen a una consulta (bot:id)
const claim = k => { claimed.add(k); if (claimed.size > 500) claimed.delete(claimed.values().next().value); };

// Manda `text` al bot de Telegram (ej. "@mibot") y devuelve la respuesta de ESA consulta.
// Cada consulta se amarra al mensaje del bot que la contesta (el "Procesando…") y se sigue SOLO ese mensaje
// hasta que se edita con el resultado; así una respuesta tardía no se cuela en la consulta de otra persona.
// Devuelve { status, text? }:
//   'ok'      → resultado final en `text`
//   'pending' → pasó el tiempo, pero se sigue vigilando; si llega, se entrega con o.onLate(texto)
//   'failed'  → la consulta SÍ se envió pero no hubo resultado (el motivo queda en lastError())
//   'unsent'  → no se pudo ni enviar (Telegram desconectado, sin configurar…)
async function relay(botUsername, text, o = {}) {
  const opt = {
    timeoutMs: o.timeoutMs || 45000, claimMs: o.claimMs || 20000, quietMs: o.quietMs ?? 3000,
    pollMs: o.pollMs || 1200, claimPollMs: o.claimPollMs || 700, lateMs: o.lateMs ?? 180000, latePollMs: o.latePollMs || 4000,
    doneText: String(o.doneText || '').trim(),
    waitWords: (Array.isArray(o.waitWords) && o.waitWords.length ? o.waitWords : DEFAULT_WAIT).map(w => String(w).toLowerCase()),
    onLate: typeof o.onLate === 'function' ? o.onLate : null,
    onGiveUp: typeof o.onGiveUp === 'function' ? o.onGiveUp : null
  };
  lastErr = '';
  if (!configured()) { lastErr = 'Faltan TELEGRAM_API_ID / TELEGRAM_API_HASH.'; return { status: 'unsent' }; }
  if (!ready()) { if (!(await connectSaved()) || !ready()) { lastErr = 'Telegram no está conectado: ' + statusText; return { status: 'unsent' }; } }
  const uname = String(botUsername).trim().replace(/^@/, '');
  if (!uname) { lastErr = 'No hay bot destino configurado.'; return { status: 'unsent' }; }
  const key = id => uname.toLowerCase() + ':' + id;

  const release = await lock();
  let released = false;
  const free = () => { if (!released) { released = true; release(); } };
  let bot, ticket = 0;
  try {
    try {
      bot = await client.getEntity(uname);
      const before = await client.getMessages(bot, { limit: 1 });
      const beforeId = before && before[0] ? before[0].id : 0;
      const sent = await client.sendMessage(bot, { message: String(text) });
      const floor = (sent && sent.id) || beforeId;
      // 1) reclamar el "boleto": el primer mensaje nuevo del bot que nadie más reclamó.
      const t0 = Date.now();
      while (Date.now() - t0 < opt.claimMs && !ticket) {
        await sleep(opt.claimPollMs);
        const msgs = await client.getMessages(bot, { limit: 10 });
        const cand = (msgs || []).filter(m => m && !m.out && m.id > floor && !claimed.has(key(m.id))).sort((a, b) => a.id - b.id)[0];
        if (cand) { ticket = cand.id; claim(key(ticket)); }
      }
    } catch (e) {
      lastErr = 'Error al consultar a ' + uname + ': ' + (e?.message || e);
      console.error('[TG-Usuario] ' + lastErr);
      return { status: ticket ? 'failed' : 'unsent' };
    }
    if (!ticket) { lastErr = 'El bot no contestó en ' + Math.round(opt.claimMs / 1000) + ' s.'; return { status: 'failed' }; }
  } finally { free(); }   // ya reclamado: la siguiente consulta puede enviarse

  // 2) seguir SOLO ese mensaje hasta que sea el resultado final y deje de cambiar.
  const watch = async (deadline, pollMs) => {
    let lastSnap = '', lastChange = Date.now(), lastText = '', media = false;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      let m = null;
      try { const r = await client.getMessages(bot, { ids: [ticket] }); m = r && r[0]; } catch (e) { continue; }
      if (!m) continue;
      const t = (m.message || '').trim();
      media = Boolean(m.media) && !t;
      const snap = JSON.stringify([t, m.editDate || 0, Boolean(m.media)]);
      if (snap !== lastSnap) { lastSnap = snap; lastChange = Date.now(); }
      lastText = t;
      if (isFinal(t, opt) && Date.now() - lastChange >= opt.quietMs) return { text: t };
    }
    return { text: '', lastText, media };
  };
  const why = r => r.media ? 'El bot respondió con un archivo/imagen sin texto (el puente solo reenvía texto).'
    : r.lastText ? 'El bot se quedó en un aviso de espera: "' + r.lastText.slice(0, 60) + '".'
    : 'El bot no entregó el resultado.';

  const r1 = await watch(Date.now() + opt.timeoutMs, opt.pollMs);
  if (r1.text) return { status: 'ok', text: r1.text };
  if (opt.onLate && opt.lateMs > 0) {
    // 3) respuesta tardía: se sigue vigilando el mismo mensaje en segundo plano.
    (async () => {
      const r2 = await watch(Date.now() + opt.lateMs, opt.latePollMs);
      if (r2.text) await opt.onLate(r2.text);
      else if (opt.onGiveUp) opt.onGiveUp(why(r2));
    })().catch(e => { try { opt.onGiveUp && opt.onGiveUp('Error al vigilar la respuesta tardía: ' + (e?.message || e)); } catch {} });
    lastErr = 'Sigue en proceso; se entregará si llega.';
    return { status: 'pending' };
  }
  lastErr = why(r1);
  return { status: 'failed' };
}

module.exports = { init, configured, ready, status, connectSaved, sendCode, signIn, logout, relay, lastError };
