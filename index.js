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
const BUFFER_SIMPAN_MAX = 40; // maksimal pesan yang diingat per grup
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
  const batas = Date.now() - 15 * 60000;
  const segar = arr.filter((x) => x.ts >= batas).slice(-BUFFER_SIMPAN_MAX);
  buffers.set(chatJid, segar);
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
  // daftar: [{ waMsg, info }]; dibatasi 3 sekaligus supaya API baca gambar tidak kebanjiran
  const hasil = [];
  for (let i = 0; i < daftar.length; i += 3) {
    const kelompok = daftar.slice(i, i + 3);
    const diproses = await Promise.all(kelompok.map(({ waMsg, info }) => media.ambilLampiran(waMsg, info, sock)));
    hasil.push(...diproses.map((lp) => ({ ...lp, caption: '' })));
  }
  return hasil;
}

async function kumpulkanKonten({ m, content, chatJid, isGrup, senderJid, ci, balasBot }) {
  const bagianTeks = [];
  const antreanLampiran = [];
  let kuat = false;

  const teksSendiri = hapusMentionBot(ambilTeks(content));
  if (teksSendiri) bagianTeks.push(teksSendiri);

  const infoSendiri = media.infoLampiran(content);
  if (infoSendiri) antreanLampiran.push({ waMsg: m, info: infoSendiri });

  // Reply ke pesan orang lain = target dump yang eksplisit (reply ke bot sendiri itu jawaban, bukan target)
  const quoted = ci?.quotedMessage;
  const adaTargetReply = !!quoted && !balasBot;
  if (adaTargetReply) {
    const qContent = normalizeMessageContent(quoted);
    const qTeks = ambilTeks(qContent);
    const dari = nomorDariJid(ci.participant) || 'seseorang';
    if (qTeks) bagianTeks.push(`Pesan yang di-reply (dari ${dari}):\n${qTeks}`);
    const qInfo = media.infoLampiran(qContent);
    if (qInfo) {
      const waQuoted = { key: { remoteJid: chatJid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: quoted };
      antreanLampiran.push({ waMsg: waQuoted, info: qInfo });
    }
    kuat = true;
  }

  // "Simpan yang tadi": gabungkan pesan terbaru pengirim yang sama kalau tag-nya pendek dan bukan reply
  if (isGrup && !adaTargetReply && teksSendiri.length < TEKS_PENDEK) {
    const lama = ambilDariBuffer(chatJid, senderJid, m.key.id);
    for (const x of lama) {
      if (x.teks) bagianTeks.unshift(`Pesan sebelumnya dari ${x.nama || 'pengirim yang sama'}:\n${x.teks}`);
      if (x.info) antreanLampiran.unshift({ waMsg: x.waMsg, info: x.info });
    }
    if (lama.length) kuat = true;
  }

  const dipakai = antreanLampiran.slice(-MAX_LAMPIRAN_PER_DUMP);
  const lampiran = await unduhLampiran(dipakai);
  return { teks: bagianTeks.join('\n\n'), lampiran, kuat };
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
  const konten = await kumpulkanKonten({ m, content, chatJid, isGrup, senderJid, ci, balasBot });

  const lampiranBermasalah = konten.lampiran.filter((l) => l.gagal && /terlalu besar/.test(l.gagal));
  if (lampiranBermasalah.length) {
    await kirimTeks(replyJid, `Ada file yang terlalu besar (batas ${media.MAX_BYTES / 1048576} MB), jadi tidak ikut disimpan.`, quotedMsg);
  }
  const lampiranOk = konten.lampiran.filter((l) => !(l.gagal && /terlalu besar/.test(l.gagal)));
  konten.lampiran = lampiranOk;

  console.log(`📩 [${isGrup ? chat.grupNama || chatJid : 'pribadi'}] ${pengirimNama || senderJid}: "${potong(konten.teks, 80)}" + ${konten.lampiran.length} lampiran`);

  // Voice note murni: simpan langsung, tidak perlu LLM
  const cumaVoice = !konten.teks && konten.lampiran.length > 0 && konten.lampiran.every((l) => l.tipe === 'voice');
  let entriBaru = [];
  let entriDiubah = [];
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
    files = hasil.files;
    balasan = hasil.balasan;
    if (!balasan) balasan = 'Maaf, aku belum nangkep maksudnya. Boleh diulang?';
    simpanChatHistory(chat.jid, 'assistant', balasan);
  }

  if (balasan) await kirimTeks(replyJid, balasan, quotedMsg);

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
  pascaSimpan(entriBaru, entriDiubah).catch((err) => console.error('❌ Pasca-simpan gagal:', err.message));
}

async function pascaSimpan(entriBaru, entriDiubah) {
  for (const id of entriBaru) {
    const entri = dump.getEntri(id);
    if (!entri) continue;
    await sync.teruskanKeOwner(sock, entri);
    await sync.sinkronSheets(id);
  }
  for (const id of entriDiubah) await sync.sinkronSheets(id);
}

// ========== TERIMA PESAN ==========

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
    simpanKeBuffer(chatJid, { id: m.key.id, ts: Date.now(), senderJid, nama: pengirimNama, waMsg: m, teks, info, dipakai: false });
    return;
  }

  if (isGrup) {
    // pesan yang men-tag bot tidak boleh ikut dipakai ulang sebagai buffer
    simpanKeBuffer(chatJid, { id: m.key.id, ts: Date.now(), senderJid, nama: pengirimNama, waMsg: m, teks: '', info: null, dipakai: true });
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
      console.log(`Salinan file dikirim ke owner: ${sync.ownerJid() || '(OWNER_JID belum diisi)'}\n`);
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
