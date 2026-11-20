const { google } = require('googleapis');
const path = require('path');

// Auth dibuat lazy supaya bot tetap bisa jalan tanpa konfigurasi Google (fitur Sheets cuma nonaktif).
let _sheets = null;

function getSheets() {
  if (!_sheets) {
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, process.env.GOOGLE_SERVICE_ACCOUNT_PATH),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    _sheets = google.sheets({ version: 'v4', auth });
  }
  return _sheets;
}

function spreadsheetId() {
  return process.env.GOOGLE_SPREADSHEET_ID;
}

function sheetsAktif() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_PATH && process.env.GOOGLE_SPREADSHEET_ID && process.env.DUMP_SHEETS !== 'off');
}

/**
 * Tambah 1 baris baru ke tab tertentu.
 * Return nomor baris yang baru ditambah (buat referensi update nanti).
 */
async function appendRow(namaTab, rowValues, valueInputOption = 'USER_ENTERED') {
  const result = await getSheets().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${namaTab}!A1`,
    valueInputOption,
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] },
  });

  const updatedRange = result.data.updates.updatedRange; // contoh: "Dump!A5:J5"
  const match = updatedRange.match(/!A(\d+):/);
  return match ? parseInt(match[1], 10) : null;
}

/** Timpa satu baris penuh (mulai kolom A). */
async function updateRow(namaTab, rowNumber, rowValues, valueInputOption = 'USER_ENTERED') {
  await getSheets().spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${namaTab}!A${rowNumber}`,
    valueInputOption,
    requestBody: { values: [rowValues] },
  });
}

/**
 * Update 1 cell spesifik (misal kolom status).
 */
async function updateCell(namaTab, rowNumber, kolomHuruf, value) {
  await getSheets().spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${namaTab}!${kolomHuruf}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

/** Pastikan tab ada (dibuat + header ditulis kalau belum). */
async function pastikanTab(namaTab, headerRow) {
  const api = getSheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: spreadsheetId(), fields: 'sheets.properties.title' });
  const ada = meta.data.sheets.some((s) => s.properties.title === namaTab);
  if (ada) return false;

  await api.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests: [{ addSheet: { properties: { title: namaTab, gridProperties: { frozenRowCount: 1 } } } }] },
  });
  await api.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${namaTab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headerRow] },
  });
  return true;
}

module.exports = { appendRow, updateRow, updateCell, pastikanTab, sheetsAktif };
