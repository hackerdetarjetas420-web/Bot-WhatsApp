// Puente de Telegram → WhatsApp.
// Un SEGUNDO bot de Telegram (su token va en la variable TELEGRAM_BOT_TOKEN) lee los
// mensajes de un canal donde es administrador y los entrega a onMessage({ text, chatId, title }).
// Telegram no deja leer lo que ENVÍA otro bot en chats normales; por eso se usa un canal.
// Opcional: TELEGRAM_SOURCE_CHAT limita el puente a un solo canal (su ID, p. ej. -1001234567890).

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const SOURCE = String(process.env.TELEGRAM_SOURCE_CHAT || '').trim();
const API = m => `https://api.telegram.org/bot${TOKEN}/${m}`;

const extractText = msg => (msg && (msg.text || msg.caption)) || '';

async function startTelegramBridge(onMessage, log = console.info) {
  if (!TOKEN) return false;
  log('[Telegram] Puente iniciado' + (SOURCE ? ` (solo chat ${SOURCE})` : '') + '.');
  let offset = 0, fail = 0;
  (async function loop() {
    for (;;) {
      try {
        const url = API('getUpdates') + `?timeout=50&offset=${offset}` +
          `&allowed_updates=${encodeURIComponent('["message","channel_post","edited_channel_post"]')}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
        const j = await r.json();
        if (!j.ok) {
          fail++;
          if (r.status === 409) log('[Telegram] Conflicto: ¿otro programa usa el mismo bot, o hay un webhook puesto?');
          else log('[Telegram] getUpdates falló: ' + (j.description || r.status));
          await sleep(Math.min(60000, 3000 * fail));
          continue;
        }
        fail = 0;
        for (const u of j.result) {
          offset = u.update_id + 1;
          const msg = u.message || u.channel_post || u.edited_channel_post;
          const chatId = String(msg?.chat?.id ?? '');
          if (!msg || (SOURCE && chatId !== SOURCE)) continue;
          const text = extractText(msg);
          if (!text) continue;
          try { await onMessage({ text, chatId, title: msg.chat?.title || '' }); }
          catch (e) { log('[Telegram] No se pudo reenviar: ' + e.message); }
        }
      } catch (e) {
        fail++;
        await sleep(Math.min(60000, 3000 * fail));
      }
    }
  })();
  return true;
}

module.exports = { startTelegramBridge };
