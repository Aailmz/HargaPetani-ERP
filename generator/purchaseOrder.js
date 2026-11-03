const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { renderHtmlToJpg } = require('./renderImage');
const { templatePO } = require('./templates');

const WARNA_HIJAU = 'FF92D050';
const WARNA_ORANYE = 'FFF4B183';
const FOLDER_OUTPUT = path.join(__dirname, '..', 'output', 'purchase-order');

if (!fs.existsSync(FOLDER_OUTPUT)) fs.mkdirSync(FOLDER_OUTPUT, { recursive: true });

function formatTanggalIndo(tanggalISO) {
  const hariList = ['MINGGU', 'SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU'];
  const bulanList = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];
  const d = new Date(tanggalISO + 'T00:00:00');
  return `${hariList[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')} ${bulanList[d.getMonth()]} ${d.getFullYear()}`;
}

function buatKodeOutletOtomatis(namaOutlet) {
  const kata = namaOutlet.trim().split(/\s+/);
  if (kata.length > 1) return kata.map((k) => k[0].toUpperCase()).join('');
  return namaOutlet.substring(0, 3).toUpperCase();
}

/**
 * Resolve kode outlet: pakai outlet.kode dari DB kalau sudah di-set manual,
 * fallback ke auto-generate dari inisial nama kalau belum.
 */
function getKodeOutlet(outletId, namaOutlet) {
  const outlet = db.prepare('SELECT kode FROM outlet WHERE id = ?').get(outletId);
  if (outlet && outlet.kode) return outlet.kode;
  return buatKodeOutletOtomatis(namaOutlet);
}

function setKodeOutlet(outletId, kodeBaru) {
  db.prepare('UPDATE outlet SET kode = ? WHERE id = ?').run(kodeBaru.toUpperCase(), outletId);
}

/**
 * items: [{ nama_barang, barang_id, qty, uom, outlet_nama, outlet_id }]
 * Semua item WAJIB punya outlet.
 *
 * Return: { sukses, file_path, purchase_order_id, pesan }
 */
async function generatePO({ supplierId, supplierNama, tanggal, items, labelKategori }) {
  if (!items || items.length === 0) {
    return { sukses: false, pesan: 'Tidak ada item untuk PO ini.' };
  }

  const tanpaOutlet = items.filter((i) => !i.outlet_nama);
  if (tanpaOutlet.length > 0) {
    return {
      sukses: false,
      pesan: `Item berikut belum ada outlet asalnya: ${tanpaOutlet.map((i) => i.nama_barang).join(', ')}. Sebutkan outlet buat tiap barang.`,
    };
  }

  const grupBarang = new Map();
  for (const item of items) {
    if (!grupBarang.has(item.nama_barang)) grupBarang.set(item.nama_barang, []);
    grupBarang.get(item.nama_barang).push({
      outlet_nama: item.outlet_nama,
      kode: getKodeOutlet(item.outlet_id, item.outlet_nama),
      qty: item.qty,
      uom: item.uom,
    });
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('PO');

  sheet.columns = [
    { width: 10 },
    { width: 28 },
    { width: 9 },
    { width: 8 },
  ];

  sheet.mergeCells('A1:D1');
  const cellTanggal = sheet.getCell('A1');
  cellTanggal.value = formatTanggalIndo(tanggal);
  cellTanggal.font = { bold: true, size: 14 };
  cellTanggal.alignment = { vertical: 'middle' };
  cellTanggal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARNA_HIJAU } };
  sheet.getRow(1).height = 24;

  sheet.mergeCells('A2:D2');
  sheet.getCell('A2').value = (labelKategori || '').toUpperCase();
  sheet.getCell('A2').font = { bold: true, size: 13 };

  sheet.mergeCells('A3:D3');
  sheet.getCell('A3').value = `PO ${supplierNama.toUpperCase()}`;
  sheet.getCell('A3').font = { bold: true, size: 13 };

  sheet.getRow(4).height = 4;

  const headerRow = sheet.getRow(5);
  headerRow.values = ['KODE', 'NAMA BARANG', 'QTY', 'UOM'];
  headerRow.font = { bold: true, size: 12 };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  let rowIdx = 6;
  let grupKe = 0;
  const borderTipis = { style: 'thin', color: { argb: 'FF000000' } };

  for (const [namaBarang, baris] of grupBarang.entries()) {
    const pakaiWarna = grupKe % 2 === 1;

    for (const b of baris) {
      const row = sheet.getRow(rowIdx);
      row.getCell(1).value = `SSB ${b.kode}`;
      row.getCell(2).value = namaBarang.toUpperCase();
      row.getCell(3).value = b.qty;
      row.getCell(4).value = b.uom || '';

      row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell(4).alignment = { horizontal: 'center', vertical: 'middle' };
      row.height = 20;

      if (pakaiWarna) {
        for (let c = 1; c <= 4; c++) {
          row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARNA_ORANYE } };
        }
      }
      for (let c = 1; c <= 4; c++) {
        row.getCell(c).border = { top: borderTipis, left: borderTipis, bottom: borderTipis, right: borderTipis };
      }
      rowIdx++;
    }
    grupKe++;
  }

  const namaFile = `PO-${supplierNama.replace(/\s+/g, '')}-${tanggal}-${Date.now()}.xlsx`;
  const filePath = path.join(FOLDER_OUTPUT, namaFile);
  await workbook.xlsx.writeFile(filePath);

  const insertPO = db.prepare(`
    INSERT INTO purchase_order (supplier_id, tanggal, status, file_path) VALUES (?, ?, 'DIBUAT', ?)
  `);
  const poId = insertPO.run(supplierId, tanggal, filePath).lastInsertRowid;

  const insertItem = db.prepare(`
    INSERT INTO purchase_order_item (purchase_order_id, barang_id, outlet_id, qty, uom) VALUES (?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    insertItem.run(poId, item.barang_id, item.outlet_id || null, item.qty, item.uom || null);
  }

  const htmlPO = templatePO({
    tanggalDisplay: formatTanggalIndo(tanggal),
    labelKategori,
    supplierNama,
    grupBarang,
  });
  const namaFileJpg = `PO-${supplierNama.replace(/\s+/g, '')}-${tanggal}-${Date.now()}.jpg`;
  const filePathJpg = path.join(FOLDER_OUTPUT, namaFileJpg);
  await renderHtmlToJpg(htmlPO, filePathJpg);

  return {
    sukses: true,
    file_path: filePath,
    file_path_jpg: filePathJpg,
    purchase_order_id: poId,
    pesan: `PO ke ${supplierNama} berhasil dibuat (${grupBarang.size} jenis barang, ${items.length} baris).`,
  };
}

module.exports = { generatePO, getKodeOutlet, setKodeOutlet, buatKodeOutletOtomatis };