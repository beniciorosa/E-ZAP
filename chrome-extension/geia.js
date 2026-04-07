// ===== GEIA - Grupo Escalada I.A. =====
// Sidebar with AI features: conversation summary + reply suggestions
console.log("[GEIA] Module loaded");

var geiaSidebarOpen = false;
var geiaConfig = null; // { personality, knowledge }
var geiaConfigLoaded = false;

// ===== Helpers =====
function geiaSupaRest(path, method, body) {
  // Delegates to shared api.js helper (eliminates duplicate wrapper)
  return window.ezapSupaRest ? window.ezapSupaRest(path, method, body) : Promise.resolve(null);
}

function geiaChat(messages, maxTokens) {
  return new Promise(function(resolve) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) { resolve({ error: "Extension context lost" }); return; }
      chrome.runtime.sendMessage({
        action: "geia_chat", messages: messages, maxTokens: maxTokens || 1000
      }, function(resp) {
        if (chrome.runtime.lastError) { resolve({ error: "Sem resposta" }); return; }
        resolve(resp || { error: "Sem resposta" });
      });
    } catch (e) { resolve({ error: e.message }); }
  });
}

function geiaLoadConfig() {
  return new Promise(function(resolve) {
    if (geiaConfigLoaded && geiaConfig) { resolve(geiaConfig); return; }
    try {
      chrome.runtime.sendMessage({ action: "geia_get_config" }, function(resp) {
        if (chrome.runtime.lastError) { resolve({ personality: "", knowledge: [] }); return; }
        geiaConfig = resp || { personality: "", knowledge: [] };
        geiaConfigLoaded = true;
        resolve(geiaConfig);
      });
    } catch(e) { resolve({ personality: "", knowledge: [] }); }
  });
}

// ===== Build system prompt from config =====
function buildSystemPrompt(config) {
  var parts = [];

  if (config.personality && config.personality.trim()) {
    parts.push(config.personality.trim());
  }

  if (config.knowledge && config.knowledge.length > 0) {
    parts.push("\n--- BASE DE CONHECIMENTO ---");
    config.knowledge.forEach(function(k) {
      var entry = "\n[" + (k.title || "Sem titulo") + "]";
      if (k.url) entry += "\nLink: " + k.url;
      if (k.content) entry += "\n" + k.content;
      parts.push(entry);
    });
  }

  return parts.join("\n") || "Voce e um assistente util para conversas de WhatsApp Business.";
}

// ===== Extract messages from WhatsApp DOM =====
function extractConversationMessages(maxMessages) {
  maxMessages = maxMessages || 50;
  var messages = [];
  var rows = document.querySelectorAll('div[role="row"]');

  rows.forEach(function(row) {
    if (messages.length >= maxMessages) return;

    // Check if message is incoming or outgoing
    var isOut = !!row.querySelector('[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-time"]');
    var textEl = row.querySelector('[class*="copyable-text"]');
    if (!textEl) return;

    var dataAttr = textEl.getAttribute("data-pre-plain-text");
    var timestamp = "";
    var sender = "";
    if (dataAttr) {
      // Format: [HH:MM, DD/MM/YYYY] Name:
      var match = dataAttr.match(/\[([^\]]+)\]\s*(.+?):\s*$/);
      if (match) {
        timestamp = match[1];
        sender = match[2];
      }
    }

    // Get the visible text content
    var spans = textEl.querySelectorAll("span[dir]");
    var text = "";
    spans.forEach(function(s) {
      var t = s.textContent || "";
      if (t.trim()) text += (text ? " " : "") + t.trim();
    });

    if (!text.trim()) return;

    messages.push({
      role: isOut ? "sent" : "received",
      sender: sender || (isOut ? "Eu" : "Contato"),
      text: text.trim(),
      time: timestamp,
    });
  });

  return messages;
}

// ===== Get current contact name =====
function getContactName() {
  // Prefer currentName from content.js (has proper chat/group name)
  if (typeof currentName !== 'undefined' && currentName) return currentName;
  var header = document.querySelector('header span[title]');
  return header ? header.getAttribute("title") : "Contato";
}

// ===== Write text to WhatsApp input box =====
function writeToInputBox(text) {
  var inputBox = document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
                 document.querySelector('footer div[contenteditable="true"]') ||
                 document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!inputBox) {
    console.warn("[GEIA] Input box not found");
    return false;
  }

  inputBox.focus();
  // Clear existing content
  inputBox.textContent = "";

  // Use InputEvent to trigger WhatsApp's internal handlers
  var dt = new DataTransfer();
  dt.setData("text/plain", text);
  var pasteEvent = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });
  inputBox.dispatchEvent(pasteEvent);

  return true;
}

// ===== Create GEIA button =====
function createGeiaButton() {
  if (document.getElementById("geia-toggle")) return;
  var btn = document.createElement("button");
  btn.id = "geia-toggle";
  btn.title = "GEIA - Inteligencia Artificial";
  btn.addEventListener("click", toggleGeiaSidebar);
  Object.assign(btn.style, {
    width: "50px",
    height: "50px",
    borderRadius: "50%",
    border: "none",
    fontWeight: "bold",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "geia");
  else { btn.textContent = "GEIA"; btn.style.background = "#cc5de8"; btn.style.color = "#fff"; btn.style.fontSize = "10px"; }
  var container = document.getElementById("ezap-float-container");
  if (container) container.appendChild(btn);
  else document.body.appendChild(btn);
}

// ===== Toggle GEIA Sidebar =====
function toggleGeiaSidebar() {
  var sidebar = document.getElementById("geia-sidebar");
  if (!sidebar) {
    createGeiaSidebar();
    sidebar = document.getElementById("geia-sidebar");
  }
  if (window.ezapSidebar) { ezapSidebar.toggle('geia'); return; }
  // Fallback
  geiaSidebarOpen = !geiaSidebarOpen;
  var floatContainer = document.getElementById("ezap-float-container");
  if (geiaSidebarOpen) {
    sidebar.classList.add("open");
    if (floatContainer) floatContainer.style.display = "none";
    updateGeiaContent();
  } else {
    sidebar.classList.remove("open");
    if (floatContainer) floatContainer.style.display = "flex";
  }
}

// ===== Create GEIA Sidebar =====
function createGeiaSidebar() {
  if (document.getElementById("geia-sidebar")) return;

  var sidebar = document.createElement("div");
  sidebar.id = "geia-sidebar";
  Object.assign(sidebar.style, {
    position: "fixed",
    top: "0",
    right: "0",
    width: "320px",
    height: "100vh",
    background: "#111b21",
    borderLeft: "1px solid #2a3942",
    zIndex: "100000",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    color: "#e9edef",
    fontSize: "13px",
    overflow: "hidden",
  });

  // Build header
  var header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 16px", background: "#202c33", borderBottom: "1px solid #2a3942", minHeight: "48px",
  });
  header.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px">' +
      '<div style="width:32px;height:32px;border-radius:50%;background:#cc5de8;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff">G</div>' +
      '<h3 style="margin:0;font-size:15px;font-weight:600;color:#e9edef">GEIA</h3>' +
    '</div>';
  var closeBtn = document.createElement("button");
  Object.assign(closeBtn.style, { background: "none", border: "none", color: "#8696a0", fontSize: "20px", cursor: "pointer", padding: "4px 8px", borderRadius: "4px" });
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", toggleGeiaSidebar);
  header.appendChild(closeBtn);
  sidebar.appendChild(header);

  var contentDiv = document.createElement("div");
  contentDiv.id = "geia-content";
  Object.assign(contentDiv.style, { flex: "1", overflowY: "auto", padding: "16px" });
  sidebar.appendChild(contentDiv);

  document.body.appendChild(sidebar);

  // Register with sidebar manager (overlay mode — doesn't shrink app or close others)
  if (window.ezapSidebar) {
    window.ezapSidebar.register('geia', {
      show: function() {
        geiaSidebarOpen = true;
        var sb = document.getElementById("geia-sidebar");
        if (sb) sb.classList.add("open");
      },
      hide: function() {
        geiaSidebarOpen = false;
        var sb = document.getElementById("geia-sidebar");
        if (sb) sb.classList.remove("open");
      },
      onOpen: function() { updateGeiaContent(); },
      shrinkApp: false,
      closesOthers: false,
    });
  }
}

// ===== Update sidebar content =====
function updateGeiaContent() {
  var content = document.getElementById("geia-content");
  if (!content) return;

  var contactName = getContactName();
  var hasResumo = window.__ezapHasFeature && window.__ezapHasFeature("geia_resumo");
  var hasSugestao = window.__ezapHasFeature && window.__ezapHasFeature("geia_sugestao");

  // Clear and rebuild with DOM elements
  content.innerHTML = '';

  // Contact name section
  var contactSection = document.createElement("div");
  contactSection.style.marginBottom = "16px";
  contactSection.innerHTML =
    '<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin-bottom:8px;font-weight:600">Conversa atual</div>' +
    '<div style="font-size:15px;font-weight:600;color:#e9edef">' + escGeia(contactName) + '</div>';
  content.appendChild(contactSection);

  if (hasResumo) {
    var resumoDiv = document.createElement("div");
    resumoDiv.style.marginBottom = "16px";
    var resumoBtn = document.createElement("button");
    resumoBtn.id = "geia-btn-resumo";
    Object.assign(resumoBtn.style, { width: "100%", padding: "12px", background: "#202c33", border: "1px solid #2a3942", borderRadius: "8px", color: "#e9edef", fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "10px", textAlign: "left" });
    resumoBtn.innerHTML = '<span style="font-size:18px">&#128203;</span><div><div style="font-weight:600">Resumo da Conversa</div><div style="font-size:11px;color:#8696a0;margin-top:2px">Gera um resumo inteligente das mensagens</div></div>';
    resumoBtn.addEventListener("click", geiaGenerateSummary);
    resumoDiv.appendChild(resumoBtn);
    var resumoResult = document.createElement("div");
    resumoResult.id = "geia-resumo-result";
    resumoResult.style.marginTop = "10px";
    resumoDiv.appendChild(resumoResult);
    content.appendChild(resumoDiv);
  }

  if (hasSugestao) {
    var sugestaoDiv = document.createElement("div");
    sugestaoDiv.style.marginBottom = "16px";
    var sugestaoBtn = document.createElement("button");
    sugestaoBtn.id = "geia-btn-sugestao";
    Object.assign(sugestaoBtn.style, { width: "100%", padding: "12px", background: "#202c33", border: "1px solid #2a3942", borderRadius: "8px", color: "#e9edef", fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "10px", textAlign: "left" });
    sugestaoBtn.innerHTML = '<span style="font-size:18px">&#128172;</span><div><div style="font-weight:600">Sugestão de Resposta</div><div style="font-size:11px;color:#8696a0;margin-top:2px">Sugere uma resposta baseada no contexto</div></div>';
    sugestaoBtn.addEventListener("click", geiaSuggestReply);
    sugestaoDiv.appendChild(sugestaoBtn);
    var sugestaoResult = document.createElement("div");
    sugestaoResult.id = "geia-sugestao-result";
    sugestaoResult.style.marginTop = "10px";
    sugestaoDiv.appendChild(sugestaoResult);
    content.appendChild(sugestaoDiv);
  }

  if (!hasResumo && !hasSugestao) {
    content.innerHTML = '<div style="text-align:center;padding:30px;color:#8696a0;font-style:italic">Nenhuma funcao GEIA habilitada para seu perfil.</div>';
  }
}

// ===== Generate Summary =====
async function geiaGenerateSummary() {
  var resultEl = document.getElementById("geia-resumo-result");
  var btnEl = document.getElementById("geia-btn-resumo");
  if (!resultEl) return;

  resultEl.innerHTML = '<div style="text-align:center;padding:12px;color:#8696a0"><span class="ezap-tr-spin" style="display:inline-block;margin-right:8px"></span>Gerando resumo...</div>';
  if (btnEl) btnEl.style.pointerEvents = "none";

  var config = await geiaLoadConfig();
  var messages = extractConversationMessages(60);

  if (messages.length === 0) {
    resultEl.innerHTML = '<div style="padding:10px;color:#ff6b6b;font-size:12px">Nenhuma mensagem encontrada nesta conversa.</div>';
    if (btnEl) btnEl.style.pointerEvents = "";
    return;
  }

  var contactName = getContactName();
  var conversationText = messages.map(function(m) {
    return "[" + m.time + "] " + m.sender + ": " + m.text;
  }).join("\n");

  var systemPrompt = buildSystemPrompt(config);
  var chatMessages = [
    { role: "system", content: systemPrompt + "\n\nVoce deve gerar um resumo conciso e util da conversa de WhatsApp abaixo. Destaque os pontos principais, decisoes tomadas, pendencias e proximos passos. Responda em portugues." },
    { role: "user", content: "Conversa com " + contactName + ":\n\n" + conversationText + "\n\nGere um resumo desta conversa." },
  ];

  var resp = await geiaChat(chatMessages, 800);

  if (resp.error) {
    resultEl.innerHTML = '<div style="padding:10px;background:#1a2730;border-radius:8px;color:#ff6b6b;font-size:12px">' + escGeia(resp.error) + '</div>';
  } else {
    renderResultBox(resultEl, "Resumo", "#cc5de8", resp.text, { showCopy: true });
  }
  if (btnEl) btnEl.style.pointerEvents = "";
}

// ===== Suggest Reply (from sidebar) =====
async function geiaSuggestReply() {
  var resultEl = document.getElementById("geia-sugestao-result");
  var btnEl = document.getElementById("geia-btn-sugestao");
  if (!resultEl) return;

  resultEl.innerHTML = '<div style="text-align:center;padding:12px;color:#8696a0"><span class="ezap-tr-spin" style="display:inline-block;margin-right:8px"></span>Gerando sugestao...</div>';
  if (btnEl) btnEl.style.pointerEvents = "none";

  var config = await geiaLoadConfig();
  var messages = extractConversationMessages(30);

  if (messages.length === 0) {
    resultEl.innerHTML = '<div style="padding:10px;color:#ff6b6b;font-size:12px">Nenhuma mensagem encontrada.</div>';
    if (btnEl) btnEl.style.pointerEvents = "";
    return;
  }

  var contactName = getContactName();
  var conversationText = messages.map(function(m) {
    return "[" + m.time + "] " + m.sender + ": " + m.text;
  }).join("\n");

  var systemPrompt = buildSystemPrompt(config);
  var chatMessages = [
    { role: "system", content: systemPrompt + "\n\nVoce deve sugerir uma resposta adequada para a conversa de WhatsApp abaixo. A resposta deve ser natural, no tom da conversa, e pronta para enviar. NAO use saudacao se a conversa ja esta em andamento. Responda APENAS com o texto da mensagem sugerida, sem explicacoes. Responda em portugues." },
    { role: "user", content: "Conversa com " + contactName + ":\n\n" + conversationText + "\n\nSugira uma resposta para a ultima mensagem recebida." },
  ];

  var resp = await geiaChat(chatMessages, 500);

  if (resp.error) {
    resultEl.innerHTML = '<div style="padding:10px;background:#1a2730;border-radius:8px;color:#ff6b6b;font-size:12px">' + escGeia(resp.error) + '</div>';
  } else {
    renderResultBox(resultEl, "Sugestao de Resposta", "#25d366", resp.text, { showUse: true, showCopy: true, showRegenerate: true });
  }
  if (btnEl) btnEl.style.pointerEvents = "";
}

// ===== Shared result renderer (uses addEventListener for actions) =====
function renderResultBox(container, title, color, text, opts) {
  opts = opts || {};
  container.innerHTML = '';

  var box = document.createElement("div");
  Object.assign(box.style, { padding: "12px", background: "#1a2730", borderRadius: "8px", borderLeft: "3px solid " + color });

  var titleEl = document.createElement("div");
  Object.assign(titleEl.style, { fontSize: "11px", color: color, fontWeight: "600", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" });
  titleEl.textContent = title;
  box.appendChild(titleEl);

  var textEl = document.createElement("div");
  Object.assign(textEl.style, { whiteSpace: "pre-wrap", lineHeight: "1.6", fontSize: "13px", color: "#e9edef" });
  textEl.textContent = text;
  box.appendChild(textEl);

  var actions = document.createElement("div");
  Object.assign(actions.style, { display: "flex", gap: "12px", marginTop: "10px", paddingTop: "8px", borderTop: "1px solid rgba(134,150,160,0.2)" });

  if (opts.showUse) {
    var useBtn = document.createElement("span");
    useBtn.className = "ezap-tr-action";
    useBtn.textContent = "Usar resposta";
    Object.assign(useBtn.style, { color: "#25d366", fontWeight: "600" });
    useBtn.addEventListener("click", function() {
      if (writeToInputBox(text.trim())) {
        useBtn.textContent = "Colado!";
        setTimeout(function() { useBtn.textContent = "Usar resposta"; }, 2000);
      }
    });
    actions.appendChild(useBtn);
  }

  if (opts.showCopy) {
    var copyBtn = document.createElement("span");
    copyBtn.className = "ezap-tr-action";
    copyBtn.textContent = "Copiar";
    copyBtn.addEventListener("click", function() {
      navigator.clipboard.writeText(text).then(function() {
        copyBtn.textContent = "Copiado!";
        setTimeout(function() { copyBtn.textContent = "Copiar"; }, 2000);
      });
    });
    actions.appendChild(copyBtn);
  }

  if (opts.showRegenerate) {
    var regenBtn = document.createElement("span");
    regenBtn.className = "ezap-tr-action";
    regenBtn.textContent = "Gerar outra";
    regenBtn.addEventListener("click", geiaSuggestReply);
    actions.appendChild(regenBtn);
  }

  box.appendChild(actions);
  container.appendChild(box);
}

// ===== Inline reply suggestion button (next to received messages) =====
var geiaSuggestBusy = {};

function geiaScanMessages() {
  if (!window.__ezapHasFeature || !window.__ezapHasFeature("geia_sugestao")) return;

  var rows = document.querySelectorAll('div[role="row"]');
  rows.forEach(function(row) {
    // Skip if already has button
    if (row.querySelector(".geia-suggest-btn")) return;
    // Skip outgoing messages
    if (row.querySelector('[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-time"]')) return;
    // Must have text content
    var textEl = row.querySelector('[class*="copyable-text"] span[dir]');
    if (!textEl || !textEl.textContent.trim()) return;

    injectSuggestButton(row);
  });
}

function injectSuggestButton(row) {
  var btn = document.createElement("div");
  btn.className = "geia-suggest-btn";
  btn.innerHTML = "&#9997;";
  btn.title = "Sugerir resposta (GEIA)";
  btn.addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    onSuggestClick(row, btn);
  });

  // Find bubble
  var bubble = null;
  var copyText = row.querySelector('[class*="copyable-text"]');
  if (copyText) {
    var el = copyText;
    for (var i = 0; i < 10; i++) {
      if (!el.parentElement || el.parentElement === row) break;
      el = el.parentElement;
      try {
        var bg = window.getComputedStyle(el).backgroundColor;
        if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)" && el.offsetWidth > 100) {
          bubble = el;
          break;
        }
      } catch(e2) {}
    }
  }

  if (!bubble) bubble = row.querySelector('[data-testid="msg-container"]') || row;
  bubble.style.position = "relative";
  bubble.appendChild(btn);
}

async function onSuggestClick(row, btn) {
  var rowId = getGeiaRowId(row);
  if (geiaSuggestBusy[rowId]) return;
  geiaSuggestBusy[rowId] = true;

  var origHTML = btn.innerHTML;
  btn.innerHTML = '<span class="ezap-tr-spin" style="width:12px;height:12px"></span>';
  btn.style.pointerEvents = "none";

  // Get the clicked message text
  var spans = row.querySelectorAll('[class*="copyable-text"] span[dir]');
  var clickedText = "";
  spans.forEach(function(s) {
    if (s.textContent.trim()) clickedText += (clickedText ? " " : "") + s.textContent.trim();
  });

  // Get context (previous messages)
  var allMessages = extractConversationMessages(20);
  var contactName = getContactName();

  var config = await geiaLoadConfig();
  var conversationText = allMessages.map(function(m) {
    return "[" + m.time + "] " + m.sender + ": " + m.text;
  }).join("\n");

  var systemPrompt = buildSystemPrompt(config);
  var chatMessages = [
    { role: "system", content: systemPrompt + "\n\nVoce deve sugerir uma resposta curta e adequada para a mensagem do contato em uma conversa de WhatsApp. A resposta deve ser natural e pronta para enviar. NAO use saudacao se a conversa ja esta em andamento. Responda APENAS com o texto da mensagem sugerida. Responda em portugues." },
    { role: "user", content: "Contexto da conversa com " + contactName + ":\n\n" + conversationText + "\n\nSugira uma resposta para: \"" + clickedText + "\"" },
  ];

  var resp = await geiaChat(chatMessages, 300);

  btn.innerHTML = origHTML;
  btn.style.pointerEvents = "";
  delete geiaSuggestBusy[rowId];

  if (resp.error) {
    console.error("[GEIA] Suggest error:", resp.error);
    btn.style.color = "#ff6b6b";
    setTimeout(function() { btn.style.color = ""; }, 2000);
    return;
  }

  // Write to input box
  var ok = writeToInputBox(resp.text.trim());
  if (ok) {
    btn.innerHTML = "&#10003;";
    btn.style.color = "#25d366";
    setTimeout(function() { btn.innerHTML = origHTML; btn.style.color = ""; }, 2000);
  }
}

function getGeiaRowId(row) {
  var id = row.getAttribute("data-id");
  if (id) return id;
  var child = row.querySelector("[data-id]");
  if (child) return child.getAttribute("data-id");
  return "geia_" + Array.from(row.parentElement.children).indexOf(row);
}

// ===== Escape helpers =====
function escGeia(str) {
  if (!str) return "";
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ===== Observer for inline suggestion buttons =====
function startGeiaObserver() {
  var debounceTimer = null;
  var observer = new MutationObserver(function() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(geiaScanMessages, 500);
  });

  var app = document.getElementById("app");
  if (app) {
    observer.observe(app, { childList: true, subtree: true });
  }

  geiaScanMessages();
  setInterval(geiaScanMessages, 5000);
}

// ===== Init =====
function initGeia() {
  console.log("[GEIA] Initializing...");
  createGeiaButton();
  createGeiaSidebar();

  // Start inline suggestion buttons if feature enabled
  if (window.__ezapHasFeature && window.__ezapHasFeature("geia_sugestao")) {
    startGeiaObserver();
  }

  // Preload config
  geiaLoadConfig();
  console.log("[GEIA] Ready!");
}

// Start after authentication
document.addEventListener("wcrm-auth-ready", function() {
  if (window.__ezapHasFeature && window.__ezapHasFeature("geia")) {
    setTimeout(initGeia, 1000);
  } else {
    console.log("[GEIA] Feature not enabled for this user");
  }
});
if (window.__wcrmAuth && window.__ezapHasFeature && window.__ezapHasFeature("geia")) setTimeout(initGeia, 3000);
