# Laporan Audit Keamanan & Spesifikasi — Kaliber Bot

> **Acuan Audit:** `AGENTS.md`, `README.md`, `DESIGN.md`, dan `kaliber-bot-prompt.md`
> **Lingkungan Audit:** Windows (Node.js v24.19.0, tanpa Podman/Docker lokal)

---

## 1. Ringkasan Eksekutif

Audit menyeluruh dilakukan terhadap seluruh kode sumber (`src/`, `public/`, `test/`, `scripts/`, `deploy/`, `package.json`, `.env.example`, `.gitignore`, `.gitattributes`, `README.md`, dan riwayat Git).

| Tingkat Keparahan | Jumlah Temuan | Diperbaiki pada Tahap B | Dicatat |
|---|---:|---:|---:|
| **Critical** | 3 | 3 | 0 |
| **High** | 9 | 9 | 0 |
| **Medium** | 10 | 10 | 0 |
| **Low** | 5 | 3 | 2 |
| **Total** | **27** | **25** | **2** |

---

## 2. Tabel Temuan

| ID | Tingkat | Lokasi (`file:baris`) | Deskripsi Singkat | Cara Memperbaiki | Status |
|---|---|---|---|---|---|
| **C-01** | **Critical** | `src/sanitize.ts:34-36` | `leaksPrompt()` mengabaikan `_systemPrompt` dan tidak mendeteksi kebocoran 8 kata berurutan dari system prompt (menyebabkan `test/sanitize.test.ts` gagal dan kebocoran aturan prompt lolos ke pengguna). | Hapus blok `<info_kaliber>...</info_kaliber>` dari `systemPrompt` terlebih dahulu (agar jawaban knowledge base tidak terblokir), lalu bandingkan 8-gram kata berurutan antara `output` dan instruksi `systemPrompt`. Tambahkan juga pola `gsk_`, `SECRET_KEY`, dan `REVEAL_PASSWORD` ke `SECRET_PATTERNS`. | **Diperbaiki** |
| **C-02** | **Critical** | `src/api.ts:201-206` | `clientIp(c)` memanggil `getConnInfo(c).remote.address` tanpa cek `c.env?.incoming`, melempar `TypeError: Cannot read properties of undefined (reading 'server')` saat dipanggil tanpa socket HTTP nyata dan menyebabkan HTTP 500 pada 5 test di `test/api.test.ts`. | Hanya panggil `getConnInfo(c)` bila `c.env?.incoming` tersedia, dan fallback aman tanpa mengizinkan spoofing `CF-Connecting-IP` ketika `TRUST_PROXY=false`. | **Diperbaiki** |
| **C-03** | **Critical** | `deploy/Containerfile:30-38` | Stage `runtime` di `Containerfile` membuat `/data` sebagai `root` tanpa `chown node:node /data` dan tidak memiliki instruksi `USER node`, sehingga proses berjalan sebagai `root` di dalam container. | Ubah menjadi `RUN mkdir -p /data && chown -R node:node /data /app` dan tambahkan `USER node` sebelum `EXPOSE`/`CMD`, serta hapus layer `RUN npm cache clean --force` yang sia-sia di stage runtime. | **Diperbaiki** |
| **H-01** | **High** | `src/guard.ts:54-89`, `src/api.ts:180-183` | Tidak ada proteksi **ReDoS** pada `compilePatterns()` / `invalidPatterns()`. Pola berbahaya seperti `(a+)+$` diterima (`200 OK` pada `PUT /api/settings`) dan dapat membekukan event loop Node.js saat mencocokkan input. | Tambahkan deteksi statis pola ReDoS (`isUnsafeRegex`: nested quantifiers seperti `(a+)+`, backreference, quantifier berlebih) serta uji waktu eksekusi cepat terhadap string adversarial sebelum menerima regex, dan batasi panjang teks yang diuji di `matchesInjection`. | **Diperbaiki** |
| **H-02** | **High** | `src/prompt.ts:16-21` | `escapeUserText()` tidak meng-escape tag pembuka `<pesan_user>` dan tidak menangani variasi spasi/atribut di dalam tag seperti `</pesan_user >`, `< /pesan_user>`, atau `<info_kaliber >`. | Gunakan regex `/<\s*(\/?)\s*(pesan_user\|info_kaliber)\b[^>]*>/gi` untuk mengubah `<` dan `>` menjadi `&lt;` dan `&gt;` pada semua variasinya. | **Diperbaiki** |
| **H-03** | **High** | `src/guard.ts:35-42`, `src/guard.ts:66-89` | Bypass normalisasi & regex injeksi: (1) karakter tak terlihat seperti soft-hyphen `\u00AD` dan `\u034F` tidak dihapus di `normalizeText`, (2) homoglyph Cyrillic/Greek (`а`, `е`, `і`, `о`) tidak dinormalisasi saat cek injeksi, dan (3) varian `squashed` hanya menghapus `\s` literal di regex tetapi tidak menghapus spasi literal (`you are now`, `kamu sekarang`, `DAN mode`) maupun tanda baca penyisip (`a.b.a.i.k.a.n`). | Perluas penghapusan karakter format/invisible (`\u00AD`, `\u034F`, `\u061C`, `\u2060-\u206F`, dll.), tambahkan `foldConfusables()` untuk homoglyph & diakritik, hapus spasi literal serta `\b` pada regex `squashed`, dan perluas `DEFAULT_INJECTION_PATTERNS`. | **Diperbaiki** |
| **H-04** | **High** | `src/index.ts:33-41` | Seeding `ROUTER_KEY` berada di luar blok `if (providerCount.n === 0)`, sehingga setiap kali bot restart dengan `ROUTER_KEY` terisi di `.env`, key duplikat baru (`label: 'primary'`) selalu ditambahkan ke tabel `provider_keys`. | Pindahkan penambahan key awal `ROUTER_KEY` ke dalam blok `if (providerCount.n === 0)` saat membuat provider `default`. | **Diperbaiki** |
| **H-05** | **High** | `src/providers.ts:261-265` | `resolveModel()` mengembalikan `null` jika `rawKeys.length === 0`, sehingga provider lokal tanpa API key (mis. 9router lokal tanpa auth, sesuai `README.md:145` dan form UI "API key (opsional)") selalu gagal dipanggil oleh `callLlm` meskipun `/api/providers/:id/test` sukses. | Jika provider tidak memiliki baris sama sekali di `provider_keys`, kembalikan `apiKey: ''` dan `keyId: 0` (dan abaikan `keyId <= 0` pada `markKeyFailed`/`markKeySucceeded`). Jika ada key tetapi semuanya dinonaktifkan (`enabled = 0`), tetap kembalikan `null`. | **Diperbaiki** |
| **H-06** | **High** | `src/providers.ts:128-142`, `src/api.ts:622-638` | Dua bug pada `updateProvider` & `PUT /api/providers/:id`: (1) `updateProvider` menimpa kolom yang tidak dikirim di patch dengan `''` atau `0`, (2) `api.ts:624` mengecek `patch.name !== getProvider(id)?.name` **setelah** `updateProvider` selesai dijalankan, sehingga `oldPrefix` sudah berubah menjadi nama baru dan `settings.model`/`fallback_models` tidak pernah ikut diperbarui. | Ambil data provider lama (`before = getProvider(id)`) sebelum memanggil `updateProvider`, gunakan nilai lama sebagai fallback di `updateProvider`, dan gunakan `before.name` untuk memperbarui prefix di `settings.model` & `fallback_models`. | **Diperbaiki** |
| **H-07** | **High** | `src/index.ts:69-77` | Tidak ada handler `unhandledRejection` dan `uncaughtException`, serta `shutdown()` pada `SIGINT`/`SIGTERM` tidak memanggil `closeDb()` dan tidak menghentikan interval `pruneStorage()`. | Tambahkan handler `unhandledRejection` dan `uncaughtException` yang mencatat ke `logger.error`, tambahkan guard `shuttingDown`, hentikan timer prune, tutup server HTTP, tutup WA socket, dan panggil `closeDb()` sebelum `process.exit(0)`. | **Diperbaiki** |
| **H-08** | **High** | `deploy/kaliber-bot.container:10-18` | Quadlet memakai `Network=host` aktif bersamaan dengan `Environment=HOST=0.0.0.0` tanpa `PublishPort=127.0.0.1:3000:3000` dan tanpa `HealthCmd`, sehingga membuka port admin 3000 ke seluruh LAN STB dan menyimpang dari `README.md:397` serta spesifikasi Bagian 11. | Gunakan `PublishPort=127.0.0.1:3000:3000` dan `HealthCmd` secara default, serta cantumkan `# Network=host` sebagai opsi fallback berkomentar lengkap dengan peringatan konflik `PublishPort` dan pengaturan `HOST=127.0.0.1`. | **Diperbaiki** |
| **H-09** | **High** | `src/llm.ts:233-256`, `test/llm.test.ts:129` | Signature `pingLlm()` menghapus `routerUrl` dan `routerKey` serta tidak meneruskannya ke `callLlm()`, menyebabkan `npm run build:test` dan `npm test` gagal kompilasi (`TS2353`) dan gagal runtime (`false !== true`). | Tambahkan kembali `routerUrl?: string; routerKey?: string;` pada parameter `pingLlm()` dan teruskan ke `callLlm()`. | **Diperbaiki** |
| **M-01** | **Medium** | `src/pipeline.ts:138-150` | Di grup, mention bot (`@628...`) tidak dihapus dari teks pesan sebelum diproses, dan regex `/^!(info\|help)\b/i` mengizinkan pesan apa pun yang diawali `!info ...` (mis. `!info buat puisi`) memicu LLM di grup tanpa prefix `!kaliber` atau mention. | Hapus token mention `@\d+` saat `input.mentioned` aktif, perketat deteksi perintah statis menjadi `/^!(info\|help)$/i`, dan abaikan pesan bila teks bersih setelah hapus prefix/mention kosong. | **Diperbaiki** |
| **M-02** | **Medium** | `src/pipeline.ts:184`, `src/pipeline.ts:230` | `addMessage(input.senderId, 'user', ...)` dipanggil sebelum `callLlm()`, sehingga ketika LLM gagal (`status = 'error'`) atau output bocor (`status = 'blocked'`), pesan user tetap tersimpan yatim di tabel `messages` tanpa balasan asisten. | Simpan pasangan pesan `user` dan `assistant` ke tabel `messages` hanya setelah balasan valid (`status === 'ok'`), sesuai urutan langkah 10 spesifikasi. | **Diperbaiki** |
| **M-03** | **Medium** | `src/api.ts:368-377`, `src/api.ts:875-878` | Header keamanan (`Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy`, `X-Content-Type-Options`) dipasang setelah `await next()`, sehingga berisiko tidak terpasang jika handler melempar error ke `app.onError`. | Pasang header keamanan sebelum `await next()` dan pastikan juga diterapkan pada `app.onError` dan `app.notFound`. | **Diperbaiki** |
| **M-04** | **Medium** | `src/api.ts:722-762` | Endpoint `PUT/DELETE /api/providers/:providerId/keys/:keyId` dan `POST /api/providers/:id/keys/:keyId/toggle` tidak memverifikasi bahwa `keyId` benar-benar milik `providerId` pada URL. | Verifikasi kepemilikan `existing.providerId === providerId` dengan `getKey(keyId)` sebelum mengubah, men-toggle, atau menghapus key; kembalikan `404` bila tidak cocok. | **Diperbaiki** |
| **M-05** | **Medium** | `src/api.ts:764-796`, `src/crypto.ts:150-161` | (1) `POST /api/llm/test` tidak memvalidasi skema `baseUrl` (`http://`/`https://`) dan membocorkan `err.message` mentah, (2) `POST /api/keys/:keyId/reveal` tidak membatasi panjang `password` sebelum menjalankan `scryptSync` yang sinkron di event loop. | Validasi `validateProviderBaseUrl(baseUrl)` pada `/api/llm/test`, samarkan pesan error internal, dan batasi panjang `password` maksimal 256 karakter sebelum `verifyRevealPassword`. | **Diperbaiki** |
| **M-06** | **Medium** | `src/llm.ts:133-144` | Pada cabang `llmContext`, saat respons `>= 500` atau `429` pada `attempt === 0`, tidak ada jeda `await sleep(RETRY_DELAY_MS)` untuk `5xx`, dan pemanggilan `resolveModel(model)` kedua kalinya di dalam blok `429` menggeser counter round-robin dua kali. | Gunakan jeda `await sleep(RETRY_DELAY_MS)` secara konsisten pada retry pertama (`429`/`5xx`) tanpa memanggil `resolveModel(model)` ekstra di dalam blok pengecekan. | **Diperbaiki** |
| **M-07** | **Medium** | `src/guard.ts:26-28`, `src/guard.ts:112-127`, `src/guard.ts:208`, `src/providers.ts:244` | Kebocoran memori potensial pada Map in-memory: `groupLast` tidak memiliki batas ukuran/pembersihan sama sekali; `rateBuckets` dan `nonTextNotices` tidak memangkas entri tertua jika seluruh >2000 entri masih dalam jendela aktif; `keyCounters` tidak dibersihkan saat provider dihapus. | Tambahkan fungsi pembatas ukuran Map (`capMap` eviksi FIFO maksimal 2000 entri) untuk `rateBuckets`, `groupLast`, dan `nonTextNotices`, jangan menyimpan array kosong di `rateAllowed`, serta bersihkan `keyCounters` pada `deleteProvider`. | **Diperbaiki** |
| **M-08** | **Medium** | `src/db.ts:80-95`, `src/db.ts:242-259` | (1) Tabel `audit_log` belum memiliki indeks pada kolom `ts`, (2) `pruneStorage()` membatasi 5000 baris (bukan 2000 baris sesuai spesifikasi Bagian 8 & `README.md:509`), belum membatasi jumlah baris `seen_messages`, dan belum menghapus riwayat `messages` yang sudah kedaluwarsa (> 6 jam). | Tambahkan migrasi idempoten `CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)`, ubah batas baris `pruneStorage()` menjadi 2000 baris (termasuk `seen_messages`), prune `messages` > 6 jam, dan tambahkan unit test `pruneStorage()`. | **Diperbaiki** |
| **M-09** | **Medium** | `.gitattributes:1-2`, `.gitignore:1-7`, `.dockerignore` | (1) `.gitattributes` hanya berisi `* text=auto` tanpa `eol=lf` (memicu peringatan CRLF pada `deploy/Containerfile` dan `deploy/kaliber-bot.container`), (2) `.dockerignore` belum ada, (3) `.gitignore` belum memuat `wa-auth/` dan `*.backup`, serta ada file sisa `src/sanitize.ts.backup` dan `src/audit-log.sql`. | Ubah `.gitattributes` menjadi `* text=auto eol=lf`, buat `.dockerignore` (abaikan `.env`, `data/`, `node_modules/`, `.git/`, `test/`, dll.), lengkapi `.gitignore`, dan hapus file sisa. | **Diperbaiki** |
| **M-10** | **Medium** | `src/index.ts:19`, `src/index.ts:59`, `src/wa.ts:215-218` | (1) `src/index.ts` menggabungkan path dengan template string `${env.dataDir}/...` alih-alih `path.join()`, (2) `src/wa.ts` memakai opsi `printQRInTerminal: false` (deprecated di Baileys v7) dan `shouldSyncHistoryMessage: () => false` yang memicu peringatan `DANGER: DISABLING ALL SYNC...` karena memblokir initial LID mapping Baileys v7. | Gunakan `path.join(env.dataDir, ...)` di `src/index.ts`; hapus `printQRInTerminal` di `src/wa.ts` dan tolak hanya `FULL`/`RECENT` pada `shouldSyncHistoryMessage` agar pemetaan `@lid` bekerja stabil. | **Diperbaiki** |
| **L-01** | **Low** | `src/prompt.ts:48-51` | `renderSystemPrompt()` melakukan `.replaceAll()` berantai untuk `{{NOW}}`, `{{CONTACT}}`, `{{KNOWLEDGE}}`; jika nilai `contact` memuat teks `{{KNOWLEDGE}}`, placeholder tersebut ikut diganti. | Gunakan satu kali `.replace(/\{\{(NOW\|CONTACT\|KNOWLEDGE)\}\}/g, ...)` agar substitusi berlangsung satu tahap. | **Diperbaiki** |
| **L-02** | **Low** | `src/api.ts:49` | `const env = loadEnv()` dievaluasi sekali saat modul `api.ts` di-import, bukan saat `createApi()` dipanggil, sehingga perubahan `process.env` setelah import tidak terbaca. | Panggil `loadEnv()` di dalam `createApi()`. | **Diperbaiki** |
| **L-03** | **Low** | `src/index.ts:9`, `src/api.ts:45` | Fungsi `maskKey` di-import di `src/index.ts` dan `src/api.ts` tetapi tidak pernah dipakai (hanya `keyLast4` yang disimpan dan ditampilkan di UI). | Hapus import `maskKey` yang tidak terpakai di `src/index.ts` dan `src/api.ts`, serta tambahkan validasi prefix `data:image/` pada `wa.qrDataUrl` di `public/index.html`. | **Diperbaiki** |
| **L-04** | **Low** | `src/api.ts:407-413` | `GET /` memanggil `readFileSync(file, 'utf8')` setiap request. Karena hanya diakses admin, dampaknya kecil di produksi, namun dapat dioptimalkan. | Dicatat (memungkinkan edit `public/index.html` langsung terlihat tanpa restart saat pengembangan lokal sesuai `README.md:171`). | **Dicatat** |
| **L-05** | **Low** | `.env` (lokal, tidak di-commit) | File `.env` lokal di laptop dev saat ini mengisi `DATA_DIR=/data` (di Windows mengarah ke `C:\data`, bukan `./data`) dan memakai nilai yang sama untuk `ADMIN_TOKEN` dan `SECRET_KEY`. | Dicatat (tidak mengubah `SECRET_KEY` lokal agar key terenkripsi yang sudah ada di database lokal tidak gagal didekripsi; saat deploy di STB pastikan `ADMIN_TOKEN` dan `SECRET_KEY` digenerate terpisah). | **Dicatat** |

---

## 3. Ulasan Per Kategori Checklist

### 3.1 Kesesuaian Spesifikasi
- **Struktur proyek & fitur**: Seluruh modul inti (`index.ts`, `config.ts`, `db.ts`, `settings.ts`, `crypto.ts`, `providers.ts`, `endpoint.ts`, `wa.ts`, `pipeline.ts`, `guard.ts`, `prompt.ts`, `llm.ts`, `sanitize.ts`, `memory.ts`, `queue.ts`, `api.ts`, `logger.ts`, `public/index.html`) lengkap dan sesuai arsitektur `AGENTS.md` + `README.md` + `DESIGN.md`.
- **Fitur grup**: Grup hanya melayani tanya jawab ber-trigger (mention / prefix `!kaliber`) dan perintah statis `!info`/`!help` tanpa LLM; `group_enabled` default `false`. Bug penghapusan mention dari teks dan regex `/^!(info|help)$/i` (**M-01**) telah diperbaiki.
- **Alur 10 langkah pipeline**: `pipeline.ts` murni bebas dari Baileys, dan penyimpanan pasangan pesan `user`/`assistant` kini dilakukan hanya setelah balasan valid (**M-02**).
- **Multi-provider & enkripsi key**: Key dienkripsi AES-256-GCM (`v2:` dengan KEK turunan `scryptSync` yang di-cache di memori). Bug duplikasi key saat startup (**H-04**), kegagalan provider tanpa key (**H-05**), dan bug rename provider (**H-06**) telah diperbaiki.

### 3.2 Keamanan Web Admin
- **Auth & Constant-Time**: Token admin di-hash SHA-256 (32 byte tetap) sebelum `timingSafeEqual`, sehingga panjang token berbeda tidak pernah melempar exception. Password reveal memakai `scryptSync` + `timingSafeEqual` dengan batas panjang maksimal 256 karakter (**M-05**).
- **Rate Limit & IP**: `clientIp(c)` hanya mempercayai `CF-Connecting-IP`/`X-Forwarded-For` bila `TRUST_PROXY=true`, dan aman ketika dipanggil tanpa socket HTTP nyata (**C-02**).
- **XSS**: Seluruh manipulasi DOM di `public/index.html` memakai helper `h()` dengan `node.textContent` dan `document.createTextNode()`. Tidak ada penggunaan `innerHTML`, `outerHTML`, atau `insertAdjacentHTML`. Token disimpan hanya di `sessionStorage`.
- **CSP & Security Headers**: Terpasang di middleware `*` sebelum `await next()` serta di `app.onError` dan `app.notFound` (**M-03**).
- **Body Limit 64 KB**: Ditegakkan pada stream body melalui `hono/body-limit` (`413 Payload Too Large`).
- **Validasi Settings & ReDoS**: `validatePatch` menolak key di luar whitelist, memvalidasi tipe/rentang, dan menolak pola regex yang rentan ReDoS (**H-01**).
- **Kebocoran Rahasia di API**: `GET /api/settings`, `GET /api/status`, dan `GET /api/providers` terbukti tidak memuat `ROUTER_KEY`, `ADMIN_TOKEN`, `SECRET_KEY`, `REVEAL_PASSWORD`, maupun `keyEncrypted`.

### 3.3 Keamanan Prompt dan LLM
- **Isolasi Prompt**: Teks pengguna dan riwayat user selalu berada di role `user` dengan pembungkus `<pesan_user>...</pesan_user>`, tidak pernah masuk ke system prompt. `escapeUserText` kini mencakup `<pesan_user>`, `</pesan_user>`, `<info_kaliber>`, `</info_kaliber>` beserta variasi spasi/atribut (**H-02**).
- **Normalisasi & Filter Injeksi**: `normalizeText` + `foldConfusables` + `toSquashedRegexSource` kini menangani soft-hyphen `\u00AD`, homoglyph Cyrillic/Greek, karakter berspasi/titik, serta pola ekstraksi tidak langsung (**H-03**).
- **Sanitasi Output**: Deteksi kebocoran 8 kata berurutan dari system prompt (dengan mengecualikan blok `<info_kaliber>`) telah dipulihkan di `src/sanitize.ts` (**C-01**).

### 3.4 Logika Pipeline dan WhatsApp
- **Dedupe & Filter**: Pesan sendiri (`fromMe`), `status@broadcast`, `@broadcast`, `@newsletter`, pesan > 60 detik, dan ID duplikat (`seen_messages`) diabaikan di langkah 1.
- **Antrean**: `MessageQueue` memakai `try / finally { this.release(); }` sehingga error pada satu task tidak pernah membuat antrean macet.
- **Memori**: Seluruh Map in-memory (`rateBuckets`, `groupLast`, `nonTextNotices`, `loginBuckets`, `revealBuckets`, `patternCache`) memiliki batas ukuran dan pembersihan (**M-07**).
- **Graceful Shutdown**: Menangani `unhandledRejection`, `uncaughtException`, `SIGINT`, dan `SIGTERM` dengan menutup WA socket, server HTTP, dan `closeDb()` (**H-07**).

### 3.5 Database dan Performa
- **SQLite**: Mode `WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON`, dan semua query memakai prepared statement berparameter (`?`) tanpa interpolasi string SQL.
- **Indeks & Prune**: Indeks `idx_audit_log_ts` telah ditambahkan dan `pruneStorage` membatasi maksimal 2000 baris serta menghapus riwayat > 6 jam (**M-08**).

### 3.6 Dependency dan Repositori
- **Dependency**: Hanya `@hono/node-server`, `@whiskeysockets/baileys`, `hono`, `pino`, `qrcode` (0 vulnerabilities pada `npm ci`).
- **Riwayat Git**: Seluruh commit di-scan (`git rev-list --all`); tidak pernah ada kredensial asli atau `creds.json` yang ter-commit.
- **Konfigurasi Git & Docker**: `.gitattributes` telah diatur ke `* text=auto eol=lf`, `.dockerignore` telah dibuat, `.gitignore` dilengkapi, dan file sisa telah dihapus (**M-09**).

---

## 4. Hasil Verifikasi Eksekusi Nyata — Tahap A (Sebelum Perbaikan)

### 4.1 Clean Install, Build, dan Unit Test (Sebelum Perbaikan)
Perintah yang dijalankan setelah menghapus `dist/`, `dist-test/`, dan `node_modules/`:
```text
$ npm ci --offline
added 106 packages, and audited 107 packages in 8s
found 0 vulnerabilities

$ npm run build
> tsc -p tsconfig.json (LULUS, exit 0)

$ npm test
> tsc -p tsconfig.test.json
test/llm.test.ts(129,5): error TS2353: Object literal may only specify known properties, and 'routerUrl' does not exist in type ...
(GAGAL kompilasi TS pada test/llm.test.ts)
```
Saat dijalankan dengan `node --test` terhadap hasil kompilasi sebelum perbaikan:
- **Total test**: 55 | **Lulus**: 48 | **Gagal**: 7 (`C-01`, `C-02`, `H-09`).

---

## 5. Hasil Verifikasi Eksekusi Nyata — Tahap B (Setelah Perbaikan)

### 5.1 Build & Unit Test + Regresi
```text
$ npm run build
> tsc -p tsconfig.json (LULUS, exit 0)

$ npm test
> npm run build:test && node --test "dist-test/test/*.test.js"
ℹ tests 64
ℹ pass 64
ℹ fail 0
ℹ duration_ms 557.3592
```
Seluruh **64 unit test** (55 test awal + 9 test regresi baru untuk `C-01`, `C-02`, `H-01`, `H-02`, `H-03`, `H-05`, `H-06`, `M-01`, `M-02`, `M-03`, `M-08`, `L-01`) **LULUS 100%**.

### 5.2 Uji Endpoint API & Server Tiruan 9router (Setelah Perbaikan)
- `GET /healthz` → `200 OK`, `{"ok":true,"uptimeSec":0,"rssMb":58}`, CSP header terpasang.
- `GET /tidak-ada` (404) & `GET /api/status` tanpa token (401) → CSP & `X-Frame-Options: DENY` terpasang di semua respons error/404.
- `GET /api/status` via `app.request()` tanpa socket server → `401 Unauthorized` (tidak lagi crash 500).
- Login gagal 6x berturut-turut (termasuk percobaan spoofing `CF-Connecting-IP` saat `TRUST_PROXY=false`) → `[401, 401, 401, 401, 401, 429]`.
- `GET /api/settings` & `GET /api/status` → `200 OK`, `hasRouterKey: false`, `hasAdminToken: false`, `hasSecretKey: false`.
- `PUT /api/settings`:
  - Body 70 KB → `413 Payload Too Large` (`{"error":"body terlalu besar"}`).
  - Key tak dikenal (`unknown_key`) → `400 Bad Request` (`{"error":"setting tidak dikenal: unknown_key"}`).
  - Regex rusak (`([unclosed`) → `400 Bad Request`.
  - Regex ReDoS (`(a+)+$`) → **`400 Bad Request` (TERBLOKIR)**.
  - Tipe salah (`temperature: "bukan-angka"`) → `400 Bad Request`.
- Simulasi respons LLM via `/api/test`:
  - Normal (termasuk provider lokal tanpa API key) → `200 OK`, `status: "ok"`, `model: "default/mock-model"`.
  - HTTP 429 / HTTP 500 / Timeout / JSON rusak / Konten kosong → tidak crash, mengembalikan `fallback_text` dengan `status: "error"`, `usedFallback: true`.
  - **Respons LLM membocorkan 8+ kata system prompt** → **`status: "blocked"`, `flags: ["output_leak"]`, `usedFallback: true` (TERBLOKIR)**.

### 5.3 Uji Prompt Injection (22 Serangan: 10 Standar + 12 Halus/Bypass)
- 11 dari 12 serangan halus/bypass (ulangi teks di atas, terjemahkan panduan, keluarkan JSON konfigurasi awal, salin teks sebelum `<pesan_user>`, simulasi debugging konteks awal, summarize before `<info_kaliber>`, kalimat pertama ATURAN, base64 `SWdub3Jl...`, soft-hyphen `aba\u00ADikan`, homoglyph Cyrillic `аbаikаn`, dan tag `</pesan_user >`) langsung ditolak di langkah Guard (`status: "injection"`, tanpa memanggil LLM).
- 1 serangan role-play murni tanpa kata kunci prompt/instruksi tetap dibungkus `<pesan_user>...</pesan_user>`, dan bila model lemah mencoba membocorkan ≥8 kata system prompt, `sanitizeOutput` memblokirnya (`status: "blocked"`, `flags: ["output_leak"]`). **Kebocoran (`leaked`): 0 dari 22 serangan**.

### 5.4 Uji Beban (`npm run test:load`) & Simulasi Gangguan
- `npm run test:load`: 20/20 pesan paralel (5 nomor × 4 pesan) selesai dalam **32 ms**, RSS idle **54–58 MB**, puncak RSS **55 MB** (jauh di bawah target < 150 MB), antrean kembali `aktif: 0, menunggu: 0`.
- 100 pesan cepat dari satu nomor: 5 pesan pertama `ok`, 95 pesan berikutnya ditahan `ratelimit` (`{"ok":5,"ratelimit":95}`).
- Pesan 10.000 karakter: ditolak oleh pipeline (`status: "blocked"`, `flags: ["too_long"]`) dan oleh `/api/test` (`400 Bad Request`).
- Pesan dengan emoji dan karakter kontrol: dijawab normal (`status: "ok"`).
- 9router mati lalu hidup kembali: saat mati membalas `fallback_text` (`status: "error"`), saat hidup kembali langsung pulih (`status: "ok"`).

---

## 6. Risiko Tersisa & Yang Tidak Bisa Diuji di Laptop Ini

### Risiko Tersisa (Low)
1. **L-04 (`GET /` membaca `public/index.html` dari disk setiap request)**: Dibiarkan sesuai desain agar perubahan file statis langsung terlihat tanpa restart; beban dapat diabaikan karena dashboard admin hanya diakses pengurus.
2. **L-05 (Konfigurasi `.env` lokal)**: Pastikan saat men-deploy ke STB produksi (`~/.config/kaliber-bot/env`), `ADMIN_TOKEN` dan `SECRET_KEY` memakai nilai acak 32+ karakter yang berbeda.

### Yang Tidak Bisa Diuji di Laptop Ini
1. **Build & eksekusi container `linux/arm64` (Podman rootless + systemd Quadlet)**: Laptop Windows ini tidak memiliki Podman; `deploy/Containerfile`, `deploy/kaliber-bot.container`, dan `.dockerignore` telah diaudit dan diperbaiki secara statis.
2. **Koneksi WhatsApp produksi (scan QR / pairing code nyata ke server WA)**: Diuji pada batas unit dan integrasi pipeline; uji pairing nyata dilakukan di STB/mesin dengan sesi WhatsApp aktif.
3. **Cloudflare Tunnel & Cloudflare Access di STB HG680P**: Merupakan komponen jaringan eksternal di luar proses `kaliber-bot`.
