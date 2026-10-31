function formatWaktu(date = new Date()) {
  return date.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(/\./g, ':');
}

module.exports = { formatWaktu };