const fs = require('fs');
const dump = require('./dump');
const sheets = require('./sheets');
const { formatWaktuDb, potong, nomorDariJid } = require('./utils');

const TAB = process.env.DUMP_SHEET_TAB || 'Dump';
const HEADER = ['ID', 'Waktu', 'Grup / Chat', 'Pengirim', 'Jenis', 'Judul', 'Ringkasan', 'Data (JSON)', 'File', 'Status'];
const MAX_SEL = 40000; // batas sel Google Sheets 50.000 karakter

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
async function teruskanKeOwner(sock, entri) {
  const tujuan = ownerJid();
  if (!tujuan || !entri.files.length) return;
  if (!entri.is_grup && isOwner(entri.chat_jid)) return;

  for (const f of entri.files) {
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
    potong(e.data_json || '', MAX_SEL),
    e.files.map((f) => f.nama).join(', '),
    e.status === 'AKTIF' ? 'Aktif' : 'Dihapus',
  ];
}

async function pastikanTabSiap() {
  if (!tabSiap) {
    tabSiap = sheets.pastikanTab(TAB, HEADER).catch((err) => {
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

module.exports = { ownerJid, isOwner, teruskanKeOwner, sinkronSheets };
