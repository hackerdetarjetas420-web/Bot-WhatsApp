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

// Avisos de "espera" que algunos bots mandan antes del resultado real (no son la respuesta final).
const isPlaceholder = t => t.length < 90 && /(procesando|consultando|cargando|espera|un momento|buscando|verificando|checking|processing|loading|please wait|wait|⏳|⌛)/i.test(t);

// Un solo relay a la vez: si llegan 2 clientes juntos, las respuestas del bot no se mezclan.
let relayChain = Promise.resolve();
function relay(botUsername, text, timeoutMs = 45000) {
  const run = relayChain.then(() => doRelay(botUsername, text, timeoutMs));
  relayChain = run.catch(() => {});
  return run;
}

// Manda `text` al bot de Telegram (ej. "@mibot") y espera su respuesta FINAL. Devuelve texto o null.
// Espera a que el bot deje de escribir/editar (3 s de calma), ignora avisos tipo "Procesando…"
// y lee mensajes editados (muchos bots editan el mismo mensaje con el resultado).
async function doRelay(botUsername, text, timeoutMs) {
  lastErr = '';
  if (!configured()) { lastErr = 'Faltan TELEGRAM_API_ID / TELEGRAM_API_HASH.'; return null; }
  if (!ready()) { if (!(await connectSaved())) { lastErr = 'Telegram no está conectado: ' + statusText; return null; } }
  if (!ready()) { lastErr = 'Telegram no está conectado: ' + statusText; return null; }
  const uname = String(botUsername).trim().replace(/^@/, '');
  if (!uname) { lastErr = 'No hay bot destino configurado.'; return null; }
  try {
    const bot = await client.getEntity(uname);
    const before = await client.getMessages(bot, { limit: 1 });
    const beforeId = before && before[0] ? before[0].id : 0;
    await client.sendMessage(bot, { message: String(text) });
    const deadline = Date.now() + timeoutMs;
    let lastSnap = '', lastChange = Date.now(), real = [], sawMedia = false, sawPlaceholder = false;
    while (Date.now() < deadline) {
      await sleep(1200);
      const msgs = await client.getMessages(bot, { limit: 10 });
      const nuevos = (msgs || []).filter(m => m && !m.out && m.id > beforeId).sort((a, b) => a.id - b.id);
      const snap = JSON.stringify(nuevos.map(m => [m.id, m.message || '', m.editDate || 0, Boolean(m.media)]));
      if (snap !== lastSnap) { lastSnap = snap; lastChange = Date.now(); }
      const texts = nuevos.map(m => (m.message || '').trim()).filter(Boolean);
      real = texts.filter(t => !isPlaceholder(t));
      sawPlaceholder = texts.length > real.length;
      sawMedia = nuevos.some(m => m.media && !(m.message || '').trim());
      if (real.length && Date.now() - lastChange >= 3000) return real.join('\n\n').trim();
    }
    if (real.length) return real.join('\n\n').trim();
    lastErr = sawPlaceholder ? 'El bot solo mandó un aviso de espera y no el resultado en ' + Math.round(timeoutMs / 1000) + ' s.'
      : sawMedia ? 'El bot respondió con un archivo/imagen sin texto (el puente solo reenvía texto).'
      : 'El bot de Telegram no respondió en ' + Math.round(timeoutMs / 1000) + ' s.';
    return null;
  } catch (e) {
    lastErr = 'Error al consultar a ' + uname + ': ' + (e?.message || e);
    console.error('[TG-Usuario] ' + lastErr);
    return null;
  }
}

module.exports = { init, configured, ready, status, connectSaved, sendCode, signIn, logout, relay, lastError };
