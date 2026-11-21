require('dotenv').config();

// Satu-satunya tempat klien Claude dibuat. Dipakai agent.js (percakapan + tool) dan media.js (baca gambar).
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;

// Kunci dibaca dari ANTHROPIC_API_KEY. Variabel AI_* lama (OpenAI) sengaja tidak dipakai lagi
// supaya nilai lama di .env tidak ikut terkirim ke Claude.
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';

// Opsional: low | medium | high | xhigh | max. Kosong = bawaan model (Haiku 5.5: medium).
const EFFORT = process.env.CLAUDE_EFFORT || null;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('⚠️  ANTHROPIC_API_KEY belum diisi di .env, panggilan ke Claude akan gagal.');
}

const client = new Anthropic({ timeout: 60 * 1000, maxRetries: 2 });

module.exports = { client, MODEL, EFFORT };
