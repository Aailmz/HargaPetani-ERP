require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { DIR_TMP } = require('./db');
const { potong } = require('./utils');

const MAX_BYTES = (parseInt(process.env.MAX_FILE_MB, 10) || 10) * 1024 * 1024;
const MAX_TEKS_HASIL = 30000;

// bisa diganti di test supaya tidak perlu koneksi WhatsApp
let downloader = downloadMediaMessage;

const { client, MODEL } = require('./ai');

const FORMAT_GAMBAR_CLAUDE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// sharp cuma dipakai buat mengecilkan gambar sebelum dikirim ke model (file asli tetap utuh)
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  /* opsional */
}

// ========== DETEKSI LAMPIRAN ==========

const EXT_EXCEL = ['.xlsx', '.xlsm'];
const EXT_TEKS = ['.txt', '.csv', '.tsv', '.json', '.md', '.log'];

function tipeDokumen(mimetype, namaAsli) {
  const mime = String(mimetype || '').toLowerCase();
  const ext = path.extname(namaAsli || '').toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime.includes('spreadsheetml') || EXT_EXCEL.includes(ext)) return 'excel';
  if (mime.startsWith('text/') || mime === 'application/json' || EXT_TEKS.includes(ext)) return 'teks';
  if (mime.startsWith('image/')) return 'gambar';
  return 'file';
}

/**
 * Dari konten pesan (sudah dinormalisasi) -> info lampiran tanpa download, atau null.
 * Dipanggil untuk tiap pesan masuk, jadi harus murah.
 */
function infoLampiran(content) {
  if (!content) return null;

  if (content.imageMessage) {
    const m = content.imageMessage;
    return { kunci: 'imageMessage', tipe: 'gambar', mimetype: m.mimetype || 'image/jpeg', namaAsli: null, ukuran: Number(m.fileLength) || 0, caption: m.caption || '' };
  }
  if (content.documentMessage) {
    const m = content.documentMessage;
    const namaAsli = m.fileName || null;
    return { kunci: 'documentMessage', tipe: tipeDokumen(m.mimetype, namaAsli), mimetype: m.mimetype || 'application/octet-stream', namaAsli, ukuran: Number(m.fileLength) || 0, caption: m.caption || '' };
  }
  if (content.audioMessage) {
    const m = content.audioMessage;
    return { kunci: 'audioMessage', tipe: 'voice', mimetype: m.mimetype || 'audio/ogg', namaAsli: null, ukuran: Number(m.fileLength) || 0, caption: '' };
  }
  if (content.videoMessage) {
    const m = content.videoMessage;
    return { kunci: 'videoMessage', tipe: 'video', mimetype: m.mimetype || 'video/mp4', namaAsli: null, ukuran: Number(m.fileLength) || 0, caption: m.caption || '' };
  }
  return null;
}

function ekstensiTmp(info) {
  const dariNama = path.extname(info.namaAsli || '').toLowerCase();
  if (dariNama) return dariNama;
  const mime = info.mimetype.split(';')[0];
  const peta = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'video/mp4': '.mp4', 'application/pdf': '.pdf' };
  return peta[mime] || '.bin';
}

// ========== EKSTRAKSI TEKS ==========

async function bacaGambar(buffer, mimetype) {
  let data = buffer;
  let mime = mimetype.split(';')[0];
  if (sharp) {
    try {
      data = await sharp(buffer).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      mime = 'image/jpeg';
    } catch {
      /* pakai gambar apa adanya */
    }
  }

  if (!FORMAT_GAMBAR_CLAUDE.has(mime)) throw new Error(`format gambar ${mime} tidak didukung`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    output_config: { effort: 'low' }, // transkripsi tidak butuh penalaran panjang
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } },
          {
            type: 'text',
            text:
              'Baca gambar ini untuk keperluan pencatatan data bisnis. Tulis HANYA apa yang benar-benar terlihat, jangan menebak, ' +
              'jangan melengkapi, dan jangan menghitung sendiri angka yang tidak tertulis. Jawab dalam bahasa Indonesia dengan format:\n' +
              'DESKRIPSI: satu sampai dua kalimat tentang apa yang terlihat. Sebut jenis dokumen (nota, kwitansi, struk, tabel, chat, dll) hanya kalau jelas dari isinya; kalau tidak yakin, tulis "tidak jelas ini dokumen apa".\n' +
              'TEKS: transkrip SEMUA teks yang terbaca apa adanya (nama, tanggal, angka, nominal, satuan), dengan susunan baris/tabel dipertahankan. ' +
              'Bagian yang tidak terbaca atau meragukan tulis [tidak jelas], jangan diisi tebakan. Kalau tidak ada teks, tulis "(tidak ada teks)".\n' +
              'KEJELASAN: satu dari "jelas", "sebagian tidak jelas", atau "buram/tidak terbaca", disusul daftar bagian penting yang meragukan (mis. total, tanggal, nama, angka tertentu).',
          },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude menolak membaca gambar ini');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function bacaPdf(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const hasil = await parser.getText();
    const teks = (hasil.text || '').replace(/^-- \d+ of \d+ --$/gm, '').trim();
    if (teks.length < 20) return '[PDF ini tidak berisi teks, kemungkinan hasil scan, jadi isinya belum terbaca]';
    return `(PDF ${hasil.total || '?'} halaman)\n${teks}`;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function bacaExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const bagian = [];
  wb.eachSheet((ws) => {
    const baris = [];
    const maxRow = Math.min(ws.rowCount, 300);
    const maxCol = Math.min(ws.columnCount, 30);
    for (let r = 1; r <= maxRow; r++) {
      const sel = [];
      for (let c = 1; c <= maxCol; c++) sel.push(String(ws.getRow(r).getCell(c).text ?? '').trim());
      if (sel.some(Boolean)) baris.push(sel.join(' | ').replace(/(\s\|\s)+$/, ''));
    }
    const catatan = ws.rowCount > maxRow ? `\n… (${ws.rowCount - maxRow} baris lagi tidak ditampilkan)` : '';
    bagian.push(`## Sheet "${ws.name}" (${ws.rowCount} baris)\n${baris.join('\n')}${catatan}`);
  });
  return bagian.join('\n\n') || '[Excel kosong]';
}

async function ekstrakTeks(info, buffer) {
  switch (info.tipe) {
    case 'gambar':
      return bacaGambar(buffer, info.mimetype);
    case 'pdf':
      return bacaPdf(buffer);
    case 'excel':
      return bacaExcel(buffer);
    case 'teks':
      return buffer.toString('utf8');
    case 'voice':
      return '[voice note, belum ditranskrip]';
    case 'video':
      return '[video, isinya tidak dibaca otomatis]';
    default:
      return `[file ${info.namaAsli || ''} tersimpan, isinya tidak dibaca otomatis]`;
  }
}

// ========== DOWNLOAD + EKSTRAK ==========

/**
 * Download lampiran dari satu pesan WA ({ key, message }), simpan sementara di data/tmp,
 * lalu ekstrak teksnya. Tidak pernah melempar error: kegagalan dicatat di hasil.
 */
async function ambilLampiran(waMsg, info, sock) {
  const dasar = { tipe: info.tipe, namaAsli: info.namaAsli, mimetype: info.mimetype, caption: info.caption, path: null, ukuran: 0, teksHasil: '', gagal: null };

  if (info.ukuran && info.ukuran > MAX_BYTES) {
    return { ...dasar, gagal: `file terlalu besar (${(info.ukuran / 1048576).toFixed(1)} MB, batas ${MAX_BYTES / 1048576} MB)`, teksHasil: '[file terlalu besar, tidak disimpan]' };
  }

  let buffer;
  try {
    buffer = await downloader(waMsg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
  } catch (err) {
    return { ...dasar, gagal: `gagal download: ${err.message}`, teksHasil: '[file gagal diunduh dari WhatsApp]' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ...dasar, gagal: `file terlalu besar (${(buffer.length / 1048576).toFixed(1)} MB)`, teksHasil: '[file terlalu besar, tidak disimpan]' };
  }

  const tmpPath = path.join(DIR_TMP, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ekstensiTmp(info)}`);
  fs.writeFileSync(tmpPath, buffer);

  let teksHasil;
  let gagal = null;
  try {
    teksHasil = await ekstrakTeks(info, buffer);
  } catch (err) {
    gagal = `gagal baca isi: ${err.message}`;
    console.error(`❌ Ekstrak ${info.tipe} gagal:`, err.message);
    teksHasil = `[${info.tipe} tersimpan tapi isinya gagal dibaca otomatis]`;
  }

  return { ...dasar, path: tmpPath, ukuran: buffer.length, teksHasil: potong(teksHasil, MAX_TEKS_HASIL), gagal };
}

module.exports = {
  infoLampiran,
  ambilLampiran,
  MAX_BYTES,
  _setDownloader(fn) {
    downloader = fn;
  },
};
