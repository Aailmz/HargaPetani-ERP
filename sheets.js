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


async function sheetIdDari(namaTab) {
  const meta = await getSheets().spreadsheets.get({ spreadsheetId: spreadsheetId(), fields: 'sheets.properties(sheetId,title)' });
  const sheet = meta.data.sheets.find((x) => x.properties.title === namaTab);
  return sheet ? sheet.properties.sheetId : null;
}

/** Baca baris pertama (header) tab, atau [] kalau kosong. */
async function bacaHeader(namaTab, jumlahKolom) {
  const huruf = String.fromCharCode(64 + jumlahKolom);
  const r = await getSheets().spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range: `${namaTab}!A1:${huruf}1` });
  return (r.data.values && r.data.values[0]) || [];
}

async function tulisHeader(namaTab, headerRow) {
  await getSheets().spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${namaTab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headerRow] },
  });
}

/** Hapus semua isi di bawah header. */
async function kosongkanIsi(namaTab) {
  await getSheets().spreadsheets.values.clear({ spreadsheetId: spreadsheetId(), range: `${namaTab}!A2:Z` });
}

/** Tulis banyak baris sekaligus mulai dari baris 2. */
async function tulisBanyak(namaTab, rows) {
  const UKURAN = 400;
  for (let i = 0; i < rows.length; i += UKURAN) {
    await getSheets().spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${namaTab}!A${2 + i}`,
      valueInputOption: 'RAW',
      requestBody: { values: rows.slice(i, i + UKURAN) },
    });
  }
}

const HIJAU_TUA = { red: 0.11, green: 0.34, blue: 0.24 };
const PUTIH = { red: 1, green: 1, blue: 1 };

/**
 * Rapikan tampilan tab: header tebal berwarna + beku, lebar kolom, teks panjang membungkus,
 * kolom angka berformat ribuan, dan filter. Aman dipanggil berulang (idempoten).
 * spec: { lebar: [px per kolom], wrap: [indeks kolom], angka: [indeks kolom] }
 */
async function rapikanTab(namaTab, spec) {
  const sheetId = await sheetIdDari(namaTab);
  if (sheetId === null) return;
  const n = spec.lebar.length;
  const BARIS_MAKS = 5000;
  const rentang = (kolomAwal, kolomAkhir, barisAwal = 1, barisAkhir = BARIS_MAKS) => ({
    sheetId,
    startRowIndex: barisAwal,
    endRowIndex: barisAkhir,
    startColumnIndex: kolomAwal,
    endColumnIndex: kolomAkhir,
  });

  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: rentang(0, n, 0, 1),
        cell: { userEnteredFormat: { backgroundColor: HIJAU_TUA, textFormat: { bold: true, foregroundColor: PUTIH }, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)',
      },
    },
    {
      repeatCell: {
        range: rentang(0, n),
        cell: { userEnteredFormat: { verticalAlignment: 'TOP', wrapStrategy: 'CLIP' } },
        fields: 'userEnteredFormat(verticalAlignment,wrapStrategy)',
      },
    },
    ...spec.wrap.map((c) => ({
      repeatCell: { range: rentang(c, c + 1), cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.wrapStrategy' },
    })),
    ...spec.angka.map((c) => ({
      repeatCell: {
        range: rentang(c, c + 1),
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' }, horizontalAlignment: 'RIGHT' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    })),
    ...spec.lebar.map((px, i) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    })),
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: n } } } },
  ];

  await getSheets().spreadsheets.batchUpdate({ spreadsheetId: spreadsheetId(), requestBody: { requests } });
}

/** Tinggi baris menyesuaikan isi (dipanggil setelah tulis massal). */
async function sesuaikanTinggiBaris(namaTab, jumlahBaris) {
  const sheetId = await sheetIdDari(namaTab);
  if (sheetId === null || jumlahBaris < 1) return;
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests: [{ autoResizeDimensions: { dimensions: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: jumlahBaris + 1 } } }] },
  });
}

module.exports = {
  appendRow,
  updateRow,
  updateCell,
  pastikanTab,
  sheetsAktif,
  bacaHeader,
  tulisHeader,
  kosongkanIsi,
  tulisBanyak,
  rapikanTab,
  sesuaikanTinggiBaris,
};
