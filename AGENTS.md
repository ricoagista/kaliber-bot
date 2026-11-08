# AGENTS.md — Panduan Kerja Agen untuk Kaliber Bot

## 1. Ringkasan Proyek
Kaliber Bot adalah chatbot WhatsApp otomatis dan web admin untuk LSO Kaliber (UMM Informatika). Sistem berjalan dalam satu proses Node.js di satu container dengan target perangkat berdaya rendah seperti STB arm64 (RAM kecil) maupun PC lokal.
- **Stack**: Node.js `>= 22.13`, TypeScript ESM, Hono (`@hono/node-server`), `node:sqlite` (`DatabaseSync`), `@whiskeysockets/baileys`, `pino`, `qrcode`.
- **Frontend**: Satu file `public/index.html` (HTML + CSS + JS vanilla, tanpa bundler/framework/CDN).
- **Spesifikasi Backend**: Seluruh perilaku, skema DB, dan kontrak API mengacu pada `PRD.md`.

## 2. Perintah Utama
- Instalasi: `npm ci` (atau `npm install` saat inisialisasi lockfile)
- Build: `npm run build` (menjalankan `tsc -p tsconfig.json`, wajib lulus setelah setiap perubahan kode)
- Menjalankan bot: `node --env-file=.env --max-old-space-size=128 dist/index.js`
  - Catatan: `.env` tidak dibaca otomatis oleh kode; wajib dilewatkan lewat flag `--env-file=.env`.
  - Untuk eksekusi lokal, gunakan `DATA_DIR=./data`.
  - Web admin dapat diakses di `http://127.0.0.1:3000` dengan login menggunakan `ADMIN_TOKEN`.

## 3. Aturan Tes
- Jangan menjalankan, mengubah, atau menambah tes otomatis (jangan membuat folder `test/` atau `scripts/test-*`).
- Verifikasi selalu dilakukan melalui `npm run build` dan pengujian manual dengan menjalankan bot.

## 4. Struktur Kode
```text
src/
  index.ts      Bootstrap aplikasi: validasi env, init DB, init settings, seed provider, start WA & HTTP, jadwal prune, graceful shutdown
  config.ts     Pembacaan environment variables, nilai DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, DEFAULT_INJECTION_PATTERNS
  db.ts         Koneksi node:sqlite (WAL mode), migrasi berurutan (PRAGMA user_version), fungsi query log/audit/strike/mute, pruneStorage()
  settings.ts   Cache settings in-memory, initSettings(), getSetting(), getSettings(), updateSettings(), resetSettings()
  crypto.ts     Enkripsi/dekripsi API key (AES-256-GCM + scrypt KEK cache format v2), migrasi format legacy, verifikasi REVEAL_PASSWORD
  providers.ts  CRUD provider & key, rotasi key round-robin + cooldown, strategi LLM (manual / round_robin / priority), buildModelPlan()
  endpoint.ts   Normalisasi Base URL provider & generator kandidat URL (/v1/... dan non-/v1/...)
  wa.ts         Koneksi Baileys WhatsApp, QR/pairing code, auto-reconnect eksponensial, ekstraksi pesan & JID, kirim balasan + efek mengetik
  pipeline.ts   Alur utama pemrosesan pesan 10 langkah (bebas dari dependensi Baileys)
  guard.ts      Normalisasi teks (NFKC + homoglyph folding), validasi anti-ReDoS regex, blocklist/mute/allowlist, rate limit, cooldown grup, strike
  prompt.ts     Render system prompt ({{NOW}}, {{CONTACT}}, {{KNOWLEDGE}}), escape & bungkus input user dengan <pesan_user>
  llm.ts        Klien HTTP ke LLM (callLlm, pingLlm, probeProvider), budget waktu total, retry, fallback antar model/provider
  sanitize.ts   Pembersihan output LLM: buang <think>, hapus tag internal, deteksi bocor 8 kata berurutan & pola rahasia, konversi Markdown WA
  memory.ts     Riwayat percakapan per pengirim di SQLite (TTL 6 jam, dibatasi N giliran)
  queue.ts      Antrean serial per pengirim (per-key promise chain) + semaphore konkurensi global (maksimal 2 tugas LLM paralel)
  api.ts        HTTP server Hono: security headers, body limit 64 KB, Bearer auth + rate limit IP, seluruh route /api/* dan static asset
  logger.ts     Logger pino (level dinamis mengikuti settings.log_level)
public/
  index.html    Aplikasi SPA Web Admin (memanggil /api/* dengan Authorization: Bearer <ADMIN_TOKEN>)
  kaliber.avif  Aset logo aplikasi
```

## 5. Provider dan API Key
- Maksimal **5 provider** dan maksimal **20 API key per provider**.
- Strategi pemilihan LLM (`llm_strategy`): `manual | round_robin | priority`.
- Setiap provider memiliki model default (`providers.model`); kandidat model menggunakan format `namaProvider/namaModel`.
- Pengujian koneksi/key dilakukan di sisi server melalui `probeProvider` (browser tidak pernah memanggil provider LLM secara langsung).
- Respons hasil tes tidak boleh membocorkan body upstream mentah, plaintext API key, atau URL internal.
- Status hasil tes disimpan di kolom `provider_keys.last_status` dan `last_checked_at`.

## 6. Aturan Teknis
- Dilarang menambah dependency berat (tanpa ORM, Redis, bundler, atau framework frontend); target RSS idle `< 150 MB`.
- Semua pengaturan di `settings.ts` berlaku langsung tanpa restart proses (hot-reload).
- Migrasi database SQLite wajib idempoten (`PRAGMA user_version`, satu statement per entri) dan tidak boleh menghapus data yang ada atau direktori `wa-auth`.
- Header keamanan CSP ketat dan seluruh aset disajikan secara lokal.
- `pipeline.ts` harus sepenuhnya bebas dari dependensi Baileys.
- Pemanggilan LLM dilakukan tanpa tools/function calling dan `stream: false`.

## 7. Aturan Keamanan
- API key disimpan terenkripsi dengan AES-256-GCM (`v2:`).
- API key asli, `ADMIN_TOKEN`, `SECRET_KEY`, dan `REVEAL_PASSWORD` tidak boleh muncul di log, pesan error, atau respons `GET` (hanya `keyLast4`).
- Perbandingan token wajib constant-time (`SHA-256` + `timingSafeEqual`).
- Endpoint sensitif (login, reveal key, endpoint tes) wajib dilindungi rate limit.
- Jangan pernah melakukan commit terhadap `.env`, `data/`, atau `data.bak/`.
- Nomor WhatsApp (`chat_id`) di log web admin ditampilkan lengkap tanpa sensor sesuai keputusan pemilik.

## 8. Gaya Kode
- TypeScript `strict`, ESM (`NodeNext`) dengan akhiran `.js` pada setiap import lokal.
- Ikuti gaya penulisan file sekitar; buat perubahan kecil, bersih, dan terarah.
- Gunakan identifier berbahasa Inggris di kode dan Bahasa Indonesia untuk seluruh teks antarmuka pengguna (UI).
- Tulis komentar kode hanya untuk menjelaskan alasan ("kenapa"), bukan sekadar mengulang apa yang dilakukan kode.

## 9. Desain UI
- Tampilan web admin mengikuti token dari `DESIGN.md` dan disaring secara selektif dengan `taste-SKILL.md`.
- Urutan prioritas jika terjadi pertentangan: `AGENTS.md` > `PRD.md` > `DESIGN.md` > `taste-SKILL.md`.
- `taste-SKILL.md` bukan untuk dashboard, sehingga hanya aturan yang tidak bergantung stack yang diterapkan:
  - **Wajib**: 0.B/0.D, 4.2, 4.4, 4.5, 4.6, 4.9, 4.11, 6.A–6.C, 6.F, 8, 9.A–9.G, 14.
  - **Diabaikan**: 2, 3, 4.3, 4.7, 4.8, 4.10, 5, 7, 10, 12, 15.
- Aturan tetap UI:
  - Nol em dash (`—`) dan en dash (`–`) di seluruh teks UI.
  - Dilarang menggunakan `innerHTML`, `outerHTML`, atau `insertAdjacentHTML` (wajib `createElement` + `textContent`).
  - Tanpa emoji di UI (kecuali teks balasan WhatsApp yang diwajibkan PRD).
  - Satu warna aksen (`primary`), satu skala radius, kontras minimal WCAG AA, dan semua warna wajib melalui CSS variable.
  - Logo `public/kaliber.avif` (4320x4320 px, transparan) dipotong menggunakan pembungkus CSS `overflow: hidden`; jangan mengubah isi file logo.

## 10. Git
- Jangan melakukan `git push`.
- Jangan melakukan `git commit` kecuali diminta secara eksplisit oleh pengguna.
- Jangan mengubah isi direktori `deploy/` kecuali tugas memintanya secara langsung.

## 11. Definisi Selesai
- `npm run build` lulus tanpa error.
- Bot berjalan normal dengan `node --env-file=.env --max-old-space-size=128 dist/index.js` dan halaman web admin dapat dibuka.
- `README.md`, `.env.example`, dan contoh environment di `deploy/` diperbarui apabila ada variabel lingkungan baru.
- Ringkasan akhir mencantumkan daftar file yang diubah, keputusan desain, asumsi, dan daftar hal yang perlu dicek manual.
