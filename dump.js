const fs = require('fs');
const path = require('path');
const { db, DIR_FILES, DIR_EXPORT } = require('./db');
const { formatWaktu, formatWaktuDb, potong } = require('./utils');

const MAX_DATA_JSON = 30000;
const MAX_TEKS_ASLI = 200000;

// ========== ID & JENIS ==========

function formatId(id) {
  return `DUMP-${String(id).padStart(4, '0')}`;
}

/** "DUMP-0042" | "dump-42" | "42" | 42 -> 42 (atau null kalau tidak valid) */
function parseId(input) {
  const m = String(input ?? '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Label jenis dirapikan supaya "Nota Belanja " dan "nota  belanja" dianggap sama. */
function normalisasiJenis(jenis) {
  const s = String(jenis || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return s || 'lainnya';
}

// ========== SIMPAN ==========

function rapikanData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const json = JSON.stringify(data);
  if (json.length > MAX_DATA_JSON) {
    return JSON.stringify({ catatan: 'Data terlalu besar untuk disimpan terstruktur, lihat teks asli.' });
  }
  return json;
}

function ekstensiDari(namaAsli, mimetype) {
  const dariNama = path.extname(namaAsli || '').toLowerCase();
  if (dariNama && dariNama.length <= 6) return dariNama;
  const peta = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  };
  const dasar = String(mimetype || '').split(';')[0].trim().toLowerCase();
  return peta[dasar] || '.bin';
}

/**
 * Simpan satu dump. File lampiran (yang masih di data/tmp) dipindah ke data/files
 * dengan nama DUMP-<id>.<ext> (atau DUMP-<id>-<n>.<ext> kalau lebih dari satu).
 */
function simpanEntri({ jenis, judul, ringkasan, data, teksAsli, chat, pengirim, lampiran = [] }) {
  const proses = db.transaction(() => {
    const id = db.prepare(`
      INSERT INTO entri (jenis, judul, ringkasan, data_json, teks_asli, chat_jid, is_grup, grup_nama, pengirim_jid, pengirim_nama)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalisasiJenis(jenis),
      potong(judul || '', 200) || null,
      potong(ringkasan || '', 2000) || null,
      rapikanData(data),
      potong(teksAsli || '', MAX_TEKS_ASLI) || null,
      chat.jid,
      chat.isGrup ? 1 : 0,
      chat.grupNama || null,
      pengirim.jid || null,
      pengirim.nama || null,
    ).lastInsertRowid;

    lampiran.forEach((lp, i) => {
      const ext = ekstensiDari(lp.namaAsli, lp.mimetype);
      const nama = `${formatId(id)}${lampiran.length > 1 ? `-${i + 1}` : ''}${ext}`;
      const tujuan = path.join(DIR_FILES, nama);
      fs.renameSync(lp.path, tujuan);
      db.prepare(`
        INSERT INTO entri_file (entri_id, nama, nama_asli, path, mimetype, tipe, ukuran, urutan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, nama, lp.namaAsli || null, tujuan, lp.mimetype || null, lp.tipe || 'file', lp.ukuran || null, i + 1);
    });

    return id;
  });

  return getEntri(proses());
}

// ========== PESAN WHATSAPP <-> ENTRI ==========

function catatPesan(entriId, chatJid, pesanIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO entri_pesan (entri_id, chat_jid, pesan_id) VALUES (?, ?, ?)');
  for (const p of new Set((pesanIds || []).filter(Boolean))) ins.run(entriId, chatJid, String(p));
}

function pesanDiEntri(entriId) {
  return new Set(db.prepare('SELECT pesan_id FROM entri_pesan WHERE entri_id = ?').all(entriId).map((r) => r.pesan_id));
}

/** Entri aktif di chat ini yang sudah memuat salah satu pesan WhatsApp tersebut. */
function cariEntriByPesan(chatJid, pesanIds) {
  const ids = [...new Set((pesanIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const tanda = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT DISTINCT e.id, e.jenis, e.judul FROM entri e
    JOIN entri_pesan p ON p.entri_id = e.id
    WHERE p.chat_jid = ? AND p.pesan_id IN (${tanda}) AND e.status = 'AKTIF'
    ORDER BY e.id
  `).all(chatJid, ...ids);
}

/**
 * Lanjutkan entri yang sudah ada: teks baru ditambahkan ke teks_asli, file baru ditambahkan
 * sebagai DUMP-<id>-<n>.<ext>, dan field (judul/ringkasan/data) bisa diperbarui sekaligus.
 */
function tambahKeEntri(id, { teksTambahan, lampiran = [], judul, ringkasan, data, perluKonfirmasi }) {
  const proses = db.transaction(() => {
    const e = getEntri(id);
    if (!e) return null;

    if (teksTambahan) {
      const gabung = [e.teks_asli || '', `--- Lanjutan ${formatWaktu()} ---`, teksTambahan].join('\n\n').trim();
      db.prepare('UPDATE entri SET teks_asli = ? WHERE id = ?').run(potong(gabung, MAX_TEKS_ASLI), id);
    }

    let urutan = e.files.reduce((mx, f) => Math.max(mx, f.urutan || 0), 0);
    const fileBaruIds = [];
    for (const lp of lampiran) {
      urutan += 1;
      const nama = `${formatId(id)}${urutan > 1 ? `-${urutan}` : ''}${ekstensiDari(lp.namaAsli, lp.mimetype)}`;
      const tujuan = path.join(DIR_FILES, nama);
      fs.renameSync(lp.path, tujuan);
      const fid = db.prepare(`
        INSERT INTO entri_file (entri_id, nama, nama_asli, path, mimetype, tipe, ukuran, urutan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, nama, lp.namaAsli || null, tujuan, lp.mimetype || null, lp.tipe || 'file', lp.ukuran || null, urutan).lastInsertRowid;
      fileBaruIds.push(Number(fid));
    }
    return fileBaruIds;
  });

  const fileBaruIds = proses();
  if (fileBaruIds === null) return null;
  ubahEntri(id, { judul, ringkasan, data, perluKonfirmasi }); // sekaligus memperbarui updated_at
  db.prepare('UPDATE entri SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  return { entri: getEntri(id), fileBaruIds };
}

// ========== BACA ==========

function getEntri(id) {
  const e = db.prepare('SELECT * FROM entri WHERE id = ?').get(id);
  if (!e) return null;
  e.files = db.prepare('SELECT * FROM entri_file WHERE entri_id = ? ORDER BY urutan').all(id);
  try {
    e.data = e.data_json ? JSON.parse(e.data_json) : null;
  } catch {
    e.data = null;
  }
  return e;
}

/** Non-owner cuma boleh menyentuh data dari chat/grupnya sendiri. */
function bolehAkses(entri, chatJid, isOwner) {
  return !!entri && (isOwner || entri.chat_jid === chatJid);
}

function cariEntri({ kataKunci, jenis, limit = 10, chatJid, isOwner, sertakanDihapus = false }) {
  const where = [];
  const params = [];

  if (!sertakanDihapus) where.push("status = 'AKTIF'");
  if (!isOwner) {
    where.push('chat_jid = ?');
    params.push(chatJid);
  }
  if (jenis) {
    where.push('jenis = ?');
    params.push(normalisasiJenis(jenis));
  }
  for (const kata of String(kataKunci || '').split(/\s+/).filter(Boolean).slice(0, 6)) {
    where.push(`(judul LIKE ? OR ringkasan LIKE ? OR teks_asli LIKE ? OR data_json LIKE ? OR jenis LIKE ? OR pengirim_nama LIKE ?)`);
    const pola = `%${kata.replace(/[%_]/g, '')}%`;
    params.push(pola, pola, pola, pola, pola, pola);
  }

  const sql = `
    SELECT id, jenis, judul, ringkasan, pengirim_nama, grup_nama, is_grup, created_at, status
    FROM entri
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?
  `;
  return db.prepare(sql).all(...params, Math.min(Math.max(limit, 1), 30));
}

function daftarJenis({ chatJid, isOwner } = {}) {
  const scope = isOwner || !chatJid ? '' : 'AND chat_jid = ?';
  const params = isOwner || !chatJid ? [] : [chatJid];
  return db.prepare(`
    SELECT jenis, COUNT(*) AS jumlah FROM entri
    WHERE status = 'AKTIF' ${scope}
    GROUP BY jenis ORDER BY jumlah DESC, jenis ASC
  `).all(...params);
}

/** Daftar jenis dari seluruh data, dipakai supaya penamaan antar grup konsisten. */
function daftarJenisGlobal(limit = 40) {
  return db.prepare(`
    SELECT jenis, COUNT(*) AS jumlah FROM entri WHERE status = 'AKTIF'
    GROUP BY jenis ORDER BY jumlah DESC, jenis ASC LIMIT ?
  `).all(limit);
}

// ========== UBAH / HAPUS ==========

const KUNCI_KONFIRMASI = 'perlu_konfirmasi';

/** Daftar hal yang masih perlu dikonfirmasi pada sebuah data (array string, bisa kosong). */
function daftarKonfirmasi(data) {
  const v = data && data[KUNCI_KONFIRMASI];
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

/** Status yang ditampilkan di Sheets. */
function statusEntri(e) {
  if (e.status !== 'AKTIF') return 'Dihapus';
  return daftarKonfirmasi(e.data).length ? 'Perlu konfirmasi' : 'Aktif';
}

/**
 * Ubah entri. `data` digabung ke data lama (null = hapus field). `perluKonfirmasi` menggantikan daftar
 * hal yang masih diragukan ([] = semua sudah terjawab). `catatanKoreksi` dicatat di teks_asli sebagai
 * log koreksi, jadi teks asli aslinya tidak pernah ditimpa.
 */
function ubahEntri(id, { jenis, judul, ringkasan, data, perluKonfirmasi, catatanKoreksi, oleh }) {
  const e = getEntri(id);
  if (!e) return null;

  const sets = [];
  const params = [];

  if (jenis) { sets.push('jenis = ?'); params.push(normalisasiJenis(jenis)); }
  if (judul) { sets.push('judul = ?'); params.push(potong(judul, 200)); }
  if (ringkasan) { sets.push('ringkasan = ?'); params.push(potong(ringkasan, 2000)); }

  const adaData = data && typeof data === 'object' && !Array.isArray(data);
  const adaKonfirmasi = Array.isArray(perluKonfirmasi);
  if (adaData || adaKonfirmasi) {
    const gabung = { ...(e.data || {}) };
    if (adaData) {
      for (const [k, v] of Object.entries(data)) {
        if (v === null) delete gabung[k];
        else gabung[k] = v;
      }
    }
    if (adaKonfirmasi) {
      const sisa = perluKonfirmasi.map((x) => String(x).trim()).filter(Boolean);
      if (sisa.length) gabung[KUNCI_KONFIRMASI] = sisa;
      else delete gabung[KUNCI_KONFIRMASI];
    }
    sets.push('data_json = ?');
    params.push(rapikanData(gabung));
  }

  if (catatanKoreksi) {
    const log = `--- Koreksi ${formatWaktu()}${oleh ? ` oleh ${oleh}` : ''} ---\n${catatanKoreksi}`;
    sets.push('teks_asli = ?');
    params.push(potong([e.teks_asli || '', log].join('\n\n').trim(), MAX_TEKS_ASLI));
  }

  if (sets.length) {
    sets.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(`UPDATE entri SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }
  return getEntri(id);
}

/** Hapus lunak: baris dan file asli tetap ada, cuma tidak muncul di pencarian/ekspor. */
function hapusEntri(id) {
  db.prepare("UPDATE entri SET status = 'DIHAPUS', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return getEntri(id);
}

function setSheetRow(id, row) {
  db.prepare('UPDATE entri SET sheet_row = ? WHERE id = ?').run(row, id);
}

// ========== FORMAT TAMPILAN ==========

function formatNilai(v, kedalaman = 0) {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'number') return v.toLocaleString('id-ID');
  if (typeof v === 'boolean') return v ? 'ya' : 'tidak';
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return v.map((x) => formatNilai(x)).join(', ');
    return v.map((x) => formatNilai(x, kedalaman + 1)).join(' | ');
  }
  if (typeof v === 'object') {
    return Object.entries(v)
      .map(([k, val]) => `${k} ${formatNilai(val, kedalaman + 1)}`)
      .join(', ');
  }
  return String(v);
}

const SINGKATAN = { po: 'PO', so: 'SO', do: 'DO', pic: 'PIC', wa: 'WA', hp: 'HP', ppn: 'PPN', npwp: 'NPWP', id: 'ID', pt: 'PT', cv: 'CV', ud: 'UD', no: 'No.', qty: 'Qty', uom: 'UOM' };

/** "no_po" -> "No. PO", "nama_outlet" -> "Nama outlet" */
function labelKunci(k) {
  const kata = String(k).split(/[_\-\s]+/).filter(Boolean).map((w) => SINGKATAN[w.toLowerCase()] || w.toLowerCase());
  const s = kata.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Kartu ringkas yang dikirim balik ke pengirim setelah data tersimpan. */
function formatKartu(entri, { judulKartu = 'Tersimpan' } = {}) {
  const baris = [`✅ ${judulKartu} · *${formatId(entri.id)}*`, `📂 ${entri.jenis}`];
  if (entri.judul) baris.push(`*${entri.judul}*`);
  if (entri.ringkasan) baris.push(entri.ringkasan);

  const konfirmasi = daftarKonfirmasi(entri.data);
  if (entri.data && typeof entri.data === 'object') {
    const kolom = Object.entries(entri.data).filter(([k]) => k !== KUNCI_KONFIRMASI).slice(0, 12);
    if (kolom.length) baris.push('');
    for (const [k, v] of kolom) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
        baris.push(`• ${labelKunci(k)}:`);
        for (const item of v.slice(0, 8)) baris.push(`   - ${potong(formatNilai(item), 140)}`);
        if (v.length > 8) baris.push(`   - … +${v.length - 8} lainnya`);
      } else {
        baris.push(`• ${labelKunci(k)}: ${potong(formatNilai(v), 200)}`);
      }
    }
    if (Object.keys(entri.data).filter((k) => k !== KUNCI_KONFIRMASI).length > 12) baris.push('• …');
  }

  if (konfirmasi.length) {
    baris.push('', '❓ *Perlu dikonfirmasi:*');
    konfirmasi.forEach((x, i) => baris.push(`${i + 1}. ${x}`));
    baris.push('_Balas pesan ini untuk menjawab atau mengoreksi._');
  }

  if (entri.files?.length) baris.push('', `📎 ${entri.files.map((f) => f.nama).join(', ')}`);
  return baris.join('\n');
}

/** Caption untuk salinan file yang diteruskan ke owner. */
function captionUntukOwner(entri, file) {
  const asal = entri.is_grup ? `${entri.pengirim_nama || 'Seseorang'} (${entri.grup_nama || 'grup'})` : entri.pengirim_nama || 'Chat pribadi';
  const n = entri.files.length;
  return [
    `*${formatId(entri.id)}* · ${entri.jenis}${n > 1 ? ` (${file.urutan}/${n})` : ''}`,
    entri.judul || '',
    `dari ${asal} · ${formatWaktuDb(entri.created_at)}`,
  ].filter(Boolean).join('\n');
}

function barisRingkas(r) {
  const asal = r.is_grup ? r.grup_nama || 'grup' : 'pribadi';
  return `${formatId(r.id)} · ${r.jenis} · ${r.judul || '(tanpa judul)'} · ${r.pengirim_nama || '?'} @ ${asal} · ${formatWaktuDb(r.created_at)}`;
}

// ========== TAMPILAN UNTUK SHEETS ==========

function barisItemObjek(o) {
  const isi = Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const lead = isi.find(([k, v]) => typeof v === 'string' && /nama|item|barang|produk|deskripsi/i.test(k)) || isi.find(([, v]) => typeof v === 'string');
  const sisa = isi.filter((e) => e !== lead).map(([k, v]) => `${String(k).replace(/[_-]+/g, ' ')} ${formatNilai(v)}`);
  return [lead ? formatNilai(lead[1]) : null, ...sisa].filter(Boolean).join(' · ');
}

/** Isi data_json sebagai teks berbaris yang enak dibaca di satu sel (Label: nilai, item pakai butir). */
function detailSheet(data) {
  if (!data || typeof data !== 'object') return '';
  const baris = [];
  const konfirmasi = daftarKonfirmasi(data);
  if (konfirmasi.length) {
    baris.push('⚠ PERLU KONFIRMASI:');
    for (const x of konfirmasi) baris.push(`  ? ${x}`);
    baris.push('');
  }
  for (const [k, v] of Object.entries(data)) {
    if (k === KUNCI_KONFIRMASI || v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
      baris.push(`${labelKunci(k)}:`);
      for (const x of v) baris.push(`  • ${barisItemObjek(x)}`);
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      baris.push(`${labelKunci(k)}:`);
      for (const [sk, sv] of Object.entries(v)) if (sv !== null && sv !== '') baris.push(`  ${labelKunci(sk)}: ${formatNilai(sv)}`);
    } else {
      baris.push(`${labelKunci(k)}: ${formatNilai(v)}`);
    }
  }
  return baris.join('\n');
}

const KUNCI_NOMINAL = ['total', 'grand_total', 'total_harga', 'total_tagihan', 'nominal', 'jumlah_bayar', 'total_bayar', 'jumlah'];

/** Angka nominal utama (rupiah) kalau ada di data, untuk kolom yang bisa diurutkan/dijumlah di Sheets. */
function nominalDari(data) {
  if (!data || typeof data !== 'object') return '';
  for (const k of KUNCI_NOMINAL) {
    const v = data[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+([.,]\d+)*$/.test(v.trim())) return Number(v.replace(/[.,]/g, ''));
  }
  return '';
}

// ========== EKSPOR ==========

function amankanSel(v) {
  let s = String(v ?? '');
  if (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s)) s = `'${s}`; // cegah formula injection di Excel/Sheets
  return `"${s.replace(/"/g, '""')}"`;
}

function ekspor({ jenis, format = 'csv', chatJid, isOwner }) {
  const where = ["status = 'AKTIF'"];
  const params = [];
  if (!isOwner) { where.push('chat_jid = ?'); params.push(chatJid); }
  if (jenis) { where.push('jenis = ?'); params.push(normalisasiJenis(jenis)); }

  const ids = db.prepare(`SELECT id FROM entri WHERE ${where.join(' AND ')} ORDER BY id ASC`).all(...params).map((r) => r.id);
  if (!ids.length) return null;

  const rows = ids.map(getEntri);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dasar = `dump-${jenis ? normalisasiJenis(jenis).replace(/[^\p{L}\p{N}]+/gu, '-') : 'semua'}-${stamp}`;

  if (format === 'json') {
    const out = rows.map((e) => ({
      id: formatId(e.id),
      waktu: formatWaktuDb(e.created_at),
      grup: e.is_grup ? e.grup_nama : null,
      pengirim: e.pengirim_nama,
      jenis: e.jenis,
      judul: e.judul,
      ringkasan: e.ringkasan,
      data: e.data,
      file: e.files.map((f) => f.nama),
      teks_asli: e.teks_asli,
    }));
    const p = path.join(DIR_EXPORT, `${dasar}.json`);
    fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
    return { path: p, jumlah: rows.length };
  }

  const header = ['ID', 'Waktu', 'Grup', 'Pengirim', 'Jenis', 'Judul', 'Ringkasan', 'Data (JSON)', 'File', 'Teks asli'];
  const baris = rows.map((e) => [
    formatId(e.id),
    formatWaktuDb(e.created_at),
    e.is_grup ? e.grup_nama || '' : '(pribadi)',
    e.pengirim_nama || '',
    e.jenis,
    e.judul || '',
    e.ringkasan || '',
    e.data_json || '',
    e.files.map((f) => f.nama).join(' '),
    potong(e.teks_asli || '', 30000),
  ]);
  const csv = '﻿' + [header, ...baris].map((r) => r.map(amankanSel).join(',')).join('\r\n');
  const p = path.join(DIR_EXPORT, `${dasar}.csv`);
  fs.writeFileSync(p, csv, 'utf8');
  return { path: p, jumlah: rows.length };
}

module.exports = {
  formatId,
  parseId,
  normalisasiJenis,
  simpanEntri,
  getEntri,
  bolehAkses,
  cariEntri,
  daftarJenis,
  daftarJenisGlobal,
  ubahEntri,
  hapusEntri,
  setSheetRow,
  statusEntri,
  daftarKonfirmasi,
  catatPesan,
  pesanDiEntri,
  cariEntriByPesan,
  tambahKeEntri,
  detailSheet,
  nominalDari,
  formatKartu,
  captionUntukOwner,
  barisRingkas,
  ekspor,
};
