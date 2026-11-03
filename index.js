require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const { db } = require('./db');
const agent = require('./agent');

const OWNER_JID = process.env.OWNER_JID;
const MAX_HISTORI = 20;

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
      console.log('\nScan QR code ini dengan WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('\n✅ Harga Petani Order bot terkoneksi!\n');
      console.log(`Menerima pesan dari: ${OWNER_JID}\n`);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return;

    const sender = normalizeJid(message);

    // Hanya terima pesan dari owner
    if (sender !== OWNER_JID) {
      console.log(`(Pesan dari ${sender} diabaikan, bukan owner)`);
      return;
    }

    const text = (
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      ''
    ).trim();

    if (!text) return;

    console.log(`\n📩 Pesan masuk: "${text}"`);

    try {
      await handleIncomingMessage(sender, text);
    } catch (err) {
      console.error('❌ Error handle pesan:', err.message);
      await kirimPesan(sender, 'Ada kendala teknis, boleh diulang?');
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

async function kirimPesan(jid, text) {
  return sock.sendMessage(jid, { text });
}

async function kirimFile(jid, filePath) {
  const namaFile = filePath.split(/[\\/]/).pop();
  const isJpg = filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.jpeg');

  if (isJpg) {
    return sock.sendMessage(jid, {
      image: fs.readFileSync(filePath),
      caption: '',
    });
  }

  return sock.sendMessage(jid, {
    document: fs.readFileSync(filePath),
    fileName: namaFile,
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// ========== CHAT HISTORY ==========

function simpanChatHistory(jid, role, content) {
  db.prepare('INSERT INTO chat_history (jid, role, content) VALUES (?, ?, ?)').run(jid, role, content);

  const total = db.prepare('SELECT COUNT(*) as c FROM chat_history WHERE jid = ?').get(jid).c;
  if (total > MAX_HISTORI) {
    db.prepare(`
      DELETE FROM chat_history WHERE id IN (
        SELECT id FROM chat_history WHERE jid = ? ORDER BY created_at ASC LIMIT ?
      )
    `).run(jid, total - MAX_HISTORI);
  }
}

function getChatHistory(jid) {
  const rows = db.prepare(`
    SELECT role, content FROM chat_history WHERE jid = ? ORDER BY created_at ASC LIMIT ?
  `).all(jid, MAX_HISTORI);
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

// ========== ROUTING ==========

async function handleIncomingMessage(jid, text) {
  const historiChat = getChatHistory(jid);

  // jid di-pass ke agent supaya staging preview (pending_parse) ter-scope per pengirim
  const hasil = await agent.jalankanAgent({ historiChat, pesanBaru: text, jid });

  simpanChatHistory(jid, 'user', text);

  if (hasil.error) {
    console.error('❌ Agent error:', hasil.error);
    await kirimPesan(jid, hasil.jawabanFinal || 'Ada kendala teknis, boleh diulang?');
    return;
  }

  if (hasil.jawabanFinal) {
    await kirimPesan(jid, hasil.jawabanFinal);
    simpanChatHistory(jid, 'assistant', hasil.jawabanFinal);
  }

  // Kirim semua file yang digenerate (DO/Invoice/PO) sebagai attachment
  for (const filePath of hasil.files) {
    try {
      await tunggu(500); // jeda dikit biar urutan pesan rapi
      await kirimFile(jid, filePath);
    } catch (err) {
      console.error('❌ Gagal kirim file:', filePath, err.message);
      await kirimPesan(jid, `Dokumen berhasil dibuat tapi gagal dikirim: ${err.message}`);
    }
  }
}

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection (bot tetap jalan):', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception (bot tetap jalan):', err.message);
});

startBot();