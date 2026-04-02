// ===== MSG - Mensagens Automaticas =====
// Sidebar with saved sequences + Modal editor
console.log("[WCRM MSG] Module loaded");

let msgSequences = {};
let msgSidebarOpen = false;
let msgEditing = null;
let msgTempItems = [];

// ===== Supabase Helper =====
function getMsgUserId() {
  return window.__wcrmAuth ? window.__wcrmAuth.userId : null;
}

function msgSupaRest(path, method, body, prefer) {
  return new Promise(function(resolve) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) { resolve(null); return; }
      chrome.runtime.sendMessage({
        action: "supabase_rest", path: path, method: method || "GET", body: body, prefer: prefer
      }, function(resp) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ===== Storage (Supabase + chrome.storage cache) =====
function loadMsgData() {
  return new Promise(function(resolve) {
    // Fast: load from local cache first
    chrome.storage.local.get("wcrm_msg_sequences", function(data) {
      msgSequences = (data && data.wcrm_msg_sequences) || {};
      console.log("[WCRM MSG] Loaded", Object.keys(msgSequences).length, "sequences from cache");
      resolve();
    });

    // Background: sync from Supabase
    var uid = getMsgUserId();
    if (!uid) return;

    msgSupaRest("/rest/v1/msg_sequences?user_id=eq." + uid + "&select=*&order=updated_at.desc").then(function(rows) {
      if (!rows || !Array.isArray(rows)) return;

      if (rows.length > 0) {
        // Supabase has data — use it
        var newSeqs = {};
        rows.forEach(function(r) {
          newSeqs[r.id] = {
            id: r.id,
            name: r.name || "",
            messages: r.messages || [],
            schedule: r.schedule || null,
            sent: r.sent || false,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          };
        });
        msgSequences = newSeqs;
        chrome.storage.local.set({ wcrm_msg_sequences: msgSequences });
        console.log("[WCRM MSG] Synced", rows.length, "sequences from Supabase");
        if (msgSidebarOpen) renderSavedSequences();
      } else if (Object.keys(msgSequences).length > 0) {
        // First time: migrate local sequences to Supabase
        console.log("[WCRM MSG] Migrating local sequences to Supabase...");
        migrateLocalMsgToSupabase(uid);
      }
    });
  });
}

function migrateLocalMsgToSupabase(uid) {
  var newSeqs = {};
  var rows = [];

  Object.keys(msgSequences).forEach(function(oldId) {
    var seq = msgSequences[oldId];
    var newId = isValidUUID(oldId) ? oldId : crypto.randomUUID();
    rows.push({
      id: newId,
      user_id: uid,
      name: seq.name || "Sem nome",
      messages: seq.messages || [],
      schedule: seq.schedule || null,
      sent: seq.sent || false,
      contact_phone: "",
      status: seq.sent ? "completed" : "active",
    });
    newSeqs[newId] = {
      id: newId,
      name: seq.name || "Sem nome",
      messages: seq.messages || [],
      schedule: seq.schedule || null,
      sent: seq.sent || false,
      createdAt: seq.createdAt,
      updatedAt: seq.updatedAt,
    };
  });

  if (rows.length > 0) {
    msgSupaRest("/rest/v1/msg_sequences", "POST", rows, "return=minimal").then(function() {
      msgSequences = newSeqs;
      chrome.storage.local.set({ wcrm_msg_sequences: msgSequences });
      console.log("[WCRM MSG] Migrated", rows.length, "sequences to Supabase");
      if (msgSidebarOpen) renderSavedSequences();
    });
  }
}

function saveMsgData() {
  chrome.storage.local.set({ wcrm_msg_sequences: msgSequences });
}

// ===== MSG Button =====
function createMsgButton() {
  if (document.getElementById("wcrm-msg-toggle")) return;
  var btn = document.createElement("button");
  btn.id = "wcrm-msg-toggle";
  btn.textContent = "MSG";
  btn.title = "Mensagens Automaticas";
  btn.addEventListener("click", toggleMsgSidebar);
  Object.assign(btn.style, {
    position: "fixed",
    top: "140px",
    right: "16px",
    width: "50px",
    height: "50px",
    borderRadius: "50%",
    background: "#4d96ff",
    color: "#fff",
    border: "none",
    fontSize: "11px",
    fontWeight: "bold",
    cursor: "pointer",
    zIndex: "99999",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  document.body.appendChild(btn);
}

// ===== MSG Sidebar =====
function createMsgSidebar() {
  if (document.getElementById("wcrm-msg-sidebar")) return;

  var sidebar = document.createElement("div");
  sidebar.id = "wcrm-msg-sidebar";
  Object.assign(sidebar.style, {
    position: "fixed",
    top: "0",
    right: "0",
    width: "320px",
    height: "100vh",
    background: "#111b21",
    borderLeft: "1px solid #2a3942",
    zIndex: "99999",
    display: "none",
    flexDirection: "column",
    fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    color: "#e9edef",
    fontSize: "13px",
    overflow: "hidden",
  });

  sidebar.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#202c33;border-bottom:1px solid #2a3942;min-height:48px">
      <h3 style="margin:0;font-size:15px;font-weight:600;color:#e9edef">Mensagens</h3>
      <button id="wcrm-msg-sidebar-close" style="background:none;border:none;color:#8696a0;font-size:22px;cursor:pointer;padding:4px 8px">&times;</button>
    </div>
    <div style="padding:12px 16px">
      <button id="wcrm-msg-create-btn" style="width:100%;background:#4d96ff;color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;transition:background 0.15s"
        onmouseover="this.style.background='#3a7ff0'" onmouseout="this.style.background='#4d96ff'">+ Criar Sequencia</button>
    </div>
    <div id="wcrm-msg-sidebar-list" style="flex:1;overflow-y:auto;padding:0 16px 16px">
      <div style="color:#8696a0;font-size:12px;text-align:center;padding:20px;font-style:italic">Nenhuma sequencia salva</div>
    </div>
  `;

  document.body.appendChild(sidebar);

  document.getElementById("wcrm-msg-sidebar-close").addEventListener("click", toggleMsgSidebar);
  document.getElementById("wcrm-msg-create-btn").addEventListener("click", function() {
    resetMsgEditor();
    openMsgModal();
  });
}

function toggleMsgSidebar() {
  // Close other sidebars if open
  if (typeof sidebarOpen !== 'undefined' && sidebarOpen) toggleSidebar();
  if (typeof sliceSidebarOpen !== 'undefined' && sliceSidebarOpen) closeSliceSidebar();
  if (typeof abasSidebarOpen !== 'undefined' && abasSidebarOpen) closeAbasSidebar();

  msgSidebarOpen = !msgSidebarOpen;
  document.getElementById("wcrm-msg-sidebar").style.display = msgSidebarOpen ? "flex" : "none";

  var appEl = document.getElementById("app");
  if (appEl) {
    if (msgSidebarOpen) {
      appEl.style.width = "calc(100% - 320px)";
      appEl.style.maxWidth = "calc(100% - 320px)";
    } else {
      appEl.style.width = "";
      appEl.style.maxWidth = "";
    }
  }

  // Hide/show floating buttons
  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();

  if (msgSidebarOpen) {
    renderSavedSequences();
  }
}

// Called from content.js when CRM sidebar opens
function closeMsgSidebar() {
  if (!msgSidebarOpen) return;
  msgSidebarOpen = false;
  var sb = document.getElementById("wcrm-msg-sidebar");
  if (sb) sb.style.display = "none";
  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();
}

// ===== MSG Modal (Editor) =====
function createMsgModal() {
  if (document.getElementById("wcrm-msg-overlay")) return;

  var overlay = document.createElement("div");
  overlay.id = "wcrm-msg-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.6)",
    zIndex: "100000",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
  });

  overlay.innerHTML = `
    <div style="width:520px;max-height:85vh;background:#111b21;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;border:1px solid #2a3942;box-shadow:0 8px 32px rgba(0,0,0,0.5)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#202c33;border-bottom:1px solid #2a3942">
        <h3 id="wcrm-msg-modal-title" style="margin:0;font-size:15px;font-weight:600;color:#e9edef">Nova Sequencia</h3>
        <button id="wcrm-msg-modal-close" style="background:none;border:none;color:#8696a0;font-size:22px;cursor:pointer;padding:4px 8px">&times;</button>
      </div>
      <div id="wcrm-msg-modal-content" style="flex:1;overflow-y:auto;padding:16px;color:#e9edef;font-size:13px">

        <div style="margin-bottom:12px">
          <input id="wcrm-msg-seq-name" type="text" placeholder="Nome da sequencia (ex: Boas Vindas Mentoria)" maxlength="50"
            style="width:100%;background:#2a3942;border:1px solid #3b4a54;border-radius:8px;padding:10px 12px;color:#e9edef;font-size:13px;outline:none;box-sizing:border-box">
        </div>

        <div style="margin-bottom:12px;background:#1a2730;border-radius:8px;padding:10px;border:1px solid #2a3942">
          <div style="font-size:11px;font-weight:600;color:#4d96ff;margin-bottom:6px">Variaveis disponiveis (dados do HubSpot):</div>
          <div style="font-size:11px;color:#8696a0;line-height:1.7">
            <code style="background:#2a3942;padding:1px 5px;border-radius:3px;color:#25d366">@nome</code> Primeiro nome &nbsp;
            <code style="background:#2a3942;padding:1px 5px;border-radius:3px;color:#25d366">@nomeCompleto</code> Nome completo<br>
            <code style="background:#2a3942;padding:1px 5px;border-radius:3px;color:#25d366">@email</code> E-mail &nbsp;
            <code style="background:#2a3942;padding:1px 5px;border-radius:3px;color:#25d366">@telefone</code> Telefone<br>
            <code style="background:#2a3942;padding:1px 5px;border-radius:3px;color:#25d366">@consultor</code> Consultor &nbsp;
            <code style="background:#2a3942;padding:1px 5px;border-radius:3px;color:#25d366">@reunioes</code> Reunioes adquiridas
          </div>
        </div>

        <div id="wcrm-msg-items" style="margin-bottom:12px">
          <div style="color:#8696a0;font-size:12px;text-align:center;padding:20px;border:1px dashed #3b4a54;border-radius:8px;font-style:italic">
            Clique em "+ Mensagem" ou "+ Arquivo" para adicionar
          </div>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:16px">
          <button id="wcrm-msg-add-text" style="flex:1;background:#2a3942;border:1px solid #3b4a54;border-radius:8px;padding:9px;color:#4d96ff;font-size:12px;font-weight:600;cursor:pointer;transition:background 0.15s"
            onmouseover="this.style.background='#344250'" onmouseout="this.style.background='#2a3942'">+ Mensagem</button>
          <button id="wcrm-msg-add-file" style="flex:1;background:#2a3942;border:1px solid #3b4a54;border-radius:8px;padding:9px;color:#ff922b;font-size:12px;font-weight:600;cursor:pointer;transition:background 0.15s"
            onmouseover="this.style.background='#344250'" onmouseout="this.style.background='#2a3942'">+ Arquivo</button>
        </div>

        <input type="file" id="wcrm-msg-file-input" style="display:none" accept=".pdf,.doc,.docx,.mp3,.ogg,.wav,.opus,.m4a,.mp4,.jpg,.jpeg,.png">

        <div style="margin-bottom:16px;background:#1a2730;border-radius:8px;padding:10px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <input type="checkbox" id="wcrm-msg-schedule-check" style="accent-color:#4d96ff;width:16px;height:16px;cursor:pointer">
            <label for="wcrm-msg-schedule-check" style="font-size:12px;color:#8696a0;cursor:pointer">Agendar envio automatico</label>
          </div>
          <input id="wcrm-msg-schedule-time" type="datetime-local"
            style="display:none;width:100%;background:#2a3942;border:1px solid #3b4a54;border-radius:6px;padding:8px 12px;color:#e9edef;font-size:13px;outline:none;box-sizing:border-box;margin-top:6px">
        </div>

        <button id="wcrm-msg-save" style="width:100%;background:#4d96ff;color:#fff;border:none;border-radius:8px;padding:11px;font-size:13px;font-weight:600;cursor:pointer;transition:background 0.15s"
          onmouseover="this.style.background='#3a7ff0'" onmouseout="this.style.background='#4d96ff'">Salvar Sequencia</button>
        <div id="wcrm-msg-save-status" style="font-size:10px;text-align:center;margin-top:4px;min-height:14px"></div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById("wcrm-msg-modal-close").addEventListener("click", closeMsgModal);
  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) closeMsgModal();
  });
  document.getElementById("wcrm-msg-add-text").addEventListener("click", function() { addMsgItem("text"); });
  document.getElementById("wcrm-msg-add-file").addEventListener("click", function() {
    document.getElementById("wcrm-msg-file-input").click();
  });
  document.getElementById("wcrm-msg-file-input").addEventListener("change", handleFileSelect);
  document.getElementById("wcrm-msg-schedule-check").addEventListener("change", function() {
    document.getElementById("wcrm-msg-schedule-time").style.display = this.checked ? "" : "none";
  });
  document.getElementById("wcrm-msg-save").addEventListener("click", saveMsgSequence);
}

function openMsgModal() {
  var overlay = document.getElementById("wcrm-msg-overlay");
  overlay.style.display = "flex";
  var title = document.getElementById("wcrm-msg-modal-title");
  title.textContent = msgEditing ? "Editar Sequencia" : "Nova Sequencia";
}

function closeMsgModal() {
  var overlay = document.getElementById("wcrm-msg-overlay");
  overlay.style.display = "none";
}

// ===== Editor Logic =====
function resetMsgEditor() {
  msgEditing = null;
  msgTempItems = [];
  var nameInput = document.getElementById("wcrm-msg-seq-name");
  if (nameInput) nameInput.value = "";
  var schedCheck = document.getElementById("wcrm-msg-schedule-check");
  if (schedCheck) schedCheck.checked = false;
  var schedTime = document.getElementById("wcrm-msg-schedule-time");
  if (schedTime) { schedTime.style.display = "none"; schedTime.value = ""; }
  var saveBtn = document.getElementById("wcrm-msg-save");
  if (saveBtn) saveBtn.textContent = "Salvar Sequencia";
  var statusEl = document.getElementById("wcrm-msg-save-status");
  if (statusEl) statusEl.innerHTML = "";
  renderMsgItems();
}

function addMsgItem(type, content, fileName) {
  msgTempItems.push({
    type: type,
    content: content || "",
    fileName: fileName || "",
    interval: 5, // ALL messages have interval, including the first
  });
  renderMsgItems();
}

function removeMsgItem(index) {
  msgTempItems.splice(index, 1);
  renderMsgItems();
}

function handleFileSelect(e) {
  var file = e.target.files[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    var statusEl = document.getElementById("wcrm-msg-save-status");
    if (statusEl) statusEl.innerHTML = '<span style="color:#ff6b6b">Arquivo muito grande (max 5MB)</span>';
    e.target.value = "";
    return;
  }

  var reader = new FileReader();
  reader.onload = function(ev) {
    var base64 = ev.target.result.split(",")[1];
    var mimeType = ev.target.result.split(";")[0].split(":")[1];
    addMsgItem("file", base64, file.name);
    msgTempItems[msgTempItems.length - 1].mimeType = mimeType;
  };
  reader.readAsDataURL(file);
  e.target.value = "";
}

function syncEditorValues() {
  document.querySelectorAll(".wcrm-msg-textarea").forEach(function(ta) {
    var idx = parseInt(ta.dataset.idx);
    if (msgTempItems[idx]) msgTempItems[idx].content = ta.value;
  });
  document.querySelectorAll(".wcrm-msg-interval").forEach(function(inp) {
    var idx = parseInt(inp.dataset.idx);
    if (msgTempItems[idx]) msgTempItems[idx].interval = parseInt(inp.value) || 5;
  });
}

function renderMsgItems() {
  var container = document.getElementById("wcrm-msg-items");
  if (!container) return;

  if (msgTempItems.length === 0) {
    container.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:20px;border:1px dashed #3b4a54;border-radius:8px;font-style:italic">Clique em "+ Mensagem" ou "+ Arquivo" para adicionar</div>';
    return;
  }

  var html = '';
  msgTempItems.forEach(function(item, idx) {
    var isText = item.type === 'text';
    var borderColor = isText ? '#4d96ff' : '#ff922b';
    var typeLabel = isText ? 'Mensagem' : (item.fileName || 'Arquivo');
    var typeIcon = isText ? '' : '\uD83D\uDCCE ';

    html += '<div class="wcrm-msg-item" style="background:#1a2730;border-radius:8px;padding:10px;margin-bottom:8px;border-left:3px solid ' + borderColor + '">';

    // Header
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
    html += '<span style="font-size:11px;font-weight:600;color:' + borderColor + '">' + (idx + 1) + '. ' + typeIcon + typeLabel + '</span>';
    html += '<span class="wcrm-msg-remove" data-idx="' + idx + '" style="color:#ff6b6b;font-size:16px;cursor:pointer;padding:0 4px;line-height:1" title="Remover">&times;</span>';
    html += '</div>';

    // Content
    if (isText) {
      html += '<textarea class="wcrm-msg-textarea" data-idx="' + idx + '" style="width:100%;min-height:60px;background:#2a3942;border:1px solid #3b4a54;border-radius:6px;padding:8px;color:#e9edef;font-size:12px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box" placeholder="Digite a mensagem...">' + escapeHtml(item.content || '') + '</textarea>';
    } else {
      var sizeInfo = item.content ? ' (' + Math.round(atob(item.content).length / 1024) + ' KB)' : '';
      html += '<div style="font-size:11px;color:#8696a0;padding:4px 0;display:flex;align-items:center;gap:4px">';
      html += '<span style="color:#ff922b">\uD83D\uDCC4</span> ' + escapeHtml(item.fileName || 'Arquivo') + '<span style="color:#3b4a54">' + sizeInfo + '</span>';
      html += '</div>';
    }

    // Interval - ALL messages have it (including the first)
    var intervalLabel = idx === 0 ? 'Aguardar antes de iniciar' : 'Aguardar antes de enviar';
    html += '<div style="display:flex;align-items:center;gap:6px;margin-top:8px">';
    html += '<span style="font-size:11px;color:#8696a0">' + intervalLabel + '</span>';
    html += '<input type="number" class="wcrm-msg-interval" data-idx="' + idx + '" value="' + item.interval + '" min="0" max="3600" style="width:55px;background:#2a3942;border:1px solid #3b4a54;border-radius:4px;padding:4px 6px;color:#e9edef;font-size:12px;text-align:center;outline:none">';
    html += '<span style="font-size:11px;color:#8696a0">seg</span>';
    html += '</div>';

    html += '</div>';
  });

  container.innerHTML = html;

  // Wire events
  container.querySelectorAll(".wcrm-msg-remove").forEach(function(btn) {
    btn.addEventListener("click", function() {
      syncEditorValues();
      removeMsgItem(parseInt(btn.dataset.idx));
    });
  });
}

function escapeHtml(text) {
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ===== Save Sequence =====
function saveMsgSequence() {
  var nameInput = document.getElementById("wcrm-msg-seq-name");
  var statusEl = document.getElementById("wcrm-msg-save-status");
  var name = nameInput.value.trim();

  if (!name) {
    nameInput.style.borderColor = "#ff6b6b";
    statusEl.innerHTML = '<span style="color:#ff6b6b">Digite um nome para a sequencia</span>';
    setTimeout(function() { nameInput.style.borderColor = "#3b4a54"; }, 2000);
    return;
  }

  if (msgTempItems.length === 0) {
    statusEl.innerHTML = '<span style="color:#ff6b6b">Adicione pelo menos uma mensagem</span>';
    return;
  }

  syncEditorValues();

  var id = msgEditing || crypto.randomUUID();
  var scheduleCheck = document.getElementById("wcrm-msg-schedule-check").checked;
  var scheduleTime = document.getElementById("wcrm-msg-schedule-time").value;

  msgSequences[id] = {
    id: id,
    name: name,
    messages: msgTempItems.map(function(m) {
      return {
        type: m.type,
        content: m.content,
        fileName: m.fileName || "",
        mimeType: m.mimeType || "",
        interval: m.interval,
      };
    }),
    schedule: scheduleCheck && scheduleTime ? scheduleTime : null,
    sent: false,
    createdAt: msgSequences[id] ? msgSequences[id].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveMsgData();

  // Sync to Supabase: upsert (delete + insert)
  var uid = getMsgUserId();
  if (uid && isValidUUID(id)) {
    msgSupaRest("/rest/v1/msg_sequences?id=eq." + id, "DELETE", null, "return=minimal").then(function() {
      msgSupaRest("/rest/v1/msg_sequences", "POST", {
        id: id,
        user_id: uid,
        name: msgSequences[id].name,
        messages: msgSequences[id].messages,
        schedule: msgSequences[id].schedule || null,
        sent: false,
        contact_phone: "",
        status: "active",
      }, "return=minimal");
    });
  }

  statusEl.innerHTML = '<span style="color:#25d366">Sequencia salva!</span>';
  setTimeout(function() {
    closeMsgModal();
    renderSavedSequences();
  }, 600);
}

// ===== Render Saved Sequences (Sidebar) =====
function renderSavedSequences() {
  var container = document.getElementById("wcrm-msg-sidebar-list");
  if (!container) return;

  var keys = Object.keys(msgSequences);
  if (keys.length === 0) {
    container.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:20px;font-style:italic">Nenhuma sequencia salva.<br>Clique em "+ Criar Sequencia" para comecar.</div>';
    return;
  }

  keys.sort(function(a, b) {
    return (msgSequences[b].updatedAt || "").localeCompare(msgSequences[a].updatedAt || "");
  });

  var html = '';
  keys.forEach(function(id) {
    var seq = msgSequences[id];
    var textMsgs = seq.messages.filter(function(m) { return m.type === 'text'; }).length;
    var fileMsgs = seq.messages.filter(function(m) { return m.type === 'file'; }).length;
    var totalInterval = seq.messages.reduce(function(sum, m) { return sum + (m.interval || 0); }, 0);

    var desc = '';
    if (textMsgs > 0) desc += textMsgs + ' msg' + (textMsgs > 1 ? 's' : '');
    if (fileMsgs > 0) desc += (desc ? ', ' : '') + fileMsgs + ' arquivo' + (fileMsgs > 1 ? 's' : '');
    desc += ' | ~' + totalInterval + 's';

    html += '<div style="background:#1a2730;border-radius:8px;padding:10px;margin-bottom:8px;border-left:3px solid #4d96ff">';

    // Name + schedule badge
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">';
    html += '<span style="font-size:13px;font-weight:600;color:#e9edef">' + escapeHtml(seq.name) + '</span>';
    if (seq.schedule && !seq.sent) {
      var sd = new Date(seq.schedule);
      html += '<span style="font-size:9px;color:#ff922b;background:#ff922b15;padding:2px 5px;border-radius:4px">';
      html += '\u23F0 ' + sd.toLocaleString("pt-BR", {day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
      html += '</span>';
    }
    html += '</div>';

    // Description
    html += '<div style="font-size:11px;color:#8696a0;margin-bottom:6px">' + desc + '</div>';

    // Preview
    var firstText = seq.messages.find(function(m) { return m.type === 'text' && m.content; });
    if (firstText) {
      var preview = firstText.content.substring(0, 50) + (firstText.content.length > 50 ? '...' : '');
      html += '<div style="font-size:10px;color:#8696a0;margin-bottom:8px;padding:3px 6px;background:#111b21;border-radius:4px;border-left:2px solid #3b4a54;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(preview) + '</div>';
    }

    // Buttons
    html += '<div style="display:flex;gap:4px">';
    html += '<button class="wcrm-msg-send" data-id="' + id + '" style="flex:1;background:#25d366;color:#111b21;border:none;border-radius:6px;padding:6px;font-size:11px;font-weight:600;cursor:pointer">\u25B6 Enviar</button>';
    html += '<button class="wcrm-msg-edit" data-id="' + id + '" style="background:#2a3942;color:#4d96ff;border:1px solid #3b4a54;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer" title="Editar">\u270F</button>';
    html += '<button class="wcrm-msg-delete" data-id="' + id + '" style="background:#2a3942;color:#ff6b6b;border:1px solid #3b4a54;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer" title="Excluir">\u2715</button>';
    html += '</div>';

    html += '</div>';
  });

  container.innerHTML = html;

  // Wire events
  container.querySelectorAll(".wcrm-msg-send").forEach(function(btn) {
    btn.addEventListener("click", function() { executeMsgSequence(btn.dataset.id); });
  });
  container.querySelectorAll(".wcrm-msg-edit").forEach(function(btn) {
    btn.addEventListener("click", function() { editMsgSequence(btn.dataset.id); });
  });
  container.querySelectorAll(".wcrm-msg-delete").forEach(function(btn) {
    btn.addEventListener("click", function() { deleteMsgSequence(btn.dataset.id); });
  });
}

// ===== Edit / Delete =====
function editMsgSequence(id) {
  var seq = msgSequences[id];
  if (!seq) return;

  msgEditing = id;
  msgTempItems = seq.messages.map(function(m) { return Object.assign({}, m); });

  // Open modal and fill data
  openMsgModal();

  document.getElementById("wcrm-msg-seq-name").value = seq.name;

  if (seq.schedule) {
    document.getElementById("wcrm-msg-schedule-check").checked = true;
    document.getElementById("wcrm-msg-schedule-time").style.display = "";
    document.getElementById("wcrm-msg-schedule-time").value = seq.schedule;
  } else {
    document.getElementById("wcrm-msg-schedule-check").checked = false;
    document.getElementById("wcrm-msg-schedule-time").style.display = "none";
  }

  document.getElementById("wcrm-msg-save").textContent = "Salvar Edicao";
  renderMsgItems();
}

function deleteMsgSequence(id) {
  var seq = msgSequences[id];
  var seqName = seq ? seq.name : "esta sequência";
  if (!confirm('Excluir "' + seqName + '"?')) return;

  delete msgSequences[id];
  saveMsgData();
  renderSavedSequences();

  // Sync to Supabase: delete
  var uid = getMsgUserId();
  if (uid && isValidUUID(id)) {
    msgSupaRest("/rest/v1/msg_sequences?id=eq." + id + "&user_id=eq." + uid, "DELETE", null, "return=minimal");
  }
}

// ===== Message Variable Replacement =====
// Ordered longest-first to prevent @nome matching inside @nomeCompleto
function getMsgVarList() {
  var data = window._wcrmContactData;
  if (!data) return [];
  return [
    ["@nomeCompleto", data.nomeCompleto || ""],
    ["@consultor", data.consultor || ""],
    ["@reunioes", data.reunioes || ""],
    ["@lifecycle", data.lifecycle || ""],
    ["@telefone", data.telefone || ""],
    ["@empresa", data.empresa || ""],
    ["@ticket", data.ticket || ""],
    ["@email", data.email || ""],
    ["@nome", data.nome || ""],
  ];
}

// Replace all @variables in text (used by MSG sequences on send)
function replaceMsgVariables(text) {
  if (!text || !window._wcrmContactData) return text;
  var vars = getMsgVarList();
  var result = text;
  vars.forEach(function(pair) {
    var regex = new RegExp(pair[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    result = result.replace(regex, pair[1]);
  });
  return result;
}

// ===== Execute Sequence =====
function executeMsgSequence(id) {
  var seq = msgSequences[id];
  if (!seq || seq.messages.length === 0) return;

  var input = document.querySelector('[data-testid="conversation-compose-box-input"]') ||
              document.querySelector('#main div[contenteditable="true"][role="textbox"]');
  if (!input) {
    alert("Abra uma conversa no WhatsApp antes de enviar.");
    return;
  }

  // Close sidebar
  if (msgSidebarOpen) toggleMsgSidebar();

  // Progress indicator
  var progress = document.createElement("div");
  progress.id = "wcrm-msg-progress";
  Object.assign(progress.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    background: "#202c33",
    border: "1px solid #2a3942",
    borderRadius: "12px",
    padding: "14px 18px",
    zIndex: "100001",
    color: "#e9edef",
    fontSize: "12px",
    fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    minWidth: "240px",
    borderLeft: "3px solid #4d96ff",
  });
  progress.innerHTML = '<div style="font-weight:600;margin-bottom:6px">\uD83D\uDCE4 ' + escapeHtml(seq.name) + '</div>' +
    '<div id="wcrm-msg-progress-bar" style="background:#2a3942;border-radius:4px;height:6px;margin-bottom:6px;overflow:hidden"><div id="wcrm-msg-progress-fill" style="background:#4d96ff;height:100%;width:0%;transition:width 0.3s;border-radius:4px"></div></div>' +
    '<div id="wcrm-msg-progress-text" style="color:#8696a0;font-size:11px">Preparando...</div>';
  document.body.appendChild(progress);

  var messages = seq.messages.slice();
  var total = messages.length;
  var idx = 0;

  function updateProgress(text, pct) {
    var pt = document.getElementById("wcrm-msg-progress-text");
    var pf = document.getElementById("wcrm-msg-progress-fill");
    if (pt) pt.textContent = text;
    if (pf) pf.style.width = pct + "%";
  }

  function sendNext() {
    if (idx >= messages.length) {
      updateProgress("\u2713 Todas as " + total + " mensagens enviadas!", 100);
      var pg = document.getElementById("wcrm-msg-progress");
      if (pg) pg.style.borderLeftColor = "#25d366";
      setTimeout(function() {
        var pg = document.getElementById("wcrm-msg-progress");
        if (pg) pg.remove();
      }, 4000);
      return;
    }

    var msg = messages[idx];
    var delay = (msg.interval || 0) * 1000;
    var pct = Math.round((idx / total) * 100);

    if (delay > 0) {
      var remaining = delay / 1000;
      updateProgress("Aguardando " + remaining + "s... (" + (idx + 1) + "/" + total + ")", pct);

      var countdownTimer = setInterval(function() {
        remaining--;
        if (remaining > 0) {
          updateProgress("Aguardando " + remaining + "s... (" + (idx + 1) + "/" + total + ")", pct);
        } else {
          clearInterval(countdownTimer);
        }
      }, 1000);

      setTimeout(function() {
        clearInterval(countdownTimer);
        doSend();
      }, delay);
    } else {
      doSend();
    }

    function doSend() {
      updateProgress("Enviando " + (idx + 1) + "/" + total + "...", Math.round(((idx + 0.5) / total) * 100));

      var sendPromise;
      if (msg.type === 'text') {
        sendPromise = typeInWhatsApp(replaceMsgVariables(msg.content));
      } else if (msg.type === 'file') {
        sendPromise = sendFileInWhatsApp(msg.content, msg.fileName, msg.mimeType);
      } else {
        sendPromise = Promise.resolve(true);
      }

      sendPromise.then(function() {
        idx++;
        sendNext();
      }).catch(function(err) {
        updateProgress("\u274C Erro na msg " + (idx + 1) + ": " + err, Math.round((idx / total) * 100));
        var pg = document.getElementById("wcrm-msg-progress");
        if (pg) pg.style.borderLeftColor = "#ff6b6b";
        setTimeout(function() {
          var pg = document.getElementById("wcrm-msg-progress");
          if (pg) pg.remove();
        }, 6000);
      });
    }
  }

  sendNext();
}

// ===== WhatsApp Web DOM - Find Send Button =====
function findSendButton() {
  // WhatsApp Business uses aria-label, not data-testid
  return document.querySelector('button[aria-label="Enviar"]') ||
         document.querySelector('span[data-icon="wds-ic-send-filled"]') ||
         document.querySelector('button[aria-label="Send"]') ||
         document.querySelector('[data-testid="send"]') ||
         document.querySelector('span[data-icon="send"]');
}

// ===== WhatsApp Web DOM - Find Message Input =====
function findMessageInput() {
  return document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
         document.querySelector('#main footer div[contenteditable="true"][role="textbox"]') ||
         document.querySelector('[data-testid="conversation-compose-box-input"]');
}

// ===== WhatsApp Web DOM - Send Text =====
function typeInWhatsApp(text) {
  return new Promise(function(resolve, reject) {
    var input = findMessageInput();

    if (!input) {
      reject("Campo de mensagem nao encontrado. Abra uma conversa primeiro.");
      return;
    }

    input.focus();

    // Clear existing content
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // Handle multiline: use Shift+Enter for line breaks in WhatsApp
    var lines = text.split('\n');
    lines.forEach(function(line, i) {
      document.execCommand('insertText', false, line);
      if (i < lines.length - 1) {
        document.execCommand('insertLineBreak');
      }
    });

    // Trigger React change detection
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Retry loop to find and click the send button
    var attempts = 0;
    var maxAttempts = 15;

    function tryClickSend() {
      attempts++;
      var sendBtn = findSendButton();

      if (sendBtn) {
        var button = sendBtn.closest('button') || sendBtn;
        button.click();
        setTimeout(function() { resolve(true); }, 800);
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(tryClickSend, 300);
      } else {
        // Last resort: simulate Enter key
        console.log("[WCRM MSG] Send button not found, trying Enter key");
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
        setTimeout(function() { resolve(true); }, 800);
      }
    }

    setTimeout(tryClickSend, 400);
  });
}

// ===== WhatsApp Web DOM - Send File =====
function sendFileInWhatsApp(fileBase64, fileName, mimeType) {
  return new Promise(function(resolve, reject) {
    // WhatsApp Business: button[aria-label="Anexar"]
    var attachBtn = document.querySelector('button[aria-label="Anexar"]') ||
                    document.querySelector('span[data-icon="plus-rounded"]') ||
                    document.querySelector('span[data-icon="plus"]') ||
                    document.querySelector('[data-testid="clip"]');

    if (!attachBtn) {
      reject("Botao de anexo nao encontrado");
      return;
    }

    (attachBtn.closest('button') || attachBtn).click();

    setTimeout(function() {
      // Click "Documento" option
      var docOption = document.querySelector('button[aria-label="Documento"]') ||
                      document.querySelector('[data-testid="mi-attach-document"]') ||
                      document.querySelector('span[data-icon="attach-document"]');

      if (docOption) {
        (docOption.closest('button') || docOption.closest('li') || docOption).click();
      }

      setTimeout(function() {
        // Find the document file input (accept="*", not our custom input)
        var docInput = null;
        document.querySelectorAll('input[type="file"]').forEach(function(fi) {
          if (fi.id !== 'wcrm-msg-file-input' && (fi.accept === '*' || fi.accept === '')) {
            docInput = fi;
          }
        });

        if (!docInput) {
          reject("Input de arquivo nao encontrado");
          return;
        }

        try {
          var byteString = atob(fileBase64);
          var ab = new ArrayBuffer(byteString.length);
          var ia = new Uint8Array(ab);
          for (var i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
          }
          var blob = new Blob([ab], { type: mimeType || 'application/octet-stream' });
          var file = new File([blob], fileName, { type: mimeType || 'application/octet-stream' });

          var dt = new DataTransfer();
          dt.items.add(file);
          docInput.files = dt.files;
          docInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
          reject("Erro ao processar arquivo: " + e.message);
          return;
        }

        // Wait for preview, then find send button with retry
        var attempts = 0;
        function trySendFile() {
          attempts++;
          var sendBtn = findSendButton();
          if (sendBtn) {
            (sendBtn.closest('button') || sendBtn).click();
            setTimeout(function() { resolve(true); }, 1500);
          } else if (attempts < 15) {
            setTimeout(trySendFile, 400);
          } else {
            reject("Botao enviar nao encontrado apos anexo");
          }
        }
        setTimeout(trySendFile, 2000);
      }, 600);
    }, 500);
  });
}

// ===== Schedule Checker =====
function checkSchedules() {
  var now = new Date();
  var changed = false;

  Object.keys(msgSequences).forEach(function(id) {
    var seq = msgSequences[id];
    if (seq.schedule && !seq.sent) {
      var schedDate = new Date(seq.schedule);
      if (now >= schedDate) {
        console.log("[WCRM MSG] Executing scheduled sequence:", seq.name);
        seq.sent = true;
        changed = true;
        executeMsgSequence(id);
      }
    }
  });

  if (changed) saveMsgData();
}

// Variable replacement is only used in MSG sequences (automatic messages)
// No live chat interception — WhatsApp's mention system conflicts with it

// ===== Init =====
function initMsg() {
  console.log("[WCRM MSG] Initializing...");
  createMsgButton();
  createMsgSidebar();
  createMsgModal();

  loadMsgData().then(function() {
    var msgInterval = setInterval(function() {
      try { if (!chrome.runtime || !chrome.runtime.id) { clearInterval(msgInterval); return; } } catch(e) { clearInterval(msgInterval); return; }
      checkSchedules();
    }, 30000);
    console.log("[WCRM MSG] Ready!");
  });
}

// Start after authentication (only if 'msg' feature is enabled)
document.addEventListener("wcrm-auth-ready", function() {
  if (window.__ezapHasFeature && window.__ezapHasFeature("msg")) {
    setTimeout(initMsg, 800);
  } else {
    console.log("[WCRM MSG] MSG feature not enabled for this user");
  }
});
if (window.__wcrmAuth && window.__ezapHasFeature && window.__ezapHasFeature("msg")) setTimeout(initMsg, 2500);
