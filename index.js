require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

const db = require('./db');

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

    await handleIncomingMessage(sender, text, message, { isImage, isLocation, isLiveLocation });
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

// ========== ROUTING (skeleton, fitur lengkap nyusul step berikutnya) ==========

async function handleIncomingMessage(jid, text, rawMessage, flags) {
  if (jid === process.env.OPERATOR_JID) {
    console.log('(routing ke handleOperatorMessage — belum diimplementasi)');
    return;
  }

  if (!db.isEmployeeRegistered(jid)) {
    console.log('(routing ke prosesOnboarding — belum diimplementasi)');
    return;
  }

  console.log('(routing ke handler fitur employee — belum diimplementasi)', flags);
}

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection (bot tetap jalan):', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception (bot tetap jalan):', err.message);
});

startBot();

module.exports = { kirimPesan };