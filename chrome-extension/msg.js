// ===== MSG - Mensagens Automaticas =====
// Sidebar with saved sequences + Modal editor
console.log("[WCRM MSG] Module loaded");

let msgSequences = {};
let msgSidebarOpen = false;
let msgEditing = null;
let msgTempItems = [];

// ===== Supabase Helper (thin wrapper over api.js) =====
function getMsgUserId() {
  return window.ezapUserId();
}

function msgSupaRest(path, method, body, prefer) {
  return window.ezapSupaRest(path, method, body, prefer);
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
  btn.className = "escalada-crm ezap-float-btn";
  btn.setAttribute("data-tooltip", "Mensagens Automáticas");
  btn.addEventListener("click", toggleMsgSidebar);
  if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "msg");
  else { btn.textContent = "MSG"; btn.style.background = "#4d96ff"; btn.style.color = "#fff"; }
  var container = document.getElementById("ezap-float-container");
  if (container) container.appendChild(btn);
  else document.body.appendChild(btn);
}

// ===== MSG Sidebar =====
function createMsgSidebar() {
  if (document.getElementById("wcrm-msg-sidebar")) return;

  var sidebar = document.createElement("div");
  sidebar.id = "wcrm-msg-sidebar";
  sidebar.className = "escalada-crm ezap-sidebar";

  sidebar.innerHTML = `
    <div class="ezap-header">
      <h3 class="ezap-header-title">Mensagens</h3>
      <button id="wcrm-msg-sidebar-close" class="ezap-header-close">&times;</button>
    </div>
    <div style="padding:12px 16px">
      <button id="wcrm-msg-create-btn" class="ezap-btn ezap-btn--secondary ezap-btn--full">+ Criar Sequência</button>
    </div>
    <div id="wcrm-msg-sidebar-list" class="ezap-content">
      <div class="ezap-empty">Nenhuma sequência salva</div>
    </div>
  `;

  document.body.appendChild(sidebar);

  document.getElementById("wcrm-msg-sidebar-close").addEventListener("click", toggleMsgSidebar);
  document.getElementById("wcrm-msg-create-btn").addEventListener("click", function() {
    resetMsgEditor();
    openMsgModal();
  });

  // Register with sidebar manager
  if (window.ezapSidebar) {
    window.ezapSidebar.register('msg', {
      show: function() { msgSidebarOpen = true; document.getElementById("wcrm-msg-sidebar").classList.add("open"); },
      hide: function() { msgSidebarOpen = false; var sb = document.getElementById("wcrm-msg-sidebar"); if (sb) sb.classList.remove("open"); },
      onOpen: function() { renderSavedSequences(); }
    });
  }
}

function toggleMsgSidebar() {
  if (window.ezapSidebar) { ezapSidebar.toggle('msg'); return; }
  // Fallback
  msgSidebarOpen = !msgSidebarOpen;
  var sb = document.getElementById("wcrm-msg-sidebar");
  if (msgSidebarOpen) sb.classList.add("open"); else sb.classList.remove("open");
  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();
  if (msgSidebarOpen) renderSavedSequences();
}

// Called from content.js when CRM sidebar opens (now handled by sidebar manager)
function closeMsgSidebar() {
  if (window.ezapSidebar) { ezapSidebar.close('msg'); return; }
  if (!msgSidebarOpen) return;
  msgSidebarOpen = false;
  var sb = document.getElementById("wcrm-msg-sidebar");
  if (sb) sb.classList.remove("open");
  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();
}

// ===== MSG Modal (Editor) =====
function createMsgModal() {
  if (document.getElementById("wcrm-msg-overlay")) return;

  var overlay = document.createElement("div");
  overlay.id = "wcrm-msg-overlay";
  overlay.className = "escalada-crm ezap-overlay";
  overlay.style.display = "none";

  overlay.innerHTML = `
    <div class="ezap-modal" style="width:520px;max-height:85vh;overflow:hidden;display:flex;flex-direction:column;padding:0">
      <div class="ezap-header">
        <h3 id="wcrm-msg-modal-title" class="ezap-header-title">Nova Sequência</h3>
        <button id="wcrm-msg-modal-close" class="ezap-header-close">&times;</button>
      </div>
      <div id="wcrm-msg-modal-content" class="ezap-content">

        <div style="margin-bottom:12px">
          <input id="wcrm-msg-seq-name" class="ezap-input" type="text" placeholder="Nome da sequência (ex: Boas Vindas Mentoria)" maxlength="50">
        </div>

        <div class="ezap-card" style="margin-bottom:12px">
          <div style="font-size:var(--ezap-text-sm);font-weight:600;color:var(--ezap-secondary);margin-bottom:6px">Variáveis disponíveis (dados do HubSpot):</div>
          <div style="font-size:var(--ezap-text-sm);color:var(--ezap-text-secondary);line-height:1.7">
            <code style="background:var(--ezap-bg-hover);padding:1px 5px;border-radius:3px;color:var(--ezap-success)">@nome</code> Primeiro nome &nbsp;
            <code style="background:var(--ezap-bg-hover);padding:1px 5px;border-radius:3px;color:var(--ezap-success)">@nomeCompleto</code> Nome completo<br>
            <code style="background:var(--ezap-bg-hover);padding:1px 5px;border-radius:3px;color:var(--ezap-success)">@email</code> E-mail &nbsp;
            <code style="background:var(--ezap-bg-hover);padding:1px 5px;border-radius:3px;color:var(--ezap-success)">@telefone</code> Telefone<br>
            <code style="background:var(--ezap-bg-hover);padding:1px 5px;border-radius:3px;color:var(--ezap-success)">@consultor</code> Consultor &nbsp;
            <code style="background:var(--ezap-bg-hover);padding:1px 5px;border-radius:3px;color:var(--ezap-success)">@reunioes</code> Reuniões adquiridas
          </div>
        </div>

        <div id="wcrm-msg-items" style="margin-bottom:12px">
          <div class="ezap-empty" style="border:1px dashed var(--ezap-border-light);border-radius:var(--ezap-radius-md)">
            Clique em "+ Mensagem" ou "+ Arquivo" para adicionar
          </div>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:16px">
          <button id="wcrm-msg-add-text" class="ezap-btn ezap-btn--ghost ezap-btn--sm" style="flex:1;border:1px solid var(--ezap-border-light);color:var(--ezap-secondary)">+ Mensagem</button>
          <button id="wcrm-msg-add-file" class="ezap-btn ezap-btn--ghost ezap-btn--sm" style="flex:1;border:1px solid var(--ezap-border-light);color:var(--ezap-orange)">+ Arquivo</button>
        </div>

        <input type="file" id="wcrm-msg-file-input" style="display:none" accept=".pdf,.doc,.docx,.mp3,.ogg,.wav,.opus,.m4a,.mp4,.jpg,.jpeg,.png">

        <div class="ezap-card" style="margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <input type="checkbox" id="wcrm-msg-schedule-check" style="accent-color:var(--ezap-secondary);width:16px;height:16px;cursor:pointer">
            <label for="wcrm-msg-schedule-check" style="font-size:var(--ezap-text-sm);color:var(--ezap-text-secondary);cursor:pointer">Agendar envio automático</label>
          </div>
          <input id="wcrm-msg-schedule-time" class="ezap-input" type="datetime-local" style="display:none;margin-top:6px">
        </div>

        <button id="wcrm-msg-save" class="ezap-btn ezap-btn--secondary ezap-btn--full">Salvar Sequência</button>
        <div id="wcrm-msg-save-status" style="font-size:var(--ezap-text-xs);text-align:center;margin-top:4px;min-height:14px"></div>
      </div>
    </div>
  `;

  // Add editor styles
  if (!document.getElementById("wcrm-msg-editor-style")) {
    var style = document.createElement("style");
    style.id = "wcrm-msg-editor-style";
    style.textContent =
      '.wcrm-msg-editor[data-empty="true"]:before { content: attr(data-placeholder); color: #8696a0; font-style: italic; pointer-events: none; }' +
      '.wcrm-msg-editor b, .wcrm-msg-editor strong { font-weight: bold !important; }' +
      '.wcrm-msg-editor i, .wcrm-msg-editor em { font-style: italic !important; }' +
      '.wcrm-msg-editor u { text-decoration: underline !important; }' +
      '.wcrm-msg-editor ul, .wcrm-msg-editor ol { margin: 2px 0; padding-left: 20px; list-style: disc !important; }' +
      '.wcrm-msg-editor li { margin: 1px 0; display: list-item !important; list-style-type: disc !important; }';
    document.head.appendChild(style);
  }

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
  title.textContent = msgEditing ? "Editar Sequência" : "Nova Sequência";
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
  if (saveBtn) saveBtn.textContent = "Salvar Sequência";
  var statusEl = document.getElementById("wcrm-msg-save-status");
  if (statusEl) statusEl.innerHTML = "";
  renderMsgItems();
}

function addMsgItem(type, content, fileName) {
  syncEditorValues(); // Preserve existing editor content before re-render
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

  var statusEl = document.getElementById("wcrm-msg-save-status");

  if (file.size > 50 * 1024 * 1024) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--ezap-danger)">Arquivo muito grande (max 50MB)</span>';
    e.target.value = "";
    return;
  }

  var originalName = file.name;
  var mimeType = file.type || "application/octet-stream";
  var fileSize = file.size;

  // Show upload progress bar
  var progressId = "wcrm-msg-upload-progress";
  var container = document.getElementById("wcrm-msg-items");
  var progressDiv = document.createElement("div");
  progressDiv.id = progressId;
  progressDiv.className = "ezap-card";
  progressDiv.style.cssText = "border-left:3px solid var(--ezap-orange)";
  progressDiv.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span style="color:var(--ezap-orange);font-size:var(--ezap-text-sm);font-weight:var(--ezap-font-semibold)">\uD83D\uDCCE ' + escapeHtml(originalName) + '</span>' +
    '</div>' +
    '<div class="ezap-progress-bar">' +
      '<div id="wcrm-msg-upload-fill" class="ezap-progress-fill" style="background:var(--ezap-orange);width:0%"></div>' +
    '</div>' +
    '<div id="wcrm-msg-upload-text" style="font-size:var(--ezap-text-xs);color:var(--ezap-text-secondary);margin-top:4px">Lendo arquivo...</div>';
  if (container) container.appendChild(progressDiv);

  function updateUploadProgress(pct, text) {
    var fill = document.getElementById("wcrm-msg-upload-fill");
    var txt = document.getElementById("wcrm-msg-upload-text");
    if (fill) fill.style.width = pct + "%";
    if (txt) txt.textContent = text;
  }

  var reader = new FileReader();
  reader.onprogress = function(ev) {
    if (ev.lengthComputable) {
      var pct = Math.round((ev.loaded / ev.total) * 40);
      updateUploadProgress(pct, "Lendo arquivo... " + pct + "%");
    }
  };
  reader.onload = function(ev) {
    updateUploadProgress(45, "Enviando para nuvem...");
    var base64 = ev.target.result.split(",")[1];
    var uid = getMsgUserId() || "anon";
    var safeFileName = uid + "/" + Date.now() + "_" + originalName.replace(/[^a-zA-Z0-9._-]/g, "_");

    // Simulate progress during upload
    var uploadPct = 45;
    var uploadTimer = setInterval(function() {
      if (uploadPct < 90) {
        uploadPct += 5;
        updateUploadProgress(uploadPct, "Enviando para nuvem... " + uploadPct + "%");
      }
    }, 500);

    chrome.runtime.sendMessage({
      action: "upload_msg_file",
      base64: base64,
      fileName: safeFileName,
      contentType: mimeType,
    }, function(resp) {
      clearInterval(uploadTimer);
      var pg = document.getElementById(progressId);
      if (resp && resp.ok) {
        updateUploadProgress(100, "Concluído!");
        setTimeout(function() {
          if (pg) pg.remove();
          addMsgItem("file", resp.url, originalName);
          msgTempItems[msgTempItems.length - 1].mimeType = mimeType;
          msgTempItems[msgTempItems.length - 1].fileSize = fileSize;
        }, 600);
      } else {
        if (pg) {
          pg.style.borderLeftColor = "var(--ezap-danger)";
          updateUploadProgress(0, "Erro: " + (resp ? resp.error : "desconhecido"));
          setTimeout(function() { if (pg) pg.remove(); }, 4000);
        }
      }
    });
  };
  reader.readAsDataURL(file);
  e.target.value = "";
}

function syncEditorValues() {
  document.querySelectorAll(".wcrm-msg-editor").forEach(function(ed) {
    var idx = parseInt(ed.dataset.idx);
    if (msgTempItems[idx]) msgTempItems[idx].content = ed.innerHTML;
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
    container.innerHTML = '<div class="ezap-empty" style="border:1px dashed var(--ezap-border-light);border-radius:var(--ezap-radius-md)">Clique em "+ Mensagem" ou "+ Arquivo" para adicionar</div>';
    return;
  }

  var html = '';
  msgTempItems.forEach(function(item, idx) {
    var isText = item.type === 'text';
    var borderColor = isText ? '#4d96ff' : '#ff922b';
    var typeLabel = isText ? 'Mensagem' : (item.fileName || 'Arquivo');
    var typeIcon = isText ? '' : '\uD83D\uDCCE ';

    html += '<div class="wcrm-msg-item ezap-card" style="border-left:3px solid ' + borderColor + '">';

    // Header
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
    html += '<span style="font-size:var(--ezap-text-sm);font-weight:var(--ezap-font-semibold);color:' + borderColor + '">' + (idx + 1) + '. ' + typeIcon + typeLabel + '</span>';
    html += '<span class="wcrm-msg-remove" data-idx="' + idx + '" style="color:var(--ezap-danger);font-size:16px;cursor:pointer;padding:0 4px;line-height:1" title="Remover">&times;</span>';
    html += '</div>';

    // Content
    if (isText) {
      // Formatting toolbar
      html += '<div class="wcrm-msg-toolbar ezap-editor-toolbar" data-idx="' + idx + '">';
      html += '<button data-cmd="bold" title="Negrito"><b>B</b></button>';
      html += '<button data-cmd="italic" title="Itálico"><i>I</i></button>';
      html += '<button data-cmd="insertUnorderedList" title="Lista">\u2022</button>';
      html += '</div>';
      // Rich text editor
      var contentHtml = item.content || '';
      html += '<div class="wcrm-msg-editor ezap-editor-body" contenteditable="true" data-idx="' + idx + '" data-placeholder="Digite a mensagem..." style="white-space:pre-wrap;word-wrap:break-word">' + contentHtml + '</div>';
    } else {
      // File info - show from URL or legacy base64
      var sizeInfo = '';
      if (item.fileSize) {
        sizeInfo = ' (' + Math.round(item.fileSize / 1024) + ' KB)';
      } else if (item.content && item.content.indexOf('http') !== 0) {
        try { sizeInfo = ' (' + Math.round(atob(item.content).length / 1024) + ' KB)'; } catch(e) {}
      }
      html += '<div style="font-size:var(--ezap-text-sm);color:var(--ezap-text-secondary);padding:4px 0;display:flex;align-items:center;gap:4px">';
      html += '<span style="color:var(--ezap-orange)">\uD83D\uDCC4</span> ' + escapeHtml(item.fileName || 'Arquivo') + '<span style="color:var(--ezap-border-light)">' + sizeInfo + '</span>';
      if (item.content && item.content.indexOf('http') === 0) {
        html += ' <span style="color:var(--ezap-success);font-size:var(--ezap-text-xs)">&#9729; Na nuvem</span>';
      }
      html += '</div>';
    }

    // Interval
    var intervalLabel = idx === 0 ? 'Aguardar antes de iniciar' : 'Aguardar antes de enviar';
    html += '<div style="display:flex;align-items:center;gap:6px;margin-top:8px">';
    html += '<span style="font-size:var(--ezap-text-sm);color:var(--ezap-text-secondary)">' + intervalLabel + '</span>';
    html += '<input type="number" class="wcrm-msg-interval ezap-input ezap-input--sm" data-idx="' + idx + '" value="' + item.interval + '" min="0" max="3600" style="width:55px;text-align:center">';
    html += '<span style="font-size:var(--ezap-text-sm);color:var(--ezap-text-secondary)">seg</span>';
    html += '</div>';

    html += '</div>';
  });

  container.innerHTML = html;

  // Wire remove buttons
  container.querySelectorAll(".wcrm-msg-remove").forEach(function(btn) {
    btn.addEventListener("click", function() {
      syncEditorValues();
      removeMsgItem(parseInt(btn.dataset.idx));
    });
  });

  // Wire toolbar buttons
  container.querySelectorAll(".wcrm-msg-toolbar button").forEach(function(btn) {
    btn.addEventListener("mousedown", function(e) {
      e.preventDefault(); // Keep focus on editor
      var idx = parseInt(btn.parentElement.dataset.idx);
      var editor = container.querySelector('.wcrm-msg-editor[data-idx="' + idx + '"]');
      if (editor) {
        editor.focus();
        document.execCommand(btn.dataset.cmd, false, null);
      }
    });
  });

  // Placeholder behavior for editors
  container.querySelectorAll(".wcrm-msg-editor").forEach(function(ed) {
    function updatePlaceholder() {
      if (!ed.textContent.trim() && !ed.querySelector("img")) {
        ed.setAttribute("data-empty", "true");
      } else {
        ed.removeAttribute("data-empty");
      }
    }
    ed.addEventListener("input", updatePlaceholder);
    ed.addEventListener("focus", updatePlaceholder);
    ed.addEventListener("blur", updatePlaceholder);
    updatePlaceholder();
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
    nameInput.style.borderColor = "var(--ezap-danger)";
    statusEl.innerHTML = '<span style="color:var(--ezap-danger)">Digite um nome para a sequência</span>';
    setTimeout(function() { nameInput.style.borderColor = ""; }, 2000);
    return;
  }

  if (msgTempItems.length === 0) {
    statusEl.innerHTML = '<span style="color:var(--ezap-danger)">Adicione pelo menos uma mensagem</span>';
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
      var item = {
        type: m.type,
        content: m.content,
        fileName: m.fileName || "",
        mimeType: m.mimeType || "",
        interval: m.interval,
      };
      if (m.fileSize) item.fileSize = m.fileSize;
      return item;
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

  statusEl.innerHTML = '<span style="color:var(--ezap-success)">Sequência salva!</span>';
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
    container.innerHTML = '<div class="ezap-empty">Nenhuma sequência salva.<br>Clique em "+ Criar Sequência" para começar.</div>';
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

    html += '<div class="ezap-card ezap-card--sequence">';

    // Name + schedule badge
    html += '<div class="ezap-seq-name">';
    html += '<span>' + escapeHtml(seq.name) + '</span>';
    if (seq.schedule && !seq.sent) {
      var sd = new Date(seq.schedule);
      html += '<span class="ezap-badge ezap-badge--warning" style="font-size:9px">';
      html += '\u23F0 ' + sd.toLocaleString("pt-BR", {day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
      html += '</span>';
    }
    html += '</div>';

    // Description
    html += '<div class="ezap-seq-meta">' + desc + '</div>';

    // Preview - extract plain text from HTML content
    var firstText = seq.messages.find(function(m) { return m.type === 'text' && m.content; });
    if (firstText) {
      var tmpDiv = document.createElement("div");
      tmpDiv.innerHTML = firstText.content;
      var plainPreview = (tmpDiv.textContent || tmpDiv.innerText || "").substring(0, 50);
      if (plainPreview.length >= 50) plainPreview += '...';
      html += '<div class="ezap-seq-preview">' + escapeHtml(plainPreview) + '</div>';
    }

    // Buttons
    html += '<div class="ezap-seq-actions">';
    html += '<button class="wcrm-msg-send ezap-btn ezap-btn--primary ezap-btn--sm" data-id="' + id + '" style="flex:1">\u25B6 Enviar</button>';
    html += '<button class="wcrm-msg-edit ezap-btn ezap-btn--ghost ezap-btn--sm" data-id="' + id + '" title="Editar">\u270F</button>';
    html += '<button class="wcrm-msg-delete ezap-btn ezap-btn--danger ezap-btn--sm" data-id="' + id + '" title="Excluir">\u2715</button>';
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

  document.getElementById("wcrm-msg-save").textContent = "Salvar Edição";
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

// Convert HTML from rich editor to WhatsApp-compatible plain text with formatting
function htmlToWhatsAppText(html) {
  if (!html) return "";
  var div = document.createElement("div");
  div.innerHTML = html;

  function processNode(node) {
    var result = "";
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeType === 3) {
        result += child.textContent;
      } else if (child.nodeType === 1) {
        var tag = child.tagName.toLowerCase();
        var inner = processNode(child);
        if (tag === "br") {
          result += "\n";
        } else if (tag === "div" || tag === "p") {
          // Each div/p = new line in contenteditable
          if (result && !result.endsWith("\n")) result += "\n";
          result += inner;
        } else if (tag === "b" || tag === "strong") {
          var t = inner.trim();
          if (t) {
            var lead = inner.match(/^\s*/)[0];
            var trail = inner.match(/\s*$/)[0];
            result += lead + "*" + t + "*" + trail;
          }
        } else if (tag === "i" || tag === "em") {
          var t = inner.trim();
          if (t) {
            var lead = inner.match(/^\s*/)[0];
            var trail = inner.match(/\s*$/)[0];
            result += lead + "_" + t + "_" + trail;
          }
        } else if (tag === "u") {
          result += inner;
        } else if (tag === "ul" || tag === "ol") {
          if (result && !result.endsWith("\n")) result += "\n";
          result += inner;
        } else if (tag === "li") {
          result += "- " + inner.trim() + "\n";
        } else {
          result += inner;
        }
      }
    }
    return result;
  }

  return processNode(div).replace(/\n{3,}/g, "\n\n").trim();
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
  progress.className = "escalada-crm ezap-card ezap-card--sequence";
  Object.assign(progress.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "100001",
    minWidth: "240px",
  });
  progress.innerHTML = '<div class="ezap-seq-name" style="margin-bottom:6px">\uD83D\uDCE4 ' + escapeHtml(seq.name) + '</div>' +
    '<div class="ezap-progress-bar" id="wcrm-msg-progress-bar" style="margin-bottom:6px"><div id="wcrm-msg-progress-fill" class="ezap-progress-fill ezap-progress-fill--secondary" style="width:0%"></div></div>' +
    '<div id="wcrm-msg-progress-text" class="ezap-seq-meta">Preparando...</div>';
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
      if (pg) pg.style.borderLeftColor = "var(--ezap-success)";
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
        // Convert HTML to WhatsApp text format, then replace variables
        var plainText = htmlToWhatsAppText(msg.content);
        sendPromise = typeInWhatsApp(replaceMsgVariables(plainText));
      } else if (msg.type === 'file') {
        // Check if content is a URL (Supabase) or legacy base64
        if (msg.content && msg.content.indexOf('http') === 0) {
          // Download from Supabase first, then send
          sendPromise = downloadAndSendFile(msg.content, msg.fileName, msg.mimeType);
        } else {
          sendPromise = sendFileInWhatsApp(msg.content, msg.fileName, msg.mimeType);
        }
      } else {
        sendPromise = Promise.resolve(true);
      }

      sendPromise.then(function() {
        idx++;
        sendNext();
      }).catch(function(err) {
        updateProgress("\u274C Erro na msg " + (idx + 1) + ": " + err, Math.round((idx / total) * 100));
        var pg = document.getElementById("wcrm-msg-progress");
        if (pg) pg.style.borderLeftColor = "var(--ezap-danger)";
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
      reject("Campo de mensagem não encontrado. Abra uma conversa primeiro.");
      return;
    }

    input.focus();

    // Clear existing content
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // Use clipboard paste to preserve line breaks
    // WhatsApp Web's paste handler properly converts \n to line breaks
    var clipData = new DataTransfer();
    clipData.setData('text/plain', text);
    var pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipData
    });
    input.dispatchEvent(pasteEvent);

    // Fallback: if paste didn't work (input still empty), use line-by-line approach
    setTimeout(function() {
      var currentText = input.textContent || input.innerText || "";
      if (currentText.trim().length === 0) {
        console.log("[WCRM MSG] Paste failed, using Shift+Enter fallback");
        input.focus();
        var lines = text.split('\n');
        lines.forEach(function(line, i) {
          if (line) {
            document.execCommand('insertText', false, line);
          }
          if (i < lines.length - 1) {
            // Simulate Shift+Enter for line break
            var shiftEnter = new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
              shiftKey: true, bubbles: true, cancelable: true
            });
            input.dispatchEvent(shiftEnter);
            // Also insert via InputEvent for React
            input.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true, cancelable: true, inputType: 'insertLineBreak',
            }));
            // Manual DOM insertion
            var sel = window.getSelection();
            if (sel.rangeCount) {
              var range = sel.getRangeAt(0);
              range.deleteContents();
              var br = document.createElement('br');
              range.insertNode(br);
              range.setStartAfter(br);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            input.dispatchEvent(new InputEvent('input', {
              bubbles: true, cancelable: false, inputType: 'insertLineBreak',
            }));
          }
        });
        // Trigger React change detection
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

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
    }, 200);
  });
}

// ===== WhatsApp Web DOM - Send File (attach button + smart input detection) =====
function sendFileInWhatsApp(fileBase64, fileName, mimeType) {
  return new Promise(function(resolve, reject) {
    try {
      // Convert base64 to File object
      var byteString = atob(fileBase64);
      var ab = new ArrayBuffer(byteString.length);
      var ia = new Uint8Array(ab);
      for (var i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      var blob = new Blob([ab], { type: mimeType || 'application/octet-stream' });
      var file = new File([blob], fileName, { type: mimeType || 'application/octet-stream' });

      // STEP 1: Snapshot existing file inputs BEFORE opening attach menu
      var existingInputs = new Set();
      document.querySelectorAll('input[type="file"]').forEach(function(fi) {
        existingInputs.add(fi);
      });
      console.log("[WCRM MSG] Existing file inputs before attach:", existingInputs.size);

      // STEP 2: Find and click the attach button
      var attachBtn = document.querySelector('button[aria-label="Anexar"]') ||
                      document.querySelector('span[data-icon="plus-rounded"]') ||
                      document.querySelector('span[data-icon="plus"]') ||
                      document.querySelector('[data-testid="clip"]') ||
                      document.querySelector('span[data-icon="attach-menu-plus"]');

      if (!attachBtn) {
        reject("Botão de anexo não encontrado");
        return;
      }

      (attachBtn.closest('button') || attachBtn).click();
      console.log("[WCRM MSG] Attach button clicked");

      // STEP 3: Wait for menu, then click "Documento"
      setTimeout(function() {
        var docOption = document.querySelector('button[aria-label="Documento"]') ||
                        document.querySelector('[data-testid="mi-attach-document"]') ||
                        document.querySelector('span[data-icon="attach-document"]');

        if (docOption) {
          (docOption.closest('button') || docOption.closest('li') || docOption).click();
          console.log("[WCRM MSG] Documento option clicked");
        } else {
          console.log("[WCRM MSG] Documento option NOT found, trying direct input");
        }

        // STEP 4: Poll for a NEW file input that didn't exist before
        var inputAttempts = 0;
        var maxInputAttempts = 20;

        function findNewInput() {
          inputAttempts++;
          var newInput = null;

          // Strategy A: Find a file input that didn't exist before (the one WhatsApp just created)
          document.querySelectorAll('input[type="file"]').forEach(function(fi) {
            if (existingInputs.has(fi)) return; // skip pre-existing
            if (fi.id && fi.id.indexOf('wcrm') !== -1) return; // skip ours
            newInput = fi;
          });

          if (newInput) {
            console.log("[WCRM MSG] Found NEW file input, accept:", newInput.accept);
            setFileAndSend(newInput);
            return;
          }

          // Strategy B: If no new input appeared, look for document input by accept attribute
          if (inputAttempts > 5) {
            document.querySelectorAll('input[type="file"]').forEach(function(fi) {
              if (fi.id && fi.id.indexOf('wcrm') !== -1) return;
              var acc = (fi.accept || '').trim();
              if (acc === '*' || acc === '*/*' || acc === '' || !fi.hasAttribute('accept')) {
                if (!newInput) newInput = fi;
              }
            });
            if (newInput) {
              console.log("[WCRM MSG] Found document input by accept attr:", newInput.accept);
              setFileAndSend(newInput);
              return;
            }
          }

          // Strategy C: Last resort — use any non-wcrm file input
          if (inputAttempts >= maxInputAttempts) {
            document.querySelectorAll('input[type="file"]').forEach(function(fi) {
              if (fi.id && fi.id.indexOf('wcrm') !== -1) return;
              if (!newInput) newInput = fi;
            });
            if (newInput) {
              console.log("[WCRM MSG] Using fallback file input, accept:", newInput.accept);
              setFileAndSend(newInput);
            } else {
              reject("Input de arquivo não encontrado");
            }
            return;
          }

          setTimeout(findNewInput, 300);
        }

        function setFileAndSend(fileInput) {
          // Set file via DataTransfer
          var dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          console.log("[WCRM MSG] File set on input, waiting for preview...");

          // Wait for preview screen, then click send
          var sendAttempts = 0;
          var maxSendAttempts = 30;

          function trySendFile() {
            sendAttempts++;

            // WhatsApp's send button in the file preview screen
            var sendBtn = document.querySelector('span[data-icon="send"]') ||
                          document.querySelector('span[data-icon="wds-ic-send-filled"]') ||
                          document.querySelector('[data-testid="send"]') ||
                          document.querySelector('button[aria-label="Enviar"]') ||
                          document.querySelector('button[aria-label="Send"]');

            if (sendBtn) {
              var button = sendBtn.closest('button') || sendBtn;
              button.click();
              console.log("[WCRM MSG] File send button clicked on attempt", sendAttempts);
              setTimeout(function() { resolve(true); }, 1500);
              return;
            }

            if (sendAttempts < maxSendAttempts) {
              setTimeout(trySendFile, 500);
            } else {
              reject("Botão enviar não encontrado após anexo");
            }
          }

          setTimeout(trySendFile, 2000);
        }

        // Start polling for new input after a short delay
        setTimeout(findNewInput, 500);
      }, 700);

    } catch (e) {
      reject("Erro ao processar arquivo: " + e.message);
    }
  });
}

// ===== Download file from Supabase and send =====
function downloadAndSendFile(fileUrl, fileName, mimeType) {
  return new Promise(function(resolve, reject) {
    chrome.runtime.sendMessage({
      action: "download_msg_file",
      url: fileUrl,
    }, function(resp) {
      if (chrome.runtime.lastError) {
        reject("Erro ao baixar arquivo: " + chrome.runtime.lastError.message);
        return;
      }
      if (resp && resp.ok) {
        sendFileInWhatsApp(resp.base64, fileName, resp.mimeType || mimeType).then(resolve).catch(reject);
      } else {
        reject("Erro ao baixar arquivo: " + (resp ? resp.error : "desconhecido"));
      }
    });
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
