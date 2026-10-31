const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: 30 * 1000,
  maxRetries: 2,
});

const MODEL = process.env.AI_MODEL;

async function callAiJson(systemPromptJson, userPrompt, maxTokens = 300) {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPromptJson },
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

/**
 * Extract nominal (angka Rupiah) dan peruntukan dari caption foto kwitansi.
 * Return: { nominal: number|null, peruntukan: string|null }
 */
async function ekstrakNominalPeruntukan(caption) {
  if (!caption || !caption.trim()) {
    return { nominal: null, peruntukan: null };
  }

  const systemJson = `Kamu parser caption kwitansi. Jawab HANYA JSON valid, tanpa markdown fence.`;
  const userPrompt = `Caption dari foto kwitansi: "${caption}"

Extract nominal (angka Rupiah murni, convert dari "50rb"/"lima puluh ribu"/dll ke integer) dan peruntukan (keterangan singkat buat apa, dirapikan).

Kalau nominal TIDAK disebutkan jelas, atau peruntukan TIDAK jelas, kasih null untuk field itu.

Balas JSON: {"nominal": angka atau null, "peruntukan": "..." atau null}`;

  const hasil = await callAiJson(systemJson, userPrompt, 150);
  if (!hasil) return { nominal: null, peruntukan: null };
  return hasil;
}

module.exports = {
  callAiJson,
  ekstrakNominalPeruntukan,
};