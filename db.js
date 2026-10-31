const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'harga-petani-erp.db'));

// ========== SKEMA ==========

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    jid TEXT PRIMARY KEY,
    nama TEXT,
    posisi TEXT,
    state TEXT DEFAULT 'IDLE',          -- IDLE | WAITING_NAMA | WAITING_POSISI
    is_registered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS operators (
    jid TEXT PRIMARY KEY,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reimburse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_jid TEXT NOT NULL,
    peruntukan TEXT NOT NULL,
    nominal INTEGER NOT NULL,
    status TEXT DEFAULT 'PENDING',
    alasan_reject TEXT,
    sheets_row INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    role TEXT NOT NULL,        -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS absensi_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_jid TEXT NOT NULL,
    lat REAL,
    long REAL,
    created_at_display TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS kwitansi_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_jid TEXT NOT NULL,
    nama_file TEXT NOT NULL,
    peruntukan TEXT,
    nominal INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

require('dotenv').config();

// ========== SETUP OPERATOR ==========

function setupOperator() {
  const jidOperator = process.env.OPERATOR_JID;
  if (!jidOperator) {
    console.log('⚠️  OPERATOR_JID belum di-set di .env!');
    return;
  }
  const sudahAda = db.prepare('SELECT jid FROM operators WHERE jid = ?').get(jidOperator);
  if (!sudahAda) {
    db.prepare('INSERT INTO operators (jid) VALUES (?)').run(jidOperator);
    console.log(`✅ Operator terdaftar: ${jidOperator}`);
  }
}
setupOperator();

function isOperator(jid) {
  const row = db.prepare('SELECT jid FROM operators WHERE jid = ?').get(jid);
  return !!row;
}

// ========== EMPLOYEES ==========

function getOrCreateEmployee(jid) {
  let employee = db.prepare('SELECT * FROM employees WHERE jid = ?').get(jid);
  if (!employee) {
    db.prepare('INSERT INTO employees (jid, state, is_registered) VALUES (?, ?, 0)').run(jid, 'IDLE');
    employee = db.prepare('SELECT * FROM employees WHERE jid = ?').get(jid);
  }
  return employee;
}

function getEmployee(jid) {
  return getOrCreateEmployee(jid);
}

function isEmployeeRegistered(jid) {
  return getOrCreateEmployee(jid).is_registered === 1;
}

function registerEmployee(jid) {
  getOrCreateEmployee(jid);
  db.prepare('UPDATE employees SET is_registered = 1 WHERE jid = ?').run(jid);
}

function setEmployeeState(jid, state) {
  getOrCreateEmployee(jid);
  db.prepare('UPDATE employees SET state = ? WHERE jid = ?').run(state, jid);
}

function setEmployeeNama(jid, nama) {
  getOrCreateEmployee(jid);
  db.prepare('UPDATE employees SET nama = ? WHERE jid = ?').run(nama, jid);
}

function setEmployeePosisi(jid, posisi) {
  getOrCreateEmployee(jid);
  db.prepare('UPDATE employees SET posisi = ? WHERE jid = ?').run(posisi, jid);
}

function getAllEmployees() {
  return db.prepare('SELECT * FROM employees WHERE is_registered = 1 ORDER BY created_at ASC').all();
}

// ========== ABSENSI ==========

function catatAbsensiLog(employeeJid, lat, long, waktuDisplay) {
  db.prepare(`
    INSERT INTO absensi_log (employee_jid, lat, long, created_at_display) VALUES (?, ?, ?, ?)
  `).run(employeeJid, lat, long, waktuDisplay);
}

function sudahCheckinHariIni(employeeJid) {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM absensi_log
    WHERE employee_jid = ? AND date(created_at) = date('now', 'localtime')
  `).get(employeeJid);
  return row.c > 0;
}

function getAbsensiHariIni(employeeJid) {
  return db.prepare(`
    SELECT * FROM absensi_log
    WHERE employee_jid = ? AND date(created_at) = date('now', 'localtime')
    ORDER BY created_at ASC
  `).all(employeeJid);
}

function getEmployeeBelumAbsenHariIni() {
  return db.prepare(`
    SELECT * FROM employees
    WHERE is_registered = 1
    AND jid NOT IN (
      SELECT DISTINCT employee_jid FROM absensi_log
      WHERE date(created_at) = date('now', 'localtime')
    )
  `).all();
}

// ========== REIMBURSE ==========

function buatReimburseBaru(employeeJid, peruntukan, nominal) {
  const result = db.prepare(`
    INSERT INTO reimburse (employee_jid, peruntukan, nominal, status) VALUES (?, ?, ?, 'PENDING')
  `).run(employeeJid, peruntukan, nominal);
  return result.lastInsertRowid;
}

function buatKwitansiPending(employeeJid, namaFile) {
  const result = db.prepare(`
    INSERT INTO kwitansi_pending (employee_jid, nama_file) VALUES (?, ?)
  `).run(employeeJid, namaFile);
  return result.lastInsertRowid;
}

function getKwitansiPendingAktif(employeeJid) {
  return db.prepare(`
    SELECT * FROM kwitansi_pending WHERE employee_jid = ? ORDER BY created_at DESC LIMIT 1
  `).get(employeeJid);
}

function lengkapiKwitansiPending(id, peruntukan, nominal) {
  db.prepare(`
    UPDATE kwitansi_pending SET peruntukan = ?, nominal = ? WHERE id = ?
  `).run(peruntukan, nominal, id);
}

function hapusKwitansiPending(id) {
  db.prepare('DELETE FROM kwitansi_pending WHERE id = ?').run(id);
}

function setSheetsRowReimburse(id, rowNumber) {
  db.prepare('UPDATE reimburse SET sheets_row = ? WHERE id = ?').run(rowNumber, id);
}

function getReimburseById(id) {
  return db.prepare('SELECT * FROM reimburse WHERE id = ?').get(id);
}

function getReimbursePendingTerbaru(limit = 5) {
  return db.prepare(`
    SELECT * FROM reimburse WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

function setStatusReimburse(id, status, alasanReject = null) {
  const waktu = new Date().toISOString();
  db.prepare(`
    UPDATE reimburse SET status = ?, alasan_reject = ?, updated_at = ? WHERE id = ?
  `).run(status, alasanReject, waktu, id);
  return waktu;
}

// ========== CHAT HISTORY ==========

const MAX_HISTORI_PER_JID = 20;

function simpanChatHistory(jid, role, content) {
  db.prepare(`
    INSERT INTO chat_history (jid, role, content) VALUES (?, ?, ?)
  `).run(jid, role, content);

  const total = db.prepare('SELECT COUNT(*) as c FROM chat_history WHERE jid = ?').get(jid).c;
  if (total > MAX_HISTORI_PER_JID) {
    db.prepare(`
      DELETE FROM chat_history WHERE id IN (
        SELECT id FROM chat_history WHERE jid = ? ORDER BY created_at ASC LIMIT ?
      )
    `).run(jid, total - MAX_HISTORI_PER_JID);
  }
}

function getChatHistory(jid, limit = MAX_HISTORI_PER_JID) {
  const rows = db.prepare(`
    SELECT role, content FROM chat_history WHERE jid = ? ORDER BY created_at ASC LIMIT ?
  `).all(jid, limit);
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

module.exports = {
  db,

  // operator
  isOperator,

  // employees
  getOrCreateEmployee,
  getEmployee,
  isEmployeeRegistered,
  registerEmployee,
  setEmployeeState,
  setEmployeeNama,
  setEmployeePosisi,
  getAllEmployees,

  // reimburse
  buatReimburseBaru,
  setSheetsRowReimburse,
  getReimburseById,
  getReimbursePendingTerbaru,
  setStatusReimburse,

  // chat history
  simpanChatHistory,
  getChatHistory,

    // absensi
  catatAbsensiLog,
  sudahCheckinHariIni,
  getAbsensiHariIni,
  getEmployeeBelumAbsenHariIni,

  // kwitansi pending
  buatKwitansiPending,
  getKwitansiPendingAktif,
  lengkapiKwitansiPending,
  hapusKwitansiPending,
};