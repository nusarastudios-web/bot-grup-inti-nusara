// Tes wiring penuh agent loop (Opsi B final, 3 Nov 2026).
//   - Unit: shouldDefer + holdingShouldSend + composeReply followup.
//   - Pengirim: send-bridge-reply.js ke server tiruan lokal (tanpa
//     Telegram nyata, tanpa secret nyata; secret dummy hanya di tes).
//   - Integrasi worker: mode defer default — pertanyaan substantif
//     TIDAK dikirim fallback, penyebutan ke-2 dari pengirim yang sama
//     otomatis dibalas holding persis "sabar sebentar ya.. bowo lagi
//     mikir", penyebutan ke-3 diam, dan siklus holding reset sesudah
//     agent loop menandai semua tertunda pengirim itu diproses.
//   - Hook: skrip ~/hooks/scripts/bowo-bridge-agent-loop.sh (dry-run)
//     membangunkan hanya untuk entri belum diproses & bukan holding.
// Semua salinan di /tmp (repo tidak tersentuh). Jalankan:
//   node test-agent-loop.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bowo-agent-loop-'));
const PORT = 3461;
const GROUP_ID = -1003000000001;
const MEMBER_ID = 201;
const OWNER_ID = 999;
const WEBHOOK_SECRET = 'tes-webhook-secret';
const BRIDGE_SECRET = 'tes-bridge-secret';
const QUEUE_FILE = path.join(TMP, 'queue', 'incoming.jsonl');
const SENT_FILE = path.join(TMP, 'queue', 'sent.jsonl');
const STATE_FILE = path.join(TMP, 'worker-state.json');
const FOLLOWUP_FILE = path.join(TMP, 'followup.jsonl');
const PROCESSED_FILE = path.join(TMP, 'processed.jsonl');
const HOOK_STATE_DIR = path.join(TMP, 'hookstate');
const HOOK_SCRIPT = '/home/hatch/hooks/scripts/bowo-bridge-agent-loop.sh';
const HOLDING_TEXT = 'sabar sebentar ya.. bowo lagi mikir';

const results = [];
function check(name, expected, actual, pass) {
  results.push({ name, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | harap: ${expected} | dapat: ${actual}`);
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
}
function sentIds() {
  // Catatan server: sent.jsonl memakai field message_id (pesan asli),
  // bukan reply_to_message_id, dan tidak menyimpan teks kiriman.
  // Teks holding diverifikasi lewat konstanta HOLDING_TEXT (unit) +
  // log reply_holding_sent (hanya dicatat sesudah /bridge/send sukses).
  return new Set(readJsonl(SENT_FILE).map((r) => Number(r.message_id)));
}
function reqJson(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* abaikan */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function webhookPath() { return `/webhook/${WEBHOOK_SECRET}`; }
function update(chatId, fromId, text, mid, isBot) {
  return {
    update_id: 1000 + mid,
    message: {
      message_id: mid, date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'supergroup' },
      from: { id: fromId, username: `u${fromId}`, is_bot: !!isBot },
      text,
    },
  };
}
function waitHealth(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const r = await reqJson('GET', '/health');
        if (r.status === 200) return resolve();
      } catch (e) { /* belum siap */ }
      if (Date.now() - start > timeoutMs) return reject(new Error('health timeout'));
      setTimeout(tick, 300);
    };
    tick();
  });
}
function runNode(args, env, timeoutMs) {
  return runCmd('node', args, env, timeoutMs);
}
function runCmd(cmd, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} resolve({ code: -1, out, err }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function main() {
  fs.mkdirSync(path.join(TMP, 'catalog'), { recursive: true });
  for (const f of ['server.js', 'worker.js', 'send-bridge-reply.js', 'catalog.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(TMP, f));
  }
  fs.copyFileSync(path.join(REPO, 'catalog', '.gitkeep'), path.join(TMP, 'catalog', '.gitkeep'));
  fs.mkdirSync(HOOK_STATE_DIR, { recursive: true });

  // ---------- Unit ----------
  process.env.OWNER_USER_ID = String(OWNER_ID);
  const workerMod = require(path.join(TMP, 'worker.js'));
  check('unit shouldDefer default aktif',
    'true untuk reply followup (BRIDGE_DEFER_SUBSTANTIVE tidak di-set)',
    String(workerMod.shouldDefer({ followup: true })),
    workerMod.shouldDefer({ followup: true }) === true);
  check('unit holding penyebutan ke-1 diam',
    'false untuk hitungan 1', String(workerMod.holdingShouldSend(1, false)),
    workerMod.holdingShouldSend(1, false) === false);
  check('unit holding penyebutan ke-2 kirim',
    'true untuk hitungan 2, holding belum terkirim', String(workerMod.holdingShouldSend(2, false)),
    workerMod.holdingShouldSend(2, false) === true);
  check('unit holding tidak diulang',
    'false bila holding sudah terkirim', String(workerMod.holdingShouldSend(3, true)),
    workerMod.holdingShouldSend(3, true) === false);
  const rAsk = workerMod.composeReply({ message_id: 5, chat_id: GROUP_ID, from_id: MEMBER_ID, text: 'Bowo, bagaimana cara daftar?', kind: 'request' });
  check('unit teks holding persis perintah Pak',
    '"sabar sebentar ya.. bowo lagi mikir"',
    JSON.stringify(workerMod.HOLDING_TEXT),
    workerMod.HOLDING_TEXT === HOLDING_TEXT);
  check('unit compose pertanyaan tetap followup',
    'followup true', JSON.stringify(rAsk), rAsk.followup === true);

  // ---------- Pengirim ke server tiruan ----------
  let fakeSeen = null;
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fakeSeen = { header: req.headers['x-bridge-secret'], body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent_message_id: 777 }));
    });
  });
  await new Promise((r) => fake.listen(3499, r));
  const answerFile = path.join(TMP, 'answer.json');
  fs.writeFileSync(answerFile, JSON.stringify({ reply_to_message_id: 42, chat_id: GROUP_ID, text: 'Halo, ini jawaban penuh Bowo.' }));
  const sendOk = await runNode([path.join(TMP, 'send-bridge-reply.js'), '--answer', answerFile],
    { ...process.env, BRIDGE_SECRET, BRIDGE_SERVER_URL: 'http://127.0.0.1:3499' }, 10000);
  let fakeBody = null;
  try { fakeBody = JSON.parse(fakeSeen.body); } catch (e) {}
  check('pengirim kirim ke /bridge/send',
    'exit 0 + header secret dummy + body reply_to 42',
    `exit ${sendOk.code}, header cocok? ${fakeSeen && fakeSeen.header === BRIDGE_SECRET}, reply_to ${fakeBody && fakeBody.reply_to_message_id}`,
    sendOk.code === 0 && fakeSeen && fakeSeen.header === BRIDGE_SECRET && fakeBody && fakeBody.reply_to_message_id === 42);
  fake.close();

  // Pengirim tanpa secret -> gagal tertutup exit 2, tanpa bocor apa pun.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bowo-empty-home-'));
  const sendNoSecret = await runNode([path.join(TMP, 'send-bridge-reply.js'), '--answer', answerFile],
    { ...process.env, HOME: emptyHome, BRIDGE_SERVER_URL: 'http://127.0.0.1:3499' }, 10000);
  delete process.env.BRIDGE_SECRET;
  check('pengirim tanpa secret gagal tertutup',
    'exit 2 + error bridge_secret_missing',
    `exit ${sendNoSecret.code}, out ${sendNoSecret.out.trim()}`,
    sendNoSecret.code === 2 && sendNoSecret.out.includes('bridge_secret_missing'));

  // ---------- Integrasi worker (defer + holding) ----------
  const serverEnv = {
    ...process.env,
    PORT: String(PORT), WEBHOOK_SECRET, GROUP_CHAT_ID: String(GROUP_ID),
    TELEGRAM_BOT_TOKEN: 'dummy-token-tes-lokal', BRIDGE_SECRET,
    OWNER_USER_ID: String(OWNER_ID), BRIDGE_FAKE_TELEGRAM: '1',
  };
  let serverChild = spawn('node', [path.join(TMP, 'server.js')], { env: serverEnv, stdio: 'ignore' });
  let workerChild = null;
  let workerOut = '';
  try {
    await waitHealth(serverChild, 15000);
    workerChild = spawn('node', [path.join(TMP, 'worker.js')], {
      env: {
        ...process.env,
        BRIDGE_SERVER_URL: `http://127.0.0.1:${PORT}`,
        BRIDGE_SECRET,
        BRIDGE_POLL_MS: '1000',
        BRIDGE_STATE_FILE: STATE_FILE,
        BRIDGE_FOLLOWUP_FILE: FOLLOWUP_FILE,
        BRIDGE_PROCESSED_FILE: PROCESSED_FILE,
        // Sengaja TIDAK set BRIDGE_DEFER_SUBSTANTIVE: default wiring penuh.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    workerChild.stdout.on('data', (c) => { workerOut += c.toString('utf8'); });
    workerChild.stderr.on('data', (c) => { workerOut += c.toString('utf8'); });
    await new Promise((r) => setTimeout(r, 1500));

    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo, bagaimana cara daftar?', 201), { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET });
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo, lalu biayanya berapa?', 202), { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET });
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo, kok belum dijawab?', 203), { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET });
    await reqJson('POST', webhookPath(), update(GROUP_ID, 202, 'Bowo halo', 204), { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET });
    await new Promise((r) => setTimeout(r, 8000));

    const sent = sentIds();
    check('worker defer: pertanyaan ke-1 TIDAK dikirim fallback',
      '201 TIDAK terkirim', `sent has 201? ${sent.has(201)}`, !sent.has(201));
    check('worker holding: penyebutan ke-2 dibalas holding',
      '202 terkirim (teks holding diverifikasi unit + log holding_sent)',
      `sent has 202? ${sent.has(202)}`,
      sent.has(202));
    check('worker holding: penyebutan ke-3 diam (tidak ada holding ulang)',
      '203 TIDAK terkirim', `sent has 203? ${sent.has(203)}`, !sent.has(203));
    check('worker sapaan tetap instan',
      '204 terkirim', `sent has 204? ${sent.has(204)}`, sent.has(204));

    const followups = readJsonl(FOLLOWUP_FILE);
    const f202 = followups.find((f) => Number(f.message_id) === 202);
    check('worker followup: semua substantif tercatat, 202 bertanda holding',
      '201,202,203 ada; 202 holding_sent true',
      `${followups.map((f) => f.message_id).join(',')}; 202 holding? ${f202 && f202.holding_sent}`,
      followups.some((f) => Number(f.message_id) === 201)
      && followups.some((f) => Number(f.message_id) === 203)
      && f202 && f202.holding_sent === true);
    check('worker log ada defer + holding',
      'reply_deferred_agent_loop & reply_holding_sent tercatat',
      `defer? ${workerOut.includes('reply_deferred_agent_loop')}, holding? ${workerOut.includes('reply_holding_sent')}`,
      workerOut.includes('reply_deferred_agent_loop') && workerOut.includes('reply_holding_sent'));

    // Simulasi agent loop menjawab siklus itu: tandai 201,202,203 diproses.
    fs.writeFileSync(PROCESSED_FILE, [
      { message_id: 201, from_id: MEMBER_ID, status: 'answered', at: new Date().toISOString() },
      { message_id: 202, from_id: MEMBER_ID, status: 'superseded', at: new Date().toISOString() },
      { message_id: 203, from_id: MEMBER_ID, status: 'superseded', at: new Date().toISOString() },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    // Jeda > jendela rate limit server (1 teks / 10 detik / orang),
    // supaya holding kedua tidak tertolak 429 dengan benar.
    await new Promise((r) => setTimeout(r, 11000));
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo, pertanyaan baru?', 205), { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET });
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo, pertanyaan baru lagi?', 206), { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET });
    await new Promise((r) => setTimeout(r, 8000));
    const sent2 = sentIds();
    check('worker reset siklus: pertanyaan baru ke-1 diam, ke-2 holding lagi',
      '205 TIDAK terkirim, 206 terkirim (holding)',
      `sent has 205? ${sent2.has(205)}, sent has 206? ${sent2.has(206)}`,
      !sent2.has(205) && sent2.has(206));
  } catch (e) {
    console.error('TES ERROR:', e && e.message ? e.message : e);
    results.push({ name: 'tes berjalan', expected: 'tanpa error', actual: String(e && e.message ? e.message : e), pass: false });
  } finally {
    try { if (workerChild) workerChild.kill(); } catch (e) {}
    try { if (serverChild) serverChild.kill(); } catch (e) {}
  }

  // ---------- Hook (dry-run) ----------
  const hookFollowup = path.join(TMP, 'hook-followup.jsonl');
  const hookProcessed = path.join(TMP, 'hook-processed.jsonl');
  fs.writeFileSync(hookFollowup, [
    { message_id: 301, chat_id: GROUP_ID, from_id: 301, text: 'Bowo, tanya satu?', reason: 'needs_bowo_answer' },
    { message_id: 302, chat_id: GROUP_ID, from_id: 302, text: 'Bowo, tanya dua?', reason: 'needs_bowo_answer' },
    { message_id: 303, chat_id: GROUP_ID, from_id: 303, text: 'Bowo, tanya tiga?', reason: 'needs_bowo_answer', holding_sent: true },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(hookProcessed, '');
  const hookEnv = {
    ...process.env,
    HATCH_HOOK_RUNTIME: '/home/hatch/hooks/runtime/hatch_hook_runtime.sh',
    HATCH_HOOK_STATE_DIR: HOOK_STATE_DIR,
    HATCH_HOOK_ID: 'bowo-bridge-agent-loop',
    HATCH_HOOK_INVOCATION_ID: 'tes-1',
    HATCH_HOOK_DRY_RUN: '1',
    BOWO_BRIDGE_FOLLOWUP_FILE: hookFollowup,
    BOWO_BRIDGE_PROCESSED_FILE: hookProcessed,
  };
  const hookRun = await runCmd('bash', [HOOK_SCRIPT], hookEnv, 15000);
  const hookOut = hookRun.out + hookRun.err;
  check('hook bangunkan untuk entri belum diproses, lewati holding',
    'wake + message_ids [301,302] (tanpa 303)',
    hookOut.trim().split('\n').pop(),
    hookOut.includes('"decision":"wake"') && hookOut.includes('301') && hookOut.includes('302') && !hookOut.includes('303'));
  fs.writeFileSync(hookProcessed, JSON.stringify({ message_id: 301, status: 'answered' }) + '\n');
  const hookRun2 = await runCmd('bash', [HOOK_SCRIPT], { ...hookEnv, HATCH_HOOK_INVOCATION_ID: 'tes-2' }, 15000);
  const hookOut2 = hookRun2.out + hookRun2.err;
  check('hook sesudah 301 diproses hanya bangunkan 302',
    'wake + 302 saja', hookOut2.trim().split('\n').pop(),
    hookOut2.includes('"decision":"wake"') && hookOut2.includes('302') && !hookOut2.includes('301'));
  fs.writeFileSync(hookProcessed, [
    { message_id: 301, status: 'answered' },
    { message_id: 302, status: 'answered' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const hookRun3 = await runCmd('bash', [HOOK_SCRIPT], { ...hookEnv, HATCH_HOOK_INVOCATION_ID: 'tes-3' }, 15000);
  const hookOut3 = hookRun3.out + hookRun3.err;
  check('hook diam bila semua sudah diproses',
    'silent', hookOut3.trim().split('\n').pop(),
    hookOut3.includes('"decision":"silent"'));

  console.log('=== HASIL TES AGENT LOOP ===');
  console.log(`Folder tes (salinan /tmp, repo tidak tersentuh): ${TMP}`);
  console.log(`Total: ${results.filter((r) => r.pass).length}/${results.length} lolos`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log('GAGAL:');
    for (const f of failed) console.log(`- ${f.name}: harap ${f.expected}, dapat ${f.actual}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('TES ERROR:', e); process.exit(1); });
