// Kerangka server bot Telegram grup inti Nusara Studio.
// TAHAP KERANGKA SAJA: server ini TIDAK membalas ke grup Telegram.
// Pesan grup yang memanggil "Bowo" hanya ditulis ke antrean file
// queue/incoming.jsonl, untuk dibaca/dijawab Bowo/Muse pada tahap berikutnya.
// TIDAK ada panggilan ke Telegram Bot API di file ini, TIDAK ada webhook
// yang di-set dari sini, dan TIDAK ada token yang ditulis di kode.
//
// Env:
//   PORT                 (opsional, default 3000)
//   TELEGRAM_BOT_TOKEN   (opsional di tahap kerangka; bila kosong, server
//                         jalan dalam mode tes lokal saja, tetap TANPA
//                         memanggil Telegram API)
//   WEBHOOK_SECRET       (opsional tapi SANGAT disarankan untuk produksi:
//                         dipakai sebagai segmen path webhook DAN sebagai
//                         secret_token Telegram yang diharapkan di header
//                         X-Telegram-Bot-Api-Secret-Token bila header itu ada)
//   GROUP_CHAT_ID        (wajib untuk produksi: hanya chat_id ini yang
//                         diproses; bila kosong, server hanya me-log dan
//                         TIDAK mengantrekan apa pun)
//
// Keamanan / privasi:
//   - Token TIDAK PERNAH di-log, di-cetak, atau ditulis ke file antrean.
//   - Log server hanya mencatat chat_id, message_id, dan status
//     (queued/ignored), bukan isi pesan grup.
//   - Isi pesan yang memanggil "Bowo" memang harus tersimpan di antrean
//     (agar Bowo bisa menjawabnya nanti), jadi file antrean ini adalah
//     data grup inti — jaga aksesnya, jangan dipublikasikan.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '';

const QUEUE_DIR = path.join(__dirname, 'queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'incoming.jsonl');

// Pemicu: kata "Bowo" saja, case-insensitive, batas kata.
// Cocok: "Bowo halo", "halo Bowo", "bowo,", "BOWO?", "Bowo!"
// Tidak cocok: "Bowok", "Bowo123", "kebowoan" (batas kata gagal).
const TRIGGER_RE = /\bBowo\b/i;

function log(obj) {
  // Satu baris JSON per log, tanpa isi pesan dan tanpa rahasia.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

function webhookPath() {
  return WEBHOOK_SECRET ? `/webhook/${WEBHOOK_SECRET}` : '/webhook';
}

function ensureQueueDir() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function enqueue(entry) {
  ensureQueueDir();
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

function handleUpdate(update) {
  const message = update && update.message;
  if (!message || typeof message.text !== 'string') {
    return { queued: false, reason: 'not_a_text_message' };
  }

  // Hindari loop bot-ke-bot: abaikan pesan dari akun bot lain.
  if (message.from && message.from.is_bot) {
    return { queued: false, reason: 'from_bot_ignored' };
  }

  const chatId = message.chat && message.chat.id;
  if (chatId === undefined || chatId === null) {
    return { queued: false, reason: 'no_chat_id' };
  }

  // Whitelist grup: bila belum dikonfigurasi, JANGAN antrekan apa pun.
  if (!GROUP_CHAT_ID) {
    log({ event: 'ignored', reason: 'group_not_configured', chat_id: chatId, message_id: message.message_id });
    return { queued: false, reason: 'group_not_configured' };
  }

  if (String(chatId) !== String(GROUP_CHAT_ID)) {
    log({ event: 'ignored', reason: 'not_whitelisted_group', chat_id: chatId, message_id: message.message_id });
    return { queued: false, reason: 'not_whitelisted_group' };
  }

  // Hanya grup (bukan chat pribadi) yang diproses, sesuai whitelist.
  const chatType = message.chat.type;
  if (chatType !== 'group' && chatType !== 'supergroup') {
    log({ event: 'ignored', reason: 'not_a_group', chat_id: chatId, message_id: message.message_id });
    return { queued: false, reason: 'not_a_group' };
  }

  // DIAM total bila tidak ada kata "Bowo".
  if (!TRIGGER_RE.test(message.text)) {
    log({ event: 'ignored', reason: 'no_trigger', chat_id: chatId, message_id: message.message_id });
    return { queued: false, reason: 'no_trigger' };
  }

  const entry = {
    received_at: new Date().toISOString(),
    update_id: update.update_id ?? null,
    message_id: message.message_id ?? null,
    chat_id: chatId,
    chat_type: chatType,
    from_id: message.from ? message.from.id : null,
    from_username: message.from ? (message.from.username || null) : null,
    text: message.text,
    trigger: 'Bowo',
  };
  enqueue(entry);
  log({ event: 'queued', chat_id: chatId, message_id: message.message_id });
  return { queued: true, reason: 'trigger_matched' };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // GET /health adalah endpoint publik untuk list ping (mis. ping Pak
  // supaya Render Free tidak tidur). Sengaja TANPA token, TANPA secret,
  // dan TANPA chat id: hanya ok + boolean konfigurasi, tanpa nilai apa pun.
  // HEAD juga dilayani 200 tanpa body, karena sebagian layanan ping
  // memakai HEAD. Cepat, tanpa baca antrean, tanpa panggil Telegram API.
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? '' : JSON.stringify({
      ok: true,
      mode: BOT_TOKEN ? 'ready_for_webhook_setup' : 'local_test_only',
      webhook_configured: Boolean(WEBHOOK_SECRET),
      group_configured: Boolean(GROUP_CHAT_ID),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === webhookPath()) {
    // Bila Telegram mengirim secret_token dan kita punya secret, harus cocok.
    // Bila header tidak ada (webhook di-set tanpa secret_token), path rahasia
    // saja yang menjadi pengaman — ini sesuai tahap kerangka.
    const presented = req.headers['x-telegram-bot-api-secret-token'];
    if (WEBHOOK_SECRET && presented !== undefined && presented !== WEBHOOK_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad_secret' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Batas sederhana agar satu update raksasa tidak memenuhi memori.
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      let update;
      try {
        update = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
        return;
      }
      // Kembalikan 200 CEPAT ke Telegram, apa pun hasil penyaringannya,
      // supaya Telegram tidak mengulang pengiriman update yang sama.
      const result = handleUpdate(update);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

ensureQueueDir();
// Render (dan host lain) memberi PORT dinamis lewat env; server WAJIB
// mengikat 0.0.0.0 supaya bisa dijangkau publik, bukan hanya localhost.
server.listen(PORT, '0.0.0.0', () => {
  log({
    event: 'started',
    host: '0.0.0.0',
    port: PORT,
    mode: BOT_TOKEN ? 'ready_for_webhook_setup' : 'local_test_only',
    webhook_configured: Boolean(WEBHOOK_SECRET),
    group_configured: Boolean(GROUP_CHAT_ID),
    note: 'skeleton_only_no_reply_to_telegram',
  });
});
