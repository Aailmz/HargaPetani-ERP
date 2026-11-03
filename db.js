require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'harga-petani-order.db'));
db.pragma('journal_mode = WAL');

// ========== SKEMA ==========

db.exec(`
  CREATE TABLE IF NOT EXISTS klien (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS outlet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klien_id INTEGER NOT NULL,
    nama TEXT NOT NULL,
    kode TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (klien_id) REFERENCES klien(id),
    UNIQUE(klien_id, nama)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS supplier (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL UNIQUE,
    kontak TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS barang (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL UNIQUE,
    satuan_default TEXT,
    alias TEXT,                 -- JSON array string, cth: ["cabe ijo","cabe hijau"]
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS harga (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klien_id INTEGER NOT NULL,
    barang_id INTEGER NOT NULL,
    harga INTEGER NOT NULL,
    berlaku_sejak TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (klien_id) REFERENCES klien(id),
    FOREIGN KEY (barang_id) REFERENCES barang(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sales_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outlet_id INTEGER NOT NULL,
    tanggal_pesanan TEXT NOT NULL,
    status TEXT DEFAULT 'BARU',   -- BARU | DIKIRIM | DITERIMA | INVOICED | LUNAS
    teks_asli TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlet(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sales_order_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_order_id INTEGER NOT NULL,
    barang_id INTEGER NOT NULL,
    qty REAL NOT NULL,
    uom TEXT,
    FOREIGN KEY (sales_order_id) REFERENCES sales_order(id),
    FOREIGN KEY (barang_id) REFERENCES barang(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_order_id INTEGER NOT NULL,
    status TEXT DEFAULT 'DIBUAT',  -- DIBUAT | DIAMBIL | DIKIRIM | DITERIMA
    file_path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sales_order_id) REFERENCES sales_order(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL,
    tanggal TEXT NOT NULL,
    status TEXT DEFAULT 'DIBUAT',  -- DIBUAT | DITERIMA
    file_path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (supplier_id) REFERENCES supplier(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_order_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL,
    barang_id INTEGER NOT NULL,
    outlet_id INTEGER,            -- opsional, kalau mau catat ini buat outlet mana (format gambar 3)
    qty REAL NOT NULL,
    uom TEXT,
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_order(id),
    FOREIGN KEY (barang_id) REFERENCES barang(id),
    FOREIGN KEY (outlet_id) REFERENCES outlet(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tagihan_supplier (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL,
    purchase_order_id INTEGER,     -- nullable, di-link manual belakangan kalau ambigu
    nominal INTEGER NOT NULL,
    keterangan TEXT,
    status TEXT DEFAULT 'BELUM_LUNAS',  -- BELUM_LUNAS | LUNAS
    teks_asli TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    FOREIGN KEY (supplier_id) REFERENCES supplier(id),
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_order(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS invoice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_order_id INTEGER NOT NULL,
    total INTEGER NOT NULL,
    status TEXT DEFAULT 'BELUM_LUNAS',  -- BELUM_LUNAS | LUNAS
    file_path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    FOREIGN KEY (sales_order_id) REFERENCES sales_order(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    barang_id INTEGER NOT NULL,
    qty REAL NOT NULL,
    uom TEXT,
    harga_satuan INTEGER NOT NULL,
    subtotal INTEGER NOT NULL,
    FOREIGN KEY (invoice_id) REFERENCES invoice(id),
    FOREIGN KEY (barang_id) REFERENCES barang(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// ========== SEED AWAL ==========

function seedAwal() {
  const klienSSB = db.prepare('SELECT id FROM klien WHERE nama = ?').get('SSB');
  let klienId;
  if (!klienSSB) {
    klienId = db.prepare('INSERT INTO klien (nama) VALUES (?)').run('SSB').lastInsertRowid;
    console.log('✅ Klien SSB dibuat');
  } else {
    klienId = klienSSB.id;
  }

  const outletAwal = ['Kelapa Gading', 'Jombang', 'Sukatani', 'Kalijaya'];
  for (const nama of outletAwal) {
    const ada = db.prepare('SELECT id FROM outlet WHERE klien_id = ? AND nama = ?').get(klienId, nama);
    if (!ada) {
      db.prepare('INSERT INTO outlet (klien_id, nama) VALUES (?, ?)').run(klienId, nama);
      console.log(`✅ Outlet ${nama} dibuat`);
    }
  }

  const hargaAwal = [
    ['Toge', 'Kg', 12500],
    ['Jeruk Wedang', 'Kg', 16900],
    ['Jeruk Nipis', 'Kg', 28000],
    ['Wortel Brastagi', 'Kg', 16500],
    ['Seledri', 'Kg', 30000],
    ['Jagung Kulit', 'Kg', 12000],
    ['Daun Bawang', 'Kg', 20500],
    ['Daun Jeruk', 'gr', 48000],
    ['Daun Pisang', 'ikat', 12000],
    ['Cabe Rawit Hijau', 'Kg', 48600],
    ['Cabe Rawit Merah Burga', 'Kg', 71000],
    ['Cabe Rawit Merah Burga Petik', 'Kg', 81500],
    ['Jahe', 'Kg', 18750],
    ['Sereh', 'Kg', 18500],
    ['Lengkuas', 'Kg', 10000],
  ];

  for (const [nama, satuan, harga] of hargaAwal) {
    let barang = db.prepare('SELECT id FROM barang WHERE nama = ?').get(nama);
    let barangId;
    if (!barang) {
      barangId = db.prepare('INSERT INTO barang (nama, satuan_default) VALUES (?, ?)').run(nama, satuan).lastInsertRowid;
      console.log(`✅ Barang ${nama} dibuat`);
    } else {
      barangId = barang.id;
    }

    const adaHarga = db.prepare('SELECT id FROM harga WHERE klien_id = ? AND barang_id = ?').get(klienId, barangId);
    if (!adaHarga) {
      db.prepare('INSERT INTO harga (klien_id, barang_id, harga) VALUES (?, ?, ?)').run(klienId, barangId, harga);
    }
  }

  console.log('✅ Seed selesai');
}

seedAwal();

// ========== HELPER QUERIES (dasar, akan ditambah di step berikutnya) ==========

function getKlienByNama(nama) {
  return db.prepare('SELECT * FROM klien WHERE nama = ?').get(nama);
}

function getOrCreateOutlet(klienId, namaOutlet) {
  let outlet = db.prepare('SELECT * FROM outlet WHERE klien_id = ? AND nama = ?').get(klienId, namaOutlet);
  if (!outlet) {
    const id = db.prepare('INSERT INTO outlet (klien_id, nama) VALUES (?, ?)').run(klienId, namaOutlet).lastInsertRowid;
    outlet = db.prepare('SELECT * FROM outlet WHERE id = ?').get(id);
  }
  return outlet;
}

function getHargaTerbaru(klienId, barangId) {
  return db.prepare(`
    SELECT * FROM harga
    WHERE klien_id = ? AND barang_id = ?
    ORDER BY berlaku_sejak DESC LIMIT 1
  `).get(klienId, barangId);
}

module.exports = {
  db,
  getKlienByNama,
  getOrCreateOutlet,
  getHargaTerbaru,
};