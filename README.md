# Bot Telegram Grup Inti Nusara Studio — Kerangka Server

Status: **KODE SIAP DEPLOY KE RENDER FREE, TAPI BELUM DI-DEPLOY DAN BELUM HIDUP DI GRUP NYATA.**
Kerangka server + file deploy (render.yaml, Procfile, .gitignore) sudah ada di folder ini. Belum ada deploy ke Render, belum ada webhook yang di-set, belum ada token yang ditulis di mana pun.
Bot Telegram `@bowo_agent_bot` sudah dibuat Pak di BotFather dan privacy mode
sudah DISABLED, grup inti sudah dibuat dan bot + 2 orang inti sudah masuk grup.
Server ini belum membalas apa pun ke grup: pesan yang memanggil "Bowo" hanya
ditulis ke antrean file, untuk dijawab Bowo/Muse pada tahap berikutnya.

## Cara kerja (tahap kerangka)

1. Telegram mengirim update webhook POST ke `/webhook/<WEBHOOK_SECRET>`.
2. Server memeriksa secret (path + header `X-Telegram-Bot-Api-Secret-Token`
   bila header itu dikirim) dan whitelist `GROUP_CHAT_ID`.
3. Bila pesan bukan dari grup whitelist, atau tidak mengandung kata "Bowo"
   (case-insensitive, batas kata), server **DIAM total** — tidak antre, tidak balas.
4. Bila mengandung "Bowo", server menulis satu baris JSON ke
   `queue/incoming.jsonl` dan membalas 200 cepat ke Telegram.
5. **Tidak ada** panggilan ke Telegram Bot API dari server ini, jadi tidak
   ada pesan yang terkirim ke grup nyata pada tahap ini.

## Cara jalan lokal

```bash
cd ~/workspace/nusara-studio/bot-grup-inti
WEBHOOK_SECRET=isi-rahasia-sendiri GROUP_CHAT_ID=-100xxxxxxxxxx node server.js
# cek kesehatan:
curl -s http://127.0.0.1:3000/health
```

Tanpa env, server tetap jalan (port 3000) dalam mode tes lokal, tapi
**tidak mengantrekan apa pun** selama `GROUP_CHAT_ID` kosong — itu sengaja,
supaya kerangka yang belum dikonfigurasi tidak menangkap pesan sembarangan.

## Tes lokal

```bash
cd ~/workspace/nusara-studio/bot-grup-inti
node test-local.js
```

Tes memakai update Telegram **tiruan** ke server lokal (port 3456) dan
memeriksa 3 kasus wajib + 1 bonus:

- (a) grup whitelist + "Bowo halo" → masuk antrean
- (b) grup whitelist tanpa "Bowo" → tidak masuk antrean, diam
- (c) grup lain + "Bowo halo" → diabaikan
- (d) bonus: "bowo" huruf kecil di grup whitelist → masuk antrean

Tes membersihkan `queue/incoming.jsonl` dulu, jadi hitungannya murni dari tes.

## Env yang dibutuhkan

| Variabel | Wajib? | Keterangan |
|---|---|---|
| `PORT` | Tidak (default 3000) | Port yang didengarkan server. Render mengisi ini sendiri. |
| `TELEGRAM_BOT_TOKEN` | Ya, untuk produksi | Token dari BotFather. **JANGAN tulis token nyata di file, di chat, atau di screenshot.** Di tahap kerangka boleh kosong (mode tes lokal). Server ini tidak memanggil Telegram API, tapi env ini dibaca untuk menandai mode. |
| `WEBHOOK_SECRET` | Sangat disarankan | String rahasia acak. Dipakai sebagai segmen path webhook dan sebagai `secret_token` saat set webhook. |
| `GROUP_CHAT_ID` | Ya, untuk produksi | ID numerik grup Telegram inti (mis. `-100xxxxxxxxxx`, negatif untuk grup). Hanya chat_id ini yang diproses. |

Contoh file env (JANGAN diisi nilai nyata di repo):

```bash
# .env.example — salin jadi .env di server, isi di sana, jangan commit
PORT=3000
TELEGRAM_BOT_TOKEN=
WEBHOOK_SECRET=
GROUP_CHAT_ID=
```

## Cara set webhook nanti (SETELAH token aman + hosting diputuskan)

Perintah ini **JANGAN dijalankan sekarang** (kerangka saja, tanpa token,
tanpa deploy). Nanti, setelah server sudah hidup di URL publik, jalankan
dari mesin yang memegang token — ganti `<TOKEN>`, `<SECRET>`, dan
`<URL-PUBLIK-SERVER>` dengan nilai sebenarnya, tanpa menempelkannya di chat:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=<URL-PUBLIK-SERVER>/webhook/<SECRET>" \
  -d "secret_token=<SECRET>"
```

Verifikasi: `getWebhookInfo` harus menunjukkan URL dan `pending_update_count`
yang wajar, dan kirim "Bowo halo" di grup inti harus menambah satu baris di
`queue/incoming.jsonl` tanpa balasan otomatis apa pun (sampai tahap jembatan
jawaban dibangun).

## Deploy ke Render Free

Langkah ini **BELUM dilakukan** — daftar di bawah ini adalah langkah yang masih butuh tangan Pak/Bowo di browser Render. Jangan jalankan set webhook sebelum service ini hidup dan env-nya terisi.

1. **Push kode ke GitHub.** Folder `bot-grup-inti` ini harus jadi root repo, atau bila repo-nya monorepo, catat folder ini untuk dipakai sebagai Root Directory di langkah 3. Pastikan `.env` dan `queue/*.jsonl` tidak ikut ter-push (sudah dikecualikan `.gitignore` di folder ini).
2. **Render Dashboard → New → Web Service → hubungkan repo GitHub** yang berisi kode ini.
3. **Pengaturan service:**
   - Name: `bot-grup-inti-nusara` (atau nama lain yang belum dipakai di akun Render itu)
   - Region: pilih yang terdekat (layanan Nusara lain memakai Singapore)
   - Branch: `main`
   - Root Directory: kosongkan bila folder ini adalah root repo; isi `bot-grup-inti` (atau path folder ini di repo) bila repo-nya monorepo
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
   - Health Check Path: `/health` (sudah tertulis di `render.yaml`)
   - Bila Render menawarkan memakai `render.yaml` (Blueprint), nilai di atas sudah sama dengan isi file itu — env tetap harus diisi manual di langkah 4, karena `render.yaml` memakai `sync: false` dan tidak membawa nilai rahasia.
4. **Isi Environment Variables di dashboard Render (Environment), BUKAN di repo, BUKAN di chat:**

   | Variabel | Isi |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | Token dari BotFather (hanya pemegang token yang menempelkannya di dashboard) |
   | `WEBHOOK_SECRET` | String rahasia acak buatan sendiri (dipakai juga sebagai segmen path webhook) |
   | `GROUP_CHAT_ID` | ID numerik grup Telegram inti (negatif untuk grup, mis. `-100xxxxxxxxxx`) |

   `PORT` **JANGAN** diisi manual: Render mengisinya otomatis, dan `server.js` sudah membaca `PORT` dari env serta mengikat `0.0.0.0`.
5. **Deploy, lalu verifikasi:** buka `<url-render>/health` di browser — harus kembali `{"ok":true,...}` dengan cepat. Bila masih 404 / tidak merespons, jangan lanjut ke webhook; periksa log deploy Render dulu.
6. **URL untuk list ping Pak (PENTING, tanpa rahasia):**

   ```
   <url-render>/health
   ```

   Contoh bentuknya (ganti `<url-render>` dengan URL service Render yang sebenarnya, tanpa nilai lain):

   ```
   https://bot-grup-inti-nusara.onrender.com/health
   ```

   Masukkan **persis URL `/health` itu** ke list ping Pak, BUKAN URL root `/` (root mengembalikan 404) dan BUKAN URL webhook (webhook mengandung secret). Endpoint `/health` publik, cepat, tanpa token, tanpa secret, tanpa chat id — hanya mengembalikan `ok` + boolean konfigurasi, tanpa nilai rahasia apa pun — jadi aman untuk di-ping berkala supaya Render Free tidak tidur.
7. **Baru sesudah service hidup + env terisi + `/health` lolos, set webhook** dengan perintah di bagian "Cara set webhook nanti" di atas, memakai URL webhook:

   ```
   <url-render>/webhook/<SECRET>
   ```

   `<SECRET>` di sini adalah nilai `WEBHOOK_SECRET` yang sama dengan yang diisi di dashboard — jangan ditempel di chat, jangan dimasukkan ke list ping.

**Catatan keterbatasan Render Free (jujur, sebelum go-live):** disk Render Free tidak persisten — antrean file `queue/incoming.jsonl` bisa hilang saat service restart/tidur, dan deploy ulang juga mengosongkannya. Untuk tahap kerangka ini diterima (antrean hanya penampung sementara sebelum jembatan jawaban dibangun); sebelum bot dipakai penuh di grup inti, jembatan jawaban harus membaca antrean dengan cepat atau antrean dipindah ke penyimpanan persisten, supaya pesan yang memanggil "Bowo" tidak hilang saat restart.

## Pilihan hosting yang perlu diputuskan Pak

1. **Server selalu hidup (berbayar / VPS / layanan always-on)**
   - Kelebihan: pesan webhook sampai dalam hitungan detik, jawaban cepat,
     sesuai janji realtime untuk grup inti.
   - Kekurangan: ada biaya bulanan (besarnya tergantung penyedia), perlu
     perawatan (restart, log, keamanan).
2. **Hosting gratis yang tidur (mis. Render Free)**
   - Kelebihan: tanpa biaya.
   - Kekurangan: server tidur saat sepi; pesan pertama sesudah tidur bisa
     telat 30–60 detik (atau lebih) sampai server bangun, webhook Telegram
     bisa menumpuk / mengulang. Untuk grup inti yang mengharapkan respons
     cepat saat dipanggil, ini adalah kelemahan nyata.
3. **Server lokal / VM yang sudah jalan (jika tersedia dan punya URL publik)**
   - Kelebihan: tanpa biaya baru, Bowo sudah punya pola watchdog untuk
     server lokal + relay.
   - Kekurangan: ketergantungan pada mesin itu (mati = bot mati), dan URL
     publiknya harus stabil + HTTPS (syarat webhook Telegram).

Rekomendasi kerangka: putuskan hosting **sebelum** set webhook, karena URL
webhook terikat ke hosting yang dipilih. Jangan set webhook ke URL sementara
lalu pindah-pindah — setiap pindah harus set webhook ulang.

## Yang masih kurang sebelum bot bisa menjawab di grup nyata

1. **Token aman**: token BotFather dimasukkan lewat formulir/env aman di
   server (bukan lewat chat, bukan di file repo).
2. **Hosting diputuskan + server di-deploy** (lihat pilihan di atas).
3. **Webhook di-set** ke URL publik server (perintah di atas).
4. **Group chat ID nyata** dimasukkan ke `GROUP_CHAT_ID` (didapat saat bot
   menerima pesan pertama di grup, atau dari info grup — bukan ditebak).
5. **Jembatan jawaban Bowo**: pekerja/penjadwal yang membaca
   `queue/incoming.jsonl`, meminta jawaban ke Bowo/Muse, lalu mengirim
   jawaban itu kembali ke grup lewat Telegram Bot API. Bagian ini BELUM ADA
   di kerangka ini — inilah yang membuat bot saat ini hanya mengantre, bukan
   menjawab. Aturan jawaban di grup (jawab langsung saat dipanggil vs
   konfirmasi ke Pak dulu per pesan) juga perlu diputuskan Pak sebelum
   jembatan ini dibangun, karena berpengaruh ke kecepatan respons.
6. **Uji di grup nyata**: "Bowo halo" → antre + jawab; obrolan tanpa "Bowo"
   → diam; pesan dari grup lain → diabaikan. Uji ini baru sah sesudah
   poin 1–5 selesai.
