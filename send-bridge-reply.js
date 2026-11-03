// Pengirim balasan agent loop ke grup Telegram / chat pribadi pemilik
// lewat /bridge/send.
// Dipakai HANYA oleh agent loop Bowo (hook realtime). Skrip ini BUKAN
// Bowo yang berpikir — ia hanya mengantar jawaban yang sudah disusun
// agent loop, lewat server Render yang memegang token Telegram.
//
// KEAMANAN (keras):
// - Secret dibaca dari env BRIDGE_SECRET bila sudah di-set, atau dari
//   file EnvironmentFile ~/.config/bowo-bridge/bridge.env (di luar repo,
//   mode 0600). Skrip TIDAK PERNAH mencetak nilai secret, isi file itu,
//   atau isi jawaban ke log selain status kirim (ok / error).
// - JANGAN PERNAH menampilkan file bridge.env dengan cat/echo, JANGAN
//   menempelkan secret ke chat, argumen, atau repo.
// - Server yang memvalidasi keras: chat_id harus sama dengan chat entri
//   antrean (grup whitelist ATAU chat pribadi pemilik), reply_to
//   harus pesan antrean nyata, satu balasan per pesan (duplikat
//   dikembalikan ok+duplicate, bukan kiriman ganda).
//
// Pakai:
//   node send-bridge-reply.js --answer /tmp/bowo-bridge-answer-<id>.json
// Isi answer JSON: {"reply_to_message_id":123,"chat_id":-100...,"text":"..."}
// ATAU (kirim file, 2026-11-03 atas penegasan Pak "kamu bisa juga kirim
// file apapun di grup itu"): {"reply_to_message_id":123,"chat_id":-100...,
// "media":{"catalog":"nama"}} atau {"media":{"url":"https://...",
// "type":"photo"|"video"|"document","caption":"..."}}.
// Aturan server (keras): tepat SATU dari teks/media; media katalog untuk
// balasan siapa pun; media URL HANYA sebagai balasan pesan Pak/Bowo
// (server menolak URL untuk pesan anggota); file selalu balasan pesan
// antrean nyata, tidak pernah kiriman lepas.
//
// Keluar: 0 = terkirim atau duplikat (sudah terkirim sebelumnya, anggap
// selesai, jangan kirim ulang); 2 = auth/konfigurasi (secret belum di-set
// atau bridge belum di-deploy — gagal tertutup, JANGAN tandai terjawab,
// ulangi di putaran berikutnya); 3 = rate limit (429 — jangan tandai
// terjawab, ulangi nanti); 1 = error lain (jangan tandai terjawab,
// kecuali server menjawab duplicate).
// Variabel tes lokal: BRIDGE_SERVER_URL boleh diarahkan ke server lokal.

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const os = require('os');
const path = require('path');

function fail(code, error) {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(code);
}

function readSecret() {
  if (process.env.BRIDGE_SECRET) return process.env.BRIDGE_SECRET;
  const envPath = path.join(os.homedir(), '.config', 'bowo-bridge', 'bridge.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === 'BRIDGE_SECRET' && value) return value;
    }
  } catch (e) { /* file belum ada -> gagal tertutup di bawah */ }
  return '';
}

// --- Proxy egress (2026-11-03, sama seperti worker.js): VM ini hanya
// keluar lewat proxy HTTP berautentikasi (env HTTPS_PROXY). https.request
// mentah gagal TLS ("wrong version number") karena koneksi langsung
// dicegat — jadi untuk target https: CONNECT ke proxy dulu, lalu TLS di
// atas terowongan. NO_PROXY dihormati. Nilai proxy dibaca dari env saat
// jalan, tidak pernah ditulis di file repo. ---
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

function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--answer');
  if (idx < 0 || !args[idx + 1]) {
    console.log(JSON.stringify({ ok: false, error: 'usage: --answer <file.json>' }));
    process.exit(1);
  }
  let answer;
  try {
    answer = JSON.parse(fs.readFileSync(args[idx + 1], 'utf8'));
  } catch (e) {
    fail(1, 'bad_answer_file');
  }
  const hasText = typeof answer.text === 'string' && answer.text.length > 0;
  const media = answer.media && typeof answer.media === 'object' ? answer.media : null;
  if (typeof answer.reply_to_message_id !== 'number'
    || answer.chat_id === undefined
    || hasText === !!media) {
    fail(1, 'bad_answer_shape');
  }
  if (media) {
    const hasCatalog = typeof media.catalog === 'string' && media.catalog.length > 0;
    const hasUrl = typeof media.url === 'string' && media.url.length > 0;
    if (hasCatalog === hasUrl) fail(1, 'bad_answer_shape');
    if (hasUrl && media.type !== 'photo' && media.type !== 'video' && media.type !== 'document') {
      fail(1, 'bad_answer_shape');
    }
    if (media.caption !== undefined && typeof media.caption !== 'string') fail(1, 'bad_answer_shape');
  }
  const secret = readSecret();
  if (!secret) fail(2, 'bridge_secret_missing');

  const serverUrl = (process.env.BRIDGE_SERVER_URL || 'https://bot-grup-inti-nusara.onrender.com').replace(/\/$/, '');
  const bodyObj = {
    reply_to_message_id: answer.reply_to_message_id,
    chat_id: answer.chat_id,
  };
  if (hasText) bodyObj.text = answer.text;
  if (media) bodyObj.media = media;
  const data = JSON.stringify(bodyObj);
  const url = new URL(`${serverUrl}/bridge/send`);
  const sendReq = (extraOpts, tlsSocket) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      timeout: 60000,
      ...(extraOpts || {}),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-bridge-secret': secret,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* biarkan null */ }
        if (res.statusCode === 200 && parsed && parsed.ok) {
          // Duplikat = sudah terkirim sebelumnya: anggap selesai, jangan ulang.
          console.log(JSON.stringify({
            ok: true,
            duplicate: !!parsed.duplicate,
            sent_message_id: parsed.sent_message_id ?? null,
          }));
          process.exit(0);
        }
        if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 503) {
          fail(2, (parsed && parsed.error) || 'bridge_auth_or_not_configured');
        }
        if (res.statusCode === 429) fail(3, 'rate_limited');
        fail(1, (parsed && parsed.error) || 'send_failed');
      });
    });
    req.on('timeout', () => {
      try { if (tlsSocket) tlsSocket.destroy(); } catch (e) { /* abaikan */ }
      req.destroy(new Error('timeout'));
    });
    req.on('error', () => fail(1, 'send_failed'));
    req.write(data);
    req.end();
  };
  const proxy = url.protocol === 'https:' ? proxyUrlFor(url.hostname) : null;
  if (proxy) {
    connectTlsViaProxy(url.hostname, Number(url.port) || 443, proxy).then(
      (tlsSocket) => sendReq({ createConnection: () => tlsSocket, servername: url.hostname }, tlsSocket),
      () => fail(1, 'send_failed'),
    );
  } else {
    sendReq();
  }
}

if (require.main === module) main();
