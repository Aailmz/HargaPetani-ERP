const { db, getKlienByNama, getOrCreateOutlet, getHargaTerbaru } = require('./db');
const { normalisasiNamaBarang, buatBarangBaru } = require('./parser');

const NAMA_KLIEN_DEFAULT = 'SSB'; // temporary, semua disamakan ke SSB (per keputusan sementara)

/**
 * Simpan hasil parse pesanan jadi Sales Order + items.
 * Barang yang tidak dikenal akan otomatis dibuat baru (satuan default dari UOM di pesanan).
 *
 * Return: { sukses, sales_order_id, outlet, barang_baru: [...nama barang yg baru dibuat] }
 */
function simpanSalesOrder(parsedData, teksAsli) {
  if (!parsedData.outlet) {
    return { sukses: false, pesan: 'Outlet tidak terdeteksi dari teks, perlu dikonfirmasi manual.' };
  }
  if (!parsedData.items || parsedData.items.length === 0) {
    return { sukses: false, pesan: 'Tidak ada item barang yang terdeteksi.' };
  }

  const klien = getKlienByNama(NAMA_KLIEN_DEFAULT);
  if (!klien) {
    return { sukses: false, pesan: `Klien ${NAMA_KLIEN_DEFAULT} belum ada di database.` };
  }

  const outlet = getOrCreateOutlet(klien.id, parsedData.outlet);
  const tanggal = parsedData.tanggal_pesanan || new Date().toISOString().split('T')[0];

  const insertSO = db.prepare(`
    INSERT INTO sales_order (outlet_id, tanggal_pesanan, status, teks_asli)
    VALUES (?, ?, 'BARU', ?)
  `);
  const soId = insertSO.run(outlet.id, tanggal, teksAsli || null).lastInsertRowid;

  const insertItem = db.prepare(`
    INSERT INTO sales_order_item (sales_order_id, barang_id, qty, uom)
    VALUES (?, ?, ?, ?)
  `);

  const barangBaru = [];

  for (const item of parsedData.items) {
    if (item.qty === null || item.qty === undefined || item.qty === 0) continue; // jaga-jaga kalau AI lolos

    let barang = normalisasiNamaBarang(item.nama_barang);
    if (!barang) {
      barang = buatBarangBaru(item.nama_barang, item.uom || null);
      barangBaru.push(item.nama_barang);
    }

    insertItem.run(soId, barang.id, item.qty, item.uom || barang.satuan_default);
  }

  return {
    sukses: true,
    sales_order_id: soId,
    outlet: outlet.nama,
    tanggal,
    jumlah_item: parsedData.items.length,
    barang_baru: barangBaru,
  };
}

function getSalesOrderDetail(soId) {
  const so = db.prepare(`
    SELECT so.*, o.nama as outlet_nama, k.nama as klien_nama, o.klien_id
    FROM sales_order so
    JOIN outlet o ON o.id = so.outlet_id
    JOIN klien k ON k.id = o.klien_id
    WHERE so.id = ?
  `).get(soId);

  if (!so) return null;

  const items = db.prepare(`
    SELECT soi.*, b.nama as barang_nama
    FROM sales_order_item soi
    JOIN barang b ON b.id = soi.barang_id
    WHERE soi.sales_order_id = ?
  `).all(soId);

  return { ...so, items };
}

function setStatusSalesOrder(soId, status) {
  db.prepare('UPDATE sales_order SET status = ? WHERE id = ?').run(status, soId);
}

function cariSalesOrderByOutletTanggal(namaOutlet, tanggal) {
  return db.prepare(`
    SELECT so.* FROM sales_order so
    JOIN outlet o ON o.id = so.outlet_id
    WHERE o.nama LIKE ? AND so.tanggal_pesanan = ?
    ORDER BY so.created_at DESC
  `).all(`%${namaOutlet}%`, tanggal);
}

function getSalesOrderHariIni(tanggal) {
  return db.prepare(`
    SELECT so.*, o.nama as outlet_nama
    FROM sales_order so
    JOIN outlet o ON o.id = so.outlet_id
    WHERE so.tanggal_pesanan = ?
    ORDER BY o.nama ASC
  `).all(tanggal);
}

/**
 * Agregasi total qty per barang, across semua SO di tanggal tertentu.
 * Dipakai owner buat liat total kebutuhan sebelum alokasi PO ke supplier.
 */
function getTotalKebutuhanBarang(tanggal) {
  return db.prepare(`
    SELECT b.id as barang_id, b.nama as barang_nama, soi.uom, SUM(soi.qty) as total_qty
    FROM sales_order_item soi
    JOIN sales_order so ON so.id = soi.sales_order_id
    JOIN barang b ON b.id = soi.barang_id
    WHERE so.tanggal_pesanan = ?
    GROUP BY b.id, soi.uom
    ORDER BY b.nama ASC
  `).all(tanggal);
}

module.exports = {
  simpanSalesOrder,
  getSalesOrderDetail,
  setStatusSalesOrder,
  cariSalesOrderByOutletTanggal,
  getSalesOrderHariIni,
  getTotalKebutuhanBarang,
};