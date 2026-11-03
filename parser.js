require('dotenv').config();
const OpenAI = require('openai');
const { db } = require('./db');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: 30 * 1000,
  maxRetries: 2,
});

const MODEL = process.env.AI_MODEL;

async function callAiJson(systemPrompt, userPrompt, maxTokens = 800) {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
    });
    const result = completion.choices[0]?.message?.content?.trim();
    if (!result) return null;
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('❌ AI JSON parse error:', err.message);
    return null;
  }
}

// ========== PARSE PESANAN SSB/KLIEN ==========

const SYSTEM_PARSE_PESANAN = `Kamu parser pesanan barang dari teks WhatsApp. Jawab HANYA JSON valid, tanpa markdown fence.

Format teks biasanya ada "Tanggal Pesanan" dan "Outlet", lalu daftar barang dengan qty dan satuan (kg/gr/ikat/dll).

Qty yang ditulis sebagai "-", "_", "0", atau kosong berarti TIDAK dipesan — JANGAN masukkan item itu ke hasil.

Normalisasi qty desimal: "2,5" jadi 2.5 (pakai titik, bukan koma).

Balas JSON dengan struktur:
{
  "outlet": "nama outlet persis seperti ditulis",
  "tanggal_pesanan": "YYYY-MM-DD",
  "items": [
    {"nama_barang": "nama persis seperti ditulis (jangan diedit/normalisasi di sini)", "qty": angka, "uom": "satuan seperti ditulis"}
  ]
}

Kalau outlet atau tanggal tidak ketemu di teks, isi null untuk field itu.`;

async function parsePesananKlien(teks) {
  const hasil = await callAiJson(SYSTEM_PARSE_PESANAN, `Teks pesanan:\n"""${teks}"""`);
  if (!hasil || !hasil.items) return null;
  return hasil;
}

// ========== PARSE TAGIHAN SUPPLIER ==========

const SYSTEM_PARSE_TAGIHAN = `Kamu parser tagihan dari supplier. Jawab HANYA JSON valid, tanpa markdown fence.

Extract nama supplier (kalau disebut), nominal tagihan (angka Rupiah murni, convert dari "1jt"/"500rb"/dll ke integer), tanggal (kalau disebut, format YYYY-MM-DD, kalau tidak ada isi null), dan keterangan singkat.

Balas JSON:
{
  "supplier": "nama supplier atau null",
  "nominal": angka atau null,
  "tanggal": "YYYY-MM-DD atau null",
  "keterangan": "ringkasan singkat isi tagihan"
}`;

async function parseTagihanSupplier(teks) {
  const hasil = await callAiJson(SYSTEM_PARSE_TAGIHAN, `Teks tagihan:\n"""${teks}"""`, 300);
  return hasil;
}

// ========== NORMALISASI NAMA BARANG ==========

function normalisasiNamaBarang(namaMentah) {
  const namaLower = namaMentah.trim().toLowerCase();

  // 1. exact match ke nama resmi
  const semuaBarang = db.prepare('SELECT * FROM barang').all();
  for (const b of semuaBarang) {
    if (b.nama.toLowerCase() === namaLower) return b;
  }

  // 2. match ke alias (JSON array per barang)
  for (const b of semuaBarang) {
    if (!b.alias) continue;
    try {
      const aliasList = JSON.parse(b.alias);
      if (aliasList.some((a) => a.toLowerCase() === namaLower)) return b;
    } catch {
      // alias corrupt, skip
    }
  }

  // 3. tidak ketemu -> null, biar caller putuskan (buat baru / tanya owner)
  return null;
}

function buatBarangBaru(nama, satuan) {
  const id = db.prepare('INSERT INTO barang (nama, satuan_default) VALUES (?, ?)').run(nama, satuan).lastInsertRowid;
  return db.prepare('SELECT * FROM barang WHERE id = ?').get(id);
}

function tambahAlias(barangId, aliasBaru) {
  const barang = db.prepare('SELECT * FROM barang WHERE id = ?').get(barangId);
  let aliasList = [];
  if (barang.alias) {
    try { aliasList = JSON.parse(barang.alias); } catch { aliasList = []; }
  }
  if (!aliasList.includes(aliasBaru)) {
    aliasList.push(aliasBaru);
    db.prepare('UPDATE barang SET alias = ? WHERE id = ?').run(JSON.stringify(aliasList), barangId);
  }
}

module.exports = {
  callAiJson,
  parsePesananKlien,
  parseTagihanSupplier,
  normalisasiNamaBarang,
  buatBarangBaru,
  tambahAlias,
};