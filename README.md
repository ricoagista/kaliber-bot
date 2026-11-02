# Kaliber Bot

Chatbot WhatsApp + web admin untuk **LSO Kaliber (UMM Informatika)**. Bot menjawab
pertanyaan seputar Kaliber berdasarkan knowledge base yang diedit lewat web, memakai
9router lokal (OpenAI-compatible) sebagai LLM.

Dirancang untuk **STB HG680P (arm64, Cortex-A53, RAM terbatas)** dengan **Podman
rootless**. Satu container saja; Cloudflare Tunnel dan 9router sudah berjalan terpisah
di STB.

## Fitur

- Tanya jawab WhatsApp (chat pribadi dan grup) memakai LLM lokal 9router.
- Web admin satu halaman: Dashboard, Prompt, Knowledge, Model, Guard, Uji Coba, Log.
- Semua pengaturan disimpan di SQLite dan **langsung berlaku tanpa restart**.
- QR login + pairing code, reconnect otomatis dengan backoff.
- Pengamanan berlapis: pemisahan instruksi/data, filter regex injeksi, strike/mute,
  rate limit, sanitasi output, dan deteksi kebocoran prompt.
- Tanpa dependency berat: `node:sqlite`, tanpa ORM, tanpa bundler, tanpa CDN.

## Arsitektur singkat

```
WhatsApp ──Baileys──> wa.ts ──> pipeline.ts ──> prompt.ts ──> llm.ts (9router)
                                   │  guard.ts (rate limit, injeksi, strike)
                                   │  memory.ts (riwayat 6 jam)
                                   └> sanitize.ts ──> balasan
                                                                       │
Browser ──Cloudflare Access/Tunnel──> Hono api.ts <── settings/db SQLite
```

Keputusan desain utama:

- **Satu proses Node** untuk bot + HTTP admin. Tidak ada worker/Redis.
- **`pipeline.ts` tidak menyentuh Baileys**, sehingga `/api/test` memakai alur yang
  persis sama dengan pesan WhatsApp.
- **Rahasia hanya dari env** (`ADMIN_TOKEN`, `ROUTER_KEY`) dan tidak pernah masuk
  SQLite, log, atau respons `GET /api/settings`.
- **LLM tanpa tools**; dampak prompt injection dibatasi pada teks balasan.
- **Settings di-cache di memori**; menulis lewat API langsung memperbarui cache.

## Struktur proyek

```
src/
  index.ts      bootstrap: DB, settings, WA, HTTP
  config.ts     env, default settings, template prompt
  db.ts         node:sqlite + migrasi + prune
  settings.ts   get/set settings + cache
  wa.ts         Baileys: QR/pairing, reconnect, terima/kirim
  pipeline.ts   alur pesan -> balasan (tanpa Baileys)
  guard.ts      normalisasi, rate limit, injeksi, strike/mute
  prompt.ts     system prompt + messages
  llm.ts        klien 9router, timeout/retry/fallback
  sanitize.ts   filter output + deteksi kebocoran
  memory.ts     riwayat per nomor
  queue.ts      serial per nomor + konkurensi global 2
  api.ts        route /api/* + auth + validasi
  logger.ts     pino + masking nomor
public/index.html   web admin (vanilla JS/CSS, dark mode)
knowledge/kaliber.template.md
scripts/test-injection.ts
test/*.test.ts
deploy/Containerfile
deploy/kaliber-bot.container
```

## Menjalankan lokal

Prasyarat: **Node.js >= 22.13** (butuh `node:sqlite`), npm.

```bash
npm ci
cp .env.example .env          # Windows: copy .env.example .env
```

Isi `.env` minimal:

```text
ADMIN_TOKEN=token-acak-minimal-24-karakter
ROUTER_URL=http://127.0.0.1:20128/v1
ROUTER_KEY=isi-api-key-9router
DEFAULT_MODEL=nama-model-atau-combo
DATA_DIR=./data
```

Jalankan:

```bash
npm run build
node --max-old-space-size=128 dist/index.js
```

Buka `http://127.0.0.1:3000`, tempel `ADMIN_TOKEN`. QR WhatsApp muncul di Dashboard
(setara login WhatsApp > Perangkat tertaut). Tanpa layar, isi nomor di kolom pairing
code lalu masukkan kode 8 karakter di WhatsApp.

> Bot menolak start kalau `ADMIN_TOKEN` kosong atau kurang dari 24 karakter.

### Variabel env

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port HTTP di dalam container |
| `DATA_DIR` | `./data` | Lokasi SQLite + `wa-auth` (container: `/data`) |
| `TZ` | `Asia/Jakarta` | Zona waktu proses |
| `ADMIN_TOKEN` | — | **Wajib**, minimal 24 karakter; rahasia lapis dalam |
| `ROUTER_URL` | `http://host.containers.internal:20128/v1` | Base URL 9router, **lokal** |
| `ROUTER_KEY` | kosong | API key 9router (opsional bila 9router tanpa auth) |
| `DEFAULT_MODEL` | kosong | Seed `model` pada run pertama |
| `LOG_LEVEL` | `warn` | Level pino (opsional) |

Env hanya dipakai untuk **seed** awal dan rahasia. Setelah itu ubah lewat web.

### Tes

```bash
npm test                  # 55 unit test (node:test)
npm run test:load         # 20 pesan paralel, DB in-memory, cek antrean + RSS
npm run test:injection    # 24 serangan prompt injection ke /api/test
```

`test:load` mandiri: tidak butuh server, 9router, maupun file DB. `test:injection`
memerlukan server lokal berjalan dengan `ADMIN_TOKEN` yang sama. Jika 9router tidak
hidup, serangan yang lolos filter regex akan memakai `fallback_text`; skrip tetap
lulus tetapi mencetak peringatan bahwa jawaban model belum benar-benar diuji.

## Web admin

Semua `/api/*` wajib header `Authorization: Bearer <ADMIN_TOKEN>` (dibandingkan
constant-time). Token disimpan di `sessionStorage`. Halaman memakai CSP ketat, tanpa
CDN, dan mendukung dark mode.

Tab:

- **Dashboard** — status WA, QR, pairing code, ON/OFF bot, logout, uptime, RSS,
  jumlah pesan/penahanan hari ini, strike, mute.
- **Prompt** — system prompt + kontak + teks fallback/penolakan + `!info`/`!help`,
  reset ke default.
- **Knowledge** — editor knowledge + penghitung karakter (peringatan > 12.000).
- **Model** — model utama, fallback (satu per baris), temperature, max tokens,
  giliran riwayat, tes koneksi 9router.
- **Guard** — saklar chat/grup, allowlist, batas panjang, rate limit, cooldown grup,
  strike/mute, blocklist/allowlist, regex injeksi (divalidasi sebelum simpan).
- **Uji Coba** — memanggil `/api/test` dengan `chat_id=admin-test`; menampilkan
  status, model, flag guard, dan latensi tanpa mengirim ke WhatsApp.
- **Log** — 100 pesan terakhir dengan nomor tersamarkan.

### Endpoint

```text
GET/PUT /api/settings     GET  /api/status
POST    /api/wa/pairing   POST /api/wa/logout
POST    /api/bot/toggle   POST /api/test
GET     /api/logs         POST /api/llm/ping
GET     /healthz
```

Body maksimum 64 KB. `GET /api/settings` tidak pernah mengembalikan `ROUTER_KEY`
maupun `ADMIN_TOKEN`.

## Alur pesan

1. Abaikan pesan sendiri, status/newsletter/broadcast, pesan > 60 detik, dan ID duplikat.
2. Bukan teks: balas sekali per nomor per jam.
3. Cek `bot_enabled`, `private_enabled`, `group_enabled`.
4. Grup: hanya `allowed_groups` dan hanya saat di-mention / diawali prefix
   (`!kaliber`). `!info` dan `!help` selalu diterima sebagai perintah statis.
5. Guard: blocklist, mute, allowlist, panjang, rate limit, cooldown grup, regex injeksi.
6. Antrean serial per nomor, konkurensi global 2.
7. Prompt `[system] + riwayat + [user]` (teks user dibungkus `<pesan_user>` dan
   tag penutupnya di-escape).
8. LLM: timeout 30 s, retry 1x untuk 429/5xx/timeout, lalu model fallback.
9. Sanitasi output: buang `<think>`/tag internal, deteksi kebocoran 8 kata dari system
   prompt / pola rahasia, ubah markdown, potong 1500 karakter.
10. Presence `composing`, jeda acak 1–3 detik, kirim (grup dengan quote), simpan riwayat.

## Deploy di STB (Podman rootless, arm64)

### 1. Build image

Di STB (arm64 native):

```bash
podman build -t localhost/kaliber-bot:latest -f deploy/Containerfile .
podman images localhost/kaliber-bot
```

Di mesin x86 (cross-build arm64, butuh binfmt/qemu):

```bash
sudo podman run --rm --privileged docker.io/multiarch/qemu-user-static --reset -p yes
podman build --platform linux/arm64 -t localhost/kaliber-bot:latest -f deploy/Containerfile .
```

Alternatif: build di mesin lain lalu `podman save` / `podman load` ke STB.

### 2. Siapkan env

```bash
mkdir -p ~/.config/kaliber-bot
cat > ~/.config/kaliber-bot/env <<'EOF'
PORT=3000
DATA_DIR=/data
TZ=Asia/Jakarta
ADMIN_TOKEN=ganti-dengan-token-panjang-acak
ROUTER_URL=http://host.containers.internal:20128/v1
ROUTER_KEY=isi-api-key-9router
DEFAULT_MODEL=nama-model-atau-combo
EOF
chmod 600 ~/.config/kaliber-bot/env
```

Buat token acak:

```bash
openssl rand -hex 32
# atau: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Quadlet

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/kaliber-bot.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start kaliber-bot
loginctl enable-linger "$USER"       # auto-start setelah reboot
```

Cek:

```bash
systemctl --user status kaliber-bot
journalctl --user -u kaliber-bot -f
curl -s http://127.0.0.1:3000/healthz
podman stats --no-stream kaliber-bot
```

Unit memakai `Memory=256m`, `PublishPort=127.0.0.1:3000:3000`, volume
`kaliber-data:/data`, dan `Restart=always`. Port **tidak** terbuka ke LAN/internet.

### 4. Login WhatsApp

Buka web admin (lewat tunnel atau `ssh -L 3000:127.0.0.1:3000`), lalu scan QR atau
minta pairing code. Sesi disimpan di `/data/wa-auth`.

## Cloudflare Tunnel (tunnel yang sudah ada)

**Jangan membuat container `cloudflared` baru.** Tambahkan saja public hostname baru
ke tunnel yang sudah dipakai 9router.

### Tunnel remote-managed (disarankan)

Zero Trust Dashboard → Networks → Tunnels → tunnel yang ada → **Public Hostname** →
Add:

- Subdomain: `admin`
- Domain: `domain-kamu`
- Service: `http://localhost:3000`

Lalu lindungi dengan **Cloudflare Access** (Zero Trust → Access → Applications →
Self-hosted):

- Domain: `admin.domain-kamu`
- Policy: `Allow` → `Emails` → hanya email pemilik
- Login method: One-time PIN (OTP email)

`ADMIN_TOKEN` tetap wajib; Cloudflare Access adalah lapis luar, token adalah lapis
dalam.

### Jika tunnel memakai `config.yml` lokal

Tambahkan ingress **sebelum** rule catch-all `http_status:404`:

```yaml
ingress:
  - hostname: admin.domain-kamu
    service: http://localhost:3000
  # ... rule 9router yang sudah ada ...
  - service: http_status:404
```

Lalu restart `cloudflared`.

### Jika `cloudflared` berjalan di container lain

Kasus ini berbeda karena bot hanya publish ke `127.0.0.1` host:

1. **cloudflared di host (systemd)** → `http://localhost:3000` berfungsi.
2. **cloudflared di container** → `host.containers.internal:3000` **tidak** bisa
   menjangkau port yang hanya bind ke loopback host. Pilihan:
   - jalankan cloudflared dengan `--network=host`, lalu service URL tetap
     `http://localhost:3000`; atau
   - buat network Podman bersama dan join keduanya:

     ```bash
     podman network create kaliber
     # tambahkan Network=kaliber.network ke Quadlet bot dan cloudflared
     # service URL tunnel: http://kaliber-bot:3000
     ```
   - jangan publish `0.0.0.0:3000` kecuali memang dibatasi firewall.

### Amankan hostname 9router

Hostname 9router yang sudah online juga harus dilindungi Cloudflare Access atau API
key kuat. Siapa pun yang bisa memanggil 9router bebas menghabiskan kuota model free.

## Bot ke 9router (lokal, bukan lewat tunnel)

`ROUTER_URL` harus mengarah ke alamat lokal supaya cepat dan tidak bergantung internet:

- `http://host.containers.internal:20128/v1` (default, Podman bridge), atau
- `http://<IP-LAN-STB>:20128/v1` bila 9router listen di LAN, atau
- `--network=host` untuk bot bila 9router hanya listen di `127.0.0.1` host.

Catatan: `--network=host` membuat bot listen di `0.0.0.0:3000`, sehingga port admin
bisa terlihat dari LAN. Pakai hanya bila perlu dan batasi dengan firewall.

Tes dari dalam container:

```bash
podman exec kaliber-bot node -e "fetch(process.env.ROUTER_URL.replace(/\/$/,'')+'/models').then(async r=>console.log(r.status, (await r.text()).slice(0,200))).catch(e=>console.error('gagal', e.message))"
```

Atau dari host:

```bash
curl -s http://127.0.0.1:20128/v1/models
```

## Operasi & perawatan

- **Log**: hanya stdout (`pino` level `warn`), dibaca journald. Tidak ada file log
  besar. Lihat `journalctl --user -u kaliber-bot`.
- **Backup**: `podman volume export kaliber-data -o kaliber-data.tar` (berisi
  `kaliber.db` dan sesi WA). Simpan di tempat aman.
- **Update**: build ulang image, lalu `systemctl --user restart kaliber-bot`.
- **Logout WA**: tombol di Dashboard (menghapus `/data/wa-auth` dan membuka sesi baru).
  Jika sesi berakhir sendiri (`logged_out`), reconnect sengaja dihentikan; minta
  pairing code baru dari Dashboard atau restart container untuk memunculkan QR baru.
- **Reset data**: `podman volume rm kaliber-data` (hati-hati, sesi WA dan settings hilang).
- **Prune otomatis**: pesan/log > 7 hari, seen-message > 1 hari, dan maksimum 2000
  baris dijalankan tiap jam.

## Keamanan

- Tidak ada port yang dibuka ke internet; hanya `127.0.0.1:3000` + tunnel.
- Semua `/api/*` butuh Bearer token constant-time; 5 login gagal/menit/IP → 429.
- Header: CSP ketat, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`. Tanpa CORS.
- Log web menyamarkan nomor menjadi `6281****7890`.
- Prompt injection: teks user tidak pernah masuk system prompt, tag di-escape,
  regex bisa diedit, strike/mute, dan output difilter terhadap kebocoran 8 kata
  system prompt serta pola `sk-...`, `Bearer ...`, `ROUTER_KEY`, `ADMIN_TOKEN`.
- LLM tidak punya akses tools/file/internet/data pribadi.
- Knowledge hanya bisa diubah admin (tanpa scraping/import eksternal).

## Batasan & risiko yang diketahui

- **WhatsApp tidak resmi (Baileys)**. Risiko ban tetap ada; jeda 1–3 detik dan
  pembatasan grup hanya mengurangi, bukan menghilangkan.
- **Model free bisa dibobol**. Filter output berbasis heuristik (8 kata berurutan +
  pola rahasia), bukan jaminan absolut. Dampak dibatasi karena tidak ada tools/rahasia
  di prompt.
- **Deteksi mention** bergantung metadata WhatsApp (`mentionedJid`); perubahan perilaku
  WhatsApp/Baileys bisa memengaruhi. Prefix `!kaliber` disediakan sebagai fallback.
- **Knowledge besar** (> 12.000 karakter) bisa menghabiskan konteks model free;
  UI memberi peringatan, bukan pemblokiran.
- **SQLite single-writer** cukup untuk satu container; jangan jalankan dua instance
  dengan volume yang sama.
- **QR/pairing** membutuhkan koneksi internet dari STB ke WhatsApp.
- **Cloudflare Tunnel/Access** disiapkan manual; repo ini tidak menyentuh konfigurasi
  tunnel yang sudah ada.

## Status definition of done

- `npm run build` lulus; `npm test` lulus (55 test).
- `test:load` lulus: 20/20 pesan diproses, puncak RSS 53 MB, antrean kembali kosong.
- `test:injection` lulus 24/24 di mesin dev; karena 9router tidak berjalan saat itu,
  jawaban model belum diuji end-to-end (hanya filter input + fallback).
- RSS idle terukur ± 97 MB dengan WhatsApp terhubung di mesin dev (target < 150 MB),
  berjalan dengan `--max-old-space-size=128`; container dibatasi 256 MB.
- Semua pengaturan di tab web dapat diubah dan langsung aktif (cache invalidasi).
- `GET /api/settings` tidak mengembalikan rahasia.
- Build image arm64 **belum dijalankan di lingkungan ini** (tidak ada Podman/Docker);
  perintah build tersedia di atas dan Containerfile sudah disiapkan untuk
  `linux/arm64`.
