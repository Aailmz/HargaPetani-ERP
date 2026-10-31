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

function formatWaktu(date = new Date()) {
  return date.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace('.', ':');
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
    db.setEmployeeNama(jid, text.trim());
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
      await appendRow('Employees', [emp.nama, jid.split('@')[0], emp.posisi, new Date().toISOString()]);
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

  // Teks biasa -> reimburse
  await handleReimburseBaru(jid, text);
}

async function handleCheckIn(jid, rawMessage) {
  const loc = rawMessage.message.locationMessage;
  const lat = loc.degreesLatitude;
  const long = loc.degreesLongitude;
  const linkMaps = `https://maps.google.com/?q=${lat},${long}`;
  const waktu = new Date().toISOString();

  const employee = db.getEmployee(jid);
  await kirimPesan(jid, `Check-in tercatat jam ${new Date().toLocaleTimeString('id-ID')} 👍`);

  try {
    await appendRow('Absensi', [employee.nama, jid.split('@')[0], waktu, linkMaps]);
  } catch (err) {
    console.error('⚠️  Gagal catat Absensi ke Sheets:', err.message);
  }
}

async function handleLiveLocationUpdate(jid, rawMessage) {
  const liveLoc = rawMessage.message.liveLocationMessage;
  const lat = liveLoc.degreesLatitude;
  const long = liveLoc.degreesLongitude;
  const linkMaps = `https://maps.google.com/?q=${lat},${long}`;
  const waktu = new Date().toISOString();

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
  const waktu = new Date().toISOString();

  const captionLower = (caption || '').toLowerCase();
  const isKwitansi = captionLower.includes('kwitansi') || captionLower.includes('trx') || captionLower.includes('order');
  const folderTujuan = isKwitansi ? 'kwitansi' : 'foto-jalan';
  const tabTujuan = isKwitansi ? 'Kwitansi' : 'FotoJalan';

  const namaFile = `${jid.split('@')[0]}-${Date.now()}.jpg`;
  const savePath = path.join(__dirname, 'images', folderTujuan, namaFile);

  try {
    const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
    fs.writeFileSync(savePath, buffer);

    await appendRow(tabTujuan, [employee.nama, jid.split('@')[0], waktu, caption || '(tanpa keterangan)', namaFile]);
    await kirimPesan(jid, 'Foto sudah tercatat, makasih 🙏');
  } catch (err) {
    console.error('❌ Gagal proses foto:', err.message);
    await kirimPesan(jid, 'Maaf, ada kendala pas proses foto. Boleh dikirim ulang?');
  }
}

async function handleReimburseBaru(jid, text) {
  if (!text) return; // skip pesan kosong (misal cuma emoji/sticker ke-filter duluan)

  const employee = db.getEmployee(jid);
  const waktu = new Date().toISOString();

  const reimburseId = db.buatReimburseBaru(jid, text);

  await kirimPesan(jid, 'Oke, pengajuan reimburse sudah diteruskan ke tim. Ditunggu ya 🙏');

  const operatorJid = process.env.OPERATOR_JID;
  await kirimPesan(
    operatorJid,
    `💰 Reimburse baru dari ${employee.nama} (${jid.split('@')[0]}):\n\n"${text}"\n\n[reimburse #${reimburseId}]`
  );

  try {
    const row = await appendRow('Reimburse', [employee.nama, jid.split('@')[0], waktu, text, 'PENDING', '']);
    db.setSheetsRowReimburse(reimburseId, row);
  } catch (err) {
    console.error('⚠️  Gagal catat Reimburse ke Sheets:', err.message);
  }
}

// ========== HANDLER OPERATOR ==========

async function handleOperatorMessage(jid, text, rawMessage, flags) {
  if (flags.isImage || flags.isLocation || flags.isLiveLocation) {
    console.log('(Operator kirim non-teks, belum ada handler khusus)');
    return;
  }

  const pendingTerbaru = db.getReimbursePendingTerbaru();

  if (pendingTerbaru.length === 0) {
    await kirimPesan(jid, 'Tidak ada reimburse yang pending saat ini.');
    return;
  }

  const keputusan = await ai.parseKeputusanReimburse(text, pendingTerbaru);

  if (keputusan.aksi === 'TIDAK_JELAS' || !keputusan.reimburse_id) {
    await kirimPesan(jid, 'Maksudnya reimburse yang mana ya? Sebut nomor reimburse-nya biar jelas (contoh: "approve #3").');
    return;
  }

  const reimburse = db.getReimburseById(keputusan.reimburse_id);
  if (!reimburse || reimburse.status !== 'PENDING') {
    await kirimPesan(jid, `Reimburse #${keputusan.reimburse_id} tidak ditemukan atau sudah diproses sebelumnya.`);
    return;
  }

  const statusBaru = keputusan.aksi === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  db.setStatusReimburse(reimburse.id, statusBaru, keputusan.alasan || null);
  const waktuUpdateTampil = formatWaktu();

  if (reimburse.sheets_row) {
    try {
      await updateCell('Reimburse', reimburse.sheets_row, 'E', statusBaru);
      await updateCell('Reimburse', reimburse.sheets_row, 'F', waktuUpdateTampil);
    } catch (err) {
      console.error('⚠️  Gagal update status Reimburse ke Sheets:', err.message);
    }
  }

  const employee = db.getEmployee(reimburse.employee_jid);
  const pesanNotif = statusBaru === 'APPROVED'
    ? `Reimburse kamu udah di-ACC ya 👍\n"${reimburse.teks_asli}"`
    : `Reimburse kamu ditolak${keputusan.alasan ? `: ${keputusan.alasan}` : ''}.\n"${reimburse.teks_asli}"`;
  await kirimPesan(reimburse.employee_jid, pesanNotif);

  await kirimPesan(jid, `Oke, reimburse #${reimburse.id} (${employee.nama}) sudah di-${statusBaru.toLowerCase()}.`);
}

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection (bot tetap jalan):', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception (bot tetap jalan):', err.message);
});

startBot();