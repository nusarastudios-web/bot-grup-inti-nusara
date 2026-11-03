# Bot Telegram Grup Inti Nusara Studio — Jembatan Jawaban (Opsi B: worker Bowo)

Status: **TAHAP IMPLEMENTASI SELESAI, SIAP UPLOAD + SIAP UJI.**
**BELUM di-upload, BELUM di-deploy, BELUM mengirim apa pun ke grup nyata.**
Dokumen ini menggambarkan keadaan per 3 November 2026. Unggahan ke GitHub
dilakukan Bowo lewat browser (memakai sesi GitHub Pak) — BUKAN git push
langsung, BUKAN manual oleh Pak. Jangan menjalankan worker atau menguji live
sebelum laporan implementasi ditinjau dan Pak memberi lampu hijau.

## Keadaan yang sudah terbukti (3 Nov 2026)

- Bot **@bowo_nusara_bot** sudah di grup inti, privacy **DISABLED**
  (menerima semua pesan grup). Bot lama @bowo_agent_bot digantikan sesudah
  Pak me-revoke token lama.
- Service Render Free **bot-grup-inti-nusara** LIVE:
  `https://bot-grup-inti-nusara.onrender.com` (+ `/health` untuk list ping Pak).
  Repo: `nusarastudios-web/bot-grup-inti-nusara`.
- Webhook **TERPASANG** (3 Nov ~10:07, `ok:true`).
- Antrean **TERVERIFIKASI**: pesan "Bowo halo" masuk antrean 10:07:56 WIB
  (~31 detik sesudah webhook dipasang); total 3 pesan tes masuk antrean
  (10:07:56, 10:13:48, 10:40:48 WIB, termasuk "halo bowo" huruf kecil).
  Nol pesan diabaikan. Tahap kerangka terbukti hidup end-to-end
  (webhook → saringan "Bowo" → antrean).

## Keputusan Pak (sudah diputuskan, jangan diubah)

1. Jawab **LANGSUNG** di grup tanpa konfirmasi per pesan.
2. **REALTIME + CEPAT**: pekerja jalan terus, latensi hitungan detik.
3. Bisa **MENGIRIM FILE**: foto (`sendPhoto`), video (`sendVideo`),
   dokumen (`sendDocument`), batas 50 MB per file, diperiksa sebelum kirim.
4. Pemicu kirim file **KEDUANYA**: permintaan anggota grup HANYA boleh
   memicu file katalog; perintah Pak/Bowo boleh memicu katalog + URL.
   Pembeda: `user_id` pengirim vs env `OWNER_USER_ID` (nama saja).
5. Tunggakan: **HANYA pesan baru**. Entri antrean sebelum waktu aktivasi
   jembatan = riwayat, tidak dijawab. Pengecualian hanya bila Pak mengirim
   ulang pesannya.
6. Katalog file: struktur dibangun, **isi awal KOSONG** (Pak mengisi
   nama + file/URL belakangan). Permintaan di luar katalog dijawab jujur
   "tidak ada" (tidak mengarang).
7. Otak: **Opsi B (worker Bowo)** — menggantikan rekomendasi rancangan
   (Opsi A, API LLM). Interval: **REALTIME** (pekerja jalan terus).

## Cara kerja (Opsi B)

1. Telegram mengantar update webhook ke server (Render) seketika.
2. Server membalas 200 CEPAT, lalu menyaring: whitelist grup, kata "Bowo"
   (case-insensitive, batas kata), abaikan pesan bot (anti-loop).
3. Pesan yang lolos ditulis ke `queue/incoming.jsonl` (di disk Render).
   Sejak jembatan aktif, antrean ini tetap menjadi daftar kerja worker
   (berbeda dengan Opsi A yang tidak memakai antrean) — karena worker
   membacanya lewat endpoint internal.
4. Worker (di VM Bowo, proses jalan terus) mengecek
   `GET /bridge/pending` tiap 15 detik (default), menyusun balasan sebagai
   Bowo, lalu mengirim lewat `POST /bridge/send`.
5. Server mengirim balasan ke grup **HANYA sebagai balasan (reply_to) atas
   pesan antrean yang nyata, HANYA ke grup whitelist** — bot tidak pernah
   memulai percakapan sendiri. Kiriman yang sudah terkirim dicatat di
   `queue/sent.jsonl` (idempotensi: tidak ada balasan ganda).
6. Penanda worker (file state di VM) menentukan apa yang "baru": entri
   sebelum waktu aktivasi worker tidak pernah dijawab (aturan tunggakan).

## Wiring penuh — final (3 Nov 2026, perintah Pak "bangun wiring jawaban
penuh, biar final" + "tetap realtime" + aturan holding spam)

Skrip worker **BUKAN Bowo yang berpikir**. Yang dikerjakan skrip sampai
tuntas dan INSTAN: sapaan, permintaan file katalog, perintah URL
Pak/Bowo. Pertanyaan substantif di-DEFER (default
`BRIDGE_DEFER_SUBSTANTIVE=1`) ke file follow-up, lalu dijawab penuh
oleh agent loop Bowo lewat hook realtime (poll 10 detik) +
`send-bridge-reply.js` + `/bridge/send`. Mode fallback lama
("Maaf, saya belum bisa menjawab itu sekarang — Bowo akan menjawab
menyusul") hanya hidup bila `BRIDGE_DEFER_SUBSTANTIVE=0` (untuk tes).
Skrip ini **TIDAK PERNAH mengarang jawaban**. Prinsip: lebih baik defer
+ holding jujur daripada jawaban karangan.

Realtime = deteksi jalan terus, bukan batch per menit: worker poll
10 detik, hook poll 10 detik, jawaban penuh menyusul dalam puluhan
detik (waktu mikir agen). Aturan holding spam (Pak 3 Nov): penyebutan
substantif ke-2 dari pengirim yang sama selagi pertanyaan pertamanya
masih tertunda OTOMATIS dibalas "sabar sebentar ya.. bowo lagi mikir"
(teks persis); sesudah itu tidak ada holding ulang sampai agent loop
menjawab pertanyaan tertunda pengirim itu. Detail: lihat
`agent-loop-instructions.md` + hook `~/hooks/scripts/bowo-bridge-agent-loop.sh`.

## File di folder ini

| File | Peran |
|---|---|
| `server.js` | Server Render: webhook + antrean + endpoint `/bridge/*` + pengirim Telegram. Tanpa dependensi (Node bawaan saja). |
| `worker.js` | Worker VM: poll antrean, susun balasan, kirim lewat server. Dijalankan systemd, BUKAN oleh Render. |
| `catalog.json` | Katalog file: `{"files": {}}` (KOSONG — Pak mengisi belakangan). |
| `catalog/` | Folder file katalog (saat ini hanya `.gitkeep`). File yang ditambahkan di sini ikut ter-deploy dan bisa dikirim bot. |
| `systemd/bowo-bridge-worker.service` | Unit systemd worker (berversi di repo; dipasang saat setup, bukan sekarang). |
| `test-local.js` | Tes kerangka (4 kasus, dari tahap kerangka — tetap lolos). |
| `test-bridge-local.js` | Tes jembatan (36 kasus: unit + server + worker; salinan /tmp, Telegram fake, tanpa kiriman nyata). Worker di tes ini memakai mode fallback lama (`BRIDGE_DEFER_SUBSTANTIVE=0`). |
| `send-bridge-reply.js` | Pengirim jawaban agent loop lewat `/bridge/send` (baca BRIDGE_SECRET sendiri, tanpa pernah mencetaknya). |
| `agent-loop-instructions.md` | Instruksi agent loop hook realtime (jawab tertua per pengirim, supersede sisanya, fail-closed). |
| `test-agent-loop.js` | Tes wiring penuh: defer worker + holding penyebutan ke-2 + pengirim agent loop + hook script (salinan /tmp). |
| `render.yaml`, `Procfile`, `package.json` | Deploy Render (start: `node server.js`; worker TIDAK dijalankan Render). |
| `rencana-jembatan-jawaban.md` | Rancangan (dokumen desain; rekomendasi Opsi A-nya digantikan keputusan Pak: Opsi B). |

## Env yang dibutuhkan (NAMA saja — nilai TIDAK PERNAH di repo/chat)

| Variabel | Wajib? | Keterangan |
|---|---|---|
| `PORT` | Tidak (default 3000) | Render mengisi sendiri. |
| `TELEGRAM_BOT_TOKEN` | Ya, produksi | Token BotFather. Hanya pemegang token yang menempelkannya di dashboard. |
| `WEBHOOK_SECRET` | Sangat disarankan | Segmen path webhook + `secret_token` Telegram. |
| `GROUP_CHAT_ID` | Ya, produksi | ID numerik grup inti (negatif untuk grup). Hanya chat_id ini yang diproses/dikirim. |
| `BRIDGE_SECRET` | **BARU, wajib jembatan** | Secret bersama server-worker untuk `/bridge/*`. Nilainya hanya Pak yang mengetikkan di dashboard Render; nilai yang SAMA harus ada di EnvironmentFile worker saat setup (di luar repo, mode 0600). Tanpa ini, `/bridge/*` menolak (503) dan worker berhenti gagal tertutup (exit 3) — tidak ada kiriman tanpa auth. |
| `OWNER_USER_ID` | **BARU, opsional** | User_id Telegram Pak/Bowo. Bila diisi, pesan dari user_id itu = perintah (katalog + URL). Bila kosong, semua = permintaan anggota (katalog saja) — default aman. Nilainya hanya Pak yang mengetikkan di dashboard Render. |
| `BRIDGE_DRY_RUN` | Hanya tes lokal | `"1"` = `/bridge/send` hanya mencatat tanpa memanggil Telegram dan tanpa merekam kiriman. **JANGAN PERNAH di-set di Render.** |
| `BRIDGE_FAKE_TELEGRAM` | Hanya tes lokal | `"1"` = panggilan Telegram disimulasi sukses tanpa jaringan, tapi validasi, rate limit, pencatatan, dan dedup tetap berjalan. **JANGAN PERNAH di-set di Render.** |

Contoh file env (JANGAN diisi nilai nyata di repo — lihat `.env.example`):

```bash
PORT=3000
TELEGRAM_BOT_TOKEN=
WEBHOOK_SECRET=
GROUP_CHAT_ID=
BRIDGE_SECRET=
OWNER_USER_ID=
```

## Worker + supervisi (systemd)

Worker dijalankan sebagai **system service** (bukan proses latar biasa):

- Unit: `systemd/bowo-bridge-worker.service` (Type=simple, User=root,
  WorkingDirectory + ExecStart absolut ke folder ini,
  `EnvironmentFile=-/home/hatch/.config/bowo-bridge/bridge.env` (opsional,
  tanda `-`: unit tetap bisa dimuat tanpa file itu, tapi worker exit 3
  bila `BRIDGE_SECRET` tidak ada — gagal tertutup, bukan jalan tanpa auth),
  `Environment=BRIDGE_POLL_MS=10000`).
- Restart: `Restart=on-failure`, `RestartSec=30`, dibatasi maks 5 restart
  per 10 menit (`StartLimitBurst=5`) supaya tidak berputar tanpa henti bila
  konfigurasi salah.
- Startup: `WantedBy=multi-user.target` (enabled = hidup otomatis tiap
  boot VM). Bila VM **DIGANTI**, ulangi di VM baru: salin unit ke
  `/etc/systemd/system/`, buat EnvironmentFile (mode 0600, di luar repo),
  `daemon-reload`, `enable`, `start` — itulah pemulihan startup (file unit
  berversi di repo, jadi tidak perlu ditulis ulang).
- Log worker: journal systemd (`journalctl -u bowo-bridge-worker -f`),
  HANYA metadata (message_id, kind, hasil) — tidak ada isi pesan/URL.
- File tindak lanjut: `worker-needs-followup.jsonl` (VM-lokal, gitignored,
  tidak di-upload) — berisi pesan yang perlu dijawab Bowo menyusul
  (pertanyaan substantif + kiriman gagal). Seperti antrean, file ini memang
  berisi teks pesan agar Bowo bisa menindaklanjuti — jangan dipublikasikan.

**PENTING: worker BELUM dipasang/dijalankan.** Pemasangan + `enable` +
`start` dilakukan induk/Bowo SETELAH lampu hijau Pak (bersamaan dengan
deploy server). Verifikasi unit sejauh ini: `systemd-analyze verify`
(lolos) + tes worker lokal (lolos) — bukan service yang sedang jalan.

## Katalog file (isi awal kosong)

Format `catalog.json` (kunci dicocokkan case-insensitive):

```json
{
  "files": {
    "pricelist": { "type": "document", "file": "pricelist.pdf" },
    "contoh-video": { "type": "video", "url": "https://contoh.com/video.mp4" }
  }
}
```

- `type`: `photo` | `video` | `document`.
- `file`: nama file di dalam folder `catalog/` (path traversal ditolak
  server; ukuran diperiksa ≤ 50 MB sebelum kirim).
- `url`: URL publik http(s) (hanya dipakai server untuk kirim; server
  tidak me-log URL).
- `caption`: opsional (default: `File: <nama>`).
- Menambah/mengganti file = upload lewat browser GitHub (Bowo, sesi Pak)
  + deploy ulang Render (server memuat katalog segar tiap pemakaian).

## Pengaman (yang diimplementasikan)

- **Anti-loop**: pesan bot diabaikan (kerangka) + balasan bot tidak memicu
  balasan lagi (karena pesan bot diabaikan) + dedup `update_id` (webhook)
  + idempotensi kiriman (`sent.jsonl`: satu balasan per pesan antrean).
- **Rate limit**: teks maks 1 per 10 detik per orang; file maks 1 per menit
  per orang; jarak kirim global ~1,1 detik (batas Telegram). Pelanggaran
  = bot **DIAM** (tidak ada spam "sabar ya"); worker TIDAK menunggu di
  tempat saat kena 429 — ia melewati pesan itu dan lanjut (supaya antrean
  tetap realtime untuk yang lain; pengirim bisa mengirim ulang).
- **429 Telegram**: dikembalikan ke worker sebagai `telegram_rate_limited`
  + `retry_after`; worker melewatinya (tidak memaksa).
- **Pesan panjang**: teks > 4096 karakter dibagi per paragraf (potongan
  keras per code point supaya emoji tidak terbelah); caption media
  dipotong 1024 karakter.
- **Whitelist kirim**: `/bridge/send` HANYA ke `GROUP_CHAT_ID`, HANYA
  sebagai balasan atas pesan antrean nyata. Media URL HANYA untuk
  perintah Pak/Bowo (kind=order); anggota yang mengirim URL mendapat
  jawaban "tidak ada" (dan server menolaknya 403 sebagai jaring kedua).
- **Restart/tidur Render**: webhook selamat (tersimpan di pihak Telegram);
  antrean/kiriman di disk Render bisa hilang saat restart — DITERIMA
  karena penanda worker (di VM) yang menentukan apa yang sudah dijawab,
  dan kiriman yang sudah dibalas 200 tidak dikirim ulang Telegram.
  Tidur: pesan tertunda sampai server bangun (Telegram menahan/mengulang
  sementara); ping `/health` berkala mengurangi tidur.
- **Privasi**: log server + worker = metadata saja; token/secret/user_id
  tidak pernah di-log; file antrean + follow-up = data grup inti, jangan
  dipublikasikan.

## Cara jalan lokal (tes saja, tanpa Telegram nyata)

```bash
cd ~/workspace/nusara-studio/bot-grup-inti
node test-local.js          # tes kerangka (4 kasus)
node test-bridge-local.js   # tes jembatan (36 kasus: unit + server + worker)
```

Kedua tes memakai nilai dummy + update tiruan + (jembatan) Telegram fake;
tidak ada pesan ke grup nyata, tidak ada perubahan service Render. Tes
jembatan menyalin kode ke /tmp (repo tidak tersentuh) dan menguji: auth
bridge (401/403), kind request/order, whitelist kirim, reply_to tak dikenal,
duplikat, rate limit, potongan teks, katalog kosong, URL anggota ditolak,
URL pemilik lolos, field `/health`, cutoff tunggakan (pesan pra-start
tidak dijawab), sapaan, file tak dikenal, fallback + follow-up, log tanpa
isi pesan, dan tidak ada kirim ulang.

## Langkah upload + deploy + uji (SETELAH lampu hijau Pak)

Urutan ini dilakukan Bowo (upload lewat browser, sesi GitHub Pak) + Pak
(env). **Jangan mulai sebelum laporan implementasi ditinjau.**

1. **Env baru di dashboard Render** (Pak mengetikkan nilainya sendiri,
   Bowo hanya memverifikasi NAMANYA ada):
   - `BRIDGE_SECRET` (nilai baru; nilai yang SAMA dipakai EnvironmentFile worker).
   - `OWNER_USER_ID` (user_id Telegram Pak; bila dikosongkan, semua pesan
     = permintaan anggota — perintah URL Pak tidak dikenali).
   - Pastikan `BRIDGE_DRY_RUN` dan `BRIDGE_FAKE_TELEGRAM` TIDAK di-set.
2. **Upload lewat browser GitHub** (Bowo, sesi Pak): file yang diubah/dibuat
   (lihat laporan implementasi) ke repo `nusarastudios-web/bot-grup-inti-nusara`.
3. **Render men-deploy otomatis**; tunggu status Live.
4. **Verifikasi `/health`**: `bridge_configured: true`,
   `owner_configured: true` (bila OWNER_USER_ID diisi),
   `catalog_count: 0` (katalog masih kosong), `test_mode: false`.
   Bila `test_mode: true`, BERHENTI — ada env tes yang tersisa.
5. **Verifikasi webhook masih terpasang** (uji "Bowo halo" adalah bukti
   langsung; bila ragu, Pak memeriksa info webhook dengan cara yang sama
   seperti saat set webhook — token tidak lewat Bowo).
6. **Pasang + jalankan worker** (induk/Bowo, di VM): salin unit systemd,
   buat EnvironmentFile (mode 0600, di luar repo), `daemon-reload`,
   `enable`, `start`, periksa `status` + log journal.
7. **Uji live berurutan** (semua harus lolos sebelum dinyatakan selesai):
   1. "Bowo halo" → bot membalas sapaan langsung (target hitungan detik).
   2. Pesan tanpa kata "Bowo" → bot diam total.
   3. Anti-loop: tepat satu balasan, tidak beruntun.
   4. Permintaan file anggota: "Bowo kirim <nama>" di luar katalog →
      jawaban jujur "tidak ada". (File katalog terkirim baru bisa diuji
      sesudah Pak mengisi satu entri katalog.)
   5. Perintah Pak: "Bowo kirim <URL>" → bot mengirim file-nya.
   6. File tak dikenal (ulang, sesudah katalog terisi) → tetap "tidak ada".
   7. Sesudah deploy ulang: "Bowo halo" lagi → tetap membalas (webhook
      selamat dari deploy).
   8. Spam: kirim "Bowo" bertubi-tubi → bot membatasi (tidak membanjiri).
   - Bila ada uji gagal: hentikan, perbaiki, ulangi dari uji 1.
   - Bila bot spam/loop di tengah uji: matikan darurat dengan mencabut
     webhook (Pak, dengan cara yang sama seperti set webhook — token tidak
     lewat Bowo) atau mengembalikan file repo ke versi kerangka; kerangka
     antre-saja adalah fallback yang aman.

## Keterbatasan Render Free (jujur, sebelum go-live)

- Disk tidak persisten: antrean + catatan kiriman bisa hilang saat
  restart/tidur/deploy ulang. Diterima karena penanda worker (VM) +
  idempotensi kiriman meminimalkan balasan ganda; pesan yang belum sempat
  dijawab saat server mati lama bisa hilang tanpa balasan (pengguna bisa
  mengulang panggilan "Bowo").
- Tidur: pesan pertama sesudah tidur telat sampai server bangun
  (puluhan detik). Ping `/health` berkala mengurangi tidur; monitor
  otomatis (bila disetujui Pak) lebih andal daripada ping manual.
- Satu instance: rate limit in-memory (bukan lintas instance) — cukup
  untuk Free (satu instance), dan batas Telegram sendiri menjadi backstop.
