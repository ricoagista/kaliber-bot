# Kaliber Bot — Chatbot WhatsApp & Web Admin LSO Kaliber (UMM Informatika)

Chatbot WhatsApp otomatis dan panel Web Admin ringan untuk menjawab pertanyaan seputar LSO Kaliber (Program Studi Informatika, Universitas Muhammadiyah Malang) berdasarkan *knowledge base* yang dikelola pengurus.

Sistem dirancang berjalan dalam **satu proses Node.js (`>= 22.13`)** dengan konsumsi memori rendah (`< 150 MB` RSS idle, `--max-old-space-size=128`), menggunakan SQLite bawaan (`node:sqlite` mode WAL), Hono, Baileys, dan antarmuka Web Admin satu file tanpa framework eksternal.

---

## 1. Persyaratan Sistem

- **Node.js** `>= 22.13.0` (memerlukan modul bawaan `node:sqlite`)
- **npm** `>= 10`
- Untuk produksi di STB (`linux/arm64`) atau server Linux: **Podman** (rootless) + **systemd user service (Quadlet)**

---

## 2. Menjalankan Secara Lokal (Dari Nol)

### 2.1. Clone Repositori & Pasang Dependensi

```bash
git clone <url-repo-kaliber-bot>
cd kaliber-bot
npm ci
```

### 2.2. Siapkan File `.env`

Salin `.env.example` menjadi `.env`:

```bash
cp .env.example .env
```

Isi variabel wajib di `.env`:
- `ADMIN_TOKEN`: minimal **24 karakter** acak (digunakan untuk login ke Web Admin).
- `SECRET_KEY`: minimal **32 karakter** acak (digunakan untuk menurunkan KEK AES-256-GCM bagi enkripsi API key di SQLite).
- `REVEAL_PASSWORD`: *(opsional)* minimal **12 karakter** jika ingin mengaktifkan fitur lihat/buka API key di Web Admin.
- `DATA_DIR=./data`

> **Penting:** Kode aplikasi tidak membaca `.env` secara otomatis; file `.env` wajib dilewatkan melalui flag `--env-file=.env` saat menjalankan Node.js.

### 2.3. Build & Jalankan Bot

```bash
npm run build
node --env-file=.env --max-old-space-size=128 dist/index.js
```

Buka Web Admin di browser:
- URL: `http://127.0.0.1:3000`
- Masuk menggunakan nilai `ADMIN_TOKEN` dari `.env`.

---

## 3. Deploy di STB arm64 dengan Podman Rootless & Quadlet

### 3.1. Aktifkan Linger untuk User Non-Root

Agar container rootless tetap berjalan saat boot maupun setelah sesi SSH ditutup:

```bash
sudo loginctl enable-linger $USER
```

### 3.2. Build Image Container di STB

```bash
podman build -t localhost/kaliber-bot:latest -f deploy/Containerfile .
```

### 3.3. Siapkan Environment File untuk Quadlet

```bash
mkdir -p ~/.config/kaliber-bot
cp .env.example ~/.config/kaliber-bot/env
chmod 600 ~/.config/kaliber-bot/env
nano ~/.config/kaliber-bot/env
```

Pastikan di `~/.config/kaliber-bot/env`:
- `ADMIN_TOKEN` (minimal 24 karakter) dan `SECRET_KEY` (minimal 32 karakter) sudah diisi.
- Jika Web Admin diakses melalui Cloudflare Tunnel, set `TRUST_PROXY=true`.

### 3.4. Pasang Unit Quadlet systemd

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/kaliber-bot.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start kaliber-bot.service
systemctl --user status kaliber-bot.service
```

Untuk melihat log container:

```bash
journalctl --user -u kaliber-bot.service -f
```

> **Catatan `HOST` & Jaringan Container:**
> Di dalam container Quadlet, `HOST=0.0.0.0` di-set agar Hono menerima koneksi dari port forwarding Podman, sedangkan `PublishPort=127.0.0.1:3000:3000` memastikan port hanya terekspos ke loopback host. Apabila `host.containers.internal` tidak dapat menjangkau 9router di host, aktifkan opsi `# Network=host` pada `deploy/kaliber-bot.container`, hapus `PublishPort`, dan set `HOST=127.0.0.1`.

---

## 4. Publikasi Web Admin via Cloudflare Tunnel & Access

1. Pada dashboard Cloudflare Zero Trust -> **Networks** -> **Tunnels**, tambahkan *Public Hostname*:
   - **Subdomain**: `admin.<domain-anda>`
   - **Service**: `http://localhost:3000`
2. Pastikan variabel `TRUST_PROXY=true` aktif pada environment bot agar rate limiter membaca IP asli pengunjung dari header `CF-Connecting-IP`.
3. Sangat disarankan menambahkan aplikasi **Cloudflare Access** (Zero Trust Access Policy, misalnya OTP email pengurus) di depan `admin.<domain-anda>` sebagai lapisan autentikasi tambahan sebelum halaman login `ADMIN_TOKEN`.

---

## 5. Menautkan Nomor WhatsApp & Konfigurasi Awal

1. **Gunakan Nomor Khusus Bot**:
   - Gunakan nomor WhatsApp terpisah khusus untuk bot (jangan gunakan nomor pribadi utama pengurus).
   - Buka tab **Ringkasan** di Web Admin, lalu pindai kode QR atau masukkan nomor telepon bot pada form **Pairing Code** untuk mendapatkan kode 8 karakter.
2. **Konfigurasi Provider & Model**:
   - Buka tab **Provider**, tambahkan provider berformat OpenAI-compatible atau Anthropic (API key wajib diisi; maksimal 5 provider, maksimal 5 API key per provider).
   - Klik **Tes** pada key atau **Tes koneksi** provider untuk memastikan status `Valid`.
   - Gunakan tombol **Lihat model** untuk melihat tabel model yang tersedia pada endpoint tersebut.
   - Buka tab **Model**, pilih **Mode Routing** (`fallback`, `round_robin`, atau `fusion`) dan kelola daftar prioritas model (hingga 20 model). Urutan nomor 1 otomatis menjadi Model Utama, urutan berikutnya menjadi Model Cadangan / Fallback. Gunakan tombol panah (↑/↓) untuk mengatur prioritas atau tombol **+ Tambah Model** untuk menambah model dari provider aktif.
3. **Isi Knowledge Base & Prompt**:
   - Buka tab **Knowledge**, ganti seluruh bagian `TODO` dengan informasi resmi LSO Kaliber, lalu klik **Simpan**.
   - Buka tab **Prompt**, sesuaikan `Kontak Pengurus ({{CONTACT}})` dan instruksi bila diperlukan.
4. **Uji Coba Sebelum Live**:
   - Gunakan tab **Uji Coba** untuk menguji pertanyaan normal maupun simulasi *prompt injection* tanpa mengirim pesan ke WhatsApp.
   - Uji kirim pesan lewat chat pribadi WhatsApp terlebih dahulu. Mode grup secara bawaan nonaktif (`group_enabled=false`) dan hanya merespons di grup yang terdaftar pada `allowed_groups` ketika bot di-mention atau diawali `!kaliber`.

---

## 6. Backup, Pemulihan, & Peringatan Operasional

1. **Backup `kaliber-data` dan `SECRET_KEY`**:
   - Seluruh database (`kaliber.db`) dan sesi autentikasi WhatsApp (`wa-auth/`) berada di volume `kaliber-data` (atau folder `./data` pada mode lokal).
   - API key di dalam `kaliber.db` dienkripsi menggunakan `SECRET_KEY`. **Simpan salinan `SECRET_KEY` di tempat aman.** Jika `SECRET_KEY` hilang atau berubah, seluruh API key yang tersimpan di database tidak akan bisa didekripsi dan harus dimasukkan ulang.
   - Contoh backup volume Podman:
     ```bash
     podman volume export kaliber-data -o kaliber-data-$(date +%F).tar
     ```
2. **Satu Instance per Volume / Sesi WhatsApp**:
   - Jangan pernah menjalankan dua proses atau dua container `kaliber-bot` yang mengakses direktori `DATA_DIR` / `wa-auth` yang sama secara bersamaan. Koneksi ganda pada kredensial Baileys yang sama akan merusak sesi Signal key dan menyebabkan akun terputus (*logged out*).
3. **Risiko Penggunaan Library WhatsApp Tidak Resmi (Baileys)**:
   - Proyek ini menggunakan `@whiskeysockets/baileys` (protokol WhatsApp Web multi-device tidak resmi). WhatsApp dapat membatasi atau memblokir nomor yang terdeteksi melakukan spam.
   - Bot sudah dilengkapi jeda pengetikan manusiawi (`1–3 detik`), *rate limit* per nomor, *cooldown* grup, dan *auto-mute* pelanggar, namun selalu gunakan nomor khusus bot dan hindari memasukkan bot ke grup besar yang tidak relevan.
