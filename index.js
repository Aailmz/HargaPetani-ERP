require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  normalizeMessageContent,
  getContentType,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const { tandaiPesanDiproses, simpanChatHistory, getChatHistory, bersihkanBerkalaan } = require('./db');
const dump = require('./dump');
const agent = require('./agent');
const media = require('./media');
const sync = require('./sync');
const { nomorDariJid, potong } = require('./utils');

// ========== KONFIGURASI ==========

const MAX_DUMP_PER_JAM = parseInt(process.env.MAX_DUMP_PER_JAM, 10) || 30;
const BUFFER_MENIT = 5; // pesan sebelum tag yang masih ikut disimpan
const BUFFER_MAX = 8; // maksimal pesan dari buffer yang ikut per tag
const BUFFER_SIMPAN_MAX = 300; // maksimal pesan yang diingat per grup (buat thread reply)
const BUFFER_JAM = 6; // thread reply diingat selama ini (di memori, hilang kalau bot restart)
const MAX_PESAN_THREAD = 15; // maksimal pesan thread yang ikut dicatat sekali tag
const DISKUSI_JEDA_DETIK = Number(process.env.DISKUSI_JEDA_DETIK ?? 20); // tunggu obrolan reda sebelum bot memeriksanya
const DISKUSI_MAKS_PER_JAM = 20; // batas pemeriksaan obrolan per grup, menjaga biaya
const DISKUSI_TANYA_JEDA_MENIT = Number(process.env.DISKUSI_TANYA_JEDA_MENIT ?? 10); // jarak minimal antar pertanyaan bot di satu grup
const DISKUSI_TEKS_MIN = 3; // pesan lebih pendek dari ini (mis. "ok") tidak memicu pemeriksaan
const PERINTAH_SINGKAT = 25; // teks tag sependek ini dianggap perintah ("simpan"), bukan isi
const TEKS_PENDEK = 60; // tag dengan teks sependek ini dianggap "simpan yang tadi"
const MAX_LAMPIRAN_PER_DUMP = 8;
const CACHE_GRUP_MENIT = 30;

let sock;
let botNomor = new Set();

// ========== HELPER PESAN ==========

function ambilTeks(content) {
  if (!content) return '';
  const lokasi = content.locationMessage || content.liveLocationMessage;
  if (lokasi) {
    const nama = lokasi.name || lokasi.address || '';
    return `Lokasi${nama ? ` ${nama}` : ''}: https://maps.google.com/?q=${lokasi.degreesLatitude},${lokasi.degreesLongitude}`;
  }
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.documentMessage?.caption ||
    content.videoMessage?.caption ||
    ''
  ).trim();
}

function ambilContextInfo(content) {
  if (!content) return null;
  const tipe = getContentType(content);
  return (tipe && content[tipe]?.contextInfo) || null;
}

function jidPengirim(m, isGrup) {
  const raw = isGrup ? m.key.participant : m.key.remoteJid;
  const alt = isGrup ? m.key.participantAlt : m.key.remoteJidAlt || m.key.senderPn;
  if (raw && raw.endsWith('@lid') && alt) return alt;
  return raw || '';
}

function perbaruiIdentitasBot() {
  botNomor = new Set([nomorDariJid(sock.user?.id), nomorDariJid(sock.user?.lid)].filter(Boolean));
}

function hapusMentionBot(teks) {
  let out = teks;
  for (const n of botNomor) out = out.replace(new RegExp(`@${n}\\b`, 'g'), '');
  return out.replace(/\s+/g, ' ').trim();
}

const tunggu = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ========== CACHE NAMA GRUP ==========

const cacheGrup = new Map();

async function namaGrup(jid) {
  const c = cacheGrup.get(jid);
  if (c && Date.now() - c.waktu < CACHE_GRUP_MENIT * 60000) return c.nama;
  try {
    const meta = await sock.groupMetadata(jid);
    cacheGrup.set(jid, { nama: meta.subject, waktu: Date.now() });
    return meta.subject;
  } catch {
    return c?.nama || null;
  }
}

// ========== BUFFER PESAN GRUP (cuma di memori) ==========
// Dipakai supaya "kirim 3 foto, lalu @bot simpan" bisa menyatukan ketiganya.
// Isinya tidak pernah ditulis ke disk dan file baru diunduh kalau bot benar-benar di-tag.

const buffers = new Map();

function simpanKeBuffer(chatJid, item) {
  const arr = buffers.get(chatJid) || [];
  arr.push(item);
  const batas = Date.now() - BUFFER_JAM * 3600000;
  const segar = arr.filter((x) => x.ts >= batas).slice(-BUFFER_SIMPAN_MAX);
  buffers.set(chatJid, segar);
}

/**
 * Kumpulkan seluruh thread reply (di buffer) yang memuat pesan `targetId`: naik ke pesan paling atas
 * yang diketahui, lalu turun ke semua balasan (teks maupun voice note) dari pesan-pesan itu.
 * Pesan yang men-tag bot (perintah) tidak ikut karena tidak punya isi.
 */
function kumpulkanThread(chatJid, targetId) {
  const arr = buffers.get(chatJid) || [];
  const byId = new Map(arr.map((x) => [x.id, x]));

  let akar = targetId;
  const dilewati = new Set();
  while (byId.get(akar)?.replyToId && !dilewati.has(akar) && dilewati.size < 20) {
    dilewati.add(akar);
    akar = byId.get(akar).replyToId;
  }

  const anggota = new Set([akar]);
  let bertambah = true;
  while (bertambah && anggota.size < 80) {
    bertambah = false;
    for (const x of arr) {
      if (!anggota.has(x.id) && x.replyToId && anggota.has(x.replyToId)) {
        anggota.add(x.id);
        bertambah = true;
      }
    }
  }
  return arr.filter((x) => anggota.has(x.id) && (x.teks || x.info)).sort((a, b) => a.ts - b.ts);
}

function ambilDariBuffer(chatJid, senderJid, kecualiId) {
  const batas = Date.now() - BUFFER_MENIT * 60000;
  const arr = buffers.get(chatJid) || [];
  const dipilih = arr
    .filter((x) => !x.dipakai && x.id !== kecualiId && x.senderJid === senderJid && x.ts >= batas)
    .slice(-BUFFER_MAX);
  for (const x of dipilih) x.dipakai = true;
  return dipilih;
}

// ========== RATE LIMIT ==========

const riwayatPakai = new Map();

function kenaLimit(senderJid) {
  if (sync.isOwner(senderJid)) return false;
  const sekarang = Date.now();
  const arr = (riwayatPakai.get(senderJid) || []).filter((t) => sekarang - t < 3600000);
  if (arr.length >= MAX_DUMP_PER_JAM) {
    riwayatPakai.set(senderJid, arr);
    return true;
  }
  arr.push(sekarang);
  riwayatPakai.set(senderJid, arr);
  return false;
}

// ========== ANTRIAN PER CHAT ==========

const antrian = new Map();

function enqueue(kunci, fn) {
  const sebelumnya = antrian.get(kunci) || Promise.resolve();
  const berikutnya = sebelumnya.catch(() => {}).then(fn);
  antrian.set(kunci, berikutnya);
  berikutnya
    .catch(() => {})
    .finally(() => {
      if (antrian.get(kunci) === berikutnya) antrian.delete(kunci);
    });
  return berikutnya;
}

// ========== KUMPULKAN KONTEN ==========

async function unduhLampiran(daftar) {
  // daftar: [{ waMsg, info, id }]; dibatasi 3 sekaligus supaya API baca gambar tidak kebanjiran
  const hasil = [];
  for (let i = 0; i < daftar.length; i += 3) {
    const kelompok = daftar.slice(i, i + 3);
    const diproses = await Promise.all(kelompok.map(({ waMsg, info }) => media.ambilLampiran(waMsg, info, sock)));
    hasil.push(...diproses.map((lp, j) => ({ ...lp, caption: '', pesanId: kelompok[j].id })));
  }
  return hasil;
}

function jamWib(ts) {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace('.', ':');
}

/** Pesan yang di-reply, dibentuk dari isi kutipan WhatsApp (dipakai kalau pesan itu tidak ada di buffer). */
function itemDariKutipan(ci, chatJid) {
  const qContent = normalizeMessageContent(ci.quotedMessage);
  return {
    id: ci.stanzaId,
    ts: 0,
    nama: nomorDariJid(ci.participant) || 'seseorang',
    replyKe: null,
    teks: ambilTeks(qContent),
    info: media.infoLampiran(qContent),
    waMsg: { key: { remoteJid: chatJid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: ci.quotedMessage },
  };
}

/**
 * Susun konten satu dump dari: pesan yang men-tag bot, pesan yang di-reply beserta seluruh thread-nya
 * (balasan teks/voice dari siapa pun), atau pesan-pesan terbaru pengirim yang sama ("simpan yang tadi").
 */
async function kumpulkanKonten({ m, content, chatJid, isGrup, senderJid, pengirimNama, ci, balasBot }) {
  const teksSendiri = hapusMentionBot(ambilTeks(content));
  const infoSendiri = media.infoLampiran(content);
  const adaTargetReply = !!ci?.quotedMessage && !balasBot; // reply ke bot = jawaban, bukan target
  const namaBuffer = new Map((buffers.get(chatJid) || []).map((x) => [x.id, x.nama]));
  const namaDari = (id, nomor) => namaBuffer.get(id) || nomor || 'seseorang';

  let items = [];
  let kuat = false;

  if (adaTargetReply) {
    if (isGrup) {
      const thread = kumpulkanThread(chatJid, ci.stanzaId);
      if (!thread.some((x) => x.id === ci.stanzaId)) items.push(itemDariKutipan(ci, chatJid));
      for (const x of thread) {
        x.dipakai = true;
        items.push({ id: x.id, ts: x.ts, nama: x.nama, replyKe: x.replyToId ? namaDari(x.replyToId, x.replyKeNomor) : null, teks: x.teks, info: x.info, waMsg: x.waMsg });
      }
    } else {
      items.push(itemDariKutipan(ci, chatJid));
    }
    kuat = true;
  } else if (isGrup && teksSendiri.length < TEKS_PENDEK) {
    // "Simpan yang tadi": gabungkan pesan terbaru pengirim yang sama
    for (const x of ambilDariBuffer(chatJid, senderJid, m.key.id)) {
      items.push({ id: x.id, ts: x.ts, nama: x.nama, replyKe: null, teks: x.teks, info: x.info, waMsg: x.waMsg });
      kuat = true;
    }
  }

  items.sort((a, b) => a.ts - b.ts);
  if (items.length > MAX_PESAN_THREAD) {
    const target = items.find((x) => x.id === ci?.stanzaId);
    items = items.slice(-MAX_PESAN_THREAD);
    if (target && !items.includes(target)) items[0] = target;
  }

  // Teks pendek tanpa lampiran, di samping pesan lain, dianggap perintah ("simpan") dan bukan isi dump
  const perintahSingkat = items.length > 0 && !infoSendiri && teksSendiri.length <= PERINTAH_SINGKAT;
  if (!perintahSingkat && (teksSendiri || infoSendiri)) {
    items.push({
      id: m.key.id,
      ts: Date.now(),
      nama: pengirimNama,
      replyKe: adaTargetReply ? namaDari(ci.stanzaId, nomorDariJid(ci.participant)) : null,
      teks: teksSendiri,
      info: infoSendiri,
      waMsg: m,
    });
  }

  const dipakai = items.filter((x) => x.info).slice(-MAX_LAMPIRAN_PER_DUMP);
  dipakai.forEach((x, i) => {
    x.lampiranIdx = i + 1;
  });
  const lampiran = await unduhLampiran(dipakai.map((x) => ({ waMsg: x.waMsg, info: x.info, id: x.id })));

  // Satu pesan saja (kasus biasa) tampil apa adanya; lebih dari satu tampil sebagai percakapan berurutan
  const tunggal = items.length === 1 && !adaTargetReply;
  const bagian = items.map((x) => {
    const penanda = x.lampiranIdx ? ` [lampiran ${x.lampiranIdx}: ${x.info.tipe}]` : x.info ? ' [lampiran tidak diikutkan, terlalu banyak]' : '';
    if (tunggal) return { id: x.id, teks: x.teks };
    const label = `[${[x.ts ? jamWib(x.ts) : null, x.nama].filter(Boolean).join(' ')}${x.replyKe ? ` ↪ ${x.replyKe}` : ''}]`;
    return { id: x.id, teks: `${label}${x.teks ? `: ${x.teks}` : ''}${penanda}`.trim() };
  });

  const catatan = [];
  if (perintahSingkat && teksSendiri) catatan.push(`Pesan tag: "${teksSendiri}"`);
  if (!teksSendiri && !infoSendiri && items.length > 0) catatan.push('(Pesan yang men-tag hanya berisi tag, artinya minta dicatat.)');

  return {
    teks: [...bagian.map((b) => b.teks), ...catatan].filter(Boolean).join('\n'),
    bagian: bagian.filter((b) => b.teks),
    lampiran,
    pesanIds: items.map((x) => x.id).filter(Boolean),
    kuat,
    hanyaVoice: lampiran.length > 0 && items.every((x) => !x.teks && x.info?.tipe === 'voice') && !teksSendiri,
  };
}

// ========== KIRIM ==========

async function kirimTeks(replyJid, text, quotedMsg) {
  return sock.sendMessage(replyJid, { text }, quotedMsg ? { quoted: quotedMsg } : undefined);
}

async function kirimFile(replyJid, filePath) {
  const nama = path.basename(filePath);
  const mimetype = nama.endsWith('.json') ? 'application/json' : 'text/csv';
  return sock.sendMessage(replyJid, { document: fs.readFileSync(filePath), fileName: nama, mimetype });
}

// ========== VOICE NOTE (tanpa LLM) ==========

function simpanVoiceLangsung({ konten, chat, pengirim }) {
  const ids = [];
  const kartu = [];
  for (const lp of konten.lampiran) {
    if (!lp.path) continue;
    const entri = dump.simpanEntri({
      jenis: 'voice note',
      judul: `Voice note dari ${pengirim.nama || 'tanpa nama'}`,
      ringkasan: 'Voice note tersimpan, belum ditranskrip.',
      data: lp.ukuran ? { ukuran_kb: Math.round(lp.ukuran / 1024) } : null,
      teksAsli: lp.teksHasil,
      chat,
      pengirim,
      lampiran: [{ path: lp.path, namaAsli: lp.namaAsli, mimetype: lp.mimetype, tipe: lp.tipe, ukuran: lp.ukuran }],
    });
    dump.catatPesan(entri.id, chat.jid, [lp.pesanId]);
    ids.push(entri.id);
    kartu.push(dump.formatKartu(entri));
  }
  return { ids, balasan: kartu.join('\n\n') };
}

// ========== PROSES SATU PESAN YANG DITUJUKAN KE BOT ==========

async function prosesPesan({ m, content, chatJid, isGrup, senderJid, pengirimNama, ci, balasBot }) {
  const replyJid = m.key.remoteJid;
  const quotedMsg = isGrup ? m : null;

  if (kenaLimit(senderJid)) {
    await kirimTeks(replyJid, `Wah, sudah banyak banget yang masuk dari kamu dalam sejam terakhir (batas ${MAX_DUMP_PER_JAM}). Coba lagi sebentar lagi ya.`, quotedMsg);
    return;
  }

  try {
    await sock.sendPresenceUpdate('composing', replyJid);
  } catch {
    /* tidak kritis */
  }

  const chat = { jid: isGrup ? chatJid : senderJid || chatJid, isGrup, grupNama: isGrup ? await namaGrup(chatJid) : null };
  const pengirim = { jid: senderJid, nama: pengirimNama };
  const konten = await kumpulkanKonten({ m, content, chatJid, isGrup, senderJid, pengirimNama, ci, balasBot });

  // Membalas pesan bot: cari dump mana yang dibahas pesan bot itu, supaya jawaban/koreksi tepat sasaran
  if (balasBot && ci?.stanzaId) konten.rujukanIds = dump.cariEntriByPesan(chat.jid, [ci.stanzaId]).map((e) => e.id);

  const lampiranBermasalah = konten.lampiran.filter((l) => l.gagal && /terlalu besar/.test(l.gagal));
  if (lampiranBermasalah.length) {
    await kirimTeks(replyJid, `Ada file yang terlalu besar (batas ${media.MAX_BYTES / 1048576} MB), jadi tidak ikut disimpan.`, quotedMsg);
  }

  console.log(`📩 [${isGrup ? chat.grupNama || chatJid : 'pribadi'}] ${pengirimNama || senderJid}: "${potong(konten.teks, 80)}" + ${konten.lampiran.length} lampiran`);

  // Voice note murni: simpan langsung, tidak perlu LLM
  const cumaVoice = konten.hanyaVoice;
  let entriBaru = [];
  let entriDiubah = [];
  let entriLanjut = [];
  let files = [];
  let balasan;

  if (cumaVoice) {
    const hasil = simpanVoiceLangsung({ konten, chat, pengirim });
    entriBaru = hasil.ids;
    balasan = hasil.balasan || 'Voice note-nya gagal terunduh, boleh kirim ulang?';
  } else {
    const hasil = await agent.jalankanAgent({
      chatKey: chat.jid,
      chat,
      pengirim,
      isOwner: sync.isOwner(senderJid),
      konten,
      riwayat: getChatHistory(chat.jid),
    });

    simpanChatHistory(chat.jid, 'user', hasil.teksUser);
    if (hasil.error && !hasil.balasan) {
      console.error('❌ Agent error:', hasil.error);
      await kirimTeks(replyJid, 'Ada kendala teknis, boleh coba kirim ulang sebentar lagi?', quotedMsg);
      return;
    }
    entriBaru = hasil.entriBaru;
    entriDiubah = hasil.entriDiubah;
    entriLanjut = hasil.entriLanjut;
    files = hasil.files;
    balasan = hasil.balasan;
    if (!balasan) balasan = 'Maaf, aku belum nangkep maksudnya. Boleh diulang?';
    simpanChatHistory(chat.jid, 'assistant', balasan);
  }

  const terkirim = balasan ? await kirimTeks(replyJid, balasan, quotedMsg) : null;

  // Ingat pesan bot ini membahas dump yang mana: kalau seseorang membalasnya (jawaban/koreksi), targetnya jelas
  const idPesanBot = terkirim?.key?.id;
  if (idPesanBot) {
    for (const id of new Set([...entriBaru, ...entriDiubah, ...(konten.rujukanIds || [])])) dump.catatPesan(id, chat.jid, [idPesanBot]);
  }

  for (const f of files) {
    try {
      await tunggu(400);
      await kirimFile(replyJid, f);
    } catch (err) {
      console.error('❌ Gagal kirim file ekspor:', err.message);
      await kirimTeks(replyJid, `Rekap sudah dibuat tapi gagal terkirim: ${err.message}`);
    }
  }

  // Pekerjaan susulan (salinan ke owner + Sheets) tidak menahan balasan ke pengirim
  pascaSimpan(entriBaru, entriDiubah, entriLanjut).catch((err) => console.error('❌ Pasca-simpan gagal:', err.message));
}

async function pascaSimpan(entriBaru, entriDiubah, entriLanjut = []) {
  for (const id of entriBaru) {
    const entri = dump.getEntri(id);
    if (!entri) continue;
    await sync.teruskanKeOwner(sock, entri);
    await sync.sinkronSheets(id);
  }
  // Entri yang dilanjutkan: cuma file barunya yang diteruskan ke owner
  for (const { id, fileBaruIds } of entriLanjut) {
    const entri = dump.getEntri(id);
    if (entri && fileBaruIds.length) await sync.teruskanKeOwner(sock, entri, fileBaruIds);
  }
  for (const id of entriDiubah) await sync.sinkronSheets(id);
}

// ========== MENYIMAK DISKUSI SETELAH BOT BERTANYA ==========
// Berlaku hanya di grup yang punya dump dengan pertanyaan terbuka (perlu_konfirmasi) dan hanya selama
// jendela diskusi (DISKUSI_MENIT). Di luar itu bot tidak membaca obrolan sama sekali. Obrolan dinilai
// relevan atau tidak oleh model; tanpa perubahan data bot tetap diam.

const timerDiskusi = new Map();
const diskusiTerakhir = new Map(); // chatJid -> ts pesan terakhir yang sudah diperiksa
const diskusiRiwayat = new Map(); // chatJid -> daftar waktu pemeriksaan
const diskusiTanyaTerakhir = new Map(); // chatJid -> ts pertanyaan terakhir bot

function jadwalkanDiskusi(chatJid) {
  if (!(DISKUSI_JEDA_DETIK >= 0) || dump.dumpTerbuka(chatJid).length === 0) return;
  clearTimeout(timerDiskusi.get(chatJid));
  const timer = setTimeout(() => {
    timerDiskusi.delete(chatJid);
    enqueue(chatJid, () => prosesDiskusi(chatJid)).catch((err) => console.error('❌ Diskusi gagal:', err.message));
  }, DISKUSI_JEDA_DETIK * 1000);
  timerDiskusi.set(chatJid, timer);
}

function bolehPeriksaDiskusi(chatJid) {
  const sekarang = Date.now();
  const arr = (diskusiRiwayat.get(chatJid) || []).filter((t) => sekarang - t < 3600000);
  if (arr.length >= DISKUSI_MAKS_PER_JAM) {
    diskusiRiwayat.set(chatJid, arr);
    return false;
  }
  arr.push(sekarang);
  diskusiRiwayat.set(chatJid, arr);
  return true;
}

async function prosesDiskusi(chatJid) {
  const terbuka = dump.dumpTerbuka(chatJid);
  if (!terbuka.length) return;

  const awal = Math.min(...terbuka.map((e) => dump.awalDiskusiMs(e)));
  const terakhir = diskusiTerakhir.get(chatJid) || 0;
  const arr = buffers.get(chatJid) || [];
  const namaDi = new Map(arr.map((x) => [x.id, x.nama]));
  const pesan = arr.filter((x) => x.teks && x.ts >= awal).slice(-25);
  if (!pesan.some((x) => x.ts > terakhir)) return;
  if (!bolehPeriksaDiskusi(chatJid)) {
    console.log(`(Diskusi ${chatJid} dilewati: batas ${DISKUSI_MAKS_PER_JAM} pemeriksaan per jam)`);
    return;
  }
  diskusiTerakhir.set(chatJid, Math.max(...pesan.map((x) => x.ts)));

  console.log(`👂 Menyimak diskusi di grup (${pesan.filter((x) => x.ts > terakhir).length} pesan baru, ${terbuka.length} dump terbuka)`);
  const chat = { jid: chatJid, isGrup: true, grupNama: await namaGrup(chatJid) };
  const hasil = await agent.jalankanDiskusi({
    chat,
    dumps: terbuka,
    pesan: pesan.map((x) => ({
      id: x.id,
      nama: x.nama,
      jam: jamWib(x.ts),
      teks: x.teks,
      baru: x.ts > terakhir,
      replyKe: x.replyToId ? namaDi.get(x.replyToId) || x.replyKeNomor : null,
    })),
  });

  if (!hasil.balasan) return;

  // Pertanyaan saat obrolan menuju kesimpulan tapi masih ambigu: dibatasi jaraknya supaya bot tidak cerewet
  if (hasil.tanya) {
    const sejak = Date.now() - (diskusiTanyaTerakhir.get(chatJid) || 0);
    if (sejak < DISKUSI_TANYA_JEDA_MENIT * 60000) {
      console.log('(Pertanyaan diskusi ditahan: baru saja bertanya di grup ini)');
      return;
    }
    diskusiTanyaTerakhir.set(chatJid, Date.now());
  } else if (!hasil.entriDiubah.length) {
    return;
  }

  const terkirim = await kirimTeks(chatJid, hasil.balasan, null);

  // Pesan bot ini dikaitkan ke dump yang dibahas, jadi membalasnya langsung tepat sasaran
  const disebut = [...hasil.balasan.matchAll(/DUMP-(\d+)/g)].map((x) => Number(x[1]));
  const idDibahas = hasil.tanya ? (disebut.length ? disebut : terbuka.map((e) => e.id)) : hasil.entriDiubah;
  const idPesanBot = terkirim?.key?.id;
  for (const id of new Set(idDibahas)) {
    if (idPesanBot) dump.catatPesan(id, chatJid, [idPesanBot]);
    if (hasil.tanya) dump.sentuhEntri(id); // pertanyaan baru memperpanjang jendela diskusi
  }

  simpanChatHistory(chatJid, 'user', hasil.teksUser);
  simpanChatHistory(chatJid, 'assistant', hasil.balasan);
  if (hasil.entriDiubah.length) pascaSimpan([], hasil.entriDiubah, []).catch((err) => console.error('❌ Pasca-simpan gagal:', err.message));
}

// ========== TERIMA PESAN ==========

/** Tautan reply sebuah pesan (membalas pesan mana), dipakai untuk merangkai thread. */
function infoReply(ci) {
  if (!ci?.quotedMessage || !ci.stanzaId) return { replyToId: null, replyKeNomor: null };
  return { replyToId: ci.stanzaId, replyKeNomor: nomorDariJid(ci.participant) };
}

function tanganiPesan(m) {
  const chatJid = m.key.remoteJid;
  if (!m.message || m.key.fromMe || !chatJid) return;
  const isGrup = chatJid.endsWith('@g.us');
  if (!isGrup && !chatJid.endsWith('@s.whatsapp.net') && !chatJid.endsWith('@lid')) return; // abaikan status, channel, broadcast

  if (!tandaiPesanDiproses(m.key.id)) return;

  const content = normalizeMessageContent(m.message);
  if (!content) return;

  const teks = ambilTeks(content);
  const info = media.infoLampiran(content);
  if (!teks && !info) return; // reaksi, protocol message, stiker, dll

  const senderJid = jidPengirim(m, isGrup);
  const pengirimNama = m.pushName || nomorDariJid(senderJid);
  const ci = ambilContextInfo(content);

  const ditag = !!ci?.mentionedJid?.some((j) => botNomor.has(nomorDariJid(j)));
  const balasBot = !!ci?.quotedMessage && botNomor.has(nomorDariJid(ci.participant));

  // Grup: hanya merespons kalau di-tag atau membalas pesan bot. Selain itu cuma diingat sebentar di memori.
  if (isGrup && !ditag && !balasBot) {
    simpanKeBuffer(chatJid, { id: m.key.id, ts: Date.now(), senderJid, nama: pengirimNama, waMsg: m, teks, info, dipakai: false, ...infoReply(ci) });
    if (teks.length >= DISKUSI_TEKS_MIN) jadwalkanDiskusi(chatJid);
    return;
  }

  if (isGrup) {
    // pesan yang men-tag bot tidak boleh ikut dipakai ulang sebagai buffer
    simpanKeBuffer(chatJid, { id: m.key.id, ts: Date.now(), senderJid, nama: pengirimNama, waMsg: m, teks: '', info: null, dipakai: true, ...infoReply(ci) });
  }

  const kunciAntrian = isGrup ? chatJid : senderJid || chatJid;
  enqueue(kunciAntrian, async () => {
    try {
      await prosesPesan({ m, content, chatJid, isGrup, senderJid, pengirimNama, ci, balasBot });
    } catch (err) {
      console.error('❌ Error proses pesan:', err);
      try {
        await kirimTeks(m.key.remoteJid, 'Ada kendala teknis, boleh coba kirim ulang?', isGrup ? m : null);
      } catch {
        /* sudah dicatat */
      }
    }
  });
}

// ========== KONEKSI ==========

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan QR code ini dengan WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      perbaruiIdentitasBot();
      console.log('\n✅ Bot dump data terkoneksi!');
      console.log(`Identitas bot: ${[...botNomor].join(', ')}`);
      console.log(`Salinan file dikirim ke owner: ${sync.ownerJid() || '(OWNER_JID belum diisi)'}`);
      console.log(`Google Sheets: ${sync.statusSheets()}\n`);
      // siapkan tab Sheets sekarang (buat/rapikan/isi ulang bila perlu), tanpa menunggu dump pertama
      Promise.resolve(sync.siapkanSheetsAwal()).catch((err) => console.error('❌ Persiapan Sheets gagal:', err.message));
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        tanganiPesan(m);
      } catch (err) {
        console.error('❌ Error baca pesan:', err.message);
      }
    }
  });

  return sock;
}

if (require.main === module) {
  setInterval(bersihkanBerkalaan, 6 * 3600 * 1000).unref();

  process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled rejection (bot tetap jalan):', err?.message || err);
  });

  process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception (bot tetap jalan):', err?.message || err);
  });

  startBot();
}

module.exports = {
  tanganiPesan,
  // dipakai test: suntik socket palsu tanpa koneksi WhatsApp
  _setSock(s) {
    sock = s;
    perbaruiIdentitasBot();
  },
  _selesai: () => Promise.all([...antrian.values()]),
};
