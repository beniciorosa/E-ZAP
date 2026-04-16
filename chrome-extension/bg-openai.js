// bg-openai.js — Audio transcription (Whisper), auto-transcribe, GEIA AI chat completion

// ===== Audio Transcription via OpenAI Whisper =====
async function transcribeAudio(base64, contentType) {
  try {
    // Validate content type — Whisper only accepts audio formats
    const VALID_AUDIO = ["audio/", "video/mp4", "video/webm", "application/ogg"];
    const ct = (contentType || "").toLowerCase();
    const isValidAudio = ct === "" || VALID_AUDIO.some(function(v) { return ct.indexOf(v) >= 0; });
    if (!isValidAudio) {
      console.warn("[EZAP BG] Skipping non-audio content type:", ct);
      return { error: "Formato invalido: " + ct };
    }

    // Convert base64 to binary
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Determine file extension from content type
    let ext = "ogg";
    if (ct.includes("mp4")) ext = "mp4";
    else if (ct.includes("webm")) ext = "webm";
    else if (ct.includes("mpeg") || ct.includes("mp3")) ext = "mp3";
    else if (ct.includes("wav")) ext = "wav";
    else if (ct.includes("m4a")) ext = "m4a";
    else if (ct.includes("flac")) ext = "flac";

    // Detect actual format from magic bytes if content type is generic
    if (ext === "ogg" && bytes.length > 4) {
      // OGG: "OggS" | WebM/MKV: 0x1A45DFA3 | MP4/M4A: "ftyp" at offset 4
      if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) ext = "webm";
      else if (bytes.length > 8 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === "ftyp") ext = "mp4";
      else if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) ext = "mp3";
      else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) ext = "wav";
    }

    const audioType = ext === "ogg" ? "audio/ogg" : (ext === "mp4" ? "audio/mp4" : "audio/" + ext);
    const blob = new Blob([bytes], { type: audioType });
    const file = new File([blob], "audio." + ext, { type: audioType });

    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-1");
    formData.append("language", "pt");

    // Transcribing audio

    const apiKey = await getOpenAIKey();
    if (!apiKey) throw new Error("OpenAI API key não configurada");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey },
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[EZAP BG] Whisper API error:", resp.status, errText);
      throw new Error("Whisper API " + resp.status);
    }

    const data = await resp.json();
    // Transcription complete
    return { text: data.text || "" };
  } catch (err) {
    console.error("[EZAP BG] Transcription error:", err);
    return { error: err.message || "Erro desconhecido" };
  }
}

// ===== Auto-Transcribe: Transcribe audio + save to Supabase =====
async function transcribeAndSave(base64, contentType, messageWid, userId) {
  try {
    if (!base64) throw new Error("No audio data");
    if (!messageWid) throw new Error("No message WID");

    // Step 1: Transcribe via Whisper
    const result = await transcribeAudio(base64, contentType);
    if (result.error) {
      // Mark as error in Supabase
      try {
        await supabaseRest(
          "/rest/v1/message_events?message_wid=eq." + encodeURIComponent(messageWid)
            + (userId ? "&user_id=eq." + encodeURIComponent(userId) : ""),
          "PATCH",
          { transcription_status: "error" },
          "return=minimal"
        );
      } catch(e) {}
      return result;
    }

    // Step 2: Save transcription to Supabase
    const text = (result.text || "").trim();
    if (!text) {
      await supabaseRest(
        "/rest/v1/message_events?message_wid=eq." + encodeURIComponent(messageWid)
          + (userId ? "&user_id=eq." + encodeURIComponent(userId) : ""),
        "PATCH",
        { transcription_status: "error" },
        "return=minimal"
      );
      return { error: "Empty transcription" };
    }

    await supabaseRest(
      "/rest/v1/message_events?message_wid=eq." + encodeURIComponent(messageWid)
        + (userId ? "&user_id=eq." + encodeURIComponent(userId) : ""),
      "PATCH",
      { transcript: text, transcription_status: "done" },
      "return=minimal"
    );

    // Auto-transcribe saved
    return { text: text, saved: true };
  } catch (err) {
    console.error("[EZAP BG] transcribeAndSave error:", err);
    return { error: err.message || "Unknown error" };
  }
}

// ===== GEIA - AI Functions =====
async function geiaGetConfig() {
  try {
    const headers = {
      "apikey": AUTH_SERVICE_KEY,
      "Authorization": "Bearer " + AUTH_SERVICE_KEY,
      "Content-Type": "application/json",
    };
    // Fetch personality + knowledge in parallel
    const [persResp, knResp] = await Promise.all([
      fetch(AUTH_SUPA_URL + "/rest/v1/app_settings?key=eq.geia_personality&select=value", { headers }),
      fetch(AUTH_SUPA_URL + "/rest/v1/geia_knowledge?active=eq.true&select=title,type,content,url&order=created_at.asc", { headers }),
    ]);
    const persRows = await persResp.json();
    const knowledge = await knResp.json();
    return {
      personality: (Array.isArray(persRows) && persRows.length > 0) ? persRows[0].value : "",
      knowledge: Array.isArray(knowledge) ? knowledge : [],
    };
  } catch (err) {
    console.error("[EZAP BG] GEIA config error:", err);
    return { personality: "", knowledge: [] };
  }
}

async function geiaChatCompletion(messages, maxTokens) {
  try {
    const apiKey = await getOpenAIKey();
    if (!apiKey) throw new Error("OpenAI API key não configurada");

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: messages,
        max_tokens: maxTokens || 1000,
        temperature: 0.7,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[EZAP BG] GEIA API error:", resp.status, errText);
      throw new Error("OpenAI API " + resp.status);
    }

    const data = await resp.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { text: text || "" };
  } catch (err) {
    console.error("[EZAP BG] GEIA error:", err);
    return { error: err.message || "Erro desconhecido" };
  }
}
