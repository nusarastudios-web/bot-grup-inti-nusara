# Rancangan Jembatan Jawaban Bot Telegram Grup Inti Nusara Studio

Status: RANCANGAN SAJA. Dokumen ini bukan kode, belum di-deploy, dan tidak mengubah server yang sedang jalan. Server kerangka tetap berjalan apa adanya sampai rancangan ini disetujui Pak dan dibangun.

Disusun: 3 November 2026. Bot: @bowo_nusara_bot. Service Render: bot-grup-inti-nusara. Repo: nusarastudios-web/bot-grup-inti-nusara.

## Keadaan sekarang (sudah terbukti)

- Bot @bowo_nusara_bot sudah masuk grup inti, privacy DISABLED (menerima semua pesan grup).
- Webhook sudah terpasang (3 Nov 2026).
- Antrean live (di Render) terverifikasi: pesan "Bowo halo" masuk antrean 3 Nov 2026 10:07:56 WIB. Sampai rancangan ini ditulis, antrean live berisi 3 pesan yang mengandung "Bowo" (10:07:56, 10:13:48, dan 10:40:48 WIB; yang terakhir adalah tes "halo bowo" huruf kecil, lolos saringan case-insensitive).
- Server sekarang HANYA mencatat: webhook → saring kata "Bowo" → tulis antrean → jawab 200 cepat ke Telegram. TIDAK membalas ke grup, TIDAK memanggil API Telegram.
- Pemicu: kata "Bowo" saja, huruf besar/kecil bebas, harus berdiri sendiri sebagai kata (bukan "Bowok" atau "kebowoan"). Pesan dari akun bot lain diabaikan. Hanya grup yang di-whitelist yang diproses. Log server hanya mencatat chat_id, message_id, dan status — bukan isi pesan.
- Catatan: README.md di folder ini masih menggambarkan keadaan lama (bot lama, belum deploy) — perbarui saat pembangunan agar tidak menyesatkan.

## Spesifikasi Pak (sudah diputuskan 3 Nov 2026, jangan diubah)

1. Jawab LANGSUNG di grup tanpa konfirmasi per pesan.
2. REALTIME + CEPAT membalas.
3. Bisa MENGIRIM FILE: foto, video, dokumen (batas Telegram 50 MB per file).
4. Pemicu kirim file KEDUANYA: saat anggota grup memintanya DAN saat Pak/Bowo memerintahkannya.

## 1. Cara kerja otak bot: dari mana jawaban berasal

Fakta dasar yang menentukan semua opsi: server TIDAK BISA menelepon Bowo (Muse) secara langsung. Bowo tidak punya nomor API yang bisa dipanggil server dalam hitungan detik. Jadi otak bot harus salah satu dari tiga opsi di bawah.

### Opsi A — Server memanggil API LLM (otak di dalam server)

Cara kerja: saat pesan "Bowo" masuk lewat webhook, server langsung meminta jawaban ke layanan AI (API LLM) dengan kunci yang disimpan di env Render (nama env baru, mis. LLM_API_KEY — nilainya hanya Pak yang menempelkan, seperti token bot). Setelah jawaban didapat, server mengirimnya ke grup lewat sendMessage. Semua terjadi di dalam satu service.

- Kelebihan: paling cepat (jawaban dalam hitungan detik, tanpa menunggu proses lain); arsitektur paling sederhana (satu service, tanpa bagian tambahan); paling cocok untuk "realtime + cepat".
- Kekurangan: butuh kunci API baru (ada biaya/kuota pemakaian, tergantung provider); bila layanan AI lambat/mati, jawaban ikut telat/gagal (perlu batas waktu + pesan fallback); kunci harus dijaga (bila bocor, orang lain bisa memakai kuota).
- Yang harus disediakan Pak: kunci API LLM dari provider yang dipilih + persetujuan batas biaya/kuota.

### Opsi B — Worker Bowo membaca antrean berkala (otak = Bowo sendiri)

Cara kerja: proses terpisah (worker) mengecek antrean secara berkala, Bowo menyusun jawaban dengan konteks dan ingatan penuhnya, lalu jawaban dikirim ke grup. Karena antrean live ada di disk Render (bukan di mesin Bowo), server perlu endpoint internal baru yang hanya menampilkan antrean tertunda untuk worker.

- Kelebihan: jawaban benar-benar dari Bowo (konteks, ingatan, penilaian GM); tanpa biaya API LLM; tanpa kunci baru.
- Kekurangan: TIDAK realtime — kecepatan = interval pengecekan (tiap 1 menit berarti telat sampai sekitar 1 menit + waktu menyusun; tiap 10 detik butuh proses yang jalan terus dan harus diawasi supaya tidak mati); lebih banyak bagian yang bisa rusak (endpoint + worker + jalur kirim); antrean di disk Render bisa hilang saat restart sebelum worker membacanya.
- Yang harus disediakan Pak: penerimaan bahwa jawaban tidak seketika (telat menit, bukan detik) ATAU persetujuan menjalankan worker terus-menerus dengan pengawasan.

### Opsi C — Hybrid: jalur cepat + jalur Bowo (gabungan A dan B)

Cara kerja: server menjawab langsung lewat API LLM untuk pesan biasa (jalur cepat, realtime). Bila pesan butuh data internal, keputusan Pak, atau jawaban AI terlihat ragu, pesan itu tetap dicatat untuk ditindaklanjuti Bowo (koreksi/tambahan jawaban menyusul). Kirim file sederhana (katalog) juga lewat jalur cepat tanpa AI.

- Kelebihan: realtime untuk sebagian besar pesan + kualitas Bowo untuk pesan yang penting; ada jaring pengaman saat AI gagal.
- Kekurangan: paling rumit dibangun dan dirawat (dua jalur + aturan kapan pindah jalur); biaya API LLM tetap ada + usaha Bowo tetap ada.
- Yang harus disediakan Pak: kunci API LLM (seperti opsi A) + kesepakatan aturan pindah jalur (pesan apa yang wajib ke Bowo).

### Rekomendasi: Opsi A sebagai jalur utama, dengan jaring pengaman gaya C

Alasan: hanya opsi A yang benar-benar memenuhi "realtime + cepat" tanpa proses tambahan yang harus dijaga terus. Jaring pengamannya: bila API LLM gagal atau melewati batas waktu, bot mengirim satu pesan fallback jujur ("Maaf, saya belum bisa menjawab sekarang — Bowo akan menjawab menyusul") dan pesan itu tetap tercatat untuk Bowo. Jadi tidak ada pesan yang hilang diam-diam, dan tidak ada jawaban karangan saat otak gagal. Opsi B (worker berkala) TIDAK direkomendasikan sebagai jalur utama karena melanggar janji realtime; opsi B hanya cocok sebagai pelengkap (tindak lanjut Bowo), bukan sebagai otak utama.

Catatan persona: AI harus diberi instruksi tertulis (disimpan di repo, bukan rahasia) bahwa ia menjawab sebagai Bowo, GM Nusara Studio, Bahasa Indonesia, singkat dan santai, tidak mengarang harga/janji/data internal, dan untuk hal yang tidak ia ketahui ia menjawab jujur + mengarahkan ke Pak/Bowo.

## 2. Mekanisme realtime: balas langsung dari webhook vs polling

### Balas langsung dari webhook (direkomendasikan)

Alur: Telegram mengantar pesan ke server seketika (webhook sudah terpasang) → server membalas 200 CEPAT ke Telegram (supaya Telegram tidak mengulang kirim) → di belakang layar server menyusun jawaban → mengirim jawaban ke grup. Total telat = waktu susun jawaban (hitungan detik, untuk opsi A).

- Ini satu-satunya cara yang memenuhi "realtime + cepat" dengan webhook yang sudah terpasang.
- Risiko: (a) Render Free tidur — pengiriman pertama sesudah tidur telat sampai server bangun (puluhan detik); obatnya ping /health berkala (saat ini manual oleh Pak; monitor otomatis lebih baik — lihat daftar keputusan). (b) Server tidak boleh lama-lama sebelum membalas 200 — bila 200 telat, Telegram mengulang kirim update yang sama → risiko balasan ganda; obatnya: balas 200 dulu, proses kemudian, plus pencatatan nomor update yang sudah diproses supaya update yang sama tidak dibalas dua kali.

### Polling (server bertanya berkala "ada pesan baru?")

Alur: server (atau proses lain) bertanya ke Telegram setiap beberapa detik apakah ada pesan baru, lalu menjawab yang ditemukan.

- Kekurangan: Telegram hanya mengizinkan SATU cara — webhook ATAU polling, tidak keduanya. Memakai polling berarti webhook yang sudah terpasang harus dicabut dulu. Telat = interval tanya (tidak pernah seketika). Polling butuh proses yang jalan terus — di Render Free, tidur mematikan polling.
- Kesimpulan: polling TIDAK direkomendasikan selama webhook sudah jalan. Polling hanya jadi cadangan bila webhook terbukti tidak bisa diandalkan.

### Peran antrean berubah

Sejak jembatan aktif, antrean (queue/incoming.jsonl) BERHENTI menjadi daftar kerja. Balasan diproduksi langsung dari update webhook yang sedang masuk, bukan dari membaca file antrean belakangan. File antrean tetap ditulis sebagai riwayat/audit (bukti pesan apa saja yang pernah memanggil Bowo), bukan sebagai sumber jawaban. Ini penting karena disk Render Free tidak persisten: antrean bisa hilang saat restart — dan itu tidak masalah bila jawaban tidak bergantung padanya.

## 3. Desain kirim file

### Metode Telegram

- Foto: sendPhoto. Video: sendVideo. Dokumen: sendDocument. Semua dikirim HANYA ke grup whitelist (tidak pernah ke chat lain). Setiap kiriman memakai caption pendek Bahasa Indonesia (nama file + satu baris keterangan, tanpa info internal).
- Batas: 50 MB per file. Server memeriksa ukuran sebelum mengirim; file yang melebihi batas ditolak dengan balasan jujur (bukan dikirim setengah-setengah).

### File berasal dari mana (urutan yang direkomendasikan)

1. Katalog di repo (mulai dari sini): file kecil yang stabil (mis. pricelist, one-pager, contoh) disimpan di repo dengan daftar nama (katalog: nama panggilan → file). Mengganti file = upload baru lewat browser GitHub (sesi Pak) + deploy ulang. Sederhana, tanpa otorisasi baru.
2. URL publik: file yang sudah ada di alamat publik yang stabil — server meneruskan URL itu ke Telegram. Fleksibel, tapi URL harus publik dan tidak berubah-ubah.
3. Kiriman Pak/Bowo (tahap berikutnya, bila perlu): Pak/Bowo mengirim file ke bot/server lewat jalur khusus (mis. chat pribadi ke bot atau folder Drive) lalu memerintahkan bot meneruskannya ke grup. Ini butuh jalur upload baru — tidak dibangun di tahap pertama.
- Tahap pertama jembatan: hanya katalog repo + URL publik. Jalur kiriman Pak/Bowo ditunda sampai katalog terbukti jalan.

### Membedakan permintaan anggota vs perintah Pak/Bowo

Pembeda utama yang andal: ID pengguna Telegram pengirim (user_id).

- Pesan dari Pak (dan dari operator Bowo) dikenali lewat user_id yang disimpan di env Render baru (nama env, mis. OWNER_USER_ID — nilainya hanya Pak yang menempelkan, tidak dikirim ke Bowo). Pesan dari user_id ini = perintah: boleh memicu file apa pun dari katalog + URL yang disebutkannya, dan boleh memerintahkan kiriman lain.
- Pesan dari anggota lain = permintaan: HANYA boleh memicu file katalog (nama yang ada di daftar). Anggota tidak bisa memerintahkan bot mengirim file sembarangan/URL sembarangan — ini mencegah penyalahgunaan (bot dipakai mengirim file sampah/berbahaya oleh anggota).
- Bila OWNER_USER_ID belum diisi, semua pesan diperlakukan sebagai permintaan anggota (katalog saja) — perintah Pak tidak dikenali sampai env itu diisi. Ini default yang aman.
- Cara bot mengenali permintaan file: pesan mengandung "Bowo" + kata minta/kirim + nama file (mis. "Bowo kirim pricelist", "Bowo minta video dongeng"). Bot mencocokkan nama ke katalog; bila tidak cocok, bot menjawab jujur bahwa file itu tidak ada (tidak mengarang file).
- Pesan file dari anggota (foto/video/dokumen yang dikirim anggota ke grup) TIDAK diproses sebagai perintah — jembatan tahap pertama hanya memproses pesan teks. Ini mencegah bot meneruskan file sembarangan.

## 4. Pengaman

### Anti-loop (bot tidak membalas dirinya sendiri)

- Pesan dari akun bot mana pun sudah diabaikan (termasuk pesan bot sendiri) — ini sudah ada di kerangka dan WAJIB dipertahankan.
- Tambahan: balasan bot tidak boleh memicu balasan lagi — karena pesan bot diabaikan, rantai tidak mungkin terbentuk. Uji wajib: satu pesan "Bowo halo" menghasilkan tepat satu balasan, tidak beruntun.
- Deduplikasi: setiap update Telegram punya nomor update_id. Server mencatat update_id yang sudah diproses; update yang sama datang dua kali (karena Telegram mengulang kirim) dilewati, tidak dibalas dua kali.

### Anti-spam / rate limit

- Balasan teks: dibatasi (mis. maks 1 balasan per 10 detik per orang, dan jeda antar balasan di grup) — bila melewati batas, bot diam (tidak membanjiri grup dengan "sabar ya" berulang). Angka pasti diputuskan Pak (lihat daftar keputusan).
- Telegram sendiri membatasi sekitar 1 pesan/detik per chat. Server mengirim satu per satu secara berurutan; bila Telegram menjawab 429 (terlalu cepat), server menunggu sesuai waktu yang diminta Telegram, tidak memaksa.
- Kirim file dibatasi lebih ketat (mis. maks 1 file per menit, maks beberapa file per jam) karena file lebih berat dan lebih mengganggu bila disalahgunakan.
- Bot TIDAK PERNAH memulai percakapan sendiri dan TIDAK PERNAH broadcast — bot hanya membalas di grup whitelist, hanya saat dipanggil "Bowo" atau diperintah Pak/Bowo.
- Pesan sangat panjang (di atas 4096 karakter, batas Telegram) dipotong/dibagi per paragraf, bukan dibuang.

### Perilaku saat restart / tidur Render

- Restart (termasuk deploy ulang): webhook TIDAK hilang (tersimpan di pihak Telegram, menunjuk URL yang sama) — tidak perlu set webhook ulang, tapi wajib diverifikasi sesudah tiap deploy (uji "Bowo halo"). Antrean file bisa hilang — diterima, karena jawaban tidak bergantung pada antrean (lihat bagian 2). Nomor update_id yang sudah diproses ikut hilang — risiko balasan ganda kecil karena Telegram tidak mengirim ulang update yang sudah dibalas 200.
- Tidur: pesan yang datang saat tidur tertunda sampai server bangun; Telegram menahan dan mengulang pengiriman untuk sementara waktu, jadi pesan tidak hilang — hanya telat. Setelah bangun, server memproses update yang tertunda secara berurutan (dengan deduplikasi). Ping /health berkala mengurangi tidur; monitor otomatis (bila disetujui Pak) lebih andal daripada ping manual.
- Gagal total (server mati lama): pesan yang sudah dibalas 200 tapi belum sempat dijawab akan hilang tanpa balasan. Obatnya: pesan fallback saat otak gagal + pengguna bisa mengulang panggilan "Bowo". Tidak ada antrean penyelamat yang bisa diandalkan di Render Free — ini keterbatasan yang diterima, bukan disembunyikan.

### Privasi

- Log tetap metadata saja (chat_id, message_id, status) — isi pesan dan isi file TIDAK ditulis ke log Render.
- Token, secret webhook, kunci API, dan user_id pemilik TIDAK PERNAH ditulis di kode, dokumen, atau chat — hanya nama env-nya.
- File antrean berisi teks pesan grup — data internal grup inti, jangan dipublikasikan.

## 5. Tunggakan antrean: jawab pesan lama atau hanya pesan baru?

Antrean live saat ini berisi 3 pesan "Bowo" (10:07:56, 10:13:48, dan 10:40:48 WIB, yang terakhir tes "halo bowo" huruf kecil). Rancangan harus menentukan nasibnya.

### Pilihan yang dipertimbangkan

- Pilihan 1 — Jawab tunggakan: saat jembatan pertama aktif, bot menjawab semua pesan lama di antrean satu per satu.
- Pilihan 2 — Hanya pesan baru: bot hanya menjawab pesan yang masuk SESUDAH jembatan aktif; isi antrean lama dianggap riwayat dan tidak dijawab.

### Rekomendasi: Pilihan 2 — hanya pesan baru

Alasan:

1. Tiga pesan itu adalah pesan TES dari tahap verifikasi (termasuk "Bowo halo" dan tes huruf kecil "halo bowo"), bukan pertanyaan nyata yang menunggu jawaban. Membalasnya berjam-jam kemudian hanya membingungkan grup ("kenapa bot baru membalas sapaan tes tadi?").
2. Antrean di disk Render Free tidak bisa dipercaya sebagai daftar kerja — bisa hilang saat restart. Desain yang bergantung pada menguras antrean lama adalah desain yang rapuh.
3. Risiko balasan ganda: setiap restart/deploy bisa membuat bot mengulang jawaban lama bila penanda "sudah dijawab" ikut hilang. Mengabaikan antrean lama menghilangkan seluruh kelas risiko ini.
4. Konsisten dengan desain realtime: jawaban diproduksi dari update webhook yang sedang masuk, bukan dari file antrean. "Pesan baru" = setiap update webhook yang masuk sesudah jembatan aktif — termasuk pesan yang tertunda karena server tidur (Telegram mengulang pengirimannya saat server bangun, jadi pesan itu tetap sampai sebagai update baru, bukan tunggakan).

Aturan cutover (wajib ditulis di rencana deploy): catat waktu aktif jembatan. Semua entri antrean dengan waktu terima SEBELUM waktu itu = riwayat saja, tidak dijawab, tidak dihapus paksa (dibiarkan hilang alami saat restart). Semua update webhook SESUDAH waktu itu = dijawab sesuai spesifikasi.

Pengecualian manual (bukan otomatis): bila Pak menginginkan satu pesan lama dijawab, Pak mengirim ulang pesannya (atau memerintahkan bot menjawabnya) — itu adalah pesan/perintah baru, jadi dijawab. Tidak ada pengurasan otomatis.

## 6. Langkah bangun + deploy + uji

### Bangun (Bowo menyiapkan file, Pak mengunggah — tanpa git push langsung)

1. Tambahkan pengirim Telegram (sendMessage, sendPhoto, sendVideo, sendDocument) yang memakai token dari env (nama env saja, tanpa nilai di kode). Diusahakan tetap tanpa dependensi baru (Node bawaan sudah cukup untuk sebagian besar jalur).
2. Tambahkan jalur otak sesuai opsi yang dipilih Pak (bagian 1) + batas waktu + pesan fallback saat otak gagal.
3. Tambahkan pengaman (bagian 4): abaikan pesan bot, deduplikasi update_id, rate limit, balas 200 dulu baru proses, potong pesan panjang.
4. Tambahkan katalog file (nama → file/URL) + pengenal perintah Pak lewat env OWNER_USER_ID (nama saja).
5. Pertahankan perilaku lama yang sudah terbukti: /health, whitelist grup, pemicu "Bowo", diam total tanpa pemicu, log metadata saja.
6. Uji lokal dulu (seperti tes kerangka: update tiruan, tanpa kirim ke Telegram nyata): pemicu lolos, tanpa pemicu diam, pesan bot diabaikan, katalog cocok/tidak cocok, rate limit jalan.

### Deploy (lewat browser GitHub, sesi Pak)

1. Bowo menyiapkan file yang diubah; Pak mengunggahnya lewat browser GitHub ke repo (Bowo tidak git push langsung).
2. Render men-deploy otomatis; tunggu status Live.
3. Verifikasi /health (mode + boolean konfigurasi) — tanpa nilai rahasia.
4. Verifikasi webhook masih terpasang (uji "Bowo halo" di grup adalah bukti langsung; bila ragu, Pak memeriksa info webhook dengan cara yang sama seperti saat set webhook — token tidak lewat Bowo).
5. Bila ada env baru (kunci API, OWNER_USER_ID), Pak menempelkannya sendiri di dashboard Render SEBELUM deploy dianggap selesai — Bowo hanya memverifikasi nama env-nya ada, bukan nilainya.

### Uji (di grup, berurutan — semua harus lolos sebelum dinyatakan selesai)

1. Uji balas "Bowo halo": kirim "Bowo halo" → bot membalas langsung → ukur telatnya (target: hitungan detik, bukan menit).
2. Uji diam: pesan tanpa kata "Bowo" → bot diam total.
3. Uji anti-loop: balasan bot tidak memicu balasan lanjutan (tepat satu balasan).
4. Uji kirim file (permintaan anggota): "Bowo kirim <nama katalog>" → bot mengirim file + caption.
5. Uji kirim file (perintah Pak): Pak memerintahkan file → bot mengirimnya.
6. Uji file tidak dikenal: minta file di luar katalog → bot menjawab jujur tidak ada (tidak mengarang).
7. Uji sesudah deploy ulang: kirim "Bowo halo" lagi → tetap membalas (webhook selamat dari deploy).
8. Uji spam: kirim "Bowo" bertubi-tubi → bot membatasi (tidak membanjiri).
- Bila ada uji gagal: hentikan, perbaiki, ulangi dari uji 1. Bila bot berperilaku spam/loop di tengah uji: matikan darurat dengan mencabut webhook (Pak, dengan cara yang sama seperti set webhook — token tidak lewat Bowo) atau mengembalikan file repo ke versi kerangka; kerangka antre-saja adalah fallback yang aman.

## 7. Keputusan yang masih perlu Pak (satu per baris)

- Otak bot: Opsi A (API LLM di server), Opsi B (worker Bowo berkala), atau Opsi C (hybrid)?
- Bila API LLM: provider apa dan berapa batas biaya/kuota per bulan yang diizinkan?
- Siapa yang membuat dan menempelkan kunci API LLM ke env Render (Pak sendiri, seperti token bot)?
- Persona jawaban: bot menjawab sebagai Bowo dengan gaya apa (rekomendasi: singkat, santai, Bahasa Indonesia)?
- Katalog file awal: file apa saja yang boleh diminta anggota (daftar nama + file/URL-nya)?
- Apakah perintah Pak dibedakan lewat user_id Telegram (Pak menempelkan OWNER_USER_ID sendiri ke env) atau cukup format perintah khusus?
- Apakah boleh menambahkan monitor otomatis (mis. Better Stack/UptimeRobot) ke /health supaya service tidak tidur, atau tetap ping manual oleh Pak?
- Berapa batas spam yang dipakai (rekomendasi: maks 1 balasan per 10 detik per orang; file maks 1 per menit)?
- Uji live dilakukan di grup inti langsung atau di grup uji terpisah dulu?
- Topik apa yang TIDAK boleh dijawab bot langsung (mis. harga, janji, data internal) dan harus dialihkan ke Pak/Bowo?
- Bila otak gagal: bot mengirim pesan fallback ("Bowo akan menjawab menyusul") atau diam saja?
- Apakah tunggakan 3 pesan lama di antrean tetap tidak dijawab (sesuai rekomendasi), atau ada satu yang Pak ingin dijawab manual?
