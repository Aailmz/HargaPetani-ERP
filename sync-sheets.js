// Tulis ulang seluruh dump dari database ke tab Google Sheets (dan rapikan tampilannya).
// Pakai: node sync-sheets.js
require('dotenv').config();
const { sinkronSemuaPaksa } = require('./sync');

sinkronSemuaPaksa()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Gagal:', err.message);
    process.exit(1);
  });
