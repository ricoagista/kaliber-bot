# AGENTS.md — kaliber-bot

Panduan untuk agen coding (opencode) yang bekerja di repo ini. Baca seluruhnya sebelum mengubah kode.

## Ringkasan proyek

Chatbot WhatsApp + web admin untuk LSO Kaliber (UMM Informatika). Bot menjawab pertanyaan berdasarkan knowledge base yang diedit lewat web, memakai LLM lewat endpoint OpenAI-compatible. Satu proses Node, satu container, target perangkat terbatas (STB arm64, RAM kecil).

Stack: Node.js >= 22.13, TypeScript (ESM), Hono, `node:sqlite`, Baileys, pino. Frontend: satu file `public/index.html` (vanilla JS/CSS).

## Perintah

```bash
npm ci
npm run build                                   # wajib lulus setelah setiap perubahan
node --env-file=.env --max-old-space-size=128 dist/index.js
```

- `.env` TIDAK dibaca otomatis. Selalu jalankan dengan `--env-file=.env`.
- Lokal: `DATA_DIR=./data`. `/data` hanya untuk container.
- Web admin: `http://127.0.0.1:3000`, login dengan `ADMIN_TOKEN`.

## Aturan tes

- Jangan menjalankan, mengubah, atau menambah tes. Abaikan `test/` dan `scripts/test-*`.
- Verifikasi cukup dengan `npm run build` dan menjalankan bot secara manual.

## Struktur kode

```
src/index.ts      bootstrap (DB, settings, WA, HTTP)
src/config.ts     env, default settings, template prompt
src/db.ts         node:sqlite + migrasi + prune
src/settings.ts   get/set settings + cache
src/wa.ts         Baileys: QR/pairing, reconnect, kirim/terima
src/pipeline.ts   alur pesan -> balasan (TIDAK boleh menyentuh Baileys)
src/guard.ts      rate limit, injeksi, strike/mute
src/prompt.ts     susun system prompt + messages
src/llm.ts        klien LLM, timeout/retry/fallback
src/sanitize.ts   filter output + deteksi kebocoran
src/memory.ts     riwayat per nomor
src/queue.ts      antrean serial per nomor, konkurensi global 2
src/api.ts        route /api/* + auth + validasi
src/logger.ts     pino
public/index.html web admin
```

## Aturan teknis

- Tanpa dependency berat: tanpa ORM, bundler, CDN. Gunakan modul bawaan Node (`node:crypto`, dll.). Tambah npm package hanya jika benar-benar perlu, dan sebutkan alasannya di ringkasan akhir.
- RSS idle target < 150 MB. Jangan menambah worker, Redis, atau proses kedua.
- Semua pengaturan harus berlaku langsung tanpa restart: tulis lewat `settings.ts` agar cache ikut diperbarui.
- Migrasi DB harus idempotent dan tidak menghapus data maupun sesi WhatsApp (`wa-auth`).
- CSP ketat tetap aktif. Tanpa CDN; aset (font/ikon) disimpan lokal di `public/`.
- `pipeline.ts` tetap bebas dari Baileys agar `/api/test` memakai alur yang sama dengan WhatsApp.
- LLM tetap tanpa tools; dampak prompt injection dibatasi pada teks balasan.

## Aturan keamanan

- API key provider disimpan terenkripsi (AES-256-GCM, kunci dari `SECRET_KEY`). Tidak boleh plaintext di SQLite.
- Key, `ADMIN_TOKEN`, `SECRET_KEY`, dan password reveal tidak boleh muncul di log, respons error, atau respons GET apa pun. Yang tampil hanya mask (contoh `gsk_••••ab12`).
- Perbandingan token/password memakai constant-time. Endpoint sensitif diberi rate limit.
- Jangan pernah commit `.env`, `data/`, atau file berisi rahasia. Pastikan ada di `.gitignore`.
- Nomor WhatsApp di log web tampil lengkap (tanpa sensor) sesuai keputusan pemilik. Jangan menambah penyamaran kembali.

## Gaya kode

- TypeScript strict, ESM (`import ... from "./x.js"` sesuai pola yang sudah ada).
- Ikuti gaya file di sekitarnya; perubahan kecil dan terarah, jangan refactor di luar tugas.
- Identifier dan nama file dalam bahasa Inggris; teks UI dan pesan ke pengguna dalam bahasa Indonesia.
- Komentar hanya untuk "kenapa", bukan "apa".

## Desain UI

Tampilan web admin mengikuti `design.md` di root repo. Semua warna, font, spacing, dan radius didefinisikan sebagai CSS variable di `:root` pada `public/index.html`, jangan hardcode nilai di komponen.

## Git

- Jangan push. Jangan commit kecuali diminta.
- Jangan ubah `deploy/` kecuali tugas memintanya (mis. menambah `SECRET_KEY` ke contoh env).

## Selesai berarti

1. `npm run build` lulus.
2. Bot bisa dijalankan dengan `--env-file=.env` dan web admin terbuka.
3. README.md, `.env.example`, dan contoh env di `deploy/` diperbarui bila ada env baru.
4. Ringkasan akhir: file yang diubah, keputusan desain, hal yang perlu dicek manual.
