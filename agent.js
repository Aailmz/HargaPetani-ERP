const OpenAI = require('openai');
const { db, getKlienByNama } = require('./db');
const { parsePesananKlien, parseTagihanSupplier, normalisasiNamaBarang, buatBarangBaru, tambahAlias } = require('./parser');
const { simpanSalesOrder, getSalesOrderDetail, setStatusSalesOrder, cariSalesOrderByOutletTanggal, getSalesOrderHariIni, getTotalKebutuhanBarang } = require('./salesOrder');
const { generateDO } = require('./generator/deliveryOrder');
const { generateInvoice } = require('./generator/invoice');
const { generatePO, setKodeOutlet } = require('./generator/purchaseOrder');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
});

const MODEL = process.env.AI_MODEL;
const MAX_TOOL_ITERATIONS = 6;

// ========== TOOLS ==========

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'catat_pesanan_masuk',
      description: 'Parse dan simpan teks pesanan barang dari klien (SSB/outlet) sebagai Sales Order baru. Panggil ini kalau pesan yang diforward owner terlihat seperti pesanan barang (ada Tanggal Pesanan/Outlet/daftar barang+qty).',
      parameters: {
        type: 'object',
        properties: {
          teks_pesanan: { type: 'string', description: 'Teks mentah pesanan persis seperti yang diforward owner.' },
        },
        required: ['teks_pesanan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'catat_tagihan_supplier',
      description: 'Parse dan simpan teks tagihan dari supplier. Panggil kalau owner forward pesan yang berisi tagihan/invoice dari supplier.',
      parameters: {
        type: 'object',
        properties: {
          teks_tagihan: { type: 'string', description: 'Teks mentah tagihan dari supplier.' },
          nama_supplier: { type: 'string', description: 'Nama supplier kalau disebut owner terpisah dari teks tagihan.' },
        },
        required: ['teks_tagihan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_tagihan_ke_po',
      description: 'Kaitkan sebuah tagihan supplier ke purchase order tertentu. Dipakai kalau owner konfirmasi tagihan itu buat PO mana.',
      parameters: {
        type: 'object',
        properties: {
          tagihan_id: { type: 'integer' },
          purchase_order_id: { type: 'integer' },
        },
        required: ['tagihan_id', 'purchase_order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buat_delivery_order',
      description: 'Generate file Excel Delivery Order dari sebuah Sales Order. Panggil kalau owner minta buatkan DO untuk outlet tertentu.',
      parameters: {
        type: 'object',
        properties: {
          sales_order_id: { type: 'integer', description: 'ID Sales Order. Kalau owner cuma sebut nama outlet+tanggal, cari dulu ID-nya pakai cari_sales_order.' },
        },
        required: ['sales_order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buat_invoice',
      description: 'Generate file Excel Invoice dari sebuah Sales Order, dihitung pakai harga terbaru. Panggil kalau owner minta buatkan invoice untuk outlet tertentu.',
      parameters: {
        type: 'object',
        properties: {
          sales_order_id: { type: 'integer' },
        },
        required: ['sales_order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buat_purchase_order',
      description: 'Generate file Excel Purchase Order ke supplier tertentu. SETIAP item WAJIB menyebutkan outlet asalnya. Kalau owner belum sebutkan outlet untuk suatu barang, TANYA dulu, jangan panggil tool ini.',
      parameters: {
        type: 'object',
        properties: {
          nama_supplier: { type: 'string' },
          tanggal: { type: 'string', description: 'Format YYYY-MM-DD, default hari ini kalau tidak disebut.' },
          label_kategori: { type: 'string', description: 'Opsional, label kategori/brand di atas nama supplier kalau owner sebutkan.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nama_barang: { type: 'string' },
                qty: { type: 'number' },
                uom: { type: 'string' },
                nama_outlet: { type: 'string', description: 'WAJIB diisi, outlet asal permintaan barang ini.' },
              },
              required: ['nama_barang', 'qty', 'nama_outlet'],
            },
          },
        },
        required: ['nama_supplier', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_kode_outlet',
      description: 'Set kode singkatan manual untuk sebuah outlet (dipakai di dokumen PO). Panggil kalau owner kasih tau kode tertentu buat outlet, misal "kode outlet Sukatani itu ST".',
      parameters: {
        type: 'object',
        properties: {
          nama_outlet: { type: 'string' },
          kode: { type: 'string' },
        },
        required: ['nama_outlet', 'kode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_harga_barang',
      description: 'Update harga jual sebuah barang ke klien (harga terbaru akan dipakai untuk invoice berikutnya). Histori harga lama tetap tersimpan.',
      parameters: {
        type: 'object',
        properties: {
          nama_barang: { type: 'string' },
          harga_baru: { type: 'integer' },
        },
        required: ['nama_barang', 'harga_baru'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_status_sales_order',
      description: 'Update status sebuah Sales Order (misal owner bilang barang sudah diterima SSB).',
      parameters: {
        type: 'object',
        properties: {
          sales_order_id: { type: 'integer' },
          status: { type: 'string', enum: ['BARU', 'DIKIRIM', 'DITERIMA', 'INVOICED', 'LUNAS'] },
        },
        required: ['sales_order_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_status_bayar_invoice',
      description: 'Tandai sebuah invoice sudah lunas atau belum. Dipakai kalau owner bilang SSB sudah/belum bayar.',
      parameters: {
        type: 'object',
        properties: {
          invoice_id: { type: 'integer' },
          status: { type: 'string', enum: ['BELUM_LUNAS', 'LUNAS'] },
        },
        required: ['invoice_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_status_bayar_tagihan',
      description: 'Tandai sebuah tagihan supplier sudah lunas atau belum.',
      parameters: {
        type: 'object',
        properties: {
          tagihan_id: { type: 'integer' },
          status: { type: 'string', enum: ['BELUM_LUNAS', 'LUNAS'] },
        },
        required: ['tagihan_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cari_sales_order',
      description: 'Cari Sales Order berdasarkan nama outlet dan/atau tanggal. Dipakai buat resolve ID sebelum buat DO/invoice/update status kalau owner cuma sebut nama outlet.',
      parameters: {
        type: 'object',
        properties: {
          nama_outlet: { type: 'string' },
          tanggal: { type: 'string', description: 'Format YYYY-MM-DD' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cek_kebutuhan_barang',
      description: 'Lihat total kebutuhan tiap barang (gabungan semua outlet) di tanggal tertentu. Dipakai owner buat lihat dulu sebelum alokasi PO ke supplier.',
      parameters: {
        type: 'object',
        properties: {
          tanggal: { type: 'string', description: 'Format YYYY-MM-DD, default hari ini.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cek_piutang',
      description: 'Lihat daftar invoice yang belum lunas (piutang ke SSB/klien).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cek_utang',
      description: 'Lihat daftar tagihan supplier yang belum lunas (utang ke supplier).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const SYSTEM_PROMPT = `Kamu asisten chat buat owner bisnis distributor sayur/bahan dapur "Harga Petani". Owner jual ke klien (SSB dkk) dan beli dari berbagai supplier secara dinamis.

Gaya bicaramu:
- Santai, efisien, seperti asisten kerja yang paham konteks, bukan formal kaku.
- Jangan sebut dirimu "AI"/"bot"/"sistem".
- Jawaban singkat, langsung ke poin.

CARA KERJA:
- Kalau owner forward teks yang keliatannya pesanan outlet (ada Tanggal Pesanan/Outlet/daftar barang+qty), panggil catat_pesanan_masuk dengan teks itu persis.
- Kalau owner forward teks yang keliatannya tagihan dari supplier, panggil catat_tagihan_supplier.
- Kalau owner minta generate dokumen (DO/Invoice/PO), dan dia cuma sebut nama outlet/tanggal tanpa ID pasti, panggil cari_sales_order dulu buat resolve ID-nya. Kalau hasil pencarian ada lebih dari 1 atau 0, tanya balik ke owner, jangan asal pilih.
- PO ke supplier WAJIB per outlet (setiap barang harus jelas dari outlet mana). Kalau owner belum sebutkan breakdown per outlet, TANYA dulu sebelum panggil buat_purchase_order.
- Barang baru yang otomatis tercatat saat parsing (nama tidak dikenal sebelumnya) akan diinfokan ke kamu lewat hasil tool — sampaikan ke owner biar dia sadar, tanya kalau itu sebenarnya sama dengan barang lain yang sudah ada (biar bisa digabung jadi alias).
- Barang yang invoice-nya kena harga 0 (belum ada harga di-set) akan diinfokan juga — selalu kasih tau owner, jangan diam-diam.
- Setelah tool jalan, sampaikan hasil secara natural, bukan dump data mentah/JSON.

ATURAN PENULISAN:
- Kapitalisasi normal, bukan Title Case tiap kata.
- Jangan pakai tanda strip panjang (—) atau double dash (--).`;

// ========== LOOP AGENT ==========

async function jalankanAgent({ historiChat, pesanBaru }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historiChat,
    { role: 'user', content: pesanBaru },
  ];

  let iterasi = 0;
  let fileUntukDikirim = []; // kumpulkan file_path dari tool generate dokumen

  while (iterasi < MAX_TOOL_ITERATIONS) {
    iterasi++;

    let completion;
    try {
      completion = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.3,
      });
    } catch (err) {
      console.error('❌ Agent API error:', err.message);
      return { jawabanFinal: null, error: err.message, files: [] };
    }

    const pesanAi = completion.choices[0].message;
    messages.push(pesanAi);

    if (!pesanAi.tool_calls || pesanAi.tool_calls.length === 0) {
      return { jawabanFinal: pesanAi.content, error: null, files: fileUntukDikirim };
    }

    for (const toolCall of pesanAi.tool_calls) {
      const namaFungsi = toolCall.function.name;
      let argumen;
      try {
        argumen = JSON.parse(toolCall.function.arguments);
      } catch {
        argumen = {};
      }

      console.log(`🔧 Agent manggil tool: ${namaFungsi}(${JSON.stringify(argumen)})`);

      let hasilTool;
      try {
        const fungsiEksekutor = EKSEKUTOR[namaFungsi];
        hasilTool = fungsiEksekutor ? await fungsiEksekutor(argumen) : { error: `Tool ${namaFungsi} tidak dikenali.` };

        if (hasilTool && hasilTool.file_path) {
          fileUntukDikirim.push(hasilTool.file_path);
        }
      } catch (err) {
        console.error(`❌ Error eksekusi tool ${namaFungsi}:`, err.message);
        hasilTool = { error: `Gagal eksekusi: ${err.message}` };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(hasilTool),
      });
    }
  }

  console.log('⚠️  Agent mencapai batas iterasi maksimal.');
  return { jawabanFinal: 'Ada kendala teknis, boleh diulang?', error: 'MAX_ITERATIONS', files: fileUntukDikirim };
}

// ========== EKSEKUTOR TOOL ==========

async function eksekusiCatatPesananMasuk({ teks_pesanan }) {
  const parsed = await parsePesananKlien(teks_pesanan);
  if (!parsed) return { sukses: false, pesan: 'Gagal parse teks pesanan, format mungkin tidak dikenali.' };
  return simpanSalesOrder(parsed, teks_pesanan);
}

async function eksekusiCatatTagihanSupplier({ teks_tagihan, nama_supplier }) {
  const parsed = await parseTagihanSupplier(teks_tagihan);
  if (!parsed || !parsed.nominal) {
    return { sukses: false, pesan: 'Gagal extract nominal dari teks tagihan.' };
  }

  const namaSupplierFinal = nama_supplier || parsed.supplier;
  if (!namaSupplierFinal) {
    return { sukses: false, pesan: 'Nama supplier tidak terdeteksi, sebutkan nama supplier-nya.' };
  }

  let supplier = db.prepare('SELECT * FROM supplier WHERE nama = ?').get(namaSupplierFinal);
  if (!supplier) {
    const id = db.prepare('INSERT INTO supplier (nama) VALUES (?)').run(namaSupplierFinal).lastInsertRowid;
    supplier = db.prepare('SELECT * FROM supplier WHERE id = ?').get(id);
  }

  const tanggal = parsed.tanggal || new Date().toISOString().split('T')[0];
  const result = db.prepare(`
    INSERT INTO tagihan_supplier (supplier_id, nominal, keterangan, status, teks_asli)
    VALUES (?, ?, ?, 'BELUM_LUNAS', ?)
  `).run(supplier.id, parsed.nominal, parsed.keterangan || null, teks_tagihan);

  return {
    sukses: true,
    tagihan_id: result.lastInsertRowid,
    supplier: supplier.nama,
    nominal: parsed.nominal,
    pesan: `Tagihan dari ${supplier.nama} sebesar Rp${parsed.nominal.toLocaleString('id-ID')} tercatat. Mau dikaitkan ke PO mana?`,
  };
}

async function eksekusiLinkTagihanKePo({ tagihan_id, purchase_order_id }) {
  const tagihan = db.prepare('SELECT * FROM tagihan_supplier WHERE id = ?').get(tagihan_id);
  const po = db.prepare('SELECT * FROM purchase_order WHERE id = ?').get(purchase_order_id);
  if (!tagihan) return { sukses: false, pesan: `Tagihan #${tagihan_id} tidak ditemukan.` };
  if (!po) return { sukses: false, pesan: `PO #${purchase_order_id} tidak ditemukan.` };

  db.prepare('UPDATE tagihan_supplier SET purchase_order_id = ? WHERE id = ?').run(purchase_order_id, tagihan_id);
  return { sukses: true, pesan: `Tagihan #${tagihan_id} dikaitkan ke PO #${purchase_order_id}.` };
}

async function eksekusiBuatDeliveryOrder({ sales_order_id }) {
  return generateDO(sales_order_id);
}

async function eksekusiBuatInvoice({ sales_order_id }) {
  const hasil = await generateInvoice(sales_order_id);
  if (hasil.sukses) setStatusSalesOrder(sales_order_id, 'INVOICED');
  return hasil;
}

async function eksekusiBuatPurchaseOrder({ nama_supplier, tanggal, label_kategori, items }) {
  let supplier = db.prepare('SELECT * FROM supplier WHERE nama = ?').get(nama_supplier);
  if (!supplier) {
    const id = db.prepare('INSERT INTO supplier (nama) VALUES (?)').run(nama_supplier).lastInsertRowid;
    supplier = db.prepare('SELECT * FROM supplier WHERE id = ?').get(id);
  }

  const klien = getKlienByNama('SSB');
  const itemsResolved = [];

  for (const item of items) {
    let barang = normalisasiNamaBarang(item.nama_barang);
    if (!barang) barang = buatBarangBaru(item.nama_barang, item.uom || null);

    const outlet = db.prepare(`
      SELECT * FROM outlet WHERE klien_id = ? AND nama LIKE ?
    `).get(klien.id, `%${item.nama_outlet}%`);

    if (!outlet) {
      return { sukses: false, pesan: `Outlet "${item.nama_outlet}" tidak ditemukan, sebutkan nama outlet yang benar.` };
    }

    itemsResolved.push({
      nama_barang: barang.nama,
      barang_id: barang.id,
      qty: item.qty,
      uom: item.uom || barang.satuan_default,
      outlet_nama: outlet.nama,
      outlet_id: outlet.id,
    });
  }

  return generatePO({
    supplierId: supplier.id,
    supplierNama: supplier.nama,
    tanggal: tanggal || new Date().toISOString().split('T')[0],
    items: itemsResolved,
    labelKategori: label_kategori,
  });
}

async function eksekusiSetKodeOutlet({ nama_outlet, kode }) {
  const klien = getKlienByNama('SSB');
  const outlet = db.prepare('SELECT * FROM outlet WHERE klien_id = ? AND nama LIKE ?').get(klien.id, `%${nama_outlet}%`);
  if (!outlet) return { sukses: false, pesan: `Outlet "${nama_outlet}" tidak ditemukan.` };

  setKodeOutlet(outlet.id, kode);
  return { sukses: true, pesan: `Kode outlet ${outlet.nama} di-set jadi "${kode.toUpperCase()}".` };
}

async function eksekusiUpdateHargaBarang({ nama_barang, harga_baru }) {
  const barang = normalisasiNamaBarang(nama_barang);
  if (!barang) return { sukses: false, pesan: `Barang "${nama_barang}" tidak ditemukan.` };

  const klien = getKlienByNama('SSB');
  db.prepare('INSERT INTO harga (klien_id, barang_id, harga) VALUES (?, ?, ?)').run(klien.id, barang.id, harga_baru);

  return { sukses: true, pesan: `Harga ${barang.nama} di-update jadi Rp${harga_baru.toLocaleString('id-ID')}.` };
}

async function eksekusiUpdateStatusSalesOrder({ sales_order_id, status }) {
  const so = getSalesOrderDetail(sales_order_id);
  if (!so) return { sukses: false, pesan: `Sales Order #${sales_order_id} tidak ditemukan.` };

  setStatusSalesOrder(sales_order_id, status);
  return { sukses: true, pesan: `Status Sales Order ${so.outlet_nama} (#${sales_order_id}) jadi ${status}.` };
}

async function eksekusiUpdateStatusBayarInvoice({ invoice_id, status }) {
  const invoice = db.prepare('SELECT * FROM invoice WHERE id = ?').get(invoice_id);
  if (!invoice) return { sukses: false, pesan: `Invoice #${invoice_id} tidak ditemukan.` };

  db.prepare('UPDATE invoice SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), invoice_id);
  if (status === 'LUNAS') setStatusSalesOrder(invoice.sales_order_id, 'LUNAS');

  return { sukses: true, pesan: `Invoice #${invoice_id} di-update jadi ${status}.` };
}

async function eksekusiUpdateStatusBayarTagihan({ tagihan_id, status }) {
  const tagihan = db.prepare('SELECT * FROM tagihan_supplier WHERE id = ?').get(tagihan_id);
  if (!tagihan) return { sukses: false, pesan: `Tagihan #${tagihan_id} tidak ditemukan.` };

  db.prepare('UPDATE tagihan_supplier SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), tagihan_id);
  return { sukses: true, pesan: `Tagihan #${tagihan_id} di-update jadi ${status}.` };
}

async function eksekusiCariSalesOrder({ nama_outlet, tanggal }) {
  const tgl = tanggal || new Date().toISOString().split('T')[0];
  let hasil;
  if (nama_outlet) {
    hasil = cariSalesOrderByOutletTanggal(nama_outlet, tgl);
  } else {
    hasil = getSalesOrderHariIni(tgl);
  }

  if (hasil.length === 0) return { sukses: true, jumlah: 0, pesan: 'Tidak ada Sales Order yang cocok.' };

  return {
    sukses: true,
    jumlah: hasil.length,
    daftar: hasil.map((so) => ({ id: so.id, outlet: so.outlet_nama || so.outlet_id, tanggal: so.tanggal_pesanan, status: so.status })),
  };
}

async function eksekusiCekKebutuhanBarang({ tanggal }) {
  const tgl = tanggal || new Date().toISOString().split('T')[0];
  const hasil = getTotalKebutuhanBarang(tgl);

  if (hasil.length === 0) return { sukses: true, jumlah: 0, pesan: `Belum ada pesanan tanggal ${tgl}.` };

  return {
    sukses: true,
    tanggal: tgl,
    daftar: hasil.map((h) => ({ barang: h.barang_nama, total_qty: h.total_qty, uom: h.uom })),
  };
}

async function eksekusiCekPiutang() {
  const hasil = db.prepare(`
    SELECT i.*, o.nama as outlet_nama
    FROM invoice i
    JOIN sales_order so ON so.id = i.sales_order_id
    JOIN outlet o ON o.id = so.outlet_id
    WHERE i.status = 'BELUM_LUNAS'
    ORDER BY i.created_at ASC
  `).all();

  if (hasil.length === 0) return { sukses: true, jumlah: 0, pesan: 'Tidak ada piutang, semua invoice sudah lunas.' };

  const total = hasil.reduce((sum, i) => sum + i.total, 0);
  return {
    sukses: true,
    jumlah: hasil.length,
    total_piutang: total,
    daftar: hasil.map((i) => ({ invoice_id: i.id, outlet: i.outlet_nama, total: i.total })),
  };
}

async function eksekusiCekUtang() {
  const hasil = db.prepare(`
    SELECT ts.*, s.nama as supplier_nama
    FROM tagihan_supplier ts
    JOIN supplier s ON s.id = ts.supplier_id
    WHERE ts.status = 'BELUM_LUNAS'
    ORDER BY ts.created_at ASC
  `).all();

  if (hasil.length === 0) return { sukses: true, jumlah: 0, pesan: 'Tidak ada utang, semua tagihan sudah lunas.' };

  const total = hasil.reduce((sum, t) => sum + t.nominal, 0);
  return {
    sukses: true,
    jumlah: hasil.length,
    total_utang: total,
    daftar: hasil.map((t) => ({ tagihan_id: t.id, supplier: t.supplier_nama, nominal: t.nominal })),
  };
}

const EKSEKUTOR = {
  catat_pesanan_masuk: eksekusiCatatPesananMasuk,
  catat_tagihan_supplier: eksekusiCatatTagihanSupplier,
  link_tagihan_ke_po: eksekusiLinkTagihanKePo,
  buat_delivery_order: eksekusiBuatDeliveryOrder,
  buat_invoice: eksekusiBuatInvoice,
  buat_purchase_order: eksekusiBuatPurchaseOrder,
  set_kode_outlet: eksekusiSetKodeOutlet,
  update_harga_barang: eksekusiUpdateHargaBarang,
  update_status_sales_order: eksekusiUpdateStatusSalesOrder,
  update_status_bayar_invoice: eksekusiUpdateStatusBayarInvoice,
  update_status_bayar_tagihan: eksekusiUpdateStatusBayarTagihan,
  cari_sales_order: eksekusiCariSalesOrder,
  cek_kebutuhan_barang: eksekusiCekKebutuhanBarang,
  cek_piutang: eksekusiCekPiutang,
  cek_utang: eksekusiCekUtang,
};

module.exports = { jalankanAgent };