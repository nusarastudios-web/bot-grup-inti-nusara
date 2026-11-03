// Worker jembatan jawaban bot Telegram grup inti — Opsi B (worker Bowo).
// Proses jalan terus di VM Bowo (BUKAN di Render; Render hanya menjalankan
// server.js). Worker mengecek antrean server tiap interval, menyusun balasan
// sebagai Bowo, lalu mengirimnya lewat endpoint internal server.
//
// ALUR: GET /bridge/pending (pakai BRIDGE_SECRET) -> susun balasan per pesan
// -> POST /bridge/send (balasan selalu reply_to pesan antrean nyata) ->
// majukan penanda (mark) + simpan state. Satu balasan per pesan antrean.
//
// WIRING PENUH (final, 3 Nov 2026): skrip ini BUKAN Bowo yang berpikir.
// Yang dikerjakan skrip sampai tuntas dan INSTAN: sapaan, permintaan file
// katalog, perintah URL Pak/Bowo. Pertanyaan substantif TIDAK dijawab
// skrip — ia DI-DEFER ke agent loop Bowo (hook realtime 10 detik yang
// membaca file follow-up, menyusun jawaban penuh sebagai Bowo, lalu
// mengirimnya lewat send-bridge-reply.js + /bridge/send). Mode defer ini
// default AKTIF (BRIDGE_DEFER_SUBSTANTIVE=1); set '0' hanya untuk tes
// mode fallback lama (fallback jujur langsung, tanpa agent loop).
// Skrip ini TIDAK PERNAH mengarang jawaban. Prinsip: lebih baik defer +
// holding jujur daripada jawaban karangan.
// ATURAN HOLDING SPAM (perintah Pak 3 Nov 2026): penyebutan substantif
// ke-2 dari pengirim yang sama selagi pertanyaan pertamanya masih
// tertunda OTOMATIS dibalas teks persis "sabar sebentar ya.. bowo lagi
// mikir" (balasan atas pesan ke-2 itu; slot balasan pesan ke-2 terpakai,
// jadi agent loop TIDAK mengirim jawaban penuh lagi untuk pesan ke-2,
// melainkan menjawab pesan ke-1). Sesudah holding terkirim, tidak ada
// holding ulang untuk pengirim itu sampai agent loop menjawab salah
// satu pertanyaan tertundanya (penanda dihapus saat itu).
//
// Env (NAMA saja — nilai TIDAK PERNAH ditulis di kode/repo/chat):
//   BRIDGE_SERVER_URL   (default URL Render service; tes lokal menimpa ke localhost)
//   BRIDGE_SECRET       (WAJIB; secret bersama server. Tanpa ini worker
//                         berhenti gagal tertutup (exit 3) — tidak mengirim apa pun.
//                         Nilai diinjeksikan saat setup lewat EnvironmentFile
//                         systemd (di luar repo), BUKAN ditulis di repo.)
//   BRIDGE_POLL_MS      (default 15000; interval cek antrean, 10-30 detik)
//   BRIDGE_STATE_FILE   (default ./worker-state.json; penanda + waktu aktivasi)
//   BRIDGE_FOLLOWUP_FILE (default ./worker-needs-followup.jsonl; pesan yang
//                         perlu dijawab Bowo menyusul — VM-lokal, gitignored,
//                         TIDAK PERNAH di-upload ke repo)
//
// Log worker: HANYA metadata (message_id, kind, hasil) — TIDAK PERNAH isi
// pesan, URL, atau caption. File follow-up memang berisi teks pesan (seperti
// antrean) agar Bowo bisa menindaklanjuti — file itu VM-lokal saja.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const SERVER_URL = (process.env.BRIDGE_SERVER_URL || 'https://bot-grup-inti-nusara.onrender.com').replace(/\/$/, '');
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const POLL_MS = Number(process.env.BRIDGE_POLL_MS || 15000);
const STATE_FILE = process.env.BRIDGE_STATE_FILE || path.join(__dirname, 'worker-state.json');
const FOLLOWUP_FILE = process.env.BRIDGE_FOLLOWUP_FILE || path.join(__dirname, 'worker-needs-followup.jsonl');
const PROCESSED_FILE = process.env.BRIDGE_PROCESSED_FILE || path.join(__dirname, 'agent-loop-processed.jsonl');
// Defer substantif default AKTIF (wiring penuh). '0' = mode fallback lama.
const DEFER_SUBSTANTIVE = process.env.BRIDGE_DEFER_SUBSTANTIVE !== '0';

const TRIGGER_RE = /\bBowo\b/i;
const FALLBACK_TEXT = 'Maaf, saya belum bisa menjawab itu sekarang — Bowo akan menjawab menyusul.';
// Teks holding spam — PERSIS perintah Pak (huruf kecil, titik ganda).
const HOLDING_TEXT = 'sabar sebentar ya.. bowo lagi mikir';
const TOO_LARGE_TEXT = 'Maaf, file itu melebihi batas 50 MB, jadi belum bisa dikirim.';
const ITEM_GAP_MS = 300;
const AUTH_BACKOFF_MS = 60000;
const SEND_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = 10000;

function log(obj) {
  // Metadata saja — jangan pernah memasukkan teks pesan / URL / caption.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Proxy egress (2026-11-03): VM ini hanya keluar lewat proxy HTTP
// berautentikasi (env HTTPS_PROXY). curl memakainya otomatis, https.request
// mentah tidak — koneksi langsung dicegat dan gagal TLS ("wrong version
// number"). Untuk target https: CONNECT ke proxy dulu, lalu TLS di atas
// terowongan. NO_PROXY dihormati (localhost/dll langsung). Nilai proxy
// dibaca dari env saat jalan, tidak pernah ditulis di file repo. ---
function proxyUrlFor(hostname) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return null;
  const host = hostname.toLowerCase();
  const rules = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const rule of rules) {
    if (rule === '*') return null;
    const r = rule.startsWith('.') ? rule.slice(1) : rule;
    if (host === r || host.endsWith(`.${r}`)) return null;
  }
  try {
    return new URL(raw);
  } catch (e) {
    return null;
  }
}

function connectTlsViaProxy(targetHost, targetPort, proxyUrl) {
  return new Promise((resolve, reject) => {
    const proxySocket = net.connect(Number(proxyUrl.port) || 80, proxyUrl.hostname, () => {
      let auth = '';
      if (proxyUrl.username || proxyUrl.password) {
        auth = `Proxy-Authorization: Basic ${Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
        ).toString('base64')}\r\n`;
      }
      proxySocket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`,
      );
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      proxySocket.removeListener('data', onData);
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      const code = Number(statusLine.split(' ')[1] || '0');
      if (code !== 200) {
        proxySocket.destroy();
        reject(new Error(`proxy_connect_status_${code}`));
        return;
      }
      const tlsSocket = tls.connect({ socket: proxySocket, servername: targetHost });
      tlsSocket.once('secureConnect', () => resolve(tlsSocket));
      tlsSocket.once('error', reject);
    };
    proxySocket.on('data', onData);
    proxySocket.on('error', reject);
  });
}

function httpJson(method, urlString, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(e);
      return;
    }
    const data = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const startRequest = (extraOpts, tlsSocket) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        timeout: timeoutMs,
        ...(extraOpts || {}),
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (e) { /* biarkan null */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => {
        try { if (tlsSocket) tlsSocket.destroy(); } catch (e) { /* abaikan */ }
        req.destroy(new Error('timeout'));
      });
      req.on('error', (e) => {
        try { if (tlsSocket) tlsSocket.destroy(); } catch (e2) { /* abaikan */ }
        reject(e);
      });
      if (data) req.write(data);
      req.end();
    };
    // Target https lewat proxy egress VM (curl bisa, https mentah tidak):
    // bangun terowongan CONNECT dulu, lalu TLS di atasnya.
    const proxy = url.protocol === 'https:' ? proxyUrlFor(url.hostname) : null;
    if (proxy) {
      connectTlsViaProxy(url.hostname, Number(url.port) || 443, proxy).then(
        (tlsSocket) => startRequest({ createConnection: () => tlsSocket, servername: url.hostname }, tlsSocket),
        reject,
      );
    } else {
      startRequest();
    }
  });
}

// --- State worker: waktu aktivasi (cutoff tunggakan) + penanda terakhir. ---
// Aturan tunggakan: entri antrean SEBELUM activated_at = riwayat, tidak
// dijawab. Penanda awal = sekarang, sehingga worker baru TIDAK menguras
// antrean lama (3 pesan tes) — hanya pesan baru sesudah jembatan aktif.
function defaultState() {
  const now = new Date().toISOString();
  return { activated_at: now, last_received_at: now, last_message_id: 0, updated_at: now, hold: {} };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (typeof data.activated_at !== 'string' || typeof data.last_received_at !== 'string'
      || typeof data.last_message_id !== 'number') {
      throw new Error('bad_state_shape');
    }
    if (!data.hold || typeof data.hold !== 'object' || Array.isArray(data.hold)) data.hold = {};
    return data;
  } catch (e) {
    // State rusak: selamatkan salinannya, mulai segar (penanda = sekarang).
    try {
      if (fs.existsSync(STATE_FILE)) {
        fs.renameSync(STATE_FILE, `${STATE_FILE}.corrupt`);
      }
    } catch (e2) { /* abaikan */ }
    log({ event: 'state_corrupt_recovered', file: path.basename(STATE_FILE) });
    return defaultState();
  }
}

function saveState(state) {
  state.updated_at = new Date().toISOString();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function appendFollowup(entry, reason, extra) {
  const rec = {
    at: new Date().toISOString(),
    message_id: entry.message_id ?? null,
    chat_id: entry.chat_id ?? null,
    from_id: entry.from_id ?? null,
    from_username: entry.from_username ?? null,
    kind: entry.kind ?? null,
    text: entry.text ?? null,
    ...(entry.media ? { media: entry.media } : {}),
    reason,
    ...(extra || {}),
  };
  fs.appendFileSync(FOLLOWUP_FILE, JSON.stringify(rec) + '\n', 'utf8');
}

// --- Wiring penuh: defer + holding spam (fungsi murni, bisa diuji). ---
function shouldDefer(reply) {
  return !!reply && reply.followup === true && DEFER_SUBSTANTIVE;
}

// Holding dikirim tepat saat hitungan defer pengirim mencapai 2 dan
// holding belum pernah terkirim untuk siklus tertunda ini.
function holdingShouldSend(deferredCount, holdingSent) {
  return deferredCount >= 2 && !holdingSent;
}

// Baca message_id yang sudah diproses agent loop (answered / duplicate /
// superseded). File ini ditulis agent loop, bukan worker — worker hanya
// membaca untuk mereset siklus holding pengirim yang sudah dijawab.
function readProcessedIds() {
  const ids = new Set();
  try {
    if (!fs.existsSync(PROCESSED_FILE)) return ids;
    for (const line of fs.readFileSync(PROCESSED_FILE, 'utf8').split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.message_id === 'number') ids.add(rec.message_id);
      } catch (e) { /* lewati baris rusak */ }
    }
  } catch (e) { /* abaikan */ }
  return ids;
}

// Hapus id tertunda yang sudah dijawab agent loop; bila tidak ada lagi
// id tertunda untuk pengirim itu, hapus seluruh siklus holding-nya
// (pertanyaan berikutnya mulai siklus baru dan boleh holding lagi).
function refreshHold(state, processedIds) {
  if (!state.hold) state.hold = {};
  for (const senderKey of Object.keys(state.hold)) {
    const hold = state.hold[senderKey];
    if (!hold || !Array.isArray(hold.deferred_ids)) { delete state.hold[senderKey]; continue; }
    hold.deferred_ids = hold.deferred_ids.filter((id) => !processedIds.has(id));
    if (hold.deferred_ids.length === 0) delete state.hold[senderKey];
    else state.hold[senderKey] = hold;
  }
}

// --- Komposer balasan (fungsi murni — bisa diuji tanpa jaringan). ---
// Masukan: entri antrean { message_id, chat_id, from_id, text, kind }.
// Keluaran: { action: 'text', text, followup? } atau
//           { action: 'media', media: { catalog } | { url, type } }.
// Aturan: sapaan -> balasan hangat; permintaan file -> katalog/URL;
// katalog tak ditemukan -> DEFER ke agen (Bowo jawab langsung, tanpa
// teks "tidak ada di katalog" — perintah Pak 3 Nov 13:39, mode tanpa
// katalog); pertanyaan lain -> fallback jujur + followup.
// TIDAK ADA jawaban karangan untuk hal yang tidak diketahui skrip.
function parseRemainder(text) {
  const withoutTrigger = String(text).replace(new RegExp(TRIGGER_RE, 'gi'), ' ');
  return withoutTrigger.replace(/^[\s,;:!\-]+/, '').replace(/\s+/g, ' ').trim();
}

function matchGreeting(remainder) {
  const r = remainder.toLowerCase();
  if (/^(selamat pagi|pagi)[\s!.,?]*$/.test(r)) return 'Selamat pagi! Ada yang bisa Bowo bantu?';
  if (/^(selamat siang|siang)[\s!.,?]*$/.test(r)) return 'Selamat siang! Ada yang bisa Bowo bantu?';
  if (/^(selamat sore|sore)[\s!.,?]*$/.test(r)) return 'Selamat sore! Ada yang bisa Bowo bantu?';
  if (/^(selamat malam|malam)[\s!.,?]*$/.test(r)) return 'Selamat malam! Ada yang bisa Bowo bantu?';
  if (/^(halo|hai|hi|hello|hey|assalamualaikum|selamat datang)[\s!.,?]*$/.test(r)) {
    return 'Halo! Ada yang bisa Bowo bantu?';
  }
  if (/^(terima kasih|makasih|thanks|thank you)[\s!.,?]*$/.test(r)) {
    return 'Sama-sama! Senang bisa membantu.';
  }
  return null;
}

function guessMediaType(url) {
  const clean = String(url).split(/[?#]/)[0].toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif)$/.test(clean)) return 'photo';
  if (/\.(mp4|mov|webm)$/.test(clean)) return 'video';
  return 'document';
}

function notFoundText(name) {
  const shown = String(name).slice(0, 100);
  return `Maaf, file "${shown}" tidak ada di katalog.`;
}

function composeReply(entry) {
  const remainder = parseRemainder(entry.text || '');
  if (!remainder) {
    return { action: 'text', text: 'Halo! Ada yang bisa Bowo bantu?' };
  }
  // Permintaan/perintah file: "kirim <nama>" / "minta <nama>".
  const fileMatch = remainder.match(/^(kirim|minta)\s+(.+)$/i);
  if (fileMatch) {
    const rawName = fileMatch[2].trim().replace(/[.,!?]+$/, '').trim();
    if (!rawName) {
      return { action: 'text', text: 'Maaf, file apa yang dimaksud? Sebutkan namanya ya.' };
    }
    if (/^https?:\/\//i.test(rawName)) {
      // URL HANYA untuk perintah Pak/Bowo (kind=order). Anggota -> "tidak ada".
      if (entry.kind === 'order') {
        return { action: 'media', media: { url: rawName, type: guessMediaType(rawName) } };
      }
      return { action: 'text', text: notFoundText(rawName) };
    }
    // Nama katalog: server yang mencocokkan (case-insensitive).
    return { action: 'media', media: { catalog: rawName } };
  }
  const greeting = matchGreeting(remainder);
  if (greeting) {
    return { action: 'text', text: greeting };
  }
  // Pertanyaan lain: fallback jujur + flag tindak lanjut untuk Bowo.
  return { action: 'text', text: FALLBACK_TEXT, followup: true, followupReason: 'needs_bowo_answer' };
}

// --- Pengiriman lewat server (satu balasan per pesan antrean). ---
// Prinsip realtime: bila server menjawab 429 (rate limit), worker TIDAK
// menunggu di tempat — ia melewati pesan itu diam-diam dan lanjut ke pesan
// berikutnya (pengirim bisa mengirim ulang). Menunggu 10 detik di tengah
// antrean akan memblokir balasan orang lain, termasuk perintah Pak/Bowo.
async function bridgeSend(entry, text, media) {
  const body = {
    reply_to_message_id: entry.message_id,
    chat_id: entry.chat_id,
    from_id: entry.from_id ?? null,
  };
  if (text !== undefined) body.text = text;
  if (media !== undefined) body.media = media;
  const res = await httpJson('POST', `${SERVER_URL}/bridge/send`,
    { 'x-bridge-secret': BRIDGE_SECRET }, body, SEND_TIMEOUT_MS);
  return res;
}

// Proses SATU entri antrean sampai tuntas (selalu memajukan penanda,
// supaya antrean tidak macet — kegagalan dicatat ke follow-up, bukan diulang
// tanpa henti). Mengembalikan 'sent' | 'duplicate' | 'rate_limited_skip'.
async function processEntry(entry, state) {
  const reply = composeReply(entry);
  let res;
  if (reply.action === 'media') {
    res = await bridgeSend(entry, undefined, reply.media);
    if (res.status === 200 && res.body && res.body.ok) {
      log({ event: 'reply_sent', message_id: entry.message_id, kind: entry.kind, outcome: 'media' });
      return 'sent';
    }
    if (res.status === 429) {
      log({ event: 'reply_rate_limited_skip', message_id: entry.message_id, kind: entry.kind });
      return 'rate_limited_skip';
    }
    // Media gagal: ganti dengan teks jujur (kiriman gagal TIDAK memakai
    // slot balasan, jadi teks pengganti masih diizinkan server).
    // PENGECUALIAN (perintah Pak 3 Nov 13:39, mode tanpa katalog):
    // catalog_not_found TIDAK dijawab teks "tidak ada di katalog" —
    // permintaan diteruskan ke agent loop (Bowo) supaya Bowo sendiri
    // yang menjawab langsung dengan file-nya (slot balasan tetap bebas
    // untuk kiriman agen nanti).
    const err = res.body && res.body.error;
    if (err === 'catalog_not_found') {
      appendFollowup(entry, 'needs_bowo_media', { requested: (reply.media && reply.media.catalog) || null });
      log({ event: 'reply_deferred_agent_loop', message_id: entry.message_id, kind: entry.kind, reason: 'catalog_not_found' });
      return 'sent';
    }
    let fallbackText;
    if (err === 'file_too_large') {
      fallbackText = TOO_LARGE_TEXT;
    } else if (err === 'member_url_forbidden') {
      fallbackText = notFoundText(reply.media.url || '');
    } else {
      fallbackText = FALLBACK_TEXT;
    }
    const res2 = await bridgeSend(entry, fallbackText, undefined);
    if (res2.status === 200 && res2.body && res2.body.ok) {
      log({ event: 'reply_sent', message_id: entry.message_id, kind: entry.kind, outcome: 'media_failed_text_fallback' });
    } else {
      appendFollowup(entry, `media_send_failed:${err || 'unknown'}`);
      log({ event: 'reply_failed_followup', message_id: entry.message_id, kind: entry.kind, error: err || 'unknown' });
    }
    return 'sent';
  }

  // WIRING PENUH: pertanyaan substantif di-defer ke agent loop (hook
  // realtime), BUKAN dikirim fallback langsung. Slot balasan server
  // untuk pesan ini TIDAK terpakai, sehingga agent loop bisa menjawab
  // penuh lewat /bridge/send nanti. Pengecualian: mode fallback lama
  // (BRIDGE_DEFER_SUBSTANTIVE=0) tetap mengirim fallback seperti dulu.
  if (reply.followup && shouldDefer(reply)) {
    const senderKey = (entry.from_id !== null && entry.from_id !== undefined && entry.from_id !== '')
      ? String(entry.from_id) : null;
    let sendHolding = false;
    if (senderKey) {
      refreshHold(state, readProcessedIds());
      if (!state.hold) state.hold = {};
      const hold = state.hold[senderKey] || { deferred_ids: [], holding_sent: false };
      if (!Array.isArray(hold.deferred_ids)) hold.deferred_ids = [];
      if (!hold.deferred_ids.includes(entry.message_id)) hold.deferred_ids.push(entry.message_id);
      sendHolding = holdingShouldSend(hold.deferred_ids.length, !!hold.holding_sent);
      state.hold[senderKey] = hold;
      saveState(state);
    }
    if (sendHolding) {
      // Holding atas pesan ke-2: slot balasan pesan ini terpakai oleh
      // holding, jadi agent loop wajib melewati pesan ini sebagai
      // target jawaban penuh (lihat agent-loop-instructions.md).
      const hRes = await bridgeSend(entry, HOLDING_TEXT, undefined);
      if (hRes.status === 200 && hRes.body && hRes.body.ok) {
        state.hold[senderKey].holding_sent = true;
        saveState(state);
        appendFollowup(entry, 'needs_bowo_answer', { holding_sent: true });
        log({ event: 'reply_holding_sent', message_id: entry.message_id, kind: entry.kind });
      } else if (hRes.status === 429) {
        log({ event: 'reply_holding_rate_limited_skip', message_id: entry.message_id, kind: entry.kind });
        appendFollowup(entry, 'needs_bowo_answer');
      } else {
        appendFollowup(entry, 'needs_bowo_answer');
        log({ event: 'reply_holding_failed_followup', message_id: entry.message_id, kind: entry.kind, error: (hRes.body && hRes.body.error) || 'unknown' });
      }
    } else {
      appendFollowup(entry, 'needs_bowo_answer');
      log({ event: 'reply_deferred_agent_loop', message_id: entry.message_id, kind: entry.kind });
    }
    return 'sent';
  }

  // Balasan teks (sapaan / fallback / "tidak ada").
  res = await bridgeSend(entry, reply.text, undefined);
  if (res.status === 200 && res.body && res.body.ok) {
    if (reply.followup) {
      appendFollowup(entry, reply.followupReason || 'needs_bowo_answer');
    }
    log({ event: 'reply_sent', message_id: entry.message_id, kind: entry.kind, outcome: reply.followup ? 'text_fallback' : 'text' });
    return 'sent';
  }
  if (res.status === 429) {
    log({ event: 'reply_rate_limited_skip', message_id: entry.message_id, kind: entry.kind });
    return 'rate_limited_skip';
  }
  appendFollowup(entry, `text_send_failed:${(res.body && res.body.error) || 'unknown'}`);
  log({ event: 'reply_failed_followup', message_id: entry.message_id, kind: entry.kind, error: (res.body && res.body.error) || 'unknown' });
  return 'sent';
}

async function pollOnce(state) {
  const qs = `since=${encodeURIComponent(state.last_received_at)}&after_id=${state.last_message_id}`;
  const res = await httpJson('GET', `${SERVER_URL}/bridge/pending?${qs}`,
    { 'x-bridge-secret': BRIDGE_SECRET }, undefined, FETCH_TIMEOUT_MS);
  if (res.status === 401 || res.status === 403) {
    log({ event: 'poll_auth_error', status: res.status });
    return 'auth_error';
  }
  if (res.status !== 200 || !res.body || !res.body.ok || !Array.isArray(res.body.entries)) {
    log({ event: 'poll_error', status: res.status, error: (res.body && res.body.error) || 'bad_response' });
    return 'error';
  }
  const entries = res.body.entries;
  if (entries.length > 0) {
    log({ event: 'pending', count: entries.length });
  }
  for (const entry of entries) {
    try {
      await processEntry(entry, state);
    } catch (e) {
      // Satu entri gagal total (di luar jalur kirim): catat + majukan,
      // supaya antrean tidak macet selamanya.
      appendFollowup(entry, `process_exception:${e.message}`);
      log({ event: 'reply_failed_followup', message_id: entry.message_id, kind: entry.kind, error: 'process_exception' });
    }
    // Majukan penanda SESUDAH tiap entri (bukan sesudah batch) supaya
    // crash di tengah batch tidak mengulang entri yang sudah terkirim
    // (server juga idempotent via sent.jsonl sebagai jaring kedua).
    state.last_received_at = entry.received_at;
    state.last_message_id = entry.message_id;
    saveState(state);
    await sleep(ITEM_GAP_MS);
  }
  return 'ok';
}

async function main() {
  if (!BRIDGE_SECRET) {
    console.error('BRIDGE_SECRET belum di-set — worker berhenti gagal tertutup (tidak mengirim apa pun).');
    process.exit(3);
  }
  const state = loadState();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try { saveState(state); } catch (e) { /* abaikan */ }
    log({ event: 'worker_stopping' });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  // Cek kesehatan server saat start (metadata saja, tanpa auth).
  try {
    const health = await httpJson('GET', `${SERVER_URL}/health`, {}, undefined, FETCH_TIMEOUT_MS);
    log({
      event: 'worker_started',
      server_status: health.status,
      bridge_configured: health.body ? !!health.body.bridge_configured : false,
      test_mode: health.body ? !!health.body.test_mode : false,
      poll_ms: POLL_MS,
    });
  } catch (e) {
    log({ event: 'worker_started', server_status: 'unreachable', poll_ms: POLL_MS });
  }

  let authBackoff = false;
  while (!stopping) {
    try {
      const result = await pollOnce(state);
      authBackoff = result === 'auth_error';
    } catch (e) {
      log({ event: 'poll_exception', error: String(e.message) });
      authBackoff = false;
    }
    await sleep(authBackoff ? AUTH_BACKOFF_MS : POLL_MS);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Worker fatal:', e);
    process.exit(1);
  });
} else {
  // Diekspor untuk tes unit (tanpa menjalankan loop).
  module.exports = {
    parseRemainder,
    matchGreeting,
    guessMediaType,
    composeReply,
    shouldDefer,
    holdingShouldSend,
    FALLBACK_TEXT,
    HOLDING_TEXT,
    TRIGGER_RE,
  };
}
