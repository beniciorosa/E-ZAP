// ===== DHIEGO.AI — Audio transcription via OpenAI Whisper =====
// The assistant can now receive WhatsApp voice messages. Baileys downloads
// the audio blob; this helper ships it to OpenAI's /v1/audio/transcriptions
// endpoint and returns the text. The key lives in app_settings.openai_api_key
// (already used by other parts of the app).

const { loadConfig } = require("./config");

// Transcribe an audio buffer. Returns the recognized text (trimmed).
// Throws on API failure so the caller can surface an error to the user.
async function transcribeAudio(buffer, mimetype = "audio/ogg") {
  const cfg = await loadConfig();
  const key = cfg.openaiApiKey;
  if (!key) {
    throw new Error("openai_api_key não configurada em app_settings");
  }
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Áudio vazio ou inválido");
  }

  // Guess a file extension from the mimetype so OpenAI picks the right codec.
  // WhatsApp voice notes are typically audio/ogg (Opus).
  const ext = mimetype.includes("mp3") ? "mp3"
    : mimetype.includes("wav") ? "wav"
    : mimetype.includes("m4a") ? "m4a"
    : mimetype.includes("mp4") ? "m4a"
    : "ogg";

  const form = new FormData();
  const blob = new Blob([buffer], { type: mimetype });
  form.append("file", blob, "audio." + ext);
  form.append("model", "whisper-1");
  form.append("language", "pt");
  form.append("response_format", "json");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key },
    body: form,
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error("Whisper " + resp.status + ": " + err.slice(0, 200));
  }
  const json = await resp.json();
  return (json && json.text ? String(json.text) : "").trim();
}

module.exports = { transcribeAudio };
