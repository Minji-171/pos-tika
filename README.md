# POS TIKA - Point of Sale & Business Management System

Sistem Kasir (POS) & Manajemen Bisnis **Offline-First** dengan **Sinkronisasi Lintas Jaringan (Cloud P2P + WebRTC + SQLite)** milik **TIKA**.

## Fitur Utama
- **100% Offline-First PWA**: Tetap berjalan normal tanpa internet menggunakan database lokal (`IndexedDB` di browser & `SQLite` di PC).
- **Sinkronisasi Lintas Jaringan (Beda Wi-Fi / 4G / 5G)**: Menghubungkan semua perangkat menggunakan **Cloud P2P Bridge (MQTT-over-WSS + WebRTC)** serta **Link Publik HTTPS Tunnel**.
- **Pemindai Barcode Lengkap**: Mendukung kamera HP/Laptop langsung, foto barcode, scanner fisik USB/Bluetooth, serta *Weight-Embedded Barcode* (EAN-13 timbangan).
- **Manajemen Toko Lengkap**: Kasir, Tiket Terbuka (Meja), Printer Struk & Dapur, Laporan Laba/Rugi, Inventaris Stok, Karyawan, Shift, dan Backup Terenkripsi (`AES-256-GCM`).

## Cara Menjalankan di PC / Laptop (Windows / Mac / Linux)
1. Pastikan **Python 3** sudah terinstal.
2. Klik dua kali file **`start_pos_tika.bat`** (Windows) atau jalankan perintah:
   ```bash
   python server.py 8090
   ```
3. Buka **`http://localhost:8090`** di browser.

## Cara Menggunakan di HP / Tablet / Perangkat Lain (Tanpa Instal Python)
Jika repository ini diunggah ke GitHub dan fitur **GitHub Pages** diaktifkan:
1. Buka link GitHub Pages Anda (`https://<username>.github.io/<nama-repo>/`).
2. Pilih menu **"Tambahkan ke Layar Utama (Add to Home Screen)"** di Chrome/Safari agar terinstal sebagai aplikasi penuh.
3. Pastikan **ID Bisnis** (`BIZ-POSTIKA-01`) dan **Kunci Pairing** (`TIKA-SYNC-2026`) di menu **Sinkronisasi** sama di semua perangkat agar otomatis tersinkronisasi.

## PIN Login Default
- **TIKA (Owner)**: `1234`
- **Rina (Admin)**: `2222`
- **Budi (Manager)**: `3333`
- **Siti (Kasir)**: `4444`
- **Andi (Staf Dapur)**: `5555`
