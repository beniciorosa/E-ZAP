// bg-google.js — Google OAuth, Drive search, Docs read, Meet summary processing

// ===== Google OAuth + Drive/Docs API =====
async function getGoogleAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: interactive !== false }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve({ token: token });
      }
    });
  });
}

async function googleDriveSearch(query, mimeType) {
  const { token } = await getGoogleAuthToken(false);
  let q = query;
  if (mimeType) q += " and mimeType='" + mimeType + "'";
  const url = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
    "&orderBy=modifiedTime desc&pageSize=10&fields=files(id,name,mimeType,createdTime,modifiedTime,webViewLink)";
  const resp = await fetch(url, {
    headers: { "Authorization": "Bearer " + token }
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Drive API error: " + err);
  }
  return resp.json();
}

async function googleDocsRead(documentId) {
  const { token } = await getGoogleAuthToken(false);
  const url = "https://docs.googleapis.com/v1/documents/" + documentId;
  const resp = await fetch(url, {
    headers: { "Authorization": "Bearer " + token }
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Docs API error: " + err);
  }
  const doc = await resp.json();
  // Extract plain text from doc body
  let text = "";
  if (doc.body && doc.body.content) {
    doc.body.content.forEach((block) => {
      if (block.paragraph && block.paragraph.elements) {
        block.paragraph.elements.forEach((el) => {
          if (el.textRun && el.textRun.content) text += el.textRun.content;
        });
      }
    });
  }
  return { documentId: doc.documentId, title: doc.title, text: text };
}

async function fetchMeetSummary(meetingTitle, meetRecordingId) {
  // Step 1: Search for the Gemini summary doc in Drive
  const searchQuery = "name contains '" + meetingTitle.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.document'";
  const results = await googleDriveSearch(searchQuery);

  if (!results.files || results.files.length === 0) {
    return { found: false, error: "Documento de resumo não encontrado no Drive para: " + meetingTitle };
  }

  // Step 2: Read the doc content
  const docId = results.files[0].id;
  const docData = await googleDocsRead(docId);

  // Step 3: Save raw summary to meet_recordings
  if (meetRecordingId) {
    await supabaseRest("/rest/v1/meet_recordings?id=eq." + meetRecordingId, "PATCH", {
      gemini_summary: docData.text,
      summary_doc_id: docId,
      summary_doc_url: results.files[0].webViewLink || ""
    });
  }

  return {
    found: true,
    docId: docId,
    title: docData.title,
    text: docData.text,
    webViewLink: results.files[0].webViewLink
  };
}

// ===== Process Meet Summary: AI rewrite + Supabase + HubSpot =====
async function processMeetSummary(meetRecordingId, meetingTitle, geminiText) {
  const log = (msg) => console.log("[EZAP MEET-SUMMARY] " + msg);
  const result = { steps: {} };

  try {
    // Step 1: Rewrite summary with AI (sales/consultoria language)
    log("Step 1: Rewriting summary with AI...");
    const apiKey = await getOpenAIKey();
    if (!apiKey) throw new Error("OpenAI API key não configurada");

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Você é um assistente especializado em consultoria de vendas online e e-commerce. " +
              "Reescreva o resumo da reunião abaixo em formato profissional de relatório de consultoria. " +
              "Use linguagem objetiva e estruturada. Inclua as seguintes seções:\n\n" +
              "📋 **RESUMO DA REUNIÃO**\nResumo executivo em 2-3 frases.\n\n" +
              "🎯 **PONTOS PRINCIPAIS**\nListe os tópicos discutidos como bullet points.\n\n" +
              "⚠️ **OBJEÇÕES / DIFICULDADES DO CLIENTE**\nProblemas, frustrações ou obstáculos mencionados.\n\n" +
              "✅ **DECISÕES TOMADAS**\nO que foi decidido durante a reunião.\n\n" +
              "📌 **PRÓXIMOS PASSOS**\nAções concretas com responsáveis, se mencionados.\n\n" +
              "Mantenha o texto conciso e acionável. Não invente informações que não estejam no resumo original."
          },
          {
            role: "user",
            content: "Título da reunião: " + meetingTitle + "\n\nResumo do Gemini:\n" + geminiText
          }
        ],
        max_tokens: 2000,
        temperature: 0.5,
      }),
    });

    if (!aiResp.ok) throw new Error("OpenAI API error: " + aiResp.status);
    const aiData = await aiResp.json();
    const salesSummary = aiData.choices[0].message.content;
    result.steps.ai = "ok";
    result.salesSummary = salesSummary;
    log("AI summary generated (" + salesSummary.length + " chars)");

    // Step 2: Save to Supabase
    log("Step 2: Saving to Supabase...");
    if (meetRecordingId) {
      await supabaseRest("/rest/v1/meet_recordings?id=eq." + meetRecordingId, "PATCH", {
        gemini_summary: geminiText,
        sales_summary: salesSummary
      });
      result.steps.supabase = "ok";
      log("Saved to Supabase");
    }

    // Step 3: Extract ticket ID from meeting title [12345678] and create note
    var ticketIdMatch = meetingTitle.match(/\[(\d+)\]/);
    if (!ticketIdMatch) {
      result.steps.hubspot = "skipped - no ticket ID in title";
      log("No ticket ID found in title, skipping HubSpot");
      result.ok = true;
      return result;
    }

    var ticketId = ticketIdMatch[1];
    log("Step 3: Found ticket ID in title: " + ticketId);

    // Verify ticket exists
    var ticket = null;
    try {
      ticket = await hubFetch("/crm/v3/objects/tickets/" + ticketId + "?properties=subject");
    } catch (e) {
      log("Ticket " + ticketId + " not found in HubSpot: " + e.message);
      result.steps.hubspot = "skipped - ticket not found: " + ticketId;
      result.ok = true;
      return result;
    }

    if (ticket && ticket.id) {
      log("Found ticket: " + (ticket.properties.subject || ticketId));

      // Step 4: Create note on ticket
      log("Step 4: Creating note on HubSpot ticket...");
      var noteBody = "<h3>📝 Resumo da Reunião — E-ZAP</h3>" +
        "<p><strong>Reunião:</strong> " + meetingTitle + "</p>" +
        "<hr>" + salesSummary.replace(/\n/g, "<br>");

      var noteResult = await createHubSpotNote(ticketId, noteBody);
      if (noteResult.ok) {
        result.steps.hubspot = "ok";
        result.hubspotNoteId = noteResult.noteId;
        result.hubspotTicketId = ticketId;
        result.hubspotTicketName = (ticket.properties && ticket.properties.subject) || ticketId;
        log("Note created on ticket (noteId: " + noteResult.noteId + ")");

        // Save HubSpot note ID to Supabase
        if (meetRecordingId) {
          await supabaseRest("/rest/v1/meet_recordings?id=eq." + meetRecordingId, "PATCH", {
            hubspot_note_id: noteResult.noteId
          });
        }
      } else {
        result.steps.hubspot = "error: " + noteResult.error;
        log("Failed to create note: " + noteResult.error);
      }
    } else {
      result.steps.hubspot = "skipped - no ticket found";
      log("No matching ticket found in HubSpot, skipping note creation");
    }

    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    log("ERROR: " + e.message);
  }

  return result;
}
