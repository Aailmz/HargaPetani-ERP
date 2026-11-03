const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { getSalesOrderDetail } = require('../salesOrder');
const { getHargaTerbaru } = require('../db');
const { formatTanggalIndo } = require('./deliveryOrder');
const { renderHtmlToJpg } = require('./renderImage');
const { templateInvoice } = require('./templates');

const WARNA_HIJAU = 'FF92D050';
const FOLDER_OUTPUT = path.join(__dirname, '..', 'output', 'invoice');

if (!fs.existsSync(FOLDER_OUTPUT)) fs.mkdirSync(FOLDER_OUTPUT, { recursive: true });

/**
 * Generate file Excel Invoice dari 1 Sales Order.
 * Harga diambil dari harga terbaru yg berlaku untuk klien outlet tsb.
 * Return: { sukses, file_path, total, pesan, barang_tanpa_harga: [...] }
 */
async function generateInvoice(salesOrderId) {
  const so = getSalesOrderDetail(salesOrderId);
  if (!so) {
    return { sukses: false, pesan: `Sales Order #${salesOrderId} tidak ditemukan.` };
  }
  if (so.items.length === 0) {
    return { sukses: false, pesan: `Sales Order #${salesOrderId} tidak punya item barang.` };
  }

  // Resolve harga per item, catat kalau ada yang belum punya harga
  const itemsDenganHarga = [];
  const barangTanpaHarga = [];

  for (const item of so.items) {
    const hargaRow = getHargaTerbaru(so.klien_id, item.barang_id);
    const hargaSatuan = hargaRow ? hargaRow.harga : 0;
    if (!hargaRow) barangTanpaHarga.push(item.barang_nama);

    itemsDenganHarga.push({
      ...item,
      harga_satuan: hargaSatuan,
      subtotal: Math.round(item.qty * hargaSatuan),
    });
  }

  const total = itemsDenganHarga.reduce((sum, i) => sum + i.subtotal, 0);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Invoice');

  sheet.columns = [
    { width: 32 }, // Nama Barang
    { width: 9 },  // Qty
    { width: 8 },  // UOM
    { width: 14 }, // Harga Satuan
    { width: 16 }, // Subtotal
  ];

  // Baris 1: Nama outlet
  sheet.mergeCells('A1:E1');
  const cellOutlet = sheet.getCell('A1');
  cellOutlet.value = `INVOICE - ${so.outlet_nama.toUpperCase()}`;
  cellOutlet.font = { bold: true, size: 16 };
  cellOutlet.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 28;

  // Baris 2: bar hijau tanggal
  sheet.mergeCells('A2:E2');
  const cellTanggal = sheet.getCell('A2');
  cellTanggal.value = formatTanggalIndo(so.tanggal_pesanan);
  cellTanggal.font = { bold: true, size: 14 };
  cellTanggal.alignment = { vertical: 'middle' };
  cellTanggal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARNA_HIJAU } };
  sheet.getRow(2).height = 24;

  sheet.getRow(3).height = 6;

  // Header tabel
  const headerRow = sheet.getRow(4);
  headerRow.values = ['NAMA BARANG', 'QTY', 'UOM', 'HARGA SATUAN', 'SUBTOTAL'];
  headerRow.font = { bold: true, size: 12 };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  let rowIdx = 5;
  for (const item of itemsDenganHarga) {
    const row = sheet.getRow(rowIdx);
    row.getCell(1).value = item.barang_nama.toUpperCase();
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    row.getCell(2).value = item.qty;
    row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(3).value = item.uom || '';
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(4).value = item.harga_satuan;
    row.getCell(4).numFmt = '#,##0';
    row.getCell(4).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(5).value = item.subtotal;
    row.getCell(5).numFmt = '#,##0';
    row.getCell(5).alignment = { horizontal: 'right', vertical: 'middle' };
    row.height = 20;
    rowIdx++;
  }

  // Border tabel data
  const borderTipis = { style: 'thin', color: { argb: 'FF000000' } };
  for (let r = 4; r < rowIdx; r++) {
    for (let c = 1; c <= 5; c++) {
      sheet.getRow(r).getCell(c).border = {
        top: borderTipis, left: borderTipis, bottom: borderTipis, right: borderTipis,
      };
    }
  }

  // Baris Total
  sheet.mergeCells(`A${rowIdx}:D${rowIdx}`);
  const cellTotalLabel = sheet.getCell(`A${rowIdx}`);
  cellTotalLabel.value = 'TOTAL';
  cellTotalLabel.font = { bold: true, size: 12 };
  cellTotalLabel.alignment = { horizontal: 'right', vertical: 'middle' };

  const cellTotalValue = sheet.getCell(`E${rowIdx}`);
  cellTotalValue.value = total;
  cellTotalValue.numFmt = '#,##0';
  cellTotalValue.font = { bold: true, size: 12 };
  cellTotalValue.alignment = { horizontal: 'right', vertical: 'middle' };

  for (let c = 1; c <= 5; c++) {
    sheet.getRow(rowIdx).getCell(c).border = {
      top: borderTipis, left: borderTipis, bottom: borderTipis, right: borderTipis,
    };
  }

  const namaFile = `INV-${so.outlet_nama.replace(/\s+/g, '')}-${so.tanggal_pesanan}-${salesOrderId}.xlsx`;
  const filePath = path.join(FOLDER_OUTPUT, namaFile);
  await workbook.xlsx.writeFile(filePath);

  const db = require('../db').db;
  const waktu = new Date().toISOString();
  db.prepare(`
    INSERT INTO invoice (sales_order_id, total, status, file_path) VALUES (?, ?, 'BELUM_LUNAS', ?)
  `).run(salesOrderId, total, filePath);
  const invoiceId = db.prepare('SELECT last_insert_rowid() as id').get().id;

  const insertInvoiceItem = db.prepare(`
    INSERT INTO invoice_item (invoice_id, barang_id, qty, uom, harga_satuan, subtotal) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const item of itemsDenganHarga) {
    insertInvoiceItem.run(invoiceId, item.barang_id, item.qty, item.uom, item.harga_satuan, item.subtotal);
  }

  const htmlInvoice = templateInvoice({
    outletNama: so.outlet_nama,
    tanggalDisplay: formatTanggalIndo(so.tanggal_pesanan),
    items: itemsDenganHarga,
    total,
  });
  const namaFileJpg = `INV-${so.outlet_nama.replace(/\s+/g, '')}-${so.tanggal_pesanan}-${salesOrderId}.jpg`;
  const filePathJpg = path.join(FOLDER_OUTPUT, namaFileJpg);
  await renderHtmlToJpg(htmlInvoice, filePathJpg);

  return {
    sukses: true,
    file_path: filePath,
    file_path_jpg: filePathJpg,
    invoice_id: invoiceId,
    total,
    pesan: `Invoice untuk ${so.outlet_nama} berhasil dibuat, total Rp${total.toLocaleString('id-ID')}.`,
    barang_tanpa_harga: barangTanpaHarga,
};
}

module.exports = { generateInvoice };