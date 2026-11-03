// Server bot Telegram grup inti Nusara Studio — TAHAP JEMBATAN JAWABAN.
// Arsitektur: Opsi B (worker Bowo), interval realtime (pekerja jalan terus).
// Server ini menerima webhook, mengantrekan pesan yang memanggil "Bowo",
// DAN melayani worker lewat endpoint internal /bridge/* (daftar antrean
// tertunda + kirim jawaban/file). Worker berjalan di VM Bowo, bukan di sini.
//
// PERILAKU YANG DIPERTAHANKAN dari kerangka (sudah terbukti 3 Nov 2026):
//   - /health publik (ok + boolean konfigurasi, tanpa nilai rahasia).
//   - Whitelist GROUP_CHAT_ID; diam total tanpa kata "Bowo".
//   - Pemicu kata "Bowo" saja, case-insensitive, batas kata.
//   - Pesan dari akun bot diabaikan (anti-loop).
//   - Balas 200 CEPAT ke Telegram, baru proses.
//   - Log hanya metadata (chat_id/message_id/status), BUKAN isi pesan.
//
// YANG BARU di tahap jembatan:
//   - GET /bridge/pending: daftar antrean tertunda untuk worker (butuh secret).
//   - POST /bridge/send: kirim balasan teks/file ke grup whitelist SAJA,
//     selalu sebagai balasan (reply_to) atas pesan antrean yang nyata —
//     bot TIDAK PERNAH memulai percakapan sendiri.
//   - Katalog file (catalog.json): nama -> file repo / URL publik.
//   - Rate limit + deduplikasi + pemisah pesan panjang + antre kirim.
//
// Env (NAMA saja — nilai TIDAK PERNAH ditulis di kode/repo/chat):
//   PORT                 (opsional, default 3000; Render mengisi sendiri)
//   TELEGRAM_BOT_TOKEN   (wajib produksi; dipakai memanggil Telegram Bot API)
//   WEBHOOK_SECRET       (segmen path webhook + secret_token Telegram)
//   GROUP_CHAT_ID        (wajib produksi; hanya chat_id ini yang diproses)
//   BRIDGE_SECRET        (BARU, wajib untuk jembatan; secret bersama worker.
//                         Nilainya hanya Pak yang mengetikkan di dashboard
//                         Render. Tanpa ini, /bridge/* menolak (fail closed).)
//   OWNER_USER_ID        (BARU, opsional; user_id Telegram Pak/Bowo.
//                         Bila diisi, pesan dari user_id itu = perintah
//                         (boleh katalog + URL). Bila kosong, semua pesan
//                         = permintaan anggota (katalog saja) — default aman.)
//   BRIDGE_DRY_RUN       (HANYA TES LOKAL; "1" = /bridge/send hanya mencatat
//                         tanpa memanggil Telegram dan tanpa merekam kiriman.
//                         JANGAN PERNAH di-set di Render.)
//   BRIDGE_FAKE_TELEGRAM (HANYA TES LOKAL; "1" = panggilan Telegram disimulasi
//                         sukses tanpa jaringan, tapi seluruh jalur lain
//                         (validasi, rate limit, pencatatan kiriman, dedup)
//                         tetap berjalan normal. JANGAN PERNAH di-set di Render.)
//
// Keamanan / privasi:
//   - Token, secret, dan user_id pemilik TIDAK PERNAH di-log, di-cetak,
//     atau ditulis ke file antrean/kiriman.
//   - Log server hanya metadata; isi pesan, caption, dan URL TIDAK di-log.
//   - File antrean berisi teks pesan grup — data internal grup inti,
//     jangan dipublikasikan (sudah dikecualikan .gitignore).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '';
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const OWNER_USER_ID = process.env.OWNER_USER_ID || '';
const BRIDGE_DRY_RUN = process.env.BRIDGE_DRY_RUN === '1';
const BRIDGE_FAKE_TELEGRAM = process.env.BRIDGE_FAKE_TELEGRAM === '1';

const QUEUE_DIR = path.join(__dirname, 'queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'incoming.jsonl');
const SENT_FILE = path.join(QUEUE_DIR, 'sent.jsonl');
const CATALOG_DIR = path.join(__dirname, 'catalog');
const CATALOG_FILE = path.join(__dirname, 'catalog.json');

const TRIGGER_RE = /\bBowo\b/i;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB, batas Telegram untuk bot.
const TEXT_LIMIT = 4096; // Batas karakter pesan teks Telegram.
const CAPTION_LIMIT = 1024; // Batas karakter caption media Telegram.
const TEXT_WINDOW_MS = 10000; // 1 balasan teks per 10 detik per orang.
const FILE_WINDOW_MS = 60000; // 1 file per menit per orang.
const GLOBAL_SPACING_MS = 1100; // ~1 pesan/detik per chat (batas Telegram).
const BODY_LIMIT = 1024 * 1024; // Batas body JSON 1 MB.

function log(obj) {
  // Satu baris JSON per log, tanpa isi pesan dan tanpa rahasia.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function webhookPath() {
  return WEBHOOK_SECRET ? `/webhook/${WEBHOOK_SECRET}` : '/webhook';
}

function ensureQueueDir() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

// Jenis pengirim: 'order' bila dari Pak/Bowo (OWNER_USER_ID), selebihnya
// 'request' (permintaan anggota). Bila OWNER_USER_ID kosong, semua request.
function deriveKind(fromId) {
  if (OWNER_USER_ID && fromId !== null && fromId !== undefined
    && String(fromId) === String(OWNER_USER_ID)) {
    return 'order';
  }
  return 'request';
}

function enqueue(entry) {
  ensureQueueDir();
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

function readQueueLines() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return fs.readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

function readQueueEntries() {
  const entries = [];
  for (const line of readQueueLines()) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') entries.push(entry);
    } catch (e) { /* baris rusak dilewati */ }
  }
  return entries;
}

// --- Pencatatan kiriman (idempotensi): satu balasan per pesan antrean. ---
// File append-only; dibaca ulang saat start. Kehilangan file ini saat
// restart Render DITERIMA: worker memegang penanda (mark) di sisinya,
// sehingga pesan yang sudah terkirim tidak diminta kirim ulang.
const sentIds = new Set();
const sentMessageById = new Map();
let sentLoaded = false;

function loadSentIds() {
  if (sentLoaded) return;
  sentLoaded = true;
  try {
    if (!fs.existsSync(SENT_FILE)) return;
    for (const line of fs.readFileSync(SENT_FILE, 'utf8').split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        if (rec && rec.message_id !== undefined && rec.message_id !== null) {
          sentIds.add(String(rec.message_id));
        }
      } catch (e) { /* baris rusak dilewati */ }
    }
  } catch (e) { /* file belum ada / tidak bisa dibaca: mulai kosong */ }
}

function isSent(messageId) {
  loadSentIds();
  return sentIds.has(String(messageId));
}

function recordSent(messageId, sentMessageId, type) {
  ensureQueueDir();
  fs.appendFileSync(SENT_FILE, JSON.stringify({
    message_id: messageId,
    sent_message_id: sentMessageId ?? null,
    type,
    at: new Date().toISOString(),
  }) + '\n', 'utf8');
  sentIds.add(String(messageId));
  sentMessageById.set(String(messageId), sentMessageId ?? null);
}

// --- Katalog file: nama (huruf kecil) -> { type, file | url, caption? }. ---
// Dibaca segar tiap pemakaian supaya perubahan katalog langsung berlaku
// tanpa restart. Isi awal KOSONG (Pak mengisi nama + file/URL belakangan).
function loadCatalog() {
  try {
    if (!fs.existsSync(CATALOG_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    if (!data || typeof data.files !== 'object' || Array.isArray(data.files)) return {};
    const out = {};
    for (const [key, val] of Object.entries(data.files)) {
      out[String(key).toLowerCase()] = val;
    }
    return out;
  } catch (e) {
    return {};
  }
}

function catalogCount() {
  return Object.keys(loadCatalog()).length;
}

// Validasi entri katalog. Mengembalikan { ok, type, file?, url?, caption? }
// atau { ok: false, error } tanpa pernah mengembalikan isi file.
function resolveCatalogEntry(key) {
  const catalog = loadCatalog();
  const entry = catalog[String(key).toLowerCase()];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, error: 'catalog_not_found' };
  }
  if (entry.type !== 'photo' && entry.type !== 'video' && entry.type !== 'document') {
    return { ok: false, error: 'catalog_invalid' };
  }
  if (entry.file && entry.url) {
    return { ok: false, error: 'catalog_invalid' };
  }
  if (entry.file) {
    // File HARUS berada di dalam folder catalog (cegah path traversal).
    const resolved = path.resolve(CATALOG_DIR, String(entry.file));
    if (resolved !== CATALOG_DIR && !resolved.startsWith(CATALOG_DIR + path.sep)) {
      return { ok: false, error: 'catalog_invalid' };
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (e) {
      return { ok: false, error: 'file_not_found' };
    }
    if (!stat.isFile()) return { ok: false, error: 'catalog_invalid' };
    if (stat.size > MAX_FILE_BYTES) return { ok: false, error: 'file_too_large' };
    return {
      ok: true, type: entry.type, filePath: resolved,
      caption: typeof entry.caption === 'string' ? entry.caption : undefined,
    };
  }
  if (entry.url) {
    if (!/^https?:\/\//i.test(String(entry.url))) {
      return { ok: false, error: 'catalog_invalid' };
    }
    return {
      ok: true, type: entry.type, url: String(entry.url),
      caption: typeof entry.caption === 'string' ? entry.caption : undefined,
    };
  }
  return { ok: false, error: 'catalog_invalid' };
}

// --- Pemotong pesan: per paragraf, lalu potong keras per code point. ---
// Memakai Array.from (code point) supaya emoji tidak terbelah.
function truncateToCodePoints(text, limit) {
  const points = Array.from(String(text));
  return points.length <= limit ? String(text) : points.slice(0, limit).join('');
}

function splitMessage(text, limit = TEXT_LIMIT) {
  const input = String(text);
  if (Array.from(input).length <= limit) return [input];
  const chunks = [];
  const paragraphs = input.split(/\n\s*\n/);
  for (const para of paragraphs) {
    if (!para) continue;
    const points = Array.from(para);
    if (points.length <= limit) {
      chunks.push(para);
    } else {
      for (let i = 0; i < points.length; i += limit) {
        chunks.push(points.slice(i, i + limit).join(''));
      }
    }
  }
  return chunks.length ? chunks : [input.slice(0, limit)];
}

// --- Panggilan Telegram Bot API (JSON, atau multipart untuk file lokal). ---
// TIDAK PERNAH me-log URL (mengandung token) maupun isi pesan.
let fakeMessageCounter = 900000001;

function telegramApi(method, fields, fileBuffer, fileName) {
  if (BRIDGE_DRY_RUN) {
    log({ event: 'bridge_send_dry_run', method });
    return Promise.resolve({ ok: true, dry_run: true, result: null });
  }
  if (BRIDGE_FAKE_TELEGRAM) {
    // Mode tes lokal: sukses simulasi tanpa jaringan. Seluruh jalur lain
    // (validasi, rate limit, pencatatan, dedup) tetap berjalan normal.
    const id = fakeMessageCounter;
    fakeMessageCounter += 1;
    return Promise.resolve({ ok: true, result: { message_id: id } });
  }
  return new Promise((resolve) => {
    let body;
    let contentType;
    if (fileBuffer) {
      const boundary = `----bowo${Date.now()}${Math.random().toString(36).slice(2)}`;
      const parts = [];
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`,
          'utf8',
        ));
      }
      const fileField = method === 'sendPhoto' ? 'photo'
        : method === 'sendVideo' ? 'video' : 'document';
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      ));
      parts.push(fileBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
      body = Buffer.concat(parts);
      contentType = `multipart/form-data; boundary=${boundary}`;
    } else {
      body = Buffer.from(JSON.stringify(fields), 'utf8');
      contentType = 'application/json';
    }
    const req = https.request({
      host: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      timeout: 30000,
      headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed);
        } catch (e) {
          resolve({ ok: false, error_code: res.statusCode, description: 'bad_telegram_response' });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('telegram_timeout')));
    req.on('error', (e) => resolve({ ok: false, error_code: 0, description: `network_error:${e.message}` }));
    req.write(body);
    req.end();
  });
}

// --- Antre kirim global: jarak antar kiriman >= GLOBAL_SPACING_MS. ---
let sendChain = Promise.resolve();
let lastSendAt = 0;

function pacedCall(fn) {
  const run = sendChain.then(async () => {
    const wait = GLOBAL_SPACING_MS - (Date.now() - lastSendAt);
    if (wait > 0) await sleep(wait);
    const result = await fn();
    lastSendAt = Date.now();
    return result;
  });
  // Rantai tidak boleh putus karena satu kiriman gagal.
  sendChain = run.catch(() => {});
  return run;
}

// --- Rate limit per pengirim asal (in-memory; satu instance). ---
// Hanya kiriman yang BERHASIL yang mengisi jendela (gagal tidak menghukum).
const lastTextByUser = new Map();
const lastFileByUser = new Map();

function checkRateLimit(fromId, isFile) {
  const now = Date.now();
  const map = isFile ? lastFileByUser : lastTextByUser;
  const windowMs = isFile ? FILE_WINDOW_MS : TEXT_WINDOW_MS;
  const last = map.get(String(fromId));
  if (last !== undefined && now - last < windowMs) {
    return Math.max(1, Math.ceil((windowMs - (now - last)) / 1000));
  }
  return 0;
}

function markRateLimit(fromId, isFile) {
  const map = isFile ? lastFileByUser : lastTextByUser;
  map.set(String(fromId), Date.now());
}

// Dedup update webhook (in-memory, dibatasi 2000 terakhir).
const seenUpdateIds = new Set();
const seenUpdateOrder = [];
function markUpdateSeen(updateId) {
  if (updateId === undefined || updateId === null) return false;
  const key = String(updateId);
  if (seenUpdateIds.has(key)) return true;
  seenUpdateIds.add(key);
  seenUpdateOrder.push(key);
  while (seenUpdateOrder.length > 2000) {
    const old = seenUpdateOrder.shift();
    seenUpdateIds.delete(old);
  }
  return false;
}

// --- Penanganan update webhook (PERILAKU KERANGKA, dipertahankan). ---
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
    kind: deriveKind(message.from ? message.from.id : null),
  };
  enqueue(entry);
  log({ event: 'queued', chat_id: chatId, message_id: message.message_id });
  return { queued: true, reason: 'trigger_matched' };
}

// --- Endpoint internal /bridge/* (hanya untuk worker, pakai secret). ---
// Secret TIDAK PERNAH di-log. Tanpa BRIDGE_SECRET yang terkonfigurasi,
// semua /bridge/* gagal tertutup (503) — tidak ada jalur tanpa auth.
function checkBridgeAuth(req, res) {
  if (!BRIDGE_SECRET) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bridge_not_configured' }));
    return false;
  }
  const presented = req.headers['x-bridge-secret'];
  if (presented === undefined) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'auth_required' }));
    return false;
  }
  if (presented !== BRIDGE_SECRET) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'auth_forbidden' }));
    return false;
  }
  return true;
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        reject(new Error('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// GET /bridge/pending?since=<ISO>&after_id=<number>
// Mengembalikan antrean tertunda (termasuk TEKS pesan — hanya untuk worker
// terautentikasi; jangan pernah membuka endpoint ini tanpa secret).
// Filter: (received_at > since) ATAU (received_at == since DAN
// message_id > after_id). Tanpa since: seluruh antrean.
function handleBridgePending(req, res, url) {
  const since = url.searchParams.get('since') || '';
  const afterIdRaw = url.searchParams.get('after_id');
  const afterId = afterIdRaw === null ? 0 : Number(afterIdRaw);
  const entries = readQueueEntries()
    .filter((e) => String(e.chat_id) === String(GROUP_CHAT_ID))
    .filter((e) => {
      if (!since) return true;
      const at = String(e.received_at || '');
      if (at > since) return true;
      if (at === since && Number(e.message_id) > afterId) return true;
      return false;
    })
    .sort((a, b) => {
      const at = String(a.received_at || '').localeCompare(String(b.received_at || ''));
      if (at !== 0) return at;
      return Number(a.message_id) - Number(b.message_id);
    })
    .map((e) => ({
      message_id: e.message_id,
      chat_id: e.chat_id,
      from_id: e.from_id ?? null,
      from_username: e.from_username ?? null,
      text: e.text,
      received_at: e.received_at,
      kind: deriveKind(e.from_id ?? null),
    }));
  log({ event: 'bridge_pending', count: entries.length });
  sendJson(res, 200, { ok: true, entries });
}

// POST /bridge/send — kirim SATU balasan atas SATU pesan antrean.
// Body: { reply_to_message_id, chat_id, from_id?, text?,
//         media?: { catalog?: key, url?: string, type?: photo|video|document,
//                   caption?: string } }
// Aturan keras:
//   - chat_id HARUS sama dengan GROUP_CHAT_ID (tidak pernah ke chat lain).
//   - reply_to HARUS pesan antrean yang nyata (bukan kiriman bebas).
//   - Satu balasan per pesan antrean (idempotensi via sent.jsonl).
//   - Media URL HANYA untuk kind=order (Pak/Bowo); anggota hanya katalog.
//   - Rate limit per pengirim asal + jarak kirim global; 429 Telegram
//     dikembalikan ke worker (worker yang menunggu + mencoba lagi).
async function handleBridgeSend(req, res) {
  let body;
  try {
    body = await readBodyJson(req);
  } catch (e) {
    sendJson(res, e.message === 'body_too_large' ? 413 : 400,
      { ok: false, error: e.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' });
    return;
  }

  const replyTo = body.reply_to_message_id;
  if (typeof replyTo !== 'number') {
    sendJson(res, 400, { ok: false, error: 'bad_reply_to' });
    return;
  }
  if (body.chat_id === undefined || String(body.chat_id) !== String(GROUP_CHAT_ID)) {
    sendJson(res, 403, { ok: false, error: 'chat_not_whitelisted' });
    return;
  }
  const hasText = typeof body.text === 'string' && body.text.length > 0;
  const media = body.media && typeof body.media === 'object' ? body.media : null;
  if (hasText === !!media) {
    sendJson(res, 400, { ok: false, error: 'exactly_one_of_text_or_media' });
    return;
  }

  // reply_to HARUS pesan antrean nyata (server percaya antrean, bukan klaim worker).
  const queued = readQueueEntries().find((e) => Number(e.message_id) === replyTo);
  if (!queued) {
    sendJson(res, 400, { ok: false, error: 'unknown_message' });
    return;
  }
  if (body.from_id !== undefined && body.from_id !== null
    && String(body.from_id) !== String(queued.from_id ?? '')) {
    sendJson(res, 400, { ok: false, error: 'from_mismatch' });
    return;
  }
  const fromId = queued.from_id;
  const kind = deriveKind(fromId);

  // Idempotensi: sudah terkirim -> jangan kirim ulang.
  if (isSent(replyTo)) {
    sendJson(res, 200, { ok: true, duplicate: true, sent_message_id: getSentMessageId(replyTo) });
    return;
  }

  const isFile = !!media;
  const retryAfter = checkRateLimit(fromId, isFile);
  if (retryAfter > 0) {
    sendJson(res, 429, { ok: false, error: 'rate_limited', retry_after: retryAfter });
    return;
  }

  // Siapkan kiriman (validasi penuh SEBELUM menyentuh Telegram).
  let method;
  let fields;
  let fileBuffer = null;
  let fileName = '';
  let mediaType = null;
  let logName = '';
  if (hasText) {
    method = 'sendMessage';
    fields = null; // diisi per potongan di bawah
  } else {
    const hasCatalog = typeof media.catalog === 'string' && media.catalog.length > 0;
    const hasUrl = typeof media.url === 'string' && media.url.length > 0;
    if (hasCatalog === hasUrl) {
      sendJson(res, 400, { ok: false, error: 'exactly_one_of_catalog_or_url' });
      return;
    }
    if (hasCatalog) {
      const resolved = resolveCatalogEntry(media.catalog);
      if (!resolved.ok) {
        sendJson(res, 400, { ok: false, error: resolved.error });
        return;
      }
      mediaType = resolved.type;
      method = mediaType === 'photo' ? 'sendPhoto'
        : mediaType === 'video' ? 'sendVideo' : 'sendDocument';
      logName = String(media.catalog).slice(0, 100);
      if (resolved.filePath) {
        try {
          fileBuffer = fs.readFileSync(resolved.filePath);
        } catch (e) {
          sendJson(res, 400, { ok: false, error: 'file_not_found' });
          return;
        }
        fileName = path.basename(resolved.filePath);
      } else {
        fields = { chat_id: GROUP_CHAT_ID };
        fields[mediaType === 'photo' ? 'photo' : mediaType === 'video' ? 'video' : 'document'] = resolved.url;
      }
      const caption = media.caption !== undefined ? media.caption
        : resolved.caption !== undefined ? resolved.caption : `File: ${media.catalog}`;
      if (!fields) fields = { chat_id: GROUP_CHAT_ID };
      fields.caption = truncateToCodePoints(String(caption), CAPTION_LIMIT);
    } else {
      // URL HANYA untuk perintah Pak/Bowo (kind=order). Anggota ditolak.
      if (kind !== 'order') {
        sendJson(res, 403, { ok: false, error: 'member_url_forbidden' });
        return;
      }
      if (!/^https?:\/\//i.test(media.url)) {
        sendJson(res, 400, { ok: false, error: 'bad_url' });
        return;
      }
      if (media.type !== 'photo' && media.type !== 'video' && media.type !== 'document') {
        sendJson(res, 400, { ok: false, error: 'bad_media_type' });
        return;
      }
      mediaType = media.type;
      method = mediaType === 'photo' ? 'sendPhoto'
        : mediaType === 'video' ? 'sendVideo' : 'sendDocument';
      fields = { chat_id: GROUP_CHAT_ID };
      fields[mediaType === 'photo' ? 'photo' : mediaType === 'video' ? 'video' : 'document'] = media.url;
      const caption = media.caption !== undefined ? media.caption : 'File dari Pak/Bowo.';
      fields.caption = truncateToCodePoints(String(caption), CAPTION_LIMIT);
    }
  }

  // Mode dry-run: validasi sudah lolos; catat saja, tanpa Telegram,
  // tanpa merekam kiriman, tanpa mengisi jendela rate limit.
  if (BRIDGE_DRY_RUN) {
    log({
      event: 'bridge_send_dry_run', message_id: replyTo, chat_id: GROUP_CHAT_ID,
      kind: hasText ? 'text' : mediaType, catalog: logName || undefined,
    });
    sendJson(res, 200, { ok: true, dry_run: true });
    return;
  }

  // Kirim lewat antre jarak global. Potongan teks dikirim berurutan.
  try {
    if (hasText) {
      const chunks = splitMessage(body.text);
      let firstId = null;
      for (let i = 0; i < chunks.length; i++) {
        const chunkFields = { chat_id: GROUP_CHAT_ID, text: chunks[i] };
        if (i === 0) {
          chunkFields.reply_to_message_id = replyTo;
          chunkFields.allow_sending_without_reply = true;
        }
        const result = await pacedCall(() => telegramApi('sendMessage', chunkFields, null, ''));
        if (!result.ok) {
          if (result.error_code === 429) {
            const retry = result.parameters && result.parameters.retry_after
              ? Number(result.parameters.retry_after) : 30;
            sendJson(res, 429, { ok: false, error: 'telegram_rate_limited', retry_after: retry });
            return;
          }
          sendJson(res, 502, { ok: false, error: 'telegram_error', description: String(result.description || 'unknown') });
          return;
        }
        if (i === 0) firstId = result.result ? result.result.message_id : null;
      }
      recordSent(replyTo, firstId, 'text');
      markRateLimit(fromId, false);
      log({ event: 'bridge_sent', message_id: replyTo, chat_id: GROUP_CHAT_ID, kind: 'text', chunks: chunks.length });
      sendJson(res, 200, { ok: true, sent_message_id: firstId, chunks: chunks.length, type: 'text' });
      return;
    }

    const sendFields = { ...fields };
    sendFields.reply_to_message_id = replyTo;
    sendFields.allow_sending_without_reply = true;
    const result = await pacedCall(() => telegramApi(method, sendFields, fileBuffer, fileName));
    if (!result.ok) {
      if (result.error_code === 429) {
        const retry = result.parameters && result.parameters.retry_after
          ? Number(result.parameters.retry_after) : 30;
        sendJson(res, 429, { ok: false, error: 'telegram_rate_limited', retry_after: retry });
        return;
      }
      sendJson(res, 502, { ok: false, error: 'telegram_error', description: String(result.description || 'unknown') });
      return;
    }
    const sentId = result.result ? result.result.message_id : null;
    recordSent(replyTo, sentId, mediaType);
    markRateLimit(fromId, true);
    log({
      event: 'bridge_sent', message_id: replyTo, chat_id: GROUP_CHAT_ID,
      kind: mediaType, catalog: logName || undefined,
    });
    sendJson(res, 200, { ok: true, sent_message_id: sentId, type: mediaType });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: 'send_failed', description: String(e.message) });
  }
}

// Pencatatan sent_message_id untuk balasan duplikat.
function getSentMessageId(messageId) {
  if (sentMessageById.has(String(messageId))) return sentMessageById.get(String(messageId));
  // Muat dari file bila belum ada di memori (proses baru).
  try {
    if (fs.existsSync(SENT_FILE)) {
      for (const line of fs.readFileSync(SENT_FILE, 'utf8').split('\n').filter(Boolean)) {
        try {
          const rec = JSON.parse(line);
          if (String(rec.message_id) === String(messageId)) {
            sentMessageById.set(String(messageId), rec.sent_message_id ?? null);
            return rec.sent_message_id ?? null;
          }
        } catch (e) { /* lewati */ }
      }
    }
  } catch (e) { /* abaikan */ }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // GET /health: publik, tanpa nilai rahasia. HEAD dilayani 200 tanpa body.
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? '' : JSON.stringify({
      ok: true,
      mode: BOT_TOKEN ? 'ready_for_webhook_setup' : 'local_test_only',
      webhook_configured: Boolean(WEBHOOK_SECRET),
      group_configured: Boolean(GROUP_CHAT_ID),
      bridge_configured: Boolean(BRIDGE_SECRET),
      owner_configured: Boolean(OWNER_USER_ID),
      catalog_count: catalogCount(),
      test_mode: BRIDGE_DRY_RUN || BRIDGE_FAKE_TELEGRAM,
    }));
    return;
  }

  // Endpoint internal worker (butuh BRIDGE_SECRET).
  if (req.method === 'GET' && url.pathname === '/bridge/pending') {
    if (!checkBridgeAuth(req, res)) return;
    handleBridgePending(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/bridge/send') {
    if (!checkBridgeAuth(req, res)) return;
    handleBridgeSend(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === webhookPath()) {
    // Bila Telegram mengirim secret_token dan kita punya secret, harus cocok.
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
      if (body.length > BODY_LIMIT) req.destroy();
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
      // Dedup update_id: update yang sama (Telegram mengulang kirim)
      // tidak diproses dua kali.
      if (markUpdateSeen(update.update_id)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queued: false, reason: 'duplicate_update' }));
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

if (require.main === module) {
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
      bridge_configured: Boolean(BRIDGE_SECRET),
      owner_configured: Boolean(OWNER_USER_ID),
      test_mode: BRIDGE_DRY_RUN || BRIDGE_FAKE_TELEGRAM,
      note: BRIDGE_SECRET ? 'bridge_ready' : 'bridge_disabled_no_secret',
    });
  });
} else {
  // Diekspor untuk tes unit (tanpa menjalankan server).
  module.exports = {
    splitMessage,
    truncateToCodePoints,
    deriveKind,
    resolveCatalogEntry,
    loadCatalog,
    TRIGGER_RE,
  };
}
