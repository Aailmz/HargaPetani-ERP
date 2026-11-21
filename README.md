# Bot Dump Data (Harga Petani)

Bot WhatsApp tempat menaruh data apa saja (teks, forward chat, foto nota, PDF, Excel, voice note). Bot menyimpannya rapi di SQLite dalam bentuk teks terstruktur. Tujuannya mengumpulkan contoh nyata alur kerja dan bentuk data tim supaya bisa dipelajari.

Versi ERP sebelumnya (SO, DO, invoice, PO) ada di git history, commit `a56cf4f`. Database lamanya (`harga-petani-order.db`) tidak disentuh.

## Cara pakai

- **Grup**: tag bot, atau balas pesan bot. Selain itu bot diam.
  - `@bot` + teks/foto/file: langsung disimpan.
  - Kirim beberapa foto/pesan, lalu `@bot simpan`: pesan terbaru dari pengirim yang sama (maksimal 5 menit, 8 pesan) ikut disimpan sebagai satu dump.
  - Reply ke pesan orang lain sambil tag bot: pesan itu yang disimpan, **beserta seluruh thread-nya**. Balasan teks maupun voice note dari siapa pun (tanpa tag) ikut jadi konteks, diurutkan sesuai waktu dengan penanda siapa membalas siapa. Kalau reply-nya hanya berisi tag, artinya "catat ini".
  - Thread yang sama dicatat lagi setelah ada balasan baru: bot melanjutkan dump yang lama (hanya pesan baru yang ditambahkan, ringkasan dan data diperbarui) dan tidak membuat dump ganda.
  - Thread diingat bot di memori selama 6 jam dan hilang kalau bot restart. Pesan di luar thread atau yang sudah lewat dari itu tidak ikut.
- **Chat pribadi**: siapa saja boleh. Setiap pesan dianggap dump.
- Bot langsung menyimpan dan membalas kartu ringkas (`DUMP-0042`, jenis, judul, field). Bot bertanya hanya kalau benar-benar ambigu, lalu simpan setelah dijawab.
- Koreksi: "bukan, ini tagihan supplier", "hapus DUMP-0042", "ubah total jadi 500rb".
- **Hal yang meragukan** (misal total tidak sama dengan qty x harga, satuan harga tidak jelas): bot tetap menyimpan datanya apa adanya, tapi menaruh pertanyaannya di daftar *Perlu dikonfirmasi*. Kartu menampilkannya dengan ajakan "Balas pesan ini", dan di Sheets statusnya jadi `Perlu konfirmasi` (bisa difilter).
- **Menjawab/mengoreksi:** *balas (reply) kartu bot itu*, siapa pun orangnya, tanpa perlu tag. Bot tahu kartu itu milik dump yang mana, menerapkan koreksinya, dan menghapus poin yang sudah terjawab. Teks asli tidak pernah ditimpa: koreksi dicatat terpisah di teks asli (`--- Koreksi <waktu> oleh <nama> ---`). Alternatif: tag bot dan sebut ID-nya, misal `@bot DUMP-0007: 10 pack = 50 pcs, 1 pcs 8000`.
- **Menyimak diskusi (otomatis, tanpa tag):** setelah bot mengajukan pertanyaan konfirmasi di grup, bot ikut menyimak obrolan grup selama `DISKUSI_MENIT` menit (bawaan 60). Obrolan dikumpulkan sampai reda ~20 detik, lalu model menilai apakah itu menjawab pertanyaan terbuka. Hanya kalau jelas dan cukup, data diperbarui dan bot melapor sekali dengan kartu. Obrolan yang tidak nyambung, bertentangan, atau setengah-setengah dibiarkan dan bot diam. Jawaban dari beberapa orang digabung. Kutipan obrolan yang dipakai dicatat di log koreksi; obrolan lain tidak disimpan. Begitu semua pertanyaan terjawab, bot berhenti menyimak. **Di luar jendela itu, atau di grup yang tidak punya pertanyaan terbuka, bot tidak membaca obrolan sama sekali.** Batas 20 pemeriksaan per grup per jam menjaga biaya. Matikan dengan `DISKUSI_MENIT=0`.
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

Kalau `GOOGLE_SERVICE_ACCOUNT_PATH` dan `GOOGLE_SPREADSHEET_ID` terisi, tiap dump ditulis juga ke tab `Dump` (dibuat otomatis). Kolomnya: ID, Waktu, Grup / Chat, Pengirim, Jenis, Judul, Ringkasan, Nominal (Rp), Detail, File, Status, Data mentah (JSON). Kolom *Detail* berisi isi data dalam bentuk `Label: nilai` dan daftar item berbutir, supaya terbaca tanpa membuka JSON. Header diwarnai dan dibekukan, kolom diberi lebar yang pas, teks panjang membungkus, ada filter, dan nominal berformat ribuan.

Tampilan ini diterapkan otomatis tiap bot start. Kalau susunan kolom di tab berbeda dari yang diharapkan bot (misalnya tab lama), isi tab dari baris 2 ke bawah **ditulis ulang seluruhnya dari database**. Jangan menaruh catatan manual di tab `Dump`. Untuk memaksa tulis ulang: `node sync-sheets.js`. Gambarnya tidak masuk Sheets, hanya nama file (`DUMP-0042.jpg`). Edit/hapus lewat chat ikut memperbarui barisnya. Matikan dengan `DUMP_SHEETS=off`.

## Konfigurasi `.env`

```
AI_API_KEY=...          # kunci API (Sumopod / penyedia kompatibel OpenAI)
AI_BASE_URL=...         # endpoint kompatibel OpenAI
AI_MODEL=...            # harus mendukung tool calling
AI_VISION_MODEL=...     # opsional, default AI_MODEL; WAJIB model yang bisa membaca gambar
OWNER_JID=62812xxxx@s.whatsapp.net
GOOGLE_SERVICE_ACCOUNT_PATH=credentials/xxx.json   # opsional
GOOGLE_SPREADSHEET_ID=...                          # opsional
DUMP_SHEET_TAB=Dump                                # opsional
DUMP_SHEETS=off                                    # opsional, matikan sync Sheets
MAX_DUMP_PER_JAM=30                                # opsional
MAX_FILE_MB=10                                     # opsional
DISKUSI_MENIT=60                                   # opsional, lama bot menyimak obrolan setelah bertanya (0 = mati)
DISKUSI_JEDA_DETIK=20                              # opsional, tunggu obrolan reda sebelum diperiksa
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
