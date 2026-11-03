// Skrip tes lokal kerangka server bot grup inti.
// TIDAK menyentuh Telegram nyata: semua update adalah tiruan, dikirim ke
// server lokal yang dijalankan skrip ini sebagai child process.
// Kasus wajib:
//   (a) pesan grup whitelist berisi "Bowo halo"      -> masuk antrean
//   (b) pesan grup whitelist tanpa "Bowo"            -> tidak masuk antrean, diam
//   (c) pesan dari grup lain (chat_id berbeda)      -> diabaikan
// Bonus:
//   (d) "bowo" huruf kecil di grup whitelist        -> masuk antrean (case-insensitive)
//
// Env tes (bukan nilai nyata): PORT=3456, WEBHOOK_SECRET=test-secret,
// GROUP_CHAT_ID=-1001234567890, TELEGRAM_BOT_TOKEN dikosongkan (mode tes lokal).
// Keluar 0 bila semua kasus lolos, 1 bila ada yang gagal.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3456;
const WEBHOOK_SECRET = 'test-secret';
const GROUP_ID = -1001234567890;
const OTHER_GROUP_ID = -1009999999999;
const DIR = __dirname;
const QUEUE_FILE = path.join(DIR, 'queue', 'incoming.jsonl');

function post(pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getHealth() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }).on('error', reject);
  });
}

function queueCount() {
  if (!fs.existsSync(QUEUE_FILE)) return 0;
  const content = fs.readFileSync(QUEUE_FILE, 'utf8').trim();
  return content ? content.split('\n').filter(Boolean).length : 0;
}

function queueTexts() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return fs.readFileSync(QUEUE_FILE, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line).text; } catch { return null; } });
}

async function waitHealth(child, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await getHealth();
      if (r.status === 200) return true;
    } catch (e) { /* server belum siap */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('server tidak merespons /health');
}

function update(chatId, text, messageId) {
  return {
    update_id: 1000 + messageId,
    message: {
      message_id: messageId,
      from: { id: 111, username: 'penguji', is_bot: false },
      chat: { id: chatId, type: 'supergroup' },
      date: 1793660000,
      text,
    },
  };
}

(async () => {
  // Bersihkan antrean sebelum tes, supaya hitungan murni dari tes ini.
  fs.mkdirSync(path.join(DIR, 'queue'), { recursive: true });
  fs.writeFileSync(QUEUE_FILE, '', 'utf8');

  const child = spawn('node', [path.join(DIR, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      WEBHOOK_SECRET,
      GROUP_CHAT_ID: String(GROUP_ID),
      TELEGRAM_BOT_TOKEN: '',
    },
    stdio: 'ignore',
  });

  const results = [];
  try {
    await waitHealth(child);
    const pathName = `/webhook/${WEBHOOK_SECRET}`;
    const secretHeader = { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET };

    // (a) Grup whitelist + "Bowo halo" -> masuk antrean.
    const beforeA = queueCount();
    const resA = await post(pathName, update(GROUP_ID, 'Bowo halo', 1), secretHeader);
    const afterA = queueCount();
    results.push({
      case: '(a) grup whitelist, "Bowo halo"',
      expected: 'masuk antrean (count +1, status 200)',
      actual: `status ${resA.status}, count ${beforeA} -> ${afterA}`,
      pass: resA.status === 200 && afterA === beforeA + 1,
    });

    // (b) Grup whitelist tanpa "Bowo" -> diam, tidak masuk antrean.
    const beforeB = queueCount();
    const resB = await post(pathName, update(GROUP_ID, 'Halo semua, apa kabar?', 2), secretHeader);
    const afterB = queueCount();
    results.push({
      case: '(b) grup whitelist, tanpa "Bowo"',
      expected: 'tidak masuk antrean (count tetap, status 200)',
      actual: `status ${resB.status}, count ${beforeB} -> ${afterB}`,
      pass: resB.status === 200 && afterB === beforeB,
    });

    // (c) Grup lain + "Bowo halo" -> diabaikan.
    const beforeC = queueCount();
    const resC = await post(pathName, update(OTHER_GROUP_ID, 'Bowo halo dari grup lain', 3), secretHeader);
    const afterC = queueCount();
    results.push({
      case: '(c) grup lain, "Bowo halo"',
      expected: 'diabaikan (count tetap, status 200)',
      actual: `status ${resC.status}, count ${beforeC} -> ${afterC}`,
      pass: resC.status === 200 && afterC === beforeC,
    });

    // (d) Bonus: "bowo" huruf kecil di grup whitelist -> masuk antrean.
    const beforeD = queueCount();
    const resD = await post(pathName, update(GROUP_ID, 'bowo, tolong cek ini ya', 4), secretHeader);
    const afterD = queueCount();
    results.push({
      case: '(d) bonus: grup whitelist, "bowo" huruf kecil',
      expected: 'masuk antrean (count +1, status 200)',
      actual: `status ${resD.status}, count ${beforeD} -> ${afterD}`,
      pass: resD.status === 200 && afterD === beforeD + 1,
    });

    console.log('=== HASIL TES LOKAL BOT GRUP INTI ===');
    for (const r of results) {
      console.log(`${r.pass ? 'LOLOS' : 'GAGAL'} — ${r.case} | harap: ${r.expected} | nyata: ${r.actual}`);
    }
    console.log(`Antrean akhir: ${queueCount()} baris; teks yang terantre: ${JSON.stringify(queueTexts())}`);
    console.log(`Total: ${results.filter((r) => r.pass).length}/${results.length} lolos`);
    process.exitCode = results.every((r) => r.pass) ? 0 : 1;
  } catch (e) {
    console.error('TES ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
