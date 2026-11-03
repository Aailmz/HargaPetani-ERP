const { db, getKlienByNama, getOrCreateOutlet, getHargaTerbaru } = require('./db');
const { normalisasiNamaBarang, buatBarangBaru } = require('./parser');

const NAMA_KLIEN_DEFAULT = 'SSB'; // temporary, semua disamakan ke SSB (per keputusan sementara)
const STATUS_TERKUNCI = ['INVOICED', 'LUNAS']; // SO dengan status ini tidak boleh diedit lagi

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

/**
 * Edit satu item di sebuah Sales Order: qty, uom, dan/atau ganti barang (barang_id_baru).
 * Diblokir kalau SO sudah berstatus INVOICED/LUNAS (biar nggak mismatch sama invoice yang
 * sudah digenerate/dibayar - harus dikoreksi manual atau bikin nota penyesuaian terpisah).
 *
 * item_id: id baris sales_order_item yang mau diedit.
 * perubahan: { qty?, uom?, barang_id_baru? } - hanya field yang diisi yang diupdate.
 */
function editItemSalesOrder(itemId, perubahan) {
  const item = db.prepare(`
    SELECT soi.*, so.status as so_status, so.id as so_id
    FROM sales_order_item soi
    JOIN sales_order so ON so.id = soi.sales_order_id
    WHERE soi.id = ?
  `).get(itemId);

  if (!item) return { sukses: false, pesan: `Item Sales Order #${itemId} tidak ditemukan.` };

  if (STATUS_TERKUNCI.includes(item.so_status)) {
    return {
      sukses: false,
      pesan: `Sales Order #${item.so_id} sudah berstatus ${item.so_status}, item tidak bisa diedit lagi lewat chat. Koreksi manual kalau memang perlu.`,
    };
  }

  const setParts = [];
  const params = [];

  if (perubahan.barang_id_baru !== undefined && perubahan.barang_id_baru !== null) {
    const barangBaru = db.prepare('SELECT * FROM barang WHERE id = ?').get(perubahan.barang_id_baru);
    if (!barangBaru) return { sukses: false, pesan: `Barang id ${perubahan.barang_id_baru} tidak ditemukan.` };
    setParts.push('barang_id = ?');
    params.push(perubahan.barang_id_baru);
  }

  if (perubahan.qty !== undefined && perubahan.qty !== null) {
    if (perubahan.qty <= 0) return { sukses: false, pesan: 'Qty baru harus lebih dari 0 (kalau mau hapus item, bilang saja).' };
    setParts.push('qty = ?');
    params.push(perubahan.qty);
  }

  if (perubahan.uom !== undefined && perubahan.uom !== null) {
    setParts.push('uom = ?');
    params.push(perubahan.uom);
  }

  if (setParts.length === 0) {
    return { sukses: false, pesan: 'Tidak ada perubahan yang diminta.' };
  }

  params.push(itemId);
  db.prepare(`UPDATE sales_order_item SET ${setParts.join(', ')} WHERE id = ?`).run(...params);

  const itemBaru = db.prepare(`
    SELECT soi.*, b.nama as barang_nama
    FROM sales_order_item soi
    JOIN barang b ON b.id = soi.barang_id
    WHERE soi.id = ?
  `).get(itemId);

  return {
    sukses: true,
    sales_order_id: item.so_id,
    item: { id: itemBaru.id, barang: itemBaru.barang_nama, qty: itemBaru.qty, uom: itemBaru.uom },
    pesan: `Item di SO #${item.so_id} di-update: ${itemBaru.barang_nama} ${itemBaru.qty} ${itemBaru.uom || ''}.`,
  };
}

module.exports = {
  simpanSalesOrder,
  getSalesOrderDetail,
  setStatusSalesOrder,
  cariSalesOrderByOutletTanggal,
  getSalesOrderHariIni,
  getTotalKebutuhanBarang,
  editItemSalesOrder,
};