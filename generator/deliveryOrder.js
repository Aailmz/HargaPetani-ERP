const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { getSalesOrderDetail } = require('../salesOrder');
const { renderHtmlToJpg } = require('./renderImage');
const { templateDO } = require('./templates');

const WARNA_HIJAU = 'FF92D050';
const FOLDER_OUTPUT = path.join(__dirname, '..', 'output', 'delivery-order');

if (!fs.existsSync(FOLDER_OUTPUT)) fs.mkdirSync(FOLDER_OUTPUT, { recursive: true });

function formatTanggalIndo(tanggalISO) {
  const hariList = ['MINGGU', 'SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU'];
  const bulanList = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];
  const d = new Date(tanggalISO + 'T00:00:00');
  return `${hariList[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')} ${bulanList[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Generate file Excel Delivery Order dari 1 Sales Order.
 * Return: { sukses, file_path, pesan }
 */
async function generateDO(salesOrderId) {
  const so = getSalesOrderDetail(salesOrderId);
  if (!so) {
    return { sukses: false, pesan: `Sales Order #${salesOrderId} tidak ditemukan.` };
  }
  if (so.items.length === 0) {
    return { sukses: false, pesan: `Sales Order #${salesOrderId} tidak punya item barang.` };
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('DO');

  sheet.columns = [
    { width: 38 }, // Nama Barang
    { width: 10 }, // Qty
    { width: 10 }, // UOM
  ];

  // Baris 1: Nama outlet (besar, bold, tanpa background)
  sheet.mergeCells('A1:C1');
  const cellOutlet = sheet.getCell('A1');
  cellOutlet.value = so.outlet_nama.toUpperCase();
  cellOutlet.font = { bold: true, size: 16 };
  cellOutlet.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 28;

  // Baris 2: bar hijau berisi tanggal
  sheet.mergeCells('A2:C2');
  const cellTanggal = sheet.getCell('A2');
  cellTanggal.value = formatTanggalIndo(so.tanggal_pesanan);
  cellTanggal.font = { bold: true, size: 14 };
  cellTanggal.alignment = { vertical: 'middle' };
  cellTanggal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARNA_HIJAU } };
  sheet.getRow(2).height = 24;

  // Baris 3: kosong (spacer, sesuai contoh ada jarak sebelum tabel)
  sheet.getRow(3).height = 6;

  // Baris 4: header tabel
  const headerRow = sheet.getRow(4);
  headerRow.values = ['NAMA BARANG', 'QTY', 'UOM'];
  headerRow.font = { bold: true, size: 12 };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  // Baris data
  let rowIdx = 5;
  for (const item of so.items) {
    const row = sheet.getRow(rowIdx);
    row.getCell(1).value = item.barang_nama.toUpperCase();
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    row.getCell(2).value = item.qty;
    row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(3).value = item.uom || '';
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    row.height = 20;
    rowIdx++;
  }

  // Border tipis buat semua cell tabel (header + data)
  const borderTipis = { style: 'thin', color: { argb: 'FF000000' } };
  for (let r = 4; r < rowIdx; r++) {
    for (let c = 1; c <= 3; c++) {
      sheet.getRow(r).getCell(c).border = {
        top: borderTipis, left: borderTipis, bottom: borderTipis, right: borderTipis,
      };
    }
  }

  const namaFile = `DO-${so.outlet_nama.replace(/\s+/g, '')}-${so.tanggal_pesanan}-${salesOrderId}.xlsx`;
  const filePath = path.join(FOLDER_OUTPUT, namaFile);
  await workbook.xlsx.writeFile(filePath);

  const htmlDO = templateDO({
    outletNama: so.outlet_nama,
    tanggalDisplay: formatTanggalIndo(so.tanggal_pesanan),
    items: so.items,
  });
  const namaFileJpg = `DO-${so.outlet_nama.replace(/\s+/g, '')}-${so.tanggal_pesanan}-${salesOrderId}.jpg`;
  const filePathJpg = path.join(FOLDER_OUTPUT, namaFileJpg);
  await renderHtmlToJpg(htmlDO, filePathJpg);

  const db = require('../db').db;
  db.prepare(`
    INSERT INTO delivery_order (sales_order_id, status, file_path) VALUES (?, 'DIBUAT', ?)
  `).run(salesOrderId, filePath);

  return {
    sukses: true,
    file_path: filePath,
    file_path_jpg: filePathJpg,
    pesan: `Delivery Order untuk ${so.outlet_nama} berhasil dibuat.`,
  };
}

module.exports = { generateDO, formatTanggalIndo };