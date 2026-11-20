const ZONA = 'Asia/Jakarta';

function formatWaktu(date = new Date()) {
  return date.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: ZONA,
  }).replace(/\./g, ':');
}

/** created_at dari SQLite (CURRENT_TIMESTAMP, UTC, format "YYYY-MM-DD HH:MM:SS") -> waktu lokal terformat. */
function formatWaktuDb(str) {
  if (!str) return '';
  const d = new Date(String(str).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? String(str) : formatWaktu(d);
}

function potong(teks, maks) {
  const s = String(teks ?? '');
  return s.length > maks ? s.slice(0, maks - 1) + '…' : s;
}

/** Ambil bagian nomor dari jid ("62812xxx:5@s.whatsapp.net" -> "62812xxx"). */
function nomorDariJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

module.exports = { formatWaktu, formatWaktuDb, potong, nomorDariJid };
