// Tes lokal tahap jembatan jawaban (Opsi B: worker Bowo).
// TIDAK menyentuh Telegram nyata dan TIDAK menyentuh service Render:
//   - Server + worker dijalankan dari SALINAN di /tmp (repo tidak tersentuh).
//   - Nilai env semua dummy (bukan nilai nyata).
//   - BRIDGE_FAKE_TELEGRAM=1: panggilan Telegram disimulasi sukses tanpa
//     jaringan, tapi validasi, rate limit, pencatatan kiriman, dan dedup
//     tetap berjalan normal (itulah yang diuji).
//   - Mode dry-run TIDAK dipakai di sini (fake mode lebih lengkap).
// Keluar 0 bila semua kasus lolos, 1 bila ada yang gagal.
//
// Bagian 1: tes unit (fungsi murni, tanpa server).
// Bagian 2: tes server (HTTP ke server lokal port 3457).
// Bagian 3: tes worker (worker anak, poll 1 detik, terhadap server lokal).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3457;
const WEBHOOK_SECRET = 'test-secret';
const BRIDGE_SECRET = 'test-bridge-secret';
const GROUP_ID = -1001234567890;
const OTHER_GROUP_ID = -1009999999999;
const MEMBER_ID = 111;
const OWNER_ID = 222;
const RATE_ID = 333;
const SPLIT_ID = 444;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bowo-bridge-test-'));
const REPO = __dirname;
const QUEUE_FILE = path.join(TMP, 'queue', 'incoming.jsonl');
const SENT_FILE = path.join(TMP, 'queue', 'sent.jsonl');
const STATE_FILE = path.join(TMP, 'worker-state.json');
const FOLLOWUP_FILE = path.join(TMP, 'followup.jsonl');

const results = [];
function check(name, expected, actual, pass) {
  results.push({ name, expected, actual, pass });
  console.log(`${pass ? 'LOLOS' : 'GAGAL'} — ${name} | harap: ${expected} | nyata: ${actual}`);
}

function reqJson(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (e) { /* biarkan null */ }
        resolve({ status: res.statusCode, body: parsed, raw: out });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getHealth() {
  return reqJson('GET', '/health');
}

async function waitHealth(child, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await getHealth();
      if (r.status === 200) return true;
    } catch (e) { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('server tidak merespons /health');
}

function update(chatId, fromId, text, messageId, isBot = false) {
  return {
    update_id: 2000 + messageId,
    message: {
      message_id: messageId,
      from: { id: fromId, username: fromId === OWNER_ID ? 'pemilik' : 'anggota', is_bot: isBot },
      chat: { id: chatId, type: 'supergroup' },
      date: 1793660000,
      text,
    },
  };
}

function webhookPath() {
  return `/webhook/${WEBHOOK_SECRET}`;
}

function secretHeader() {
  return { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET };
}

function bridgeHeader() {
  return { 'x-bridge-secret': BRIDGE_SECRET };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function sentIds() {
  return new Set(readJsonl(SENT_FILE).map((r) => Number(r.message_id)));
}

async function main() {
  // Salin kode ke /tmp (repo tidak tersentuh).
  fs.mkdirSync(path.join(TMP, 'catalog'), { recursive: true });
  for (const f of ['server.js', 'worker.js', 'catalog.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(TMP, f));
  }
  fs.copyFileSync(path.join(REPO, 'catalog', '.gitkeep'), path.join(TMP, 'catalog', '.gitkeep'));

  // ---------- Bagian 1: tes unit (fungsi murni) ----------
  process.env.OWNER_USER_ID = String(OWNER_ID);
  const serverMod = require(path.join(TMP, 'server.js'));
  const workerMod = require(path.join(TMP, 'worker.js'));

  const chunks = serverMod.splitMessage('x'.repeat(5000));
  check('unit splitMessage 5000 karakter', '2 potongan (4096 + 904)',
    `${chunks.length} potongan (${chunks.map((c) => Array.from(c).length).join(' + ')})`,
    chunks.length === 2 && Array.from(chunks[0]).length === 4096 && Array.from(chunks[1]).length === 904);

  const emojiSplit = serverMod.splitMessage(`😀${'y'.repeat(5000)}`);
  check('unit splitMessage tidak membelah emoji', 'potongan pertama diawali emoji utuh',
    `awal potongan: ${JSON.stringify(emojiSplit[0].slice(0, 2))}`,
    emojiSplit[0].startsWith('😀'));

  check('unit deriveKind owner', "'order'", serverMod.deriveKind(OWNER_ID),
    serverMod.deriveKind(OWNER_ID) === 'order');
  check('unit deriveKind anggota', "'request'", serverMod.deriveKind(MEMBER_ID),
    serverMod.deriveKind(MEMBER_ID) === 'request');

  const rGreet = workerMod.composeReply({ message_id: 1, chat_id: GROUP_ID, from_id: MEMBER_ID, text: 'Bowo halo', kind: 'request' });
  check('unit compose sapaan', "teks sapaan", JSON.stringify(rGreet),
    rGreet.action === 'text' && /Ada yang bisa Bowo bantu/.test(rGreet.text));

  const rFile = workerMod.composeReply({ message_id: 2, chat_id: GROUP_ID, from_id: MEMBER_ID, text: 'Bowo kirim pricelist', kind: 'request' });
  check('unit compose file katalog', "media catalog 'pricelist'", JSON.stringify(rFile),
    rFile.action === 'media' && rFile.media.catalog === 'pricelist');

  const rMemberUrl = workerMod.composeReply({ message_id: 3, chat_id: GROUP_ID, from_id: MEMBER_ID, text: 'Bowo kirim https://example.com/x.pdf', kind: 'request' });
  check('unit compose URL anggota ditolak jadi teks', 'teks "tidak ada"', JSON.stringify(rMemberUrl),
    rMemberUrl.action === 'text' && /tidak ada di katalog/.test(rMemberUrl.text));

  const rOwnerUrl = workerMod.composeReply({ message_id: 4, chat_id: GROUP_ID, from_id: OWNER_ID, text: 'Bowo kirim https://example.com/laporan.pdf', kind: 'order' });
  check('unit compose URL pemilik', "media url type document", JSON.stringify(rOwnerUrl),
    rOwnerUrl.action === 'media' && rOwnerUrl.media.url === 'https://example.com/laporan.pdf' && rOwnerUrl.media.type === 'document');

  const rAsk = workerMod.composeReply({ message_id: 5, chat_id: GROUP_ID, from_id: MEMBER_ID, text: 'Bowo, bagaimana cara daftar?', kind: 'request' });
  check('unit compose pertanyaan -> fallback + followup', 'fallback + followup true', JSON.stringify(rAsk),
    rAsk.action === 'text' && /Bowo akan menjawab menyusul/.test(rAsk.text) && rAsk.followup === true);

  // ---------- Bagian 2: tes server ----------
  const serverEnv = {
    ...process.env,
    PORT: String(PORT),
    WEBHOOK_SECRET,
    GROUP_CHAT_ID: String(GROUP_ID),
    TELEGRAM_BOT_TOKEN: 'dummy-token-tes-lokal',
    BRIDGE_SECRET,
    OWNER_USER_ID: String(OWNER_ID),
    BRIDGE_FAKE_TELEGRAM: '1',
  };
  const serverChild = spawn('node', [path.join(TMP, 'server.js')], { env: serverEnv, stdio: 'ignore' });
  let serverRef = serverChild;
  let workerChild = null;
  let workerOut = '';
  try {
    await waitHealth(serverRef);

    // S1: antre anggota + S2: antre pemilik.
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo halo', 1), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, OWNER_ID, 'Bowo halo', 2), secretHeader());
    // S3: tanpa pemicu -> diam. S4: pesan bot -> diabaikan.
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Halo semua', 3), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo dari bot', 4, true), secretHeader());
    const qCount = readJsonl(QUEUE_FILE).length;
    check('server antre 2 pesan Bowo, abaikan 2 lain', 'antrean 2 baris', `${qCount} baris`, qCount === 2);

    // S5: pending auth.
    const pNoAuth = await reqJson('GET', '/bridge/pending');
    const pWrong = await reqJson('GET', '/bridge/pending', undefined, { 'x-bridge-secret': 'salah' });
    const pOk = await reqJson('GET', '/bridge/pending', undefined, bridgeHeader());
    check('server pending tanpa secret', '401', `status ${pNoAuth.status}`, pNoAuth.status === 401);
    check('server pending secret salah', '403', `status ${pWrong.status}`, pWrong.status === 403);
    const kinds = (pOk.body && pOk.body.entries)
      ? pOk.body.entries.map((e) => `${e.message_id}:${e.kind}`).join(',') : 'bukan daftar';
    check('server pending benar + kind', '1:request, 2:order', kinds,
      pOk.status === 200 && kinds === '1:request,2:order');

    // S6: kirim ke chat lain -> 403. S7: reply_to tak dikenal -> 400.
    const sWrongChat = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 1, chat_id: OTHER_GROUP_ID, from_id: MEMBER_ID, text: 'halo' }, bridgeHeader());
    check('server send chat lain', '403 chat_not_whitelisted', `${sWrongChat.status} ${sWrongChat.body && sWrongChat.body.error}`,
      sWrongChat.status === 403 && sWrongChat.body.error === 'chat_not_whitelisted');
    const sUnknown = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 999, chat_id: GROUP_ID, from_id: MEMBER_ID, text: 'halo' }, bridgeHeader());
    check('server send reply_to tak dikenal', '400 unknown_message', `${sUnknown.status} ${sUnknown.body && sUnknown.body.error}`,
      sUnknown.status === 400 && sUnknown.body.error === 'unknown_message');

    // S8: kirim teks (fake) + duplikat.
    const sText = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 1, chat_id: GROUP_ID, from_id: MEMBER_ID, text: 'Halo! Ada yang bisa Bowo bantu?' }, bridgeHeader());
    check('server send teks fake', 'ok + sent_message_id', JSON.stringify(sText.body),
      sText.status === 200 && sText.body.ok === true && typeof sText.body.sent_message_id === 'number');
    const sDup = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 1, chat_id: GROUP_ID, from_id: MEMBER_ID, text: 'Halo lagi' }, bridgeHeader());
    check('server send duplikat', 'duplicate true, tanpa kirim ulang', JSON.stringify(sDup.body),
      sDup.status === 200 && sDup.body.duplicate === true);

    // S9: rate limit teks (pengirim baru 333, dua pesan berurutan).
    await reqJson('POST', webhookPath(), update(GROUP_ID, RATE_ID, 'Bowo satu', 11), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, RATE_ID, 'Bowo dua', 12), secretHeader());
    const sRate1 = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 11, chat_id: GROUP_ID, from_id: RATE_ID, text: 'satu' }, bridgeHeader());
    const sRate2 = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 12, chat_id: GROUP_ID, from_id: RATE_ID, text: 'dua' }, bridgeHeader());
    check('server rate limit teks 10 detik', 'pertama ok, kedua 429 rate_limited',
      `pertama ${sRate1.status}, kedua ${sRate2.status} ${sRate2.body && sRate2.body.error}`,
      sRate1.status === 200 && sRate2.status === 429 && sRate2.body.error === 'rate_limited');

    // S10: teks panjang dibagi (pengirim baru 444).
    await reqJson('POST', webhookPath(), update(GROUP_ID, SPLIT_ID, 'Bowo panjang', 13), secretHeader());
    const sSplit = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 13, chat_id: GROUP_ID, from_id: SPLIT_ID, text: 'z'.repeat(5000) }, bridgeHeader());
    check('server teks 5000 karakter dibagi', 'ok + chunks 2', JSON.stringify(sSplit.body),
      sSplit.status === 200 && sSplit.body.chunks === 2);

    // S11: katalog kosong -> catalog_not_found. S12: URL anggota -> 403.
    // S13: URL pemilik -> ok (fake, tanpa fetch jaringan).
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo kirim pricelist', 14), secretHeader());
    const sCat = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 14, chat_id: GROUP_ID, from_id: MEMBER_ID, media: { catalog: 'pricelist' } }, bridgeHeader());
    check('server katalog kosong', '400 catalog_not_found', `${sCat.status} ${sCat.body && sCat.body.error}`,
      sCat.status === 400 && sCat.body.error === 'catalog_not_found');
    const sMemberUrl = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 14, chat_id: GROUP_ID, from_id: MEMBER_ID, media: { url: 'https://example.com/x.pdf', type: 'document' } }, bridgeHeader());
    check('server URL anggota ditolak', '403 member_url_forbidden', `${sMemberUrl.status} ${sMemberUrl.body && sMemberUrl.body.error}`,
      sMemberUrl.status === 403 && sMemberUrl.body.error === 'member_url_forbidden');
    const sOwnerUrl = await reqJson('POST', '/bridge/send',
      { reply_to_message_id: 2, chat_id: GROUP_ID, from_id: OWNER_ID, media: { url: 'https://example.com/laporan.pdf', type: 'document' } }, bridgeHeader());
    check('server URL pemilik', 'ok', JSON.stringify(sOwnerUrl.body),
      sOwnerUrl.status === 200 && sOwnerUrl.body.ok === true);

    // S14: health memuat field jembatan (boolean + hitungan, tanpa nilai).
    const health = await getHealth();
    check('server health field jembatan', 'bridge true, owner true, katalog 0, test_mode true',
      JSON.stringify(health.body),
      health.body.bridge_configured === true && health.body.owner_configured === true
      && health.body.catalog_count === 0 && health.body.test_mode === true);

    // ---------- Bagian 3: tes worker ----------
    // Restart server dulu: jendela rate limit in-memory ikut reset, supaya
    // kiriman fase server tidak mencemari fase worker (pengirim sama).
    // Antrean + sent.jsonl bertahan (file), jadi tidak ada yang hilang.
    try { serverRef.kill(); } catch (e) { /* abaikan */ }
    await new Promise((r) => setTimeout(r, 500));
    serverRef = spawn('node', [path.join(TMP, 'server.js')], { env: serverEnv, stdio: 'ignore' });
    await waitHealth(serverRef);
    // M0: pesan SEBELUM worker start -> harus TIDAK dijawab (cutoff tunggakan).
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo halo sebelum worker', 100), secretHeader());
    workerChild = spawn('node', [path.join(TMP, 'worker.js')], {
      env: {
        ...process.env,
        BRIDGE_SERVER_URL: `http://127.0.0.1:${PORT}`,
        BRIDGE_SECRET,
        BRIDGE_POLL_MS: '1000',
        BRIDGE_STATE_FILE: STATE_FILE,
        BRIDGE_FOLLOWUP_FILE: FOLLOWUP_FILE,
        // Tes ini menguji mode fallback lama (M5 terkirim fallback).
        // Mode wiring penuh (defer + holding) diuji di test-agent-loop.js.
        BRIDGE_DEFER_SUBSTANTIVE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    workerChild.stdout.on('data', (c) => { workerOut += c.toString('utf8'); });
    workerChild.stderr.on('data', (c) => { workerOut += c.toString('utf8'); });
    await new Promise((r) => setTimeout(r, 1500)); // worker start + penanda awal

    // M1..M8: pesan SESUDAH worker start (harus dijawab, kecuali M7 yang
    // sengaja kena rate limit). Pengirim dibedakan supaya tidak saling
    // kena jendela rate limit 10 detik (kecuali pasangan M6/M7 yang memang
    // menguji rate limit).
    await reqJson('POST', webhookPath(), update(GROUP_ID, MEMBER_ID, 'Bowo halo', 101), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, 115, 'Bowo kirim pricelist', 102), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, 116, 'Bowo kirim https://example.com/x.pdf', 103), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, OWNER_ID, 'Bowo kirim https://example.com/laporan.pdf', 104), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, 117, 'Bowo, bagaimana cara daftar?', 105), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, 118, 'Bowo halo', 106), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, 118, 'Bowo halo lagi', 107), secretHeader());
    await reqJson('POST', webhookPath(), update(GROUP_ID, 119, 'Bowo halo', 108), secretHeader());
    // 7 kiriman x jarak server 1,1 detik + poll: tunggu cukup.
    await new Promise((r) => setTimeout(r, 14000));

    const sent = sentIds();
    check('worker abaikan tunggakan pra-start (M0)', 'M0 TIDAK terkirim', `sent has 100? ${sent.has(100)}`, !sent.has(100));
    check('worker jawab sapaan (M1)', 'M1 terkirim', `sent has 101? ${sent.has(101)}`, sent.has(101));
    check('worker jawab file tak dikenal (M2)', 'M2 terkirim (teks "tidak ada")', `sent has 102? ${sent.has(102)}`, sent.has(102));
    check('worker tolak URL anggota (M3)', 'M3 terkirim (teks "tidak ada")', `sent has 103? ${sent.has(103)}`, sent.has(103));
    check('worker kirim URL pemilik (M4)', 'M4 terkirim (media)', `sent has 104? ${sent.has(104)}`, sent.has(104));
    check('worker fallback pertanyaan (M5)', 'M5 terkirim (fallback)', `sent has 105? ${sent.has(105)}`, sent.has(105));
    check('worker rate limit: pesan pertama (M6)', 'M6 terkirim', `sent has 106? ${sent.has(106)}`, sent.has(106));
    check('worker rate limit: pesan kedua dilewati diam (M7)', 'M7 TIDAK terkirim', `sent has 107? ${sent.has(107)}`, !sent.has(107));
    check('worker tidak macet sesudah rate limit (M8)', 'M8 terkirim', `sent has 108? ${sent.has(108)}`, sent.has(108));

    const followups = readJsonl(FOLLOWUP_FILE);
    const hasM5Followup = followups.some((f) => Number(f.message_id) === 105);
    check('worker flag tindak lanjut M5', 'followup berisi 105', `${followups.length} entri, ada 105? ${hasM5Followup}`,
      hasM5Followup);

    // Log worker: metadata saja (tidak ada isi pesan / URL).
    const leaksText = workerOut.includes('bagaimana cara daftar');
    const leaksUrl = workerOut.includes('example.com');
    check('worker log tanpa isi pesan', 'tidak ada teks pesan di log', `teks bocor? ${leaksText}, URL bocor? ${leaksUrl}`,
      !leaksText && !leaksUrl);
    check('worker log ada reply_sent', 'reply_sent tercatat', workerOut.includes('reply_sent') ? 'ya' : 'tidak',
      workerOut.includes('reply_sent'));

    // Stabilitas: satu siklus poll tambahan tidak menambah kiriman (dedup).
    const sentBefore = sentIds().size;
    await new Promise((r) => setTimeout(r, 2500));
    const sentAfter = sentIds().size;
    check('worker tidak kirim ulang', `jumlah kiriman tetap ${sentBefore}`, `${sentBefore} -> ${sentAfter}`,
      sentBefore === sentAfter);
  } catch (e) {
    console.error('TES ERROR:', e && e.message ? e.message : e);
    results.push({ name: 'tes berjalan', expected: 'tanpa error', actual: String(e && e.message ? e.message : e), pass: false });
  } finally {
    try { if (workerChild) workerChild.kill(); } catch (e) { /* abaikan */ }
    try { serverRef.kill(); } catch (e) { /* abaikan */ }
  }

  console.log('=== HASIL TES LOKAL JEMBATAN ===');
  console.log(`Folder tes (salinan /tmp, repo tidak tersentuh): ${TMP}`);
  console.log(`Total: ${results.filter((r) => r.pass).length}/${results.length} lolos`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log('YANG GAGAL:');
    for (const r of failed) console.log(`- ${r.name} | harap: ${r.expected} | nyata: ${r.actual}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('TES FATAL:', e);
  process.exitCode = 1;
});
