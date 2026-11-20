# Bot Dump Data (Harga Petani)

Bot WhatsApp tempat menaruh data apa saja (teks, forward chat, foto nota, PDF, Excel, voice note). Bot menyimpannya rapi di SQLite dalam bentuk teks terstruktur. Tujuannya mengumpulkan contoh nyata alur kerja dan bentuk data tim supaya bisa dipelajari.

Versi ERP sebelumnya (SO, DO, invoice, PO) ada di git history, commit `a56cf4f`. Database lamanya (`harga-petani-order.db`) tidak disentuh.

## Cara pakai

- **Grup**: tag bot, atau balas pesan bot. Selain itu bot diam.
  - `@bot` + teks/foto/file: langsung disimpan.
  - Kirim beberapa foto/pesan, lalu `@bot simpan`: pesan terbaru dari pengirim yang sama (maksimal 5 menit, 8 pesan) ikut disimpan sebagai satu dump.
  - Reply ke pesan orang lain sambil tag bot: pesan yang di-reply yang disimpan.
- **Chat pribadi**: siapa saja boleh. Setiap pesan dianggap dump.
- Bot langsung menyimpan dan membalas kartu ringkas (`DUMP-0042`, jenis, judul, field). Bot bertanya hanya kalau benar-benar ambigu, lalu simpan setelah dijawab.
- Koreksi: "bukan, ini tagihan supplier", "hapus DUMP-0042", "ubah total jadi 500rb".
- `@bot rekap` / `@bot rekap nota belanja json`: kirim file CSV/JSON. `@bot ada jenis apa aja`, `@bot cari cabe`.

## Penyimpanan

Semua ada di folder `data/` (di-gitignore, backup folder ini saja):

| Lokasi | Isi |
|---|---|
| `data/dump.db` | SQLite: tabel `entri` (jenis bebas, `data_json`, `teks_asli`), `entri_file`, riwayat chat |
| `data/files/DUMP-0042.jpg` | File asli. Banyak file dalam satu dump: `DUMP-0042-1.jpg`, `-2`, ... |
| `data/exports/` | Hasil rekap |
| `data/tmp/` | File sementara (otomatis dibersihkan) |

Isi DB berupa teks. Gambar dibaca model vision (deskripsi + OCR), PDF diambil teksnya, Excel diubah jadi tabel teks. Voice note diterima dan disimpan, transkripsi belum ada.

File yang mengandung gambar/dokumen/voice diteruskan ke WhatsApp owner (`OWNER_JID`) dengan caption `DUMP-0042 · jenis · judul · dari ...`. Cari `DUMP-0042` di chat untuk menemukannya.

## Akses

- Siapa saja boleh memakai bot. Pengamannya: batas `MAX_DUMP_PER_JAM` per pengirim (owner dikecualikan) dan batas ukuran file `MAX_FILE_MB`.
- Non-owner hanya bisa mencari, mengubah, menghapus, dan mengekspor data dari chat/grupnya sendiri. Owner bisa semuanya.
- Hapus bersifat lunak: baris dan file tetap ada, hanya tidak muncul lagi.

## Google Sheets (opsional)

Kalau `GOOGLE_SERVICE_ACCOUNT_PATH` dan `GOOGLE_SPREADSHEET_ID` terisi, tiap dump ditulis juga ke tab `Dump` (dibuat otomatis): ID, waktu, grup, pengirim, jenis, judul, ringkasan, data JSON, nama file, status. Gambarnya tidak masuk Sheets, hanya nama file (`DUMP-0042.jpg`). Edit/hapus lewat chat ikut memperbarui barisnya. Matikan dengan `DUMP_SHEETS=off`.

## Konfigurasi `.env`

```
AI_API_KEY=...
AI_BASE_URL=...
AI_MODEL=...            # harus mendukung tool calling
AI_VISION_MODEL=...     # opsional, default AI_MODEL; harus mendukung gambar
OWNER_JID=62812xxxx@s.whatsapp.net
GOOGLE_SERVICE_ACCOUNT_PATH=credentials/xxx.json   # opsional
GOOGLE_SPREADSHEET_ID=...                          # opsional
DUMP_SHEET_TAB=Dump                                # opsional
DUMP_SHEETS=off                                    # opsional, matikan sync Sheets
MAX_DUMP_PER_JAM=30                                # opsional
MAX_FILE_MB=10                                     # opsional
```

## Menjalankan

```
npm install
node index.js      # scan QR saat pertama kali
```

## Keterbatasan

- PDF hasil scan (tanpa teks) belum dibaca; file tetap tersimpan.
- Excel lama (`.xls`) belum dibaca; hanya `.xlsx`.
- Voice note belum ditranskrip.
- Sinkronisasi ke Sheets hanya satu arah (bot ke Sheets).
