require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const { appendRow, updateCell } = require('./sheets');
const agent = require('./agent');
const { formatWaktu } = require('./utils');
const ai = require('./ai');

let sock;

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
      console.log('\nScan QR code ini dengan WhatsApp (nomor ERP internal):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('\n✅ Harga Petani ERP terkoneksi ke WhatsApp!\n');
      console.log('Bot siap menerima pesan.\n');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return;

    const remoteJidMentah = message.key.remoteJid;
    if (remoteJidMentah && remoteJidMentah.endsWith('@g.us')) {
      console.log(`(Pesan dari grup diabaikan: ${remoteJidMentah})`);
      return;
    }

    const sender = normalizeJid(message);
    const isImage = !!message.message.imageMessage;
    const isLocation = !!message.message.locationMessage;
    const isLiveLocation = !!message.message.liveLocationMessage;

    const text = (
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      message.message.imageMessage?.caption ||
      ''
    ).trim();

    console.log(
      `\n📩 Pesan masuk dari ${sender}: "${text}"` +
      `${isImage ? ' [+gambar]' : ''}${isLocation ? ' [+lokasi]' : ''}${isLiveLocation ? ' [+live location]' : ''}`
    );

    try {
      await handleIncomingMessage(sender, text, message, { isImage, isLocation, isLiveLocation });
    } catch (err) {
      console.error('❌ Error handle pesan:', err.message);
    }
  });

  return sock;
}

function normalizeJid(message) {
  const remoteJid = message.key.remoteJid;
  const altJid = message.key.senderPn || message.key.remoteJidAlt || null;
  if (remoteJid && remoteJid.endsWith('@lid') && altJid) {
    return altJid;
  }
  return remoteJid;
}

function tunggu(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function kirimPesan(jid, text, jedaMsSebelum = 0) {
  if (jedaMsSebelum > 0) await tunggu(jedaMsSebelum);
  return sock.sendMessage(jid, { text });
}

// ========== ROUTING UTAMA ==========

async function handleIncomingMessage(jid, text, rawMessage, flags) {
  if (db.isOperator(jid)) {
    await handleOperatorMessage(jid, text, rawMessage, flags);
    return;
  }

  if (!db.isEmployeeRegistered(jid)) {
    await prosesOnboarding(jid, text);
    return;
  }

  await handleEmployeeMessage(jid, text, rawMessage, flags);
}

// ========== ONBOARDING EMPLOYEE ==========

async function prosesOnboarding(jid, text) {
  const employee = db.getOrCreateEmployee(jid);

  if (employee.state === 'IDLE' && !employee.nama) {
    db.setEmployeeState(jid, 'WAITING_NAMA');
    await kirimPesan(jid, 'Halo! Sebelum mulai, boleh tau nama lengkapnya?');
    return;
  }

  if (employee.state === 'WAITING_NAMA') {
    const namaInput = text.trim();
    const kataSapaanUmum = ['halo', 'hai', 'hi', 'hello', 'pagi', 'siang', 'malam', 'assalamualaikum'];

    if (namaInput.length < 2 || kataSapaanUmum.includes(namaInput.toLowerCase())) {
        await kirimPesan(jid, 'Itu kayaknya bukan nama ya 😅 Boleh kasih tau nama lengkap kamu?');
        return;
    }

    db.setEmployeeNama(jid, namaInput);
    db.setEmployeeState(jid, 'WAITING_POSISI');
    await kirimPesan(jid, 'Oke, posisi/bagian kamu apa? (misal: driver, marketing, dll)');
    return;
    }

  if (employee.state === 'WAITING_POSISI') {
    db.setEmployeePosisi(jid, text.trim());
    db.registerEmployee(jid);
    db.setEmployeeState(jid, 'IDLE');

    const emp = db.getEmployee(jid);
    await kirimPesan(
      jid,
      `Siap ${emp.nama}, sudah terdaftar! Kamu bisa:\n1. Kirim lokasi buat check-in\n2. Kirim foto buat lapor bukti jalan/kwitansi\n3. Chat bebas buat ajuin reimburse`
    );

    try {
      await appendRow('Employees', [emp.nama, jid.split('@')[0], emp.posisi, formatWaktu()]);
    } catch (err) {
      console.error('⚠️  Gagal catat Employees ke Sheets:', err.message);
    }
    return;
  }
}

// ========== HANDLER EMPLOYEE TERDAFTAR ==========

async function handleEmployeeMessage(jid, text, rawMessage, flags) {
  if (flags.isLiveLocation) {
    await handleLiveLocationUpdate(jid, rawMessage);
    return;
  }

  if (flags.isLocation) {
    await handleCheckIn(jid, rawMessage);
    return;
  }

  if (flags.isImage) {
    await handleFotoMasuk(jid, text, rawMessage);
    return;
  }

  if (!text) return;

  const historiChat = db.getChatHistory(jid);
  const konteks = { jid, db, appendRow, formatWaktu, kirimPesan };

  const kwitansiPending = db.getKwitansiPendingAktif(jid);
  let pesanBaru = text;
  if (kwitansiPending) {
    pesanBaru = `[KWITANSI MENUNGGU KELENGKAPAN, file: ${kwitansiPending.nama_file}]\n${text}`;
  }

  const hasil = await agent.jalankanAgent({
    systemPrompt: agent.SYSTEM_PROMPT_EMPLOYEE,
    tools: agent.TOOLS_EMPLOYEE,
    historiChat,
    pesanBaru,
    eksekutorTools: agent.EKSEKUTOR_EMPLOYEE,
    konteks,
  });

  db.simpanChatHistory(jid, 'user', text);

  if (hasil.error) {
    console.error('❌ Agent error (employee):', hasil.error);
    await kirimPesan(jid, hasil.jawabanFinal || 'Maaf, ada kendala. Boleh diulang?');
    return;
  }

  if (hasil.jawabanFinal) {
    await kirimPesan(jid, hasil.jawabanFinal);
    db.simpanChatHistory(jid, 'assistant', hasil.jawabanFinal);
  }
}

async function handleCheckIn(jid, rawMessage) {
  const loc = rawMessage.message.locationMessage;
  const lat = loc.degreesLatitude;
  const long = loc.degreesLongitude;
  const linkMaps = `https://maps.google.com/?q=${lat},${long}`;
  const waktu = formatWaktu();
  const employee = db.getEmployee(jid);

  const sudahCheckinSebelumnya = db.sudahCheckinHariIni(jid);

  const jamSekarang = new Date().getHours();
  let statusAbsen;
  if (jamSekarang >= 7 && jamSekarang < 9) {
    statusAbsen = 'Tepat Waktu';
  } else if (jamSekarang >= 9) {
    statusAbsen = 'Telat';
  } else {
    statusAbsen = 'Di Luar Jam Absen';
  }

  db.catatAbsensiLog(jid, lat, long, waktu);

  try {
    await appendRow('Absensi', [employee.nama, jid.split('@')[0], waktu, linkMaps, statusAbsen]);
  } catch (err) {
    console.error('⚠️  Gagal catat Absensi ke Sheets:', err.message);
  }

  if (sudahCheckinSebelumnya) {
    await kirimPesan(jid, `Lokasi tercatat lagi jam ${waktu.split(', ')[1]} (bukan check-in pertama hari ini) 👍`);
  } else {
    const infoTelat = statusAbsen === 'Telat' ? ' (telat ya, jam absen 7-9 pagi)' : '';
    await kirimPesan(jid, `Check-in tercatat jam ${waktu.split(', ')[1]}${infoTelat} 👍`);
  }
}

async function handleLiveLocationUpdate(jid, rawMessage) {
  const liveLoc = rawMessage.message.liveLocationMessage;
  const lat = liveLoc.degreesLatitude;
  const long = liveLoc.degreesLongitude;
  const linkMaps = `https://maps.google.com/?q=${lat},${long}`;
  const waktu = formatWaktu();

  const employee = db.getEmployee(jid);

  try {
    await appendRow('LiveLocation', [employee.nama, jid.split('@')[0], waktu, linkMaps]);
  } catch (err) {
    console.error('⚠️  Gagal catat LiveLocation ke Sheets:', err.message);
  }

  console.log(`(Live location update dari ${employee.nama} tercatat)`);
}

async function handleFotoMasuk(jid, caption, rawMessage) {
  const employee = db.getEmployee(jid);
  const waktu = formatWaktu();

  const captionLower = (caption || '').toLowerCase();
  const isKwitansi = captionLower.includes('kwitansi') || captionLower.includes('trx') || captionLower.includes('order');

  const namaFile = `${jid.split('@')[0]}-${Date.now()}.jpg`;
  const folderTujuan = isKwitansi ? 'kwitansi' : 'foto-jalan';
  const savePath = path.join(__dirname, 'images', folderTujuan, namaFile);

  try {
    const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
    fs.writeFileSync(savePath, buffer);
  } catch (err) {
    console.error('❌ Gagal download foto:', err.message);
    await kirimPesan(jid, 'Maaf, ada kendala pas proses foto. Boleh dikirim ulang?');
    return;
  }

  if (!isKwitansi) {
    // FotoJalan tetap bebas caption, nggak perlu structured data
    const keteranganFinal = caption && caption.trim() ? caption.trim() : '(tanpa keterangan)';
    try {
      await appendRow('FotoJalan', [employee.nama, jid.split('@')[0], waktu, keteranganFinal, namaFile]);
    } catch (err) {
      console.error('⚠️  Gagal catat FotoJalan ke Sheets:', err.message);
    }
    await kirimPesan(jid, 'Oke, foto sudah tercatat 👍');
    return;
  }

  // Kwitansi -> coba extract nominal+peruntukan dari caption
  const ekstraksi = await ai.ekstrakNominalPeruntukan(caption || '');

  if (ekstraksi.nominal && ekstraksi.peruntukan) {
    try {
      await appendRow('Kwitansi', [employee.nama, jid.split('@')[0], waktu, ekstraksi.peruntukan, ekstraksi.nominal, namaFile]);
    } catch (err) {
      console.error('⚠️  Gagal catat Kwitansi ke Sheets:', err.message);
    }
    await kirimPesan(jid, 'Oke, kwitansi sudah tercatat 👍');
  } else {
    const pendingId = db.buatKwitansiPending(jid, namaFile);
    await kirimPesan(jid, 'Kwitansinya udah kesimpan, tapi nominal/keperluannya belum jelas nih. Buat apa dan berapa nominalnya?');
    console.log(`(Kwitansi pending #${pendingId} menunggu kelengkapan dari ${jid})`);
  }
}

// ========== HANDLER OPERATOR ==========

async function handleOperatorMessage(jid, text, rawMessage, flags) {
  if (flags.isImage || flags.isLocation || flags.isLiveLocation) {
    console.log('(Operator kirim non-teks, belum ada handler khusus)');
    return;
  }

  if (!text) return;

  const historiChat = db.getChatHistory(jid);
  const konteks = {
    jid,
    db,
    appendRow,
    updateCell,
    formatWaktu,
    kirimPesan,
  };

  const hasil = await agent.jalankanAgent({
    systemPrompt: agent.SYSTEM_PROMPT_OPERATOR,
    tools: agent.TOOLS_OPERATOR,
    historiChat,
    pesanBaru: text,
    eksekutorTools: agent.EKSEKUTOR_OPERATOR,
    konteks,
  });

  db.simpanChatHistory(jid, 'user', text);

  if (hasil.error) {
    console.error('❌ Agent error (operator):', hasil.error);
    await kirimPesan(jid, hasil.jawabanFinal || 'Maaf, ada kendala. Coba lagi ya.');
    return;
  }

  if (hasil.jawabanFinal) {
    await kirimPesan(jid, hasil.jawabanFinal);
    db.simpanChatHistory(jid, 'assistant', hasil.jawabanFinal);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection (bot tetap jalan):', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception (bot tetap jalan):', err.message);
});

startBot();