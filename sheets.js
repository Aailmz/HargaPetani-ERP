const { google } = require('googleapis');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, process.env.GOOGLE_SERVICE_ACCOUNT_PATH),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

/**
 * Tambah 1 baris baru ke tab tertentu.
 * Return nomor baris yang baru ditambah (buat referensi update status nanti).
 */
async function appendRow(namaTab, rowValues) {
  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${namaTab}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] },
  });

  const updatedRange = result.data.updates.updatedRange; // contoh: "Reimburse!A5:F5"
  const match = updatedRange.match(/!A(\d+):/);
  return match ? parseInt(match[1]) : null;
}

/**
 * Update 1 cell spesifik (misal kolom status).
 */
async function updateCell(namaTab, rowNumber, kolomHuruf, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${namaTab}!${kolomHuruf}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

module.exports = { appendRow, updateCell };