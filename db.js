require('dotenv').config();
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ========== LOKASI DATA ==========
// Semua yang dihasilkan bot (db, file asli, export) ada di ./data supaya gampang di-backup.
// DB lama (harga-petani-order.db) sengaja tidak disentuh.

const DATA_DIR = process.env.DUMP_DATA_DIR || path.join(__dirname, 'data');
const DIR_FILES = path.join(DATA_DIR, 'files');
const DIR_TMP = path.join(DATA_DIR, 'tmp');
const DIR_EXPORT = path.join(DATA_DIR, 'exports');
for (const d of [DATA_DIR, DIR_FILES, DIR_TMP, DIR_EXPORT]) fs.mkdirSync(d, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'dump.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ========== SKEMA ==========

db.exec(`
  -- Satu baris = satu "dump". Jenis bebas (label teks), isi terstruktur ada di data_json.
  CREATE TABLE IF NOT EXISTS entri (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jenis TEXT NOT NULL,
    judul TEXT,
    ringkasan TEXT,
    data_json TEXT,               -- JSON object fleksibel hasil ekstraksi
    teks_asli TEXT,               -- teks mentah / hasil OCR / isi dokumen
    chat_jid TEXT NOT NULL,       -- grup, atau jid pengirim kalau chat pribadi (dipakai buat scope akses)
    is_grup INTEGER DEFAULT 0,
    grup_nama TEXT,
    pengirim_jid TEXT,
    pengirim_nama TEXT,
    status TEXT DEFAULT 'AKTIF',  -- AKTIF | DIHAPUS
    sheet_row INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_entri_jenis ON entri(jenis);
  CREATE INDEX IF NOT EXISTS idx_entri_chat ON entri(chat_jid);

  -- File asli (gambar/pdf/excel/voice) tersimpan di disk, di DB cuma nama + path.
  CREATE TABLE IF NOT EXISTS entri_file (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entri_id INTEGER NOT NULL,
    nama TEXT NOT NULL,           -- DUMP-0042.jpg atau DUMP-0042-2.jpg
    nama_asli TEXT,
    path TEXT NOT NULL,
    mimetype TEXT,
    tipe TEXT,                    -- gambar | pdf | excel | teks | voice | video | file
    ukuran INTEGER,
    urutan INTEGER DEFAULT 1,
    FOREIGN KEY (entri_id) REFERENCES entri(id)
  );

  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Konten yang sudah diterima tapi belum disimpan karena bot nanya dulu (ambigu).
  CREATE TABLE IF NOT EXISTS pending_dump (
    chat_key TEXT PRIMARY KEY,
    konten_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Biar pesan yang sama (mis. dikirim ulang saat reconnect) tidak diproses dua kali.
  CREATE TABLE IF NOT EXISTS pesan_diproses (
    pesan_id TEXT PRIMARY KEY,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========== CHAT HISTORY ==========

const MAX_HISTORI = 12;
const MAX_PANJANG_HISTORI = 3000;

function simpanChatHistory(chatKey, role, content) {
  const isi = String(content || '').slice(0, MAX_PANJANG_HISTORI);
  db.prepare('INSERT INTO chat_history (chat_key, role, content) VALUES (?, ?, ?)').run(chatKey, role, isi);
  db.prepare(`
    DELETE FROM chat_history WHERE chat_key = ? AND id NOT IN (
      SELECT id FROM chat_history WHERE chat_key = ? ORDER BY id DESC LIMIT ?
    )
  `).run(chatKey, chatKey, MAX_HISTORI);
}

function getChatHistory(chatKey) {
  return db.prepare('SELECT role, content FROM chat_history WHERE chat_key = ? ORDER BY id ASC').all(chatKey);
}

// ========== PENDING ==========

const PENDING_KADALUARSA_MENIT = 30;

function simpanPending(chatKey, konten) {
  db.prepare(`
    INSERT INTO pending_dump (chat_key, konten_json) VALUES (?, ?)
    ON CONFLICT(chat_key) DO UPDATE SET konten_json = excluded.konten_json, created_at = CURRENT_TIMESTAMP
  `).run(chatKey, JSON.stringify(konten));
}

function getPending(chatKey) {
  const row = db.prepare(`
    SELECT konten_json FROM pending_dump
    WHERE chat_key = ? AND created_at >= datetime('now', ?)
  `).get(chatKey, `-${PENDING_KADALUARSA_MENIT} minutes`);
  if (!row) return null;
  try {
    return JSON.parse(row.konten_json);
  } catch {
    return null;
  }
}

function hapusPending(chatKey) {
  db.prepare('DELETE FROM pending_dump WHERE chat_key = ?').run(chatKey);
}

// ========== DEDUPE PESAN ==========

/** true kalau pesan ini baru pertama kali dilihat (dan langsung ditandai). */
function tandaiPesanDiproses(pesanId) {
  if (!pesanId) return true;
  const r = db.prepare('INSERT OR IGNORE INTO pesan_diproses (pesan_id) VALUES (?)').run(pesanId);
  return r.changes > 0;
}

function bersihkanBerkalaan() {
  db.prepare("DELETE FROM pesan_diproses WHERE created_at < datetime('now', '-3 days')").run();
  db.prepare("DELETE FROM pending_dump WHERE created_at < datetime('now', '-1 days')").run();

  // File sementara yang tidak jadi disimpan (dump dibatalkan / kadaluarsa)
  const batas = Date.now() - 24 * 3600 * 1000;
  for (const nama of fs.readdirSync(DIR_TMP)) {
    const p = path.join(DIR_TMP, nama);
    try {
      if (fs.statSync(p).mtimeMs < batas) fs.unlinkSync(p);
    } catch {
      /* abaikan */
    }
  }
}

bersihkanBerkalaan();

module.exports = {
  db,
  DATA_DIR,
  DIR_FILES,
  DIR_TMP,
  DIR_EXPORT,
  simpanChatHistory,
  getChatHistory,
  simpanPending,
  getPending,
  hapusPending,
  tandaiPesanDiproses,
  bersihkanBerkalaan,
};
