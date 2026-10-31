const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'harga-petani-erp.db'));

// Schema lengkap ditambahkan di Step 4

function isEmployeeRegistered(jid) {
  // Placeholder sementara, akan diimplementasi penuh di Step 4
  return false;
}

module.exports = {
  db,
  isEmployeeRegistered,
};