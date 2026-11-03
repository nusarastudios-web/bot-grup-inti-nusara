// Pengirim balasan agent loop ke grup Telegram lewat /bridge/send.
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
// - Server yang memvalidasi keras: chat_id harus grup whitelist, reply_to
//   harus pesan antrean nyata, satu balasan per pesan (duplikat
//   dikembalikan ok+duplicate, bukan kiriman ganda).
//
// Pakai:
//   node send-bridge-reply.js --answer /tmp/bowo-bridge-answer-<id>.json
// Isi answer JSON: {"reply_to_message_id":123,"chat_id":-100...,"text":"..."}
// (text saja; kirim file tetap jalur worker instan, bukan skrip ini.)
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
  if (typeof answer.reply_to_message_id !== 'number'
    || answer.chat_id === undefined
    || typeof answer.text !== 'string' || answer.text.length === 0) {
    fail(1, 'bad_answer_shape');
  }
  const secret = readSecret();
  if (!secret) fail(2, 'bridge_secret_missing');

  const serverUrl = (process.env.BRIDGE_SERVER_URL || 'https://bot-grup-inti-nusara.onrender.com').replace(/\/$/, '');
  const body = JSON.stringify({
    reply_to_message_id: answer.reply_to_message_id,
    chat_id: answer.chat_id,
    text: answer.text,
  });
  const url = new URL(`${serverUrl}/bridge/send`);
  const lib = url.protocol === 'https:' ? https : http;
  const req = lib.request({
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    timeout: 60000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
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
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => fail(1, 'send_failed'));
  req.write(body);
  req.end();
}

if (require.main === module) main();
