const fs = require('fs');
const dump = require('./dump');
const { db } = require('./db');
const sheets = require('./sheets');
const { formatWaktuDb, potong, nomorDariJid } = require('./utils');

const TAB = process.env.DUMP_SHEET_TAB || 'Dump';
const MAX_SEL = 40000; // batas sel Google Sheets 50.000 karakter

// Urutan kolom di Sheets. Mengubah ini otomatis memicu penulisan ulang seluruh tab saat bot start.
const KOLOM = [
  { judul: 'ID', lebar: 85 },
  { judul: 'Waktu', lebar: 130 },
  { judul: 'Grup / Chat', lebar: 125, wrap: true },
  { judul: 'Pengirim', lebar: 105 },
  { judul: 'Jenis', lebar: 125 },
  { judul: 'Judul', lebar: 270, wrap: true },
  { judul: 'Ringkasan', lebar: 320, wrap: true },
  { judul: 'Nominal (Rp)', lebar: 105, angka: true },
  { judul: 'Detail', lebar: 430, wrap: true },
  { judul: 'File', lebar: 150, wrap: true },
  { judul: 'Status', lebar: 75 },
  { judul: 'Data mentah (JSON)', lebar: 200 },
];
const HEADER = KOLOM.map((k) => k.judul);
const SPEC = {
  lebar: KOLOM.map((k) => k.lebar),
  wrap: KOLOM.flatMap((k, i) => (k.wrap ? [i] : [])),
  angka: KOLOM.flatMap((k, i) => (k.angka ? [i] : [])),
};

let tabSiap = null;

// ========== OWNER ==========

function ownerJid() {
  const o = process.env.OWNER_JID;
  if (!o) return null;
  return o.includes('@') ? o : `${nomorDariJid(o)}@s.whatsapp.net`;
}

function isOwner(jid) {
  const o = process.env.OWNER_JID;
  return !!(o && jid && nomorDariJid(jid) === nomorDariJid(o));
}

// ========== TERUSKAN FILE KE OWNER ==========

/**
 * Kirim salinan file entri ke WhatsApp owner, dengan caption "DUMP-0042 · jenis · judul · dari ...".
 * Dilewati kalau pengirimnya owner sendiri di chat pribadi (sudah punya filenya).
 */
async function teruskanKeOwner(sock, entri, hanyaFileIds = null) {
  const tujuan = ownerJid();
  const daftar = hanyaFileIds ? entri.files.filter((f) => hanyaFileIds.includes(f.id)) : entri.files;
  if (!tujuan || !daftar.length) return;
  if (!entri.is_grup && isOwner(entri.chat_jid)) return;

  for (const f of daftar) {
    try {
      const caption = dump.captionUntukOwner(entri, f);
      const buffer = fs.readFileSync(f.path);
      const mime = (f.mimetype || '').split(';')[0];

      if (f.tipe === 'gambar') {
        await sock.sendMessage(tujuan, { image: buffer, caption });
      } else if (f.tipe === 'voice') {
        await sock.sendMessage(tujuan, { text: caption });
        await sock.sendMessage(tujuan, { audio: buffer, mimetype: f.mimetype || 'audio/ogg; codecs=opus', ptt: false });
      } else if (f.tipe === 'video') {
        await sock.sendMessage(tujuan, { video: buffer, caption });
      } else {
        await sock.sendMessage(tujuan, { document: buffer, fileName: f.nama, mimetype: mime || 'application/octet-stream', caption });
      }
    } catch (err) {
      console.error(`❌ Gagal teruskan ${f.nama} ke owner:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ========== GOOGLE SHEETS ==========

function barisSheet(e) {
  return [
    dump.formatId(e.id),
    formatWaktuDb(e.created_at),
    e.is_grup ? e.grup_nama || 'grup' : 'Chat pribadi',
    e.pengirim_nama || '',
    e.jenis,
    e.judul || '',
    potong(e.ringkasan || '', MAX_SEL),
    dump.nominalDari(e.data),
    potong(dump.detailSheet(e.data), MAX_SEL),
    e.files.map((f) => f.nama).join('\n'),
    e.status === 'AKTIF' ? 'Aktif' : 'Dihapus',
    potong(e.data_json || '', MAX_SEL),
  ];
}

/** Tulis ulang seluruh isi tab dari database (urut ID) dan simpan nomor barisnya. */
async function tulisSemuaBaris() {
  const ids = db.prepare('SELECT id FROM entri ORDER BY id ASC').all().map((r) => r.id);
  const baris = ids.map((id) => barisSheet(dump.getEntri(id)));
  await sheets.kosongkanIsi(TAB);
  if (baris.length) await sheets.tulisBanyak(TAB, baris);
  db.transaction(() => ids.forEach((id, i) => dump.setSheetRow(id, i + 2)))();
  await sheets.sesuaikanTinggiBaris(TAB, baris.length).catch((err) => console.error('⚠️ Sheets: tinggi baris tidak disesuaikan:', err.message));
  console.log(`✅ Sheets: ${baris.length} dump ditulis ulang ke tab "${TAB}"`);
}

/** Gagal merapikan tampilan tidak boleh menggagalkan penulisan data. */
async function rapikanAman() {
  try {
    await sheets.rapikanTab(TAB, SPEC);
  } catch (err) {
    console.error('⚠️ Sheets: tampilan tab gagal dirapikan (data tetap ditulis):', err.message);
  }
}

/** Buat tab kalau belum ada, pastikan header + tampilan terbaru, dan isi ulang kalau tata letaknya berubah. */
async function siapkanTab() {
  const barusDibuat = await sheets.pastikanTab(TAB, HEADER);
  const headerSekarang = await sheets.bacaHeader(TAB, HEADER.length);
  const berubah = JSON.stringify(headerSekarang) !== JSON.stringify(HEADER);
  if (berubah) await sheets.tulisHeader(TAB, HEADER);
  await rapikanAman();
  if (berubah || barusDibuat) await tulisSemuaBaris();
}

async function pastikanTabSiap() {
  if (!tabSiap) {
    tabSiap = siapkanTab().catch((err) => {
      tabSiap = null; // coba lagi di panggilan berikutnya
      throw err;
    });
  }
  return tabSiap;
}

/** Tulis (atau timpa) baris entri di Sheets. Gagal tidak boleh mengganggu alur utama. */
async function sinkronSheets(id) {
  if (!sheets.sheetsAktif()) return;
  try {
    await pastikanTabSiap();
    const e = dump.getEntri(id);
    if (!e) return;
    const baris = barisSheet(e);
    if (e.sheet_row) {
      await sheets.updateRow(TAB, e.sheet_row, baris, 'RAW');
    } else {
      const row = await sheets.appendRow(TAB, baris, 'RAW');
      if (row) dump.setSheetRow(id, row);
    }
  } catch (err) {
    console.error(`❌ Sync Sheets ${dump.formatId(id)} gagal:`, err.message);
  }
}

/** Paksa tulis ulang semuanya (dipakai sync-sheets.js). */
async function sinkronSemuaPaksa() {
  if (!sheets.sheetsAktif()) throw new Error('Sheets tidak aktif (cek GOOGLE_SERVICE_ACCOUNT_PATH / GOOGLE_SPREADSHEET_ID / DUMP_SHEETS).');
  await sheets.pastikanTab(TAB, HEADER);
  await sheets.tulisHeader(TAB, HEADER);
  await rapikanAman();
  await tulisSemuaBaris();
}

function statusSheets() {
  return sheets.sheetsAktif() ? `aktif, tab "${TAB}"` : 'nonaktif (GOOGLE_* belum diisi atau DUMP_SHEETS=off)';
}

module.exports = { ownerJid, isOwner, teruskanKeOwner, sinkronSheets, sinkronSemuaPaksa, statusSheets, siapkanSheetsAwal: () => (sheets.sheetsAktif() ? pastikanTabSiap() : null) };
