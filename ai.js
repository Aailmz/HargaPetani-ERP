const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: 30 * 1000,
  maxRetries: 2,
});

const MODEL = process.env.AI_MODEL;

async function callAiJson(systemPromptJson, userPrompt, maxTokens = 500) {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPromptJson },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
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

/**
 * Parse balasan operator soal approve/reject reimburse.
 * Return: { reimburse_id, aksi: 'APPROVE'|'REJECT'|'TIDAK_JELAS', alasan }
 */
async function parseKeputusanReimburse(pesanOperator, daftarPending) {
  const daftarText = daftarPending
    .map((r) => `#${r.id}: "${r.teks_asli}" (dari ${r.employee_jid.split('@')[0]})`)
    .join('\n');

  const systemJson = `Kamu parser keputusan approve/reject reimburse karyawan. Jawab HANYA JSON valid, tanpa markdown fence.`;

  const userPrompt = `Operator membalas: "${pesanOperator}"

Daftar reimburse yang masih PENDING:
${daftarText}

Tentukan:
- Reimburse mana yang dimaksud (by nomor #id yang disebut, atau kalau tidak sebut nomor tapi jelas dari konteks/isi/nama orang yang disebut, cocokkan ke situ).
- Apakah keputusannya APPROVE atau REJECT (kata kunci approve: "oke", "approve", "acc", "sip", "fix", "bayar". Kata kunci reject: "tolak", "reject", "nggak bisa", "ga jelas", dll).
- Kalau operator kasih alasan (terutama buat reject), catat di "alasan".
- Kalau reimburse mana yang dimaksud TIDAK jelas, atau keputusannya (approve/reject) TIDAK jelas dari pesan operator, set aksi = "TIDAK_JELAS".

Kalau cuma ada 1 reimburse di daftar PENDING dan operator tidak sebut nomor spesifik tapi jelas merespons soal reimburse (misal cuma bilang "oke" atau "approve"), anggap itu merujuk ke reimburse satu-satunya itu.

Balas JSON: {"reimburse_id": angka atau null, "aksi": "APPROVE"|"REJECT"|"TIDAK_JELAS", "alasan": "..." atau null}`;

  const hasil = await callAiJson(systemJson, userPrompt, 200);
  if (!hasil) return { reimburse_id: null, aksi: 'TIDAK_JELAS', alasan: null };
  return hasil;
}

module.exports = {
  callAiJson,
  parseKeputusanReimburse,
};