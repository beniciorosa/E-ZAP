// ===== WhatsApp CRM - Content Script =====
console.log("[WCRM] Content script loaded");

const LABEL_COLORS = [
  "#25d366", "#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff",
  "#ff922b", "#cc5de8", "#20c997", "#ff8787", "#748ffc",
];

let currentPhone = null;
let currentName = null;
let labelsData = {};
let sidebarOpen = false;
let tagSidebarOpen = false;
let labelTemplates = [];

// ===== Floating buttons container =====
function getButtonContainer() {
  var c = document.getElementById("ezap-float-container");
  if (c) return c;
  c = document.createElement("div");
  c.id = "ezap-float-container";
  // CSS handles all positioning via #ezap-float-container rule
  document.body.appendChild(c);
  // Shrink WA app slightly to make room for the rail
  var appEl = document.getElementById("app");
  if (appEl && !appEl.dataset.ezapRail) {
    appEl.dataset.ezapRail = "1";
    appEl.style.width = "calc(100% - 62px)";
    appEl.style.maxWidth = "calc(100% - 62px)";
  }
  return c;
}

// ===== Create button IMMEDIATELY =====
function createToggleButton() {
  if (document.getElementById("wcrm-toggle")) return;
  console.log("[WCRM] Creating toggle button");
  const btn = document.createElement("button");
  btn.id = "wcrm-toggle";
  btn.className = "escalada-crm ezap-float-btn";
  btn.setAttribute("data-tooltip", "CRM");
  btn.addEventListener("click", toggleSidebar);
  if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "crm");
  else { btn.textContent = "CRM"; btn.style.background = "#00a884"; btn.style.color = "#111b21"; }
  getButtonContainer().appendChild(btn);
  console.log("[WCRM] Toggle button added to page");
}

// ===== Sidebar =====
function createSidebar() {
  if (document.getElementById("wcrm-sidebar")) return;
  console.log("[WCRM] Creating sidebar");

  const sidebar = document.createElement("div");
  sidebar.id = "wcrm-sidebar";
  sidebar.className = "escalada-crm ezap-sidebar";

  sidebar.innerHTML = `
    <div class="ezap-header">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:32px;height:32px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
        <h3 class="ezap-header-title">Escalada CRM</h3>
      </div>
      <button id="wcrm-close-btn" class="ezap-header-close">&times;</button>
    </div>
    <div id="wcrm-content" class="ezap-content">
      <div id="wcrm-no-chat" class="ezap-empty">
        Abra uma conversa para ver as informações do contato
      </div>
      <div id="wcrm-chat-info" style="display:none">
        <div id="wcrm-name" class="ezap-contact-name"></div>
        <div id="wcrm-phone" style="display:none"></div>

        <div class="ezap-section">
          <div id="wcrm-hubspot-container">
            <div class="ezap-loading">Buscando no HubSpot...</div>
          </div>
        </div>

        <div class="ezap-section">
          <div class="ezap-section-title">Etiquetas</div>
          <div id="wcrm-labels-container" class="ezap-labels"></div>
        </div>

        <div class="ezap-section">
          <div class="ezap-section-title">Observações</div>
          <div class="ezap-editor-wrapper">
            <div id="wcrm-editor-toolbar" class="ezap-editor-toolbar">
              <button data-cmd="bold" title="Negrito"><b>B</b></button>
              <button data-cmd="italic" title="Itálico"><i>I</i></button>
              <button data-cmd="underline" title="Sublinhado"><u>U</u></button>
              <button data-cmd="insertUnorderedList" title="Lista">&bull; &equiv;</button>
            </div>
            <div id="wcrm-notes-editor" class="ezap-editor-body" contenteditable="true" data-placeholder="Escreva uma observação..."></div>
          </div>
          <button id="wcrm-save-note-btn" class="ezap-btn ezap-btn--secondary ezap-btn--full" style="margin-top:6px">Salvar Observação</button>
          <div id="wcrm-save-status" style="font-size:10px;text-align:center;margin-top:4px;min-height:14px"></div>
          <div id="wcrm-notes-history" style="margin-top:8px"></div>
        </div>

        <hr class="ezap-separator">

        <div class="ezap-section">
          <div class="ezap-section-title">Reuniões</div>
          <div id="wcrm-meetings-container">
            <div class="ezap-empty">Aguardando dados do HubSpot...</div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(sidebar);

  // Events
  document.getElementById("wcrm-close-btn").addEventListener("click", toggleSidebar);

  // Click name to copy
  document.getElementById("wcrm-name").addEventListener("click", function() {
    var name = this.textContent;
    if (!name) return;
    navigator.clipboard.writeText(name).then(function() {
      var el = document.getElementById("wcrm-name");
      var orig = el.textContent;
      el.textContent = orig + " \u2713";
      setTimeout(function() { el.textContent = orig; }, 1200);
    });
  });

  // Rich text toolbar buttons
  document.querySelectorAll("#wcrm-editor-toolbar button").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.preventDefault();
      document.execCommand(btn.dataset.cmd, false, null);
      document.getElementById("wcrm-notes-editor").focus();
    });
  });

  // Placeholder behavior for contenteditable
  var editor = document.getElementById("wcrm-notes-editor");
  editor.addEventListener("focus", function() { this.dataset.focused = "1"; });
  editor.addEventListener("blur", function() { this.dataset.focused = ""; });

  // Intercept image paste — resize, upload to Supabase, insert as URL
  editor.addEventListener("paste", function(e) {
    var items = (e.clipboardData || e.originalEvent.clipboardData).items;
    if (!items) return;

    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        e.preventDefault();
        var file = items[i].getAsFile();
        if (!file) return;
        handleImageUpload(file, editor);
        return;
      }
    }
  });

  // Also support drag & drop images
  editor.addEventListener("drop", function(e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (var i = 0; i < files.length; i++) {
      if (files[i].type.indexOf("image") !== -1) {
        e.preventDefault();
        handleImageUpload(files[i], editor);
        return;
      }
    }
  });

  // Save note button
  document.getElementById("wcrm-save-note-btn").addEventListener("click", saveNote);

  console.log("[WCRM] Sidebar created");

  // Register with sidebar manager
  if (window.ezapSidebar) {
    window.ezapSidebar.register('crm', {
      show: function() { sidebarOpen = true; document.getElementById("wcrm-sidebar").classList.add("open"); },
      hide: function() { sidebarOpen = false; document.getElementById("wcrm-sidebar").classList.remove("open"); },
      onOpen: function() { if (currentPhone) renderContactInfo(); }
    });
  }
}

// ===== Toggle =====
function toggleSidebar() {
  if (window.ezapSidebar) { ezapSidebar.toggle('crm'); return; }
  // Fallback (shouldn't happen — sidebar-manager loads before content.js)
  var sidebar = document.getElementById("wcrm-sidebar");
  sidebarOpen = !sidebarOpen;
  if (sidebarOpen) sidebar.classList.add("open");
  else sidebar.classList.remove("open");
}

function updateFloatingButtons() {
  // Now handled by sidebar manager — kept for backward compatibility
  if (window.ezapSidebar) return; // Manager handles repositioning
  var container = document.getElementById("ezap-float-container");
  if (!container) return;
  container.style.display = "flex";
}

// ===== TAG Sidebar (Label Management) =====
function createTagSidebar() {
  if (document.getElementById("wcrm-tag-sidebar")) return;
  var sidebar = document.createElement("div");
  sidebar.id = "wcrm-tag-sidebar";
  sidebar.className = "escalada-crm ezap-sidebar";
  sidebar.innerHTML = [
    '<div class="ezap-header">',
    '  <div style="display:flex;align-items:center;gap:10px">',
    '    <div style="width:32px;height:32px;border-radius:50%;background:#f59e0b;display:flex;align-items:center;justify-content:center"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg></div>',
    '    <h3 class="ezap-header-title">Gerenciar Etiquetas</h3>',
    '  </div>',
    '  <button id="wcrm-tag-close" class="ezap-header-close">&times;</button>',
    '</div>',
    '<div class="ezap-content">',
    '  <div class="ezap-section">',
    '    <div class="ezap-section-title">Nova Etiqueta</div>',
    '    <div style="display:flex;gap:6px">',
    '      <input type="text" id="wcrm-tag-input" class="ezap-input" placeholder="Nome da etiqueta..." maxlength="30" style="flex:1">',
    '      <button id="wcrm-tag-add-btn" class="ezap-btn ezap-btn--primary">Criar</button>',
    '    </div>',
    '    <div id="wcrm-tag-color-picker" class="ezap-color-picker" style="margin-top:8px"></div>',
    '  </div>',
    '  <hr class="ezap-separator">',
    '  <div class="ezap-section-title">Etiquetas Criadas</div>',
    '  <div id="wcrm-tag-list"></div>',
    '  <hr class="ezap-separator">',
    '  <div id="wcrm-tag-contact-section"></div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(sidebar);

  document.getElementById("wcrm-tag-close").addEventListener("click", toggleTagSidebar);
  document.getElementById("wcrm-tag-add-btn").addEventListener("click", addLabelTemplate);
  document.getElementById("wcrm-tag-input").addEventListener("keydown", function(e) {
    if (e.key === "Enter") addLabelTemplate();
  });
  renderTagColorPicker();

  // Register with sidebar manager
  if (window.ezapSidebar) {
    window.ezapSidebar.register('tag', {
      show: function() { tagSidebarOpen = true; document.getElementById("wcrm-tag-sidebar").classList.add("open"); },
      hide: function() { tagSidebarOpen = false; document.getElementById("wcrm-tag-sidebar").classList.remove("open"); },
      onOpen: function() { renderTagList(); renderTagContactSection(); }
    });
  }
}

function toggleTagSidebar() {
  createTagSidebar();
  if (window.ezapSidebar) { ezapSidebar.toggle('tag'); return; }
  // Fallback
  var sidebar = document.getElementById("wcrm-tag-sidebar");
  tagSidebarOpen = !tagSidebarOpen;
  if (tagSidebarOpen) sidebar.classList.add("open");
  else sidebar.classList.remove("open");
}

// ===== Header Tag Dropdown (floating widget) =====
function showHeaderTagDropdown(anchorBtn, chatName) {
  var existing = document.getElementById("wcrm-header-tag-dropdown");
  if (existing) { existing.remove(); return; }
  if (!currentPhone) return;

  var t = (typeof getTheme === "function") ? getTheme() : {
    bgSecondary: "#202c33", bgHover: "#2a3942", border: "#2a3942",
    text: "#e9edef", textSecondary: "#8696a0"
  };
  var rect = anchorBtn.getBoundingClientRect();
  var minW = 220;
  var dropdown = document.createElement("div");
  dropdown.id = "wcrm-header-tag-dropdown";
  dropdown.className = "escalada-crm ezap-dropdown";
  Object.assign(dropdown.style, {
    position: "fixed",
    top: (rect.bottom + 12) + "px",
    left: Math.max(8, rect.left + (rect.width / 2) - (minW / 2)) + "px",
    minWidth: minW + "px",
    maxHeight: "360px",
  });

  renderHeaderTagDropdown(dropdown, chatName, t);
  document.body.appendChild(dropdown);

  setTimeout(function() {
    function closeDropdown(e) {
      if (!dropdown.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener('click', closeDropdown);
      }
    }
    document.addEventListener('click', closeDropdown);
  }, 50);
}

function renderHeaderTagDropdown(dropdown, chatName, t) {
  dropdown.innerHTML = "";
  var data = getContactData(currentPhone);
  var assigned = (data.labels || []).map(function(l) { return l.name.toLowerCase(); });

  // Existing templates
  if (!labelTemplates || labelTemplates.length === 0) {
    var empty = document.createElement("div");
    empty.className = "ezap-empty";
    empty.textContent = "Nenhuma etiqueta criada";
    dropdown.appendChild(empty);
  } else {
    labelTemplates.forEach(function(tmpl) {
      var isAssigned = assigned.indexOf(tmpl.name.toLowerCase()) >= 0;
      var row = document.createElement("div");
      row.className = "wcrm-header-tag-opt ezap-dropdown-item";
      var iconChar = isAssigned ? '&#10003;' : '&plus;';
      var iconColor = isAssigned ? tmpl.color : 'var(--ezap-text-secondary)';
      row.innerHTML =
        '<span class="ezap-aba-color" style="width:10px;height:10px;background:' + tmpl.color + '"></span>' +
        '<span style="font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + tmpl.name + '</span>' +
        '<span style="color:' + iconColor + ';font-size:14px;font-weight:bold">' + iconChar + '</span>';
      row.addEventListener('click', function(e) {
        e.stopPropagation();
        if (isAssigned) {
          var d = getContactData(currentPhone);
          var idx = -1;
          (d.labels || []).forEach(function(l, i) { if (l.name.toLowerCase() === tmpl.name.toLowerCase()) idx = i; });
          if (idx >= 0) {
            var removed = d.labels[idx];
            d.labels.splice(idx, 1);
            setContactData(currentPhone, d);
            if (typeof renderLabels === "function") renderLabels();
            var uid = getLabelUserId();
            if (uid && removed) {
              var key = contactKey(currentPhone);
              sendBgMessage({ action: "supabase_rest", path: "/rest/v1/labels?user_id=eq." + uid + "&contact_phone=eq." + encodeURIComponent(key) + "&text=eq." + encodeURIComponent(removed.name), method: "DELETE", prefer: "return=minimal" });
            }
          }
        } else {
          assignLabel(tmpl.name, tmpl.color);
        }
        renderHeaderTagDropdown(dropdown, chatName, t);
      });
      dropdown.appendChild(row);
    });
  }

  // Divider
  var divider = document.createElement("div");
  divider.className = "ezap-dropdown-divider";
  dropdown.appendChild(divider);

  // "Criar nova etiqueta" -> opens tag sidebar
  var createRow = document.createElement("div");
  createRow.id = "wcrm-header-tag-create";
  createRow.className = "ezap-dropdown-item";
  createRow.innerHTML =
    '<span style="color:var(--ezap-primary);font-size:16px;font-weight:bold;width:10px;display:inline-block;text-align:center">+</span>' +
    '<span style="font-size:12px;font-weight:500">Criar nova etiqueta</span>';
  createRow.addEventListener('click', function(e) {
    e.stopPropagation();
    dropdown.remove();
    if (typeof toggleTagSidebar === "function") toggleTagSidebar();
  });
  dropdown.appendChild(createRow);
}

function renderTagColorPicker() {
  var picker = document.getElementById("wcrm-tag-color-picker");
  if (!picker) return;
  picker.innerHTML = "";
  LABEL_COLORS.forEach(function(color, i) {
    var dot = document.createElement("div");
    dot.className = "ezap-color-dot";
    dot.style.background = color;
    dot.dataset.color = color;
    if (i === 0) { dot.dataset.selected = "1"; dot.classList.add("selected"); }
    dot.addEventListener("click", function() {
      picker.querySelectorAll(".ezap-color-dot").forEach(function(d) { d.dataset.selected = ""; d.classList.remove("selected"); });
      dot.dataset.selected = "1";
      dot.classList.add("selected");
    });
    picker.appendChild(dot);
  });
}

function getTagSelectedColor() {
  var picker = document.getElementById("wcrm-tag-color-picker");
  if (!picker) return LABEL_COLORS[0];
  var selected = picker.querySelector('div[data-selected="1"]');
  return selected ? selected.dataset.color : LABEL_COLORS[0];
}

// ===== Label Templates (global library) =====
function loadLabelTemplates() {
  chrome.storage.local.get("wcrm_label_templates", function(data) {
    labelTemplates = (data && data.wcrm_label_templates) || [];
    // Auto-populate from existing contact labels if library is empty
    if (labelTemplates.length === 0 && Object.keys(labelsData).length > 0) {
      var seen = {};
      Object.keys(labelsData).forEach(function(key) {
        var d = labelsData[key];
        if (d.labels) d.labels.forEach(function(l) {
          var k = l.name.toLowerCase();
          if (!seen[k]) { seen[k] = true; labelTemplates.push({ name: l.name, color: l.color }); }
        });
      });
      if (labelTemplates.length > 0) saveLabelTemplates();
    }
  });
}

function saveLabelTemplates() {
  chrome.storage.local.set({ wcrm_label_templates: labelTemplates });
}

function addLabelTemplate() {
  var input = document.getElementById("wcrm-tag-input");
  var name = input.value.trim();
  if (!name) return;
  var exists = labelTemplates.some(function(t) { return t.name.toLowerCase() === name.toLowerCase(); });
  if (exists) return;
  var color = getTagSelectedColor();
  labelTemplates.push({ name: name, color: color });
  saveLabelTemplates();
  input.value = "";
  renderTagList();
  renderTagContactSection();
}

function removeLabelTemplate(index) {
  var tmpl = labelTemplates[index];
  if (!tmpl) return;
  if (!confirm('Remover a etiqueta "' + tmpl.name + '" da biblioteca?')) return;
  labelTemplates.splice(index, 1);
  saveLabelTemplates();
  renderTagList();
  renderTagContactSection();
}

function renderTagList() {
  var container = document.getElementById("wcrm-tag-list");
  if (!container) return;
  if (labelTemplates.length === 0) {
    container.innerHTML = '<div class="ezap-empty">Nenhuma etiqueta criada</div>';
    return;
  }
  container.innerHTML = "";
  labelTemplates.forEach(function(tmpl, i) {
    var row = document.createElement("div");
    row.className = "ezap-card";
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 10px";
    row.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><span class="ezap-aba-color" style="background:' + tmpl.color + '"></span><span style="font-size:13px">' + tmpl.name + '</span></span>' +
      '<span class="wcrm-tag-del ezap-label-remove" data-idx="' + i + '" title="Remover">&times;</span>';
    row.querySelector(".wcrm-tag-del").addEventListener("click", function() { removeLabelTemplate(i); });
    container.appendChild(row);
  });
}

// ===== Tag Contact Section (in TAG sidebar) =====
function renderTagContactSection() {
  var container = document.getElementById("wcrm-tag-contact-section");
  if (!container) return;

  if (!currentPhone) {
    container.innerHTML = '<div class="ezap-empty">Selecione um contato para atribuir etiquetas</div>';
    return;
  }

  var displayName = currentName || currentPhone;
  var pipeIdx = displayName.indexOf("|");
  if (pipeIdx > 0) displayName = displayName.substring(0, pipeIdx).trim();

  var html = '<div class="ezap-section-title">Contato Selecionado</div>';
  html += '<div class="ezap-card" style="padding:10px 12px;margin-bottom:10px">';
  html += '<div class="ezap-contact-name" style="font-size:14px;margin-bottom:0">' + displayName + '</div>';
  html += '</div>';

  container.innerHTML = html;

  if (labelTemplates.length === 0) {
    container.innerHTML += '<div class="ezap-empty">Crie etiquetas acima para atribuir</div>';
    return;
  }

  var data = getContactData(currentPhone);
  var assigned = (data.labels || []).map(function(l) { return l.name.toLowerCase(); });

  var listDiv = document.createElement("div");
  labelTemplates.forEach(function(tmpl) {
    var isAssigned = assigned.indexOf(tmpl.name.toLowerCase()) >= 0;
    var row = document.createElement("div");
    row.className = "ezap-dropdown-item";
    row.style.cssText = "margin-bottom:4px;background:" + (isAssigned ? tmpl.color + "20" : "transparent");
    row.innerHTML = '<span class="ezap-aba-color" style="width:14px;height:14px;background:' + tmpl.color + '"></span>' +
      '<span style="font-size:13px;flex:1">' + tmpl.name + '</span>' +
      '<span style="color:' + (isAssigned ? tmpl.color : 'var(--ezap-text-secondary)') + ';font-size:14px;font-weight:bold">' + (isAssigned ? '&#10003;' : '&plus;') + '</span>';
    row.addEventListener("mouseenter", function() { row.style.background = isAssigned ? tmpl.color + "30" : "var(--ezap-bg-surface)"; });
    row.addEventListener("mouseleave", function() { row.style.background = isAssigned ? tmpl.color + "20" : "transparent"; });
    row.addEventListener("click", function() {
      if (isAssigned) {
        // Remove
        var d = getContactData(currentPhone);
        var idx = -1;
        (d.labels || []).forEach(function(l, i) { if (l.name.toLowerCase() === tmpl.name.toLowerCase()) idx = i; });
        if (idx >= 0) {
          var removed = d.labels[idx];
          d.labels.splice(idx, 1);
          setContactData(currentPhone, d);
          renderLabels();
          renderTagContactSection();
          var uid = getLabelUserId();
          if (uid && removed) {
            var key = contactKey(currentPhone);
            sendBgMessage({ action: "supabase_rest", path: "/rest/v1/labels?user_id=eq." + uid + "&contact_phone=eq." + encodeURIComponent(key) + "&text=eq." + encodeURIComponent(removed.name), method: "DELETE", prefer: "return=minimal" });
          }
        }
      } else {
        assignLabel(tmpl.name, tmpl.color);
      }
    });
    listDiv.appendChild(row);
  });
  container.appendChild(listDiv);
}

function assignLabel(name, color) {
  if (!currentPhone) return;
  var data = getContactData(currentPhone);
  if (!data.labels) data.labels = [];
  var exists = data.labels.some(function(l) { return l.name.toLowerCase() === name.toLowerCase(); });
  if (exists) return;
  data.labels.push({ name: name, color: color });
  setContactData(currentPhone, data);
  renderLabels();
  renderTagContactSection();

  // Sync to Supabase
  var uid = getLabelUserId();
  if (uid) {
    sendBgMessage({
      action: "supabase_rest",
      path: "/rest/v1/labels",
      method: "POST",
      body: { user_id: uid, contact_phone: contactKey(currentPhone), contact_name: currentName || "", text: name, color: color },
      prefer: "return=minimal"
    });
  }
}

// ===== Storage (Supabase + chrome.storage cache) =====
function getLabelUserId() {
  return window.ezapUserId();
}

function loadLabelsData() {
  return new Promise(function(resolve) {
    // Fast: load from local cache first
    chrome.storage.local.get("wcrm_labels", function(data) {
      labelsData = (data && data.wcrm_labels) || {};
      if (labelsData[""]) { delete labelsData[""]; }
      console.log("[WCRM] Labels loaded from cache:", Object.keys(labelsData).length, "contacts");
      resolve();
    });

    // Background: sync from Supabase
    var uid = getLabelUserId();
    if (!uid) return;

    sendBgMessage({
      action: "supabase_rest",
      path: "/rest/v1/labels?user_id=eq." + uid + "&select=contact_phone,text,color",
      method: "GET"
    }).then(function(rows) {
      if (!rows || !Array.isArray(rows)) return;

      if (rows.length > 0) {
        // Supabase has data — use it
        var newData = {};
        rows.forEach(function(r) {
          var key = r.contact_phone || "";
          if (!key) return;
          if (!newData[key]) newData[key] = { labels: [], notes: "" };
          newData[key].labels.push({ name: r.text || "", color: r.color || "#25d366" });
        });
        labelsData = newData;
        chrome.storage.local.set({ wcrm_labels: labelsData });
        console.log("[WCRM] Labels synced from Supabase:", Object.keys(labelsData).length, "contacts");
        if (sidebarOpen && currentPhone) renderLabels();
      } else if (Object.keys(labelsData).length > 0) {
        // First time: migrate local labels to Supabase
        migrateLocalLabelsToSupabase(uid);
      }
    });
  });
}

function migrateLocalLabelsToSupabase(uid) {
  var allLabels = [];
  Object.keys(labelsData).forEach(function(key) {
    var data = labelsData[key];
    if (data.labels && data.labels.length > 0) {
      data.labels.forEach(function(label) {
        allLabels.push({
          user_id: uid,
          contact_phone: key,
          text: label.name,
          color: label.color
        });
      });
    }
  });
  if (allLabels.length > 0) {
    sendBgMessage({
      action: "supabase_rest",
      path: "/rest/v1/labels",
      method: "POST",
      body: allLabels,
      prefer: "return=minimal"
    }).then(function() {
      console.log("[WCRM] Migrated", allLabels.length, "labels to Supabase");
    });
  }
}

function saveLabelsData() {
  chrome.storage.local.set({ wcrm_labels: labelsData });
}

function contactKey(phone) {
  if (!phone) return "";
  var digits = phone.replace(/\D/g, "");
  // If it has enough digits, use digits as key (phone number)
  // Otherwise it's a name - use the name as key
  return digits.length >= 8 ? digits : phone.trim().toLowerCase();
}

function getContactData(phone) {
  var key = contactKey(phone);
  if (!key) return { labels: [], notes: "" };
  return labelsData[key] || { labels: [], notes: "" };
}

function setContactData(phone, data) {
  var key = contactKey(phone);
  if (!key) return;
  labelsData[key] = data;
  saveLabelsData();
}

// ===== Labels =====
function removeLabel(index) {
  var data = getContactData(currentPhone);
  var label = data.labels[index];
  if (!label) return;
  if (!confirm('Remover a etiqueta "' + label.name + '"?')) return;

  data.labels.splice(index, 1);
  setContactData(currentPhone, data);
  renderLabels();
  renderTagContactSection();

  // Sync to Supabase: delete by matching fields
  var uid = getLabelUserId();
  if (uid && label) {
    var key = contactKey(currentPhone);
    sendBgMessage({
      action: "supabase_rest",
      path: "/rest/v1/labels?user_id=eq." + uid + "&contact_phone=eq." + encodeURIComponent(key) + "&text=eq." + encodeURIComponent(label.name),
      method: "DELETE",
      prefer: "return=minimal"
    });
  }
}

function renderLabels() {
  var container = document.getElementById("wcrm-labels-container");
  if (!container) return;
  var data = getContactData(currentPhone);
  container.innerHTML = "";

  if (!data.labels || data.labels.length === 0) {
    container.innerHTML = '<span class="ezap-empty" style="padding:4px 0">Nenhuma etiqueta</span>';
    return;
  }

  data.labels.forEach(function(label, i) {
    var el = document.createElement("span");
    el.className = "ezap-label";
    el.style.background = label.color;
    el.style.color = "#111b21";
    el.innerHTML = label.name + '<span class="ezap-label-remove" data-idx="' + i + '">&times;</span>';
    el.querySelector("span[data-idx]").addEventListener("click", function() { removeLabel(i); });
    container.appendChild(el);
  });
}

// ===== Contact Info =====
function renderContactInfo() {
  var noChat = document.getElementById("wcrm-no-chat");
  var chatInfo = document.getElementById("wcrm-chat-info");

  if (!currentPhone) {
    noChat.style.display = "";
    chatInfo.style.display = "none";
    return;
  }

  noChat.style.display = "none";
  chatInfo.style.display = "";

  // Reset all state for the new contact
  window._wcrmTicketId = null;
  window._wcrmHubspotNotes = null;
  window._wcrmNotesExpanded = false;
  window._wcrmFuturasExpanded = false;
  window._wcrmRealizadasExpanded = false;
  window._wcrmEditingHsId = null;
  // _wcrmContactData is managed by preloadHubSpotData() — don't clear here
  window._wcrmLoadId = Date.now(); // Unique ID to prevent stale async responses

  // Show only the client name (before "|"), not the mentor name
  var displayName = currentName || "Desconhecido";
  var pipeIdx = displayName.indexOf("|");
  if (pipeIdx > 0) displayName = displayName.substring(0, pipeIdx).trim();
  document.getElementById("wcrm-name").textContent = displayName;

  renderLabels();
  renderTagContactSection();

  var data = getContactData(currentPhone);
  document.getElementById("wcrm-notes-editor").innerHTML = "";

  // Clear save status from previous contact
  var saveStatus = document.getElementById("wcrm-save-status");
  if (saveStatus) saveStatus.innerHTML = "";

  // Clear all sections and show loading state
  var notesHist = document.getElementById("wcrm-notes-history");
  if (notesHist) notesHist.innerHTML = '';

  var hubspotContainer = document.getElementById("wcrm-hubspot-container");
  if (hubspotContainer) hubspotContainer.innerHTML = '';

  var meetingsContainer = document.getElementById("wcrm-meetings-container");
  if (meetingsContainer) meetingsContainer.innerHTML = '';

  // Show progress bar
  showLoadingBar(true);

  renderNotesHistory();
  fetchHubSpotData();
}

// ===== Loading Bar =====
function showLoadingBar(show) {
  var existing = document.getElementById("wcrm-loading-bar");
  if (show) {
    if (!existing) {
      var bar = document.createElement("div");
      bar.id = "wcrm-loading-bar";
      bar.className = "ezap-loading-bar";
      bar.style.position = "relative";
      bar.style.margin = "4px 0 8px";
      var fill = document.createElement("div");
      fill.id = "wcrm-loading-bar-fill";
      fill.className = "ezap-loading-bar-fill";
      bar.appendChild(fill);

      // Insert after phone number
      var phoneEl = document.getElementById("wcrm-phone");
      if (phoneEl && phoneEl.parentElement) {
        phoneEl.parentElement.insertBefore(bar, phoneEl.nextSibling);
      }
    }
  } else {
    if (existing) existing.remove();
  }
}

// ===== HubSpot (thin wrapper over api.js) =====
function sendBgMessage(msg) {
  return window.ezapSendBg(msg, { timeoutMs: 15000 });
}

// Validate if the HubSpot contact actually matches the chat name
function validateContactMatch(contactProps, chatName) {
  if (!contactProps || !contactProps.firstname) return false;
  var contactFull = ((contactProps.firstname || "") + " " + (contactProps.lastname || "")).toLowerCase().trim();
  contactFull = removeAccentsJS(contactFull);
  // Get client name (before |)
  var clientName = removeAccentsJS(chatName.split(/\s*\|\s*/)[0].trim().toLowerCase());
  var skipWords = ["de", "da", "do", "dos", "das"];
  var chatWords = clientName.split(/\s+/).filter(function(w) { return w.length >= 3 && skipWords.indexOf(w) === -1; });
  if (chatWords.length === 0) return false;
  var matchCount = 0;
  chatWords.forEach(function(w) { if (contactFull.includes(w)) matchCount++; });
  // Require ALL significant words to match (strict) to avoid false positives
  return matchCount >= chatWords.length;
}

function removeAccentsJS(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Pre-load HubSpot data in background (without rendering UI)
// Populates window._wcrmContactData for @variable replacement
// Uses in-session cache to avoid re-fetching contacts already visited
var _hubspotCache = {}; // { phone -> { data, ticketId, timestamp } }
var _HUBSPOT_CACHE_TTL = 5 * 60 * 1000; // 5 min TTL

function preloadHubSpotData() {
  if (!currentPhone) return;
  var chatName = currentName || currentPhone || "";
  var preloadId = Date.now();
  window._wcrmPreloadId = preloadId;

  // Check cache first
  var cached = _hubspotCache[currentPhone];
  if (cached && (Date.now() - cached.timestamp) < _HUBSPOT_CACHE_TTL) {
    window._wcrmContactData = cached.data;
    if (cached.ticketId) window._wcrmTicketId = cached.ticketId;
    console.log("[WCRM] Pre-loaded from cache:", currentPhone);
    return;
  }

  window._wcrmContactData = null;

  sendBgMessage({ action: "ping" }).then(function() {
    if (window._wcrmPreloadId !== preloadId) return;
    return Promise.all([
      sendBgMessage({ action: "hubspot_search_contact", phone: currentPhone, chatName: chatName }),
      sendBgMessage({ action: "hubspot_search_tickets_by_name", name: chatName }),
    ]);
  }).then(function(results) {
    if (!results || window._wcrmPreloadId !== preloadId) return;

    var contactResult = results[0];
    var ticketResult = results[1];
    var contactProps = (contactResult && contactResult.contact && contactResult.contact.properties) || {};
    var contactId = contactResult && contactResult.contact ? contactResult.contact.id : null;
    var nameTickets = (ticketResult && ticketResult.tickets) || [];

    var contactTicketPromise = contactId
      ? sendBgMessage({ action: "hubspot_get_tickets", contactId: contactId })
      : Promise.resolve({ tickets: [] });

    contactTicketPromise.then(function(ctResult) {
      if (window._wcrmPreloadId !== preloadId) return;
      var contactTickets = (ctResult && ctResult.tickets) || [];
      var seen = {};
      var allTickets = [];
      contactTickets.concat(nameTickets).forEach(function(t) {
        if (!seen[t.id]) { seen[t.id] = true; allTickets.push(t); }
      });
      var ticket = allTickets.length > 0 ? allTickets[0] : null;
      var contactMatches = validateContactMatch(contactProps, chatName);

      // Build _wcrmContactData
      var ticketSubject = ticket ? (ticket.properties.subject || "") : "";
      var subjectParts = ticketSubject.split(/\s*\|\s*/);
      var clientNameFull = subjectParts[0] ? subjectParts[0].trim() : "";
      var consultorName = subjectParts[1] ? subjectParts[1].trim() : "";

      var firstName = "";
      var fullName = "";
      if (contactMatches && contactProps.firstname) {
        firstName = contactProps.firstname;
        fullName = [contactProps.firstname, contactProps.lastname].filter(Boolean).join(" ");
      } else if (clientNameFull) {
        firstName = clientNameFull.split(/\s+/)[0];
        fullName = clientNameFull;
      } else {
        var chatParts = (currentName || "").split(/\s*\|\s*/);
        firstName = (chatParts[0] || "").split(/\s+/)[0];
        fullName = (chatParts[0] || "").trim();
      }

      window._wcrmContactData = {
        nome: firstName,
        nomeCompleto: fullName,
        consultor: ticket && ticket.properties._ownerName ? ticket.properties._ownerName : "",
        empresa: consultorName,
        email: (ticket && ticket.properties.contrato__e_mail) ? ticket.properties.contrato__e_mail : (contactMatches && contactProps.email ? contactProps.email : ""),
        telefone: contactMatches && contactProps.phone ? contactProps.phone : (currentPhone || ""),
        lifecycle: contactMatches && contactProps.lifecyclestage ? contactProps.lifecyclestage : "",
        reunioes: ticket && ticket.properties.nm__total_de_calls_adquiridas__starter__pro__business_ ? ticket.properties.nm__total_de_calls_adquiridas__starter__pro__business_ : "",
        ticket: ticketSubject,
        proprietario: ticket && ticket.properties._ownerName ? ticket.properties._ownerName : "",
        status: ticket && ticket.properties._stageName ? ticket.properties._stageName : "",
      };
      if (ticket) window._wcrmTicketId = ticket.id;

      // Cache the result
      _hubspotCache[currentPhone] = {
        data: window._wcrmContactData,
        ticketId: ticket ? ticket.id : null,
        timestamp: Date.now()
      };

      console.log("[WCRM] Pre-loaded contact data:", window._wcrmContactData);
    });
  }).catch(function() { /* ignore preload errors */ });
}

function fetchHubSpotData() {
  var container = document.getElementById("wcrm-hubspot-container");
  if (!container || !currentPhone) return;

  var loadId = window._wcrmLoadId; // Capture current load ID to detect stale responses
  container.innerHTML = '<div class="ezap-loading">Buscando no HubSpot...</div>';
  var chatName = currentName || currentPhone || "";
  console.log("[WCRM] Searching HubSpot for:", currentPhone, "name:", chatName);

  // Wake up background worker, then search contact AND tickets in parallel
  sendBgMessage({ action: "ping" }).then(function() {
    if (window._wcrmLoadId !== loadId) return; // Contact changed, abort
    return Promise.all([
      sendBgMessage({ action: "hubspot_search_contact", phone: currentPhone, chatName: chatName }),
      sendBgMessage({ action: "hubspot_search_tickets_by_name", name: chatName }),
    ]);
  }).then(function(parallelResults) {
    if (window._wcrmLoadId !== loadId) return; // Contact changed, abort

    var contactResult = parallelResults[0];
    var ticketResult = parallelResults[1];

    console.log("[WCRM] Contact result:", contactResult);
    console.log("[WCRM] Ticket result:", ticketResult);

    if (contactResult.error === "API key not configured") {
      container.innerHTML = hsCard("no-key", "Sem API Key", "Configure no icone da extensao.");
      showLoadingBar(false);
      return;
    }

    var contactProps = (contactResult.contact && contactResult.contact.properties) || {};
    var contactId = contactResult.contact ? contactResult.contact.id : null;
    var nameTickets = (ticketResult && ticketResult.tickets) || [];

    // Also search tickets by contact association (if we have a contact)
    var contactTicketPromise = contactId
      ? sendBgMessage({ action: "hubspot_get_tickets", contactId: contactId })
      : Promise.resolve({ tickets: [] });

    contactTicketPromise.then(function(ctResult) {
      if (window._wcrmLoadId !== loadId) return; // Contact changed, abort

      var contactTickets = (ctResult && ctResult.tickets) || [];

      // Prioritize contact-associated tickets (more reliable) over name-search tickets
      // Contact tickets come from the actual HubSpot contact association, so they're accurate
      // Name tickets are searched by subject text and can have false positives
      var seen = {};
      var allTickets = [];
      // Add contact-associated tickets FIRST (higher priority)
      contactTickets.concat(nameTickets).forEach(function(t) {
        if (!seen[t.id]) { seen[t.id] = true; allTickets.push(t); }
      });

      var ticket = allTickets.length > 0 ? allTickets[0] : null;

      // Validate: does the found contact actually match the chat name?
      var contactMatches = validateContactMatch(contactProps, chatName);
      console.log("[WCRM] Contact matches chat name:", contactMatches, "| Ticket found:", !!ticket);

      // === DEBUG: Full data dump for analysis ===
      if (contactResult.contact) {
        console.log("[WCRM] === CONTACT DATA (all properties) ===");
        console.log("[WCRM] Contact ID:", contactResult.contact.id);
        console.log("[WCRM] Contact Properties:", JSON.parse(JSON.stringify(contactProps)));
      } else {
        console.log("[WCRM] === NO CONTACT FOUND ===");
      }
      if (ticket) {
        console.log("[WCRM] === TICKET DATA (all properties) ===");
        console.log("[WCRM] Ticket ID:", ticket.id);
        console.log("[WCRM] Ticket Properties:", JSON.parse(JSON.stringify(ticket.properties)));
      }
      if (allTickets.length > 1) {
        console.log("[WCRM] === ALL TICKETS (" + allTickets.length + ") ===");
        allTickets.forEach(function(t, i) {
          console.log("[WCRM] Ticket[" + i + "] ID:" + t.id + " Subject:" + (t.properties.subject || "N/A") + " Stage:" + (t.properties._stageName || t.properties.hs_pipeline_stage || "N/A"));
        });
      }
      console.log("[WCRM] ================================");

      // Determine display name:
      // - If chat name has "|" (mentoria format), ALWAYS use it
      // - If ticket found, use ticket subject
      // - If contact matches, use contact name
      // - Fallback: chat name
      var displayName;
      if (chatName.includes("|")) {
        displayName = chatName;
      } else if (ticket) {
        displayName = ticket.properties.subject;
      } else if (contactMatches) {
        displayName = [contactProps.firstname, contactProps.lastname].filter(Boolean).join(" ") || chatName;
      } else {
        displayName = chatName;
      }

      // If no ticket and no matching contact → not found
      if (!ticket && !contactMatches) {
        container.innerHTML = hsCard("not-found", "Não encontrado", "Nenhum ticket de mentoria encontrado para este contato.");
        var meetingsC = document.getElementById("wcrm-meetings-container");
        if (meetingsC) meetingsC.innerHTML = '<div class="ezap-empty">Sem dados</div>';
        showLoadingBar(false);
        return;
      }

      // Store contact data globally for message variable replacement (@nome, @email, etc.)
      var ticketSubject = ticket ? (ticket.properties.subject || "") : "";
      var subjectParts = ticketSubject.split(/\s*\|\s*/);
      var clientNameFull = subjectParts[0] ? subjectParts[0].trim() : "";
      var consultorName = subjectParts[1] ? subjectParts[1].trim() : "";

      // Determine first name: prefer contact firstname, fallback to ticket subject first word, then chat name
      var firstName = "";
      var fullName = "";
      if (contactMatches && contactProps.firstname) {
        firstName = contactProps.firstname;
        fullName = [contactProps.firstname, contactProps.lastname].filter(Boolean).join(" ");
      } else if (clientNameFull) {
        firstName = clientNameFull.split(/\s+/)[0];
        fullName = clientNameFull;
      } else {
        var chatParts = (currentName || "").split(/\s*\|\s*/);
        firstName = (chatParts[0] || "").split(/\s+/)[0];
        fullName = (chatParts[0] || "").trim();
      }

      window._wcrmContactData = {
        nome: firstName,
        nomeCompleto: fullName,
        consultor: ticket && ticket.properties._ownerName ? ticket.properties._ownerName : "",
        empresa: consultorName,
        email: (ticket && ticket.properties.contrato__e_mail) ? ticket.properties.contrato__e_mail : (contactMatches && contactProps.email ? contactProps.email : ""),
        telefone: contactMatches && contactProps.phone ? contactProps.phone : (currentPhone || ""),
        lifecycle: contactMatches && contactProps.lifecyclestage ? contactProps.lifecyclestage : "",
        reunioes: ticket && ticket.properties.nm__total_de_calls_adquiridas__starter__pro__business_ ? ticket.properties.nm__total_de_calls_adquiridas__starter__pro__business_ : "",
        ticket: ticketSubject,
        proprietario: ticket && ticket.properties._ownerName ? ticket.properties._ownerName : "",
        status: ticket && ticket.properties._stageName ? ticket.properties._stageName : "",
      };

      // Mentor name: from HubSpot owner (proprietario do ticket)
      var mentorName = (ticket && ticket.properties._ownerName) ? ticket.properties._ownerName : "";

      {
        // Build the card
        var ticketUrl = ticket ? "https://app.hubspot.com/contacts/49377285/record/0-5/" + ticket.id : "";
        var ticketEmail = (ticket && ticket.properties.contrato__e_mail) ? ticket.properties.contrato__e_mail : "";

        var html = '<div class="ezap-card ezap-card--hubspot">';
        html += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
        html += '<span class="ezap-status ezap-status--found">Encontrado no HubSpot</span>';
        if (ticket) {
          html += '<a href="' + ticketUrl + '" target="_blank" class="ezap-badge ezap-badge--warning" style="text-decoration:none" title="Abrir ticket no HubSpot">Ver Ticket &#x2197;</a>';
          window._wcrmTicketId = ticket.id;
        }
        html += '</div>';
        html += '<div style="margin-top:10px">';
        html += row("Nome", displayName);
        // Ticket creation date
        if (ticket && ticket.properties.createdate) {
          var ticketDate = new Date(ticket.properties.createdate);
          var dd = String(ticketDate.getDate()).padStart(2, "0");
          var mm = String(ticketDate.getMonth() + 1).padStart(2, "0");
          var yyyy = ticketDate.getFullYear();
          html += row("Criado em", dd + "/" + mm + "/" + yyyy);
        }
        // Mentor (from HubSpot owner)
        if (mentorName) html += row("Mentor", mentorName);
        // E-mail from ticket [CONTRATO] E-mail
        if (ticketEmail) html += row("E-mail", ticketEmail);
        // Calls adquiridas from ticket
        if (ticket && ticket.properties.nm__total_de_calls_adquiridas__starter__pro__business_) {
          html += row("Reuniões adquiridas", ticket.properties.nm__total_de_calls_adquiridas__starter__pro__business_);
        }
        html += '</div></div>';
        container.innerHTML = html;

        // Wire up all copy buttons
        container.querySelectorAll(".wcrm-copy-btn").forEach(function(btn) {
          btn.addEventListener("click", function(e) {
            e.preventDefault();
            e.stopPropagation();
            var text = btn.dataset.copy;
            navigator.clipboard.writeText(text).then(function() {
              var orig = btn.textContent;
              btn.textContent = "\u2713";
              btn.style.color = "var(--ezap-primary)";
              setTimeout(function() { btn.textContent = orig; btn.style.color = ""; }, 1500);
            });
          });
        });

        // Fetch meetings after card is built
        fetchMeetings(ticket ? ticket.id : null, contactId);

        // Fetch HubSpot notes for the ticket and merge with local notes
        if (ticket) {
          sendBgMessage({ action: "hubspot_get_notes", ticketId: ticket.id }).then(function(notesResult) {
            if (window._wcrmLoadId !== loadId) return; // Contact changed, abort
            console.log("[WCRM] HubSpot notes result:", notesResult);
            if (notesResult && notesResult.notes) {
              renderNotesHistory(notesResult.notes);
            }
            showLoadingBar(false);
          });
        } else {
          showLoadingBar(false);
        }
      } // end card build block
    });
  });
}

// ===== Meetings =====
function fetchMeetings(ticketId, contactId) {
  var container = document.getElementById("wcrm-meetings-container");
  if (!container) return;
  var loadId = window._wcrmLoadId;

  if (!ticketId && !contactId) {
    container.innerHTML = '<div class="ezap-empty">Sem ticket/contato para buscar reuniões</div>';
    return;
  }

  container.innerHTML = '<div class="ezap-loading">Buscando reuniões...</div>';

  sendBgMessage({ action: "hubspot_get_meetings", ticketId: ticketId, contactId: contactId }).then(function(result) {
    if (window._wcrmLoadId !== loadId) return; // Contact changed, abort
    console.log("[WCRM] Meetings result:", result);

    if (!result || !result.meetings || result.meetings.length === 0) {
      container.innerHTML = '<div class="ezap-empty">Nenhuma reunião encontrada</div>';
      return;
    }

    var now = new Date();
    var futuras = [];
    var realizadas = [];

    result.meetings.forEach(function(m) {
      var startTime = m.properties.hs_meeting_start_time || m.properties.hs_timestamp || "";
      var meetDate = startTime ? new Date(startTime) : null;
      if (meetDate && meetDate > now) {
        futuras.push(m);
      } else {
        realizadas.push(m);
      }
    });

    // Sort futuras ascending (soonest first), realizadas descending (most recent first)
    futuras.sort(function(a, b) {
      var da = a.properties.hs_meeting_start_time || a.properties.hs_timestamp || "";
      var db = b.properties.hs_meeting_start_time || b.properties.hs_timestamp || "";
      return da.localeCompare(db);
    });
    realizadas.sort(function(a, b) {
      var da = a.properties.hs_meeting_start_time || a.properties.hs_timestamp || "";
      var db = b.properties.hs_meeting_start_time || b.properties.hs_timestamp || "";
      return db.localeCompare(da);
    });

    var MEET_DEFAULT_SHOW = 2;
    var html = '';

    // Futuras
    if (futuras.length > 0) {
      var futurasExpanded = window._wcrmFuturasExpanded || false;
      var visibleFuturas = futurasExpanded ? futuras : futuras.slice(0, MEET_DEFAULT_SHOW);
      var hasMoreFuturas = futuras.length > MEET_DEFAULT_SHOW;

      html += '<div class="ezap-section-title" style="color:var(--ezap-warning)">Próximas (' + futuras.length + ')</div>';
      visibleFuturas.forEach(function(m) {
        html += renderMeetingItem(m, true);
      });
      if (hasMoreFuturas) {
        if (futurasExpanded) {
          html += '<button id="wcrm-futuras-toggle" class="ezap-toggle-btn" style="color:var(--ezap-warning)">&blacktriangle; Ver menos</button>';
        } else {
          html += '<button id="wcrm-futuras-toggle" class="ezap-toggle-btn" style="color:var(--ezap-warning)">&blacktriangledown; Ver mais (' + (futuras.length - MEET_DEFAULT_SHOW) + ')</button>';
        }
      }
    }

    // Realizadas
    if (realizadas.length > 0) {
      var realizadasExpanded = window._wcrmRealizadasExpanded || false;
      var visibleRealizadas = realizadasExpanded ? realizadas : realizadas.slice(0, MEET_DEFAULT_SHOW);
      var hasMoreRealizadas = realizadas.length > MEET_DEFAULT_SHOW;

      html += '<div class="ezap-section-title" style="margin-top:' + (futuras.length > 0 ? '10px' : '0') + '">Realizadas (' + realizadas.length + ')</div>';
      visibleRealizadas.forEach(function(m) {
        html += renderMeetingItem(m, false);
      });
      if (hasMoreRealizadas) {
        if (realizadasExpanded) {
          html += '<button id="wcrm-realizadas-toggle" class="ezap-toggle-btn" style="color:var(--ezap-secondary)">&blacktriangle; Ver menos</button>';
        } else {
          html += '<button id="wcrm-realizadas-toggle" class="ezap-toggle-btn" style="color:var(--ezap-secondary)">&blacktriangledown; Ver mais (' + (realizadas.length - MEET_DEFAULT_SHOW) + ')</button>';
        }
      }
    }

    container.innerHTML = html;

    // Toggle handlers
    var futurasToggle = document.getElementById("wcrm-futuras-toggle");
    if (futurasToggle) {
      futurasToggle.addEventListener("click", function() {
        window._wcrmFuturasExpanded = !window._wcrmFuturasExpanded;
        fetchMeetings(ticketId, contactId);
      });
    }
    var realizadasToggle = document.getElementById("wcrm-realizadas-toggle");
    if (realizadasToggle) {
      realizadasToggle.addEventListener("click", function() {
        window._wcrmRealizadasExpanded = !window._wcrmRealizadasExpanded;
        fetchMeetings(ticketId, contactId);
      });
    }
  });
}

function renderMeetingItem(meeting, isFuture) {
  var mp = meeting.properties;
  var title = mp.hs_meeting_title || "Reunião sem título";
  var startTime = mp.hs_meeting_start_time || mp.hs_timestamp || "";
  var dateStr = "";
  if (startTime) {
    var d = new Date(startTime);
    dateStr = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) +
      " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  var meetingClass = "ezap-card ezap-card--meeting " + (isFuture ? "ezap-card--meeting-future" : "ezap-card--meeting-past");
  var dateColor = isFuture ? "var(--ezap-warning)" : "var(--ezap-text-secondary)";

  var html = '<div class="' + meetingClass + '">';
  html += '<div style="font-size:12px;font-weight:600;color:var(--ezap-text-primary);line-height:1.3">' + title + '</div>';
  if (dateStr) {
    html += '<div style="font-size:10px;color:' + dateColor + ';margin-top:3px">' + dateStr + '</div>';
  }
  html += '</div>';
  return html;
}

// ===== Image Upload for Notes =====
function handleImageUpload(file, editor) {
  // Show placeholder while uploading
  var placeholder = document.createElement("div");
  placeholder.className = "wcrm-img-uploading";
  placeholder.style.cssText = "background:var(--ezap-bg-elevated);border:1px dashed var(--ezap-border-light);border-radius:6px;padding:12px;text-align:center;margin:6px 0;color:var(--ezap-text-secondary);font-size:11px";
  placeholder.textContent = "Enviando imagem...";
  editor.appendChild(placeholder);

  // Resize image before upload (max 500px width, JPEG 0.8 quality)
  resizeImage(file, 500, 0.8, function(resizedBase64, contentType) {
    // Generate unique filename
    var ext = contentType === "image/png" ? "png" : "jpg";
    var fileName = "note_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8) + "." + ext;

    // Upload via background script
    sendBgMessage({
      action: "upload_note_image",
      base64: resizedBase64,
      fileName: fileName,
      contentType: contentType,
    }).then(function(result) {
      // Remove placeholder
      if (placeholder.parentNode) placeholder.remove();

      if (result && result.ok && result.url) {
        // Show loading spinner while fetching image via blob (CSP bypass)
        var imgWrap = document.createElement("div");
        imgWrap.style.cssText = "background:#1a2730;border-radius:6px;padding:16px;text-align:center;margin:6px 0";
        imgWrap.innerHTML = '<div style="color:var(--ezap-text-secondary);font-size:11px"><span class="ezap-spinner"></span> Carregando imagem...</div>';
        editor.appendChild(imgWrap);

        var img = document.createElement("img");
        img.setAttribute("data-src", result.url);
        img.style.cssText = "max-width:100%;border-radius:6px;margin:4px 0;display:block";
        img.alt = "Imagem anexada";

        // Add spin animation if not present
        if (!document.getElementById("ezap-spin-style")) {
          var spinStyle = document.createElement("style");
          spinStyle.id = "ezap-spin-style";
          spinStyle.textContent = "@keyframes ezapSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
          document.head.appendChild(spinStyle);
        }

        // Load via fetch to bypass CSP
        fetch(result.url).then(function(r) { return r.blob(); }).then(function(blob) {
          img.src = URL.createObjectURL(blob);
          if (imgWrap.parentNode) imgWrap.replaceWith(img);
          // Add a line break after image so user can continue typing
          if (!img.nextSibling || img.nextSibling.nodeName !== "BR") {
            img.insertAdjacentElement("afterend", document.createElement("br"));
          }
          editor.focus();
        }).catch(function() {
          img.src = result.url;
          if (imgWrap.parentNode) imgWrap.replaceWith(img);
          editor.focus();
        });
      } else {
        // Upload failed — show error
        var errDiv = document.createElement("div");
        errDiv.style.cssText = "color:var(--ezap-danger);font-size:11px;padding:4px;margin:4px 0";
        errDiv.textContent = "Erro ao enviar imagem: " + (result && result.error || "erro desconhecido");
        editor.appendChild(errDiv);
        setTimeout(function() { if (errDiv.parentNode) errDiv.remove(); }, 5000);
      }
    });
  });
}

function resizeImage(file, maxWidth, quality, callback) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var w = img.width;
      var h = img.height;

      // Only resize if wider than maxWidth
      if (w > maxWidth) {
        h = Math.round(h * (maxWidth / w));
        w = maxWidth;
      }

      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);

      // Use JPEG for photos (smaller), PNG for screenshots with transparency
      var isPng = file.type === "image/png";
      var outputType = isPng ? "image/png" : "image/jpeg";
      var dataUrl = canvas.toDataURL(outputType, quality);

      // If PNG is too large, fall back to JPEG
      if (isPng && dataUrl.length > 500000) {
        outputType = "image/jpeg";
        dataUrl = canvas.toDataURL("image/jpeg", quality);
      }

      // Extract base64 part (remove "data:image/...;base64,")
      var base64 = dataUrl.split(",")[1];
      callback(base64, outputType);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ===== Notes =====
// Replace blob: URLs with Supabase URLs before saving (for HubSpot compatibility)
function prepareNoteHtml(editorEl) {
  var clone = editorEl.cloneNode(true);
  clone.querySelectorAll("img[data-src]").forEach(function(img) {
    img.src = img.getAttribute("data-src");
    img.removeAttribute("data-src");
    img.style.cssText = "max-width:100%";
  });
  // Remove any uploading placeholders
  clone.querySelectorAll(".wcrm-img-uploading").forEach(function(el) { el.remove(); });
  return clone.innerHTML.trim();
}

function saveNote() {
  var editor = document.getElementById("wcrm-notes-editor");
  var statusEl = document.getElementById("wcrm-save-status");
  var noteHtml = prepareNoteHtml(editor);

  if (!noteHtml || noteHtml === "<br>" || noteHtml === '<div><br></div>') {
    statusEl.innerHTML = '<span style="color:var(--ezap-danger)">Escreva algo antes de salvar</span>';
    return;
  }

  // Append author signature
  var authorName = (window.__wcrmAuth && window.__wcrmAuth.userName) || "Desconhecido";
  noteHtml += '<br><span class="wcrm-note-author" style="color:var(--ezap-text-secondary);font-size:11px;font-style:italic">Observação criada por: ' + authorName + '</span>';

  var btn = document.getElementById("wcrm-save-note-btn");
  btn.disabled = true;
  btn.textContent = "Salvando...";
  statusEl.innerHTML = "";

  var ticketId = window._wcrmTicketId;
  var editingHsId = window._wcrmEditingHsId;

  // If editing a HubSpot note, update it via API
  if (editingHsId) {
    sendBgMessage({ action: "hubspot_update_note", noteId: editingHsId, noteBody: noteHtml }).then(function(result) {
      btn.disabled = false;
      btn.textContent = "Salvar Observação";
      window._wcrmEditingHsId = null;
      window._wcrmEditingIdx = null;
      if (result && result.ok) {
        // Update cached HS note
        if (window._wcrmHubspotNotes) {
          window._wcrmHubspotNotes.forEach(function(n) {
            if (n.id === editingHsId) {
              n.properties.hs_note_body = noteHtml;
            }
          });
        }
        statusEl.innerHTML = '<span style="color:var(--ezap-primary)">Atualizado no HubSpot \u2713</span>';
      } else {
        statusEl.innerHTML = '<span style="color:var(--ezap-danger)">Erro ao atualizar: ' + (result && result.error || "erro") + '</span>';
      }
      editor.innerHTML = "";
      renderNotesHistory();
    });
    return;
  }

  // Save locally
  var key = contactKey(currentPhone);
  var data = getContactData(key);
  if (!data.notesHistory) data.notesHistory = [];

  var editIdx = window._wcrmEditingIdx;
  var isEditing = editIdx !== undefined && editIdx !== null && data.notesHistory[editIdx];
  var noteEntry;

  if (isEditing) {
    // Update existing local note
    noteEntry = data.notesHistory[editIdx];
    noteEntry.html = noteHtml;
    noteEntry.editedAt = new Date().toISOString();
    window._wcrmEditingIdx = null;
  } else {
    // New note
    noteEntry = {
      html: noteHtml,
      date: new Date().toISOString(),
      synced: false,
    };
    data.notesHistory.unshift(noteEntry);
  }
  setContactData(key, data);

  // Save to HubSpot ticket if available
  if (ticketId) {
    sendBgMessage({ action: "hubspot_create_note", ticketId: ticketId, noteBody: noteHtml }).then(function(result) {
      btn.disabled = false;
      btn.textContent = "Salvar Observação"; window._wcrmEditingIdx = null;
      if (result && result.ok) {
        noteEntry.synced = true;
        noteEntry.hsId = result.noteId; // Store HubSpot note ID for future delete/edit
        setContactData(key, data);
        statusEl.innerHTML = '<span style="color:var(--ezap-primary)">Salvo no HubSpot \u2713</span>';
      } else {
        statusEl.innerHTML = '<span style="color:var(--ezap-warning)">Salvo local. HubSpot: ' + (result && result.error || "erro") + '</span>';
      }
      editor.innerHTML = "";
      renderNotesHistory();
    });
  } else {
    btn.disabled = false;
    btn.textContent = "Salvar Observação"; window._wcrmEditingIdx = null;
    statusEl.innerHTML = '<span style="color:var(--ezap-warning)">Salvo localmente (sem ticket vinculado)</span>';
    editor.innerHTML = "";
    renderNotesHistory();
  }
}

function renderNotesHistory(hubspotNotes) {
  var container = document.getElementById("wcrm-notes-history");
  if (!container) return;

  // Store hubspot notes if provided, else use cached
  if (hubspotNotes) {
    window._wcrmHubspotNotes = hubspotNotes;
  }
  var hsNotes = window._wcrmHubspotNotes || [];

  var key = contactKey(currentPhone);
  var data = getContactData(key);
  var localHistory = data.notesHistory || [];

  // Merge local + HubSpot notes into a unified list
  var allNotes = [];
  var now24h = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago

  localHistory.forEach(function(note, idx) {
    var noteTime = note.date ? new Date(note.date).getTime() : 0;
    allNotes.push({
      html: note.html,
      date: note.date,
      source: note.synced ? "hs" : "local",
      localIdx: idx,
      editable: noteTime > now24h
    });
  });

  hsNotes.forEach(function(hsNote) {
    var body = hsNote.properties.hs_note_body || "";
    var timestamp = hsNote.properties.hs_timestamp || hsNote.properties.hs_createdate || "";
    var noteTime = timestamp ? new Date(timestamp).getTime() : 0;
    // Avoid duplicating notes that were already saved locally and synced
    var isDuplicate = localHistory.some(function(local) {
      return local.synced && local.html.replace(/<[^>]*>/g, "").trim() === body.replace(/<[^>]*>/g, "").trim();
    });
    if (!isDuplicate && body) {
      allNotes.push({
        html: body,
        date: timestamp,
        source: "hs",
        hsId: hsNote.id,
        editable: noteTime > now24h
      });
    }
  });

  // Sort by date descending (most recent first)
  allNotes.sort(function(a, b) {
    return new Date(b.date) - new Date(a.date);
  });

  if (allNotes.length === 0) {
    container.innerHTML = "";
    return;
  }

  var DEFAULT_SHOW = 2;
  var expanded = window._wcrmNotesExpanded || false;
  var visibleNotes = expanded ? allNotes : allNotes.slice(0, DEFAULT_SHOW);
  var hasMore = allNotes.length > DEFAULT_SHOW;

  var html = '<div class="ezap-section-title">Histórico</div>';

  // Store allNotes on window so event handlers can access them
  window._wcrmAllNotes = allNotes;

  // Open timeline wrapper (vertical line + dots)
  html += '<div class="ezap-timeline">';

  visibleNotes.forEach(function(note, visIdx) {
    var dateStr = note.date ? new Date(note.date).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    var sourceTag = note.source === "hs"
      ? '<span class="ezap-timeline-source ezap-timeline-source--hs" title="Do HubSpot">HS</span>'
      : '<span class="ezap-timeline-source ezap-timeline-source--local">local</span>';

    // Use visIdx to find the note in allNotes; store note type + id
    var noteType = note.hsId ? "hs" : "local";
    var noteRef = note.hsId ? note.hsId : note.localIdx;

    // Extract author signature from note HTML to display separately
    var noteBody = note.html || "";
    var authorSig = "";
    var sigMatch = noteBody.match(/<(?:br\s*\/?>)*\s*<span[^>]*class="wcrm-note-author"[^>]*>(.*?)<\/span>\s*$/i);
    if (!sigMatch) {
      sigMatch = noteBody.match(/<(?:br\s*\/?>)*\s*<span[^>]*>(Observação criada por:[^<]*)<\/span>\s*$/i);
    }
    if (sigMatch) {
      authorSig = sigMatch[1];
      noteBody = noteBody.substring(0, noteBody.indexOf(sigMatch[0]));
    }

    // Timeline item with dot indicator (--hs variant for HubSpot notes)
    var hsClass = note.source === "hs" ? " ezap-timeline-item--hs" : "";
    html += '<div class="ezap-timeline-item' + hsClass + '" data-note-type="' + noteType + '" data-note-ref="' + noteRef + '" data-vis-idx="' + visIdx + '">';
    // Date + source + actions on the same row outside the card
    html += '<div class="ezap-timeline-date" style="display:flex;align-items:center;justify-content:space-between">';
    html += '<span>' + dateStr + ' ' + sourceTag + '</span>';
    var isAdmin = window.__wcrmAuth && window.__wcrmAuth.userRole === "admin";
    var currentUser = (window.__wcrmAuth && window.__wcrmAuth.userName) || "";
    var isOwner = currentUser && note.html && note.html.indexOf("Observação criada por: " + currentUser) !== -1;
    if (isAdmin || isOwner) {
      html += '<span style="display:flex;gap:4px">';
      html += '<span class="wcrm-note-edit ezap-copy-btn" data-note-type="' + noteType + '" data-note-ref="' + noteRef + '" data-vis-idx="' + visIdx + '" title="Editar" style="color:var(--ezap-secondary);font-size:11px;cursor:pointer">&#9998;</span>';
      html += '<span class="wcrm-note-delete ezap-copy-btn" data-note-type="' + noteType + '" data-note-ref="' + noteRef + '" data-vis-idx="' + visIdx + '" title="Excluir" style="color:var(--ezap-danger);font-size:11px;cursor:pointer">&times;</span>';
      html += '</span>';
    }
    html += '</div>';
    // Card content
    html += '<div class="wcrm-note-item ezap-timeline-content">';
    html += '<div class="wcrm-note-content" style="font-size:11px;line-height:1.4;max-height:60px;overflow:hidden;position:relative">' + noteBody + '</div>';
    if (authorSig) {
      html += '<div style="color:var(--ezap-text-muted);font-size:10px;font-style:italic;margin-top:3px;border-top:1px solid var(--ezap-border);padding-top:2px">' + authorSig + '</div>';
    }
    html += '</div>'; // .ezap-timeline-content
    html += '</div>'; // .ezap-timeline-item
  });

  html += '</div>'; // .ezap-timeline

  // "Ver mais" / "Ver menos" toggle
  if (hasMore) {
    if (expanded) {
      html += '<button id="wcrm-notes-toggle" class="ezap-toggle-btn" style="color:var(--ezap-secondary)">&blacktriangle; Ver menos</button>';
    } else {
      html += '<button id="wcrm-notes-toggle" class="ezap-toggle-btn" style="color:var(--ezap-secondary)">&blacktriangledown; Ver mais (' + (allNotes.length - DEFAULT_SHOW) + ')</button>';
    }
  }

  container.innerHTML = html;

  // Load Supabase images via fetch to bypass WhatsApp CSP
  container.querySelectorAll(".wcrm-note-content img").forEach(function(img) {
    var src = img.src || "";
    if (src.indexOf("supabase.co") !== -1 && src.indexOf("blob:") === -1) {
      // Replace with loading placeholder
      var origSrc = src;
      img.src = "";
      img.alt = "";
      img.style.cssText = "display:none";
      var loader = document.createElement("div");
      loader.style.cssText = "background:var(--ezap-bg-primary);border-radius:6px;padding:10px;text-align:center;margin:4px 0;font-size:10px;color:var(--ezap-text-secondary)";
      loader.textContent = "Carregando imagem...";
      img.parentNode.insertBefore(loader, img);

      fetch(origSrc).then(function(r) { return r.blob(); }).then(function(blob) {
        img.src = URL.createObjectURL(blob);
        img.style.cssText = "max-width:100%;border-radius:6px;margin:4px 0;display:block";
        if (loader.parentNode) loader.remove();
      }).catch(function() {
        img.src = origSrc;
        img.style.cssText = "max-width:100%;border-radius:6px;margin:4px 0;display:block";
        if (loader.parentNode) loader.remove();
      });
    }
  });

  // Toggle expand/collapse
  var toggleEl = document.getElementById("wcrm-notes-toggle");
  if (toggleEl) {
    toggleEl.addEventListener("click", function() {
      window._wcrmNotesExpanded = !window._wcrmNotesExpanded;
      renderNotesHistory();
    });
  }

  // Click on truncated content to expand it
  container.querySelectorAll(".wcrm-note-content").forEach(function(contentEl) {
    if (contentEl.scrollHeight > contentEl.clientHeight) {
      contentEl.style.cursor = "pointer";
      contentEl.insertAdjacentHTML("beforeend", '<div style="position:absolute;bottom:0;left:0;right:0;height:20px;background:linear-gradient(transparent,var(--ezap-bg-elevated));pointer-events:none" class="wcrm-fade-overlay"></div>');
      contentEl.addEventListener("click", function(e) {
        e.stopPropagation();
        if (contentEl.style.maxHeight === "none") {
          contentEl.style.maxHeight = "60px";
          contentEl.style.overflow = "hidden";
          var fade = contentEl.querySelector(".wcrm-fade-overlay");
          if (fade) fade.style.display = "";
        } else {
          contentEl.style.maxHeight = "none";
          contentEl.style.overflow = "visible";
          var fade = contentEl.querySelector(".wcrm-fade-overlay");
          if (fade) fade.style.display = "none";
        }
      });
    }
  });

  // Edit buttons (pencil icon) — works for both local and HS notes
  container.querySelectorAll(".wcrm-note-edit").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var noteType = btn.dataset.noteType;
      var noteRef = btn.dataset.noteRef;
      var visIdx = parseInt(btn.dataset.visIdx);
      var noteData = window._wcrmAllNotes && window._wcrmAllNotes[visIdx];
      if (!noteData) return;

      var editor = document.getElementById("wcrm-notes-editor");
      editor.innerHTML = noteData.html;
      editor.focus();

      if (noteType === "local") {
        // Editing a local note
        window._wcrmEditingIdx = parseInt(noteRef);
        window._wcrmEditingHsId = null;
      } else {
        // Editing a HubSpot note
        window._wcrmEditingIdx = null;
        window._wcrmEditingHsId = noteRef;
      }
      document.getElementById("wcrm-save-note-btn").textContent = "Salvar Edição";
    });
  });

  // Delete buttons (trash icon) — works for both local and HS notes
  container.querySelectorAll(".wcrm-note-delete").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var noteType = btn.dataset.noteType;
      var noteRef = btn.dataset.noteRef;

      if (!confirm("Deseja excluir esta observação?")) return;

      if (noteType === "local") {
        // Delete local note
        var idx = parseInt(noteRef);
        var key = contactKey(currentPhone);
        var data = getContactData(key);
        if (data.notesHistory && data.notesHistory[idx] !== undefined) {
          var deletedNote = data.notesHistory[idx];
          var localHsId = deletedNote.hsId; // Check if synced to HubSpot
          data.notesHistory.splice(idx, 1);
          setContactData(key, data);
          renderNotesHistory();
          // Also delete from HubSpot if it was synced
          if (localHsId) {
            sendBgMessage({ action: "hubspot_delete_note", noteId: localHsId }).then(function(result) {
              var statusEl = document.getElementById("wcrm-save-status");
              if (result && result.ok) {
                if (window._wcrmHubspotNotes) {
                  window._wcrmHubspotNotes = window._wcrmHubspotNotes.filter(function(n) { return n.id !== localHsId; });
                }
                if (statusEl) statusEl.innerHTML = '<span style="color:var(--ezap-primary)">Exclu\u00eddo do HubSpot \u2713</span>';
                renderNotesHistory();
              } else {
                if (statusEl) statusEl.innerHTML = '<span style="color:var(--ezap-warning)">Removido local, erro no HubSpot</span>';
              }
            });
          }
        }
      } else {
        // Delete HubSpot note via API
        var hsId = noteRef;
        btn.textContent = "⏳";
        sendBgMessage({ action: "hubspot_delete_note", noteId: hsId }).then(function(result) {
          if (result && result.ok) {
            // Remove from cached HS notes
            if (window._wcrmHubspotNotes) {
              window._wcrmHubspotNotes = window._wcrmHubspotNotes.filter(function(n) { return n.id !== hsId; });
            }
            renderNotesHistory();
            var statusEl = document.getElementById("wcrm-save-status");
            if (statusEl) statusEl.innerHTML = '<span style="color:var(--ezap-primary)">Nota exclu\u00edda do HubSpot \u2713</span>';
          } else {
            btn.textContent = "🗑️";
            var statusEl = document.getElementById("wcrm-save-status");
            if (statusEl) statusEl.innerHTML = '<span style="color:var(--ezap-danger)">Erro ao excluir: ' + (result && result.error || "erro") + '</span>';
          }
        });
      }
    });
  });
}

function renderTicketLinks(tickets) {
  var html = '';
  tickets.forEach(function(ticket) {
    var tp = ticket.properties;
    var stageName = tp._stageName || tp.hs_pipeline_stage || "-";
    var ticketUrl = "https://app.hubspot.com/contacts/49377285/record/0-5/" + ticket.id;

    html += '<a href="' + ticketUrl + '" target="_blank" class="ezap-card ezap-card--accent" style="display:block;text-decoration:none;cursor:pointer">';
    html += '<div style="font-weight:600;font-size:12px;margin-bottom:4px">' + (tp.subject || "Ticket sem nome") + '</div>';
    html += '<div class="ezap-badge ezap-badge--warning" style="margin-bottom:4px">Status: ' + stageName + '</div>';
    html += '<div class="ezap-action-link" style="display:flex;align-items:center;gap:4px">Abrir no HubSpot &rarr;</div>';
    html += '</a>';
  });
  return html;
}

function renderTicketCard(ticket) {
  var tp = ticket.properties;
  var stageName = tp._stageName || tp.hs_pipeline_stage || "-";

  var callsTotal = tp.nm__total_de_calls_adquiridas__starter__pro__business_ || "0";
  var callsRest = tp.nm__calls_restantes || "0";
  var callsMeli = tp.nova_mentoria__calls_meli_realizadas || "0";
  var callsEspec = tp.nova_mentoria__total_de_calls_especificas_realizadas || "0";
  var callsRealizadas = parseInt(callsMeli || 0) + parseInt(callsEspec || 0);
  var dataInicio = tp.data_de_inicio_dos_blocos;
  var dataFim = tp.data_de_termino_do_2o_bloco;
  var dataFim1 = tp.data_de_termino_do_1o_bloco;
  var modelo = tp.modelo_de_mentoria;

  function fmtDate(val) {
    if (!val) return "-";
    var d = new Date(isNaN(val) ? val : Number(val));
    return isNaN(d.getTime()) ? "-" : d.toLocaleDateString("pt-BR");
  }

  var html = '<div class="ezap-card ezap-card--accent">';
  html += '<div style="font-weight:600;font-size:13px;margin-bottom:4px">' + (tp.subject || "Ticket sem nome") + '</div>';
  html += '<div class="ezap-badge ezap-badge--warning" style="margin-bottom:6px">Status: ' + stageName + '</div>';

  if (modelo) html += '<div class="ezap-row"><span class="ezap-row-label">Modelo</span><span class="ezap-row-value" style="color:var(--ezap-accent);font-weight:600">' + modelo + '</span></div>';

  html += '<div class="ezap-row"><span class="ezap-row-label">Calls adquiridas</span><span class="ezap-row-value" style="font-weight:600">' + callsTotal + '</span></div>';
  html += '<div class="ezap-row"><span class="ezap-row-label">Calls realizadas</span><span class="ezap-row-value" style="color:var(--ezap-warning);font-weight:600">' + callsRealizadas + ' <span style="color:var(--ezap-text-secondary);font-size:10px">(Meli: ' + callsMeli + ' | Espec: ' + callsEspec + ')</span></span></div>';
  html += '<div class="ezap-row"><span class="ezap-row-label">Calls restantes</span><span class="ezap-row-value" style="color:var(--ezap-success);font-weight:600">' + callsRest + '</span></div>';

  html += '<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--ezap-border)">';
  html += '<div class="ezap-row"><span class="ezap-row-label">Início dos blocos</span><span class="ezap-row-value">' + fmtDate(dataInicio) + '</span></div>';
  html += '<div class="ezap-row"><span class="ezap-row-label">Término 1º bloco</span><span class="ezap-row-value">' + fmtDate(dataFim1) + '</span></div>';
  html += '<div class="ezap-row"><span class="ezap-row-label">Término 2º bloco</span><span class="ezap-row-value">' + fmtDate(dataFim) + '</span></div>';
  html += '</div>';

  html += '</div>';
  return html;
}

// ===== Supabase / Mercado Livre Data =====
function fetchSellerData(container, sellerId) {
  container.innerHTML += '<div id="wcrm-ml-loading" class="ezap-loading" style="margin-top:8px">Carregando dados Mercado Livre...</div>';

  sendBgMessage({ action: "supabase_seller_data", sellerId: sellerId }).then(function(data) {
    var loadingEl = document.getElementById("wcrm-ml-loading");
    if (loadingEl) loadingEl.remove();

    if (!data || data.error) {
      container.innerHTML += '<div style="color:var(--ezap-danger);font-size:11px;padding:4px">Erro ML: ' + (data && data.error || "desconhecido") + '</div>';
      return;
    }

    var html = sectionTitle("MERCADO LIVRE");

    // Revenue cards
    html += '<div class="ezap-card" style="border-left:3px solid var(--ezap-warning)">';
    html += '<div class="ezap-section-title" style="color:var(--ezap-warning)">Faturamento</div>';
    html += revenueRow("Últimos 7 dias", data.revenue.days7);
    html += revenueRow("Últimos 14 dias", data.revenue.days14);
    html += revenueRow("Últimos 30 dias", data.revenue.days30);
    html += '</div>';

    // Top products
    if (data.topProducts && data.topProducts.length > 0) {
      html += '<div class="ezap-section-title" style="color:var(--ezap-secondary);margin-top:8px">Top Produtos (all-time)</div>';
      data.topProducts.forEach(function(p, i) {
        var thumb = p.thumbnail ? p.thumbnail.replace("http://", "https://") : "";
        var revenue = (p.sold_quantity * p.price);

        html += '<div class="ezap-card" style="display:flex;align-items:center;gap:8px;padding:8px">';
        if (thumb) {
          html += '<img src="' + thumb + '" style="width:40px;height:40px;border-radius:4px;object-fit:cover;flex-shrink:0" onerror="this.style.display=\'none\'">';
        }
        html += '<div style="flex:1;min-width:0">';
        html += '<div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (i + 1) + '. ' + (p.family_name || "Produto") + '</div>';
        html += '<div style="display:flex;gap:8px;margin-top:2px">';
        html += '<span style="color:var(--ezap-success);font-size:10px;font-weight:600">' + p.sold_quantity + ' vendas</span>';
        html += '<span style="color:var(--ezap-warning);font-size:10px">R$ ' + revenue.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span>';
        html += '</div>';
        html += '</div></div>';
      });
    }

    container.innerHTML += html;
  });
}

function revenueRow(label, value) {
  var formatted = "R$ " + (value || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var color = value > 0 ? "var(--ezap-success)" : "var(--ezap-text-secondary)";
  return '<div class="ezap-row"><span class="ezap-row-label">' + label + '</span><span class="ezap-row-value" style="color:' + color + ';font-weight:700">' + formatted + '</span></div>';
}

function sectionTitle(text) {
  return '<div class="ezap-section-title" style="margin-top:12px">' + text + '</div>';
}

function hsCard(type, title, msg) {
  var statusClass = { "no-key": "ezap-status--no-key", "not-found": "ezap-status--not-found", "error": "ezap-status--not-found" };
  var cls = statusClass[type] || "ezap-status--no-key";
  return '<div class="ezap-card"><span class="ezap-status ' + cls + '">' + title + '</span><p style="margin:8px 0 0;color:var(--ezap-text-secondary);font-size:12px">' + msg + '</p></div>';
}

function row(label, value) {
  return '<div class="ezap-row"><span class="ezap-row-label">' + label + '</span><span class="ezap-row-value" title="' + value + '">' + value + '</span></div>';
}

function rowCopy(label, value, copyValue) {
  var cv = (copyValue || value || "").replace(/"/g, '&quot;');
  return '<div class="ezap-row" style="align-items:center">' +
    '<span class="ezap-row-label">' + label + '</span>' +
    '<span style="display:flex;align-items:center;gap:4px;max-width:65%;min-width:0">' +
      '<span class="ezap-row-value" style="max-width:none" title="' + value + '">' + value + '</span>' +
      '<span class="wcrm-copy-btn ezap-copy-btn" data-copy="' + cv + '" title="Copiar">&#x1F4CB;</span>' +
    '</span></div>';
}

// ===== Chat Observer =====
var _detectDebounceTimer = null;

function observeChatChanges() {
  var observer = new MutationObserver(function() {
    // Debounce: MutationObserver fires many times per DOM change,
    // we only need to detect once after things settle (150ms)
    if (_detectDebounceTimer) clearTimeout(_detectDebounceTimer);
    _detectDebounceTimer = setTimeout(detectCurrentChat, 150);
  });

  var app = document.getElementById("app");
  if (app) {
    observer.observe(app, { childList: true, subtree: true });
    console.log("[WCRM] Observing chat changes");
  }

  // Safety-net polling at 3s (just a fallback, MutationObserver is the primary)
  var crmInterval = setInterval(function() {
    try { if (!chrome.runtime || !chrome.runtime.id) { clearInterval(crmInterval); return; } } catch(e) { clearInterval(crmInterval); return; }
    detectCurrentChat();
  }, 3000);
}

function detectCurrentChat() {
  try {
    // Method 1: conversation header
    var header = document.querySelector('[data-testid="conversation-header"]') ||
                 document.querySelector("header._amid") ||
                 document.querySelector("#main header");

    if (!header) return;

    var nameEl = header.querySelector("span[dir='auto']") ||
                 header.querySelector("span[title]");

    if (!nameEl) return;

    var name = (nameEl.getAttribute("title") || nameEl.textContent || "").trim();
    if (!name || name === currentName) return;

    currentName = name;

    // Check if name is a phone number
    var cleaned = name.replace(/[\s\-\(\)\+]/g, "");
    if (/^\d{10,}$/.test(cleaned)) {
      currentPhone = cleaned;
    } else {
      // Try to find phone in header subtitle or other elements
      var allSpans = header.querySelectorAll("span");
      var found = false;
      for (var i = 0; i < allSpans.length; i++) {
        var text = (allSpans[i].getAttribute("title") || allSpans[i].textContent || "").trim();
        var phoneCleaned = text.replace(/[\s\-\(\)\+]/g, "");
        if (/^\d{10,15}$/.test(phoneCleaned) && phoneCleaned !== cleaned) {
          currentPhone = phoneCleaned;
          found = true;
          break;
        }
      }
      if (!found) {
        currentPhone = name; // Use name as fallback key
      }
    }

    console.log("[WCRM] Chat changed:", currentName, "->", currentPhone);

    // Refresh widget IMMEDIATELY (pin, abas, tags, sig) — no more 2s polling delay
    if (typeof window.__ezapRefreshWidget === 'function') {
      window.__ezapRefreshWidget();
    }

    // Auto-switch from ABAS to CRM when user clicks a contact
    if (typeof abasSidebarOpen !== 'undefined' && abasSidebarOpen) {
      // Refresh ABAS contact toggles
      if (typeof renderAbasSidebar === 'function') renderAbasSidebar();
    }

    // Always preload in background (warms cache for faster sidebar render)
    preloadHubSpotData();

    if (sidebarOpen) {
      renderContactInfo();
    }
  } catch (e) {
    console.error("[WCRM] Error detecting chat:", e);
  }
}

// ===== INIT =====
function init() {
  console.log("[WCRM] Initializing...");
  createToggleButton();
  createSidebar();

  loadLabelsData().then(function() {
    loadLabelTemplates();
    observeChatChanges();
    console.log("[WCRM] Ready!");
  });
}

// Start after authentication (only if 'crm' feature is enabled)
document.addEventListener("wcrm-auth-ready", function() {
  if (window.__ezapHasFeature && window.__ezapHasFeature("crm")) {
    setTimeout(init, 500);
  } else {
    console.log("[WCRM] CRM feature not enabled for this user");
  }
});
if (window.__wcrmAuth && window.__ezapHasFeature && window.__ezapHasFeature("crm")) setTimeout(init, 2000);

// ===================================================================
// ===== ASSINATURA (Signature) — On-send injection =================
// Appends signature at the END of the message right before sending.
// The compose box stays clean — mic button remains visible.
// ===================================================================
(function() {
  var _sigInitialized = false;
  var _sigEnabled = false;
  var _sigName = "";

  // ===== Toggle (exposed globally for widget.js) =====
  function toggleSignature() {
    _sigEnabled = !_sigEnabled;
    var auth = window.__wcrmAuth;
    if (auth && auth.userId) {
      window.ezapSendBg({
        action: "supabase_rest",
        path: "/rest/v1/users?id=eq." + auth.userId,
        method: "PATCH",
        body: { signature_enabled: _sigEnabled },
        prefer: "return=minimal"
      });
      auth.signatureEnabled = _sigEnabled;
    }
    console.log("[EZAP-SIG] Signature", _sigEnabled ? "ENABLED" : "DISABLED");
  }

  window.__ezapToggleSignature = toggleSignature;

  // ===== Compose box finder =====
  function getComposeInput() {
    return document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
           document.querySelector('#main footer div[contenteditable="true"][role="textbox"]') ||
           document.querySelector('[data-testid="conversation-compose-box-input"]');
  }

  // ===== Inject signature at the END of the message =====
  function injectSignature(input, callback) {
    if (!_sigEnabled || !_sigName) { if (callback) callback(); return; }

    var text = (input.textContent || input.innerText || "").trim();
    if (!text) { if (callback) callback(); return; }

    // Don't double-inject
    var sigSuffix = "_*" + _sigName + "*_";
    if (text.endsWith(sigSuffix)) { if (callback) callback(); return; }

    // Move cursor to end and paste signature
    input.focus();
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    var clipData = new DataTransfer();
    clipData.setData("text/plain", "\n\n" + sigSuffix);
    input.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: clipData
    }));

    console.log("[EZAP-SIG] Signature appended at end");
    if (callback) setTimeout(callback, 80);
  }

  function triggerSend() {
    var sendBtn = document.querySelector('[data-testid="send"], [aria-label="Enviar"], button[aria-label="Send"]');
    if (sendBtn) {
      _sigEnabled = false;
      sendBtn.click();
      _sigEnabled = true;
    }
  }

  // ===== Intercept send button click =====
  function onSendClick(e) {
    if (!_sigEnabled) return;
    var input = getComposeInput();
    if (!input) return;
    var text = (input.textContent || input.innerText || "").trim();
    if (!text) return;

    e.stopImmediatePropagation();
    e.preventDefault();

    // Inject signature, then send via callback
    injectSignature(input, triggerSend);
  }

  // ===== Intercept Enter key =====
  function onKeyDown(e) {
    if (!_sigEnabled) return;
    if (e.key !== "Enter" || e.shiftKey) return;

    var input = getComposeInput();
    if (!input) return;
    if (e.target !== input && !input.contains(e.target)) return;

    var text = (input.textContent || input.innerText || "").trim();
    if (!text) return;

    e.stopImmediatePropagation();
    e.preventDefault();

    injectSignature(input, function() {
      setTimeout(triggerSend, 50);
    });
  }

  // ===== Attach listeners (use MutationObserver to catch send button) =====
  function attachSendListener() {
    // Listen for clicks on send button
    document.addEventListener("click", function(e) {
      if (!_sigEnabled) return;
      var btn = e.target.closest('[data-testid="send"], [aria-label="Enviar"], button[aria-label="Send"]');
      if (btn) onSendClick(e);
    }, true); // capture phase to intercept before WA

    // Listen for Enter in compose box
    document.addEventListener("keydown", onKeyDown, true);
  }

  // ===== Init =====
  function initSignature() {
    if (_sigInitialized) return;
    var auth = window.__wcrmAuth;
    if (!auth) return;

    _sigName = auth.userName || "";
    _sigEnabled = auth.signatureEnabled || false;
    _sigInitialized = true;

    attachSendListener();
    console.log("[EZAP-SIG] On-send signature initialized. Enabled:", _sigEnabled, "Name:", _sigName);
  }

  document.addEventListener("wcrm-auth-ready", function() {
    setTimeout(initSignature, 1000);
  });
  if (window.__wcrmAuth) setTimeout(initSignature, 2500);
})();

// ===================================================================
// ===== GROUP SYNC — Members + Chat Name History ===================
// Syncs group participants and tracks chat name changes.
// Lazy: only syncs when user opens a group. Max 1x per 10min per group.
// ===================================================================
(function() {
  "use strict";
  var _syncCache = {};    // groupJid -> lastSyncTime
  var _nameCache = {};    // chatJid -> lastKnownName
  var SYNC_COOLDOWN = 10 * 60 * 1000; // 10 minutes
  var _lastChatJid = null;
  var _lastDebugName = null;

  function getUserId() {
    return (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
  }

  function supa(path, method, body, prefer) {
    return window.ezapSupaRest ? window.ezapSupaRest(path, method, body, prefer) : Promise.resolve(null);
  }

  // ===== Detect current chat JID and name =====
  // Reuses the same name detected by detectCurrentChat() (already running)
  function getCurrentChat() {
    // Use the global currentName that detectCurrentChat() already maintains
    var name = (typeof currentName !== 'undefined') ? currentName : '';
    if (!name) return null;

    // Get JID: try extracting from a visible message WID
    var msgRows = document.querySelectorAll('div[role="row"] [data-id]');
    var jid = '';
    for (var ri = 0; ri < msgRows.length; ri++) {
      var wid = msgRows[ri].getAttribute('data-id') || '';
      var parts = wid.split('_');
      if (parts.length >= 2 && parts[1].indexOf('@') >= 0) {
        jid = parts[1];
        break;
      }
    }

    var isGroup = jid.indexOf('@g.us') >= 0 || jid.indexOf('@lid') >= 0;
    return { jid: jid, name: name, isGroup: isGroup };
  }

  // ===== Sync group members to DB =====
  function syncGroupMembers(groupJid, groupName) {
    if (!groupJid || !getUserId()) return;

    // Cooldown check
    var now = Date.now();
    if (_syncCache[groupJid] && (now - _syncCache[groupJid]) < SYNC_COOLDOWN) return;
    _syncCache[groupJid] = now;

    if (typeof window.ezapGetGroupMembers !== 'function') return;

    window.ezapGetGroupMembers(groupJid).then(function(result) {
      if (!result || !result.ok || !result.members || !result.members.length) return;

      var members = result.members;
      var userId = getUserId();
      console.log("[EZAP-SYNC] Syncing", members.length, "members for group:", groupName || groupJid);

      // Step 1: Mark all current members as left_at = now (will be cleared for active members)
      // Step 2: Upsert each member
      // Using individual upserts (Supabase REST doesn't support bulk upsert easily)
      members.forEach(function(m) {
        if (!m.phone) return;
        var role = m.isSuperAdmin ? 'superadmin' : (m.isAdmin ? 'admin' : 'member');
        supa("/rest/v1/group_members", "POST", {
          group_jid: groupJid,
          group_name: groupName || null,
          member_phone: m.phone,
          member_name: m.name || null,
          role: role,
          last_seen: new Date().toISOString(),
          left_at: null,
          recorded_by: userId
        }, "resolution=merge-duplicates,return=minimal");
      });

      // Step 3: Mark members NOT in the current list as left
      // Get all DB members for this group, compare with current list
      var currentPhones = {};
      members.forEach(function(m) { if (m.phone) currentPhones[m.phone] = true; });

      supa("/rest/v1/group_members?group_jid=eq." + encodeURIComponent(groupJid) + "&left_at=is.null&select=member_phone", "GET").then(function(dbMembers) {
        if (!Array.isArray(dbMembers)) return;
        dbMembers.forEach(function(dbm) {
          if (!currentPhones[dbm.member_phone]) {
            // This member left the group
            supa("/rest/v1/group_members?group_jid=eq." + encodeURIComponent(groupJid) + "&member_phone=eq." + encodeURIComponent(dbm.member_phone), "PATCH", {
              left_at: new Date().toISOString()
            }, "return=minimal");
          }
        });
      });
    });
  }

  // ===== Track chat name changes =====
  function trackNameChange(chatJid, currentName) {
    if (!chatJid || !currentName || !getUserId()) return;

    var lastKnown = _nameCache[chatJid];
    _nameCache[chatJid] = currentName;

    // First time seeing this chat — no change to record
    if (!lastKnown) return;

    // Name didn't change
    if (lastKnown === currentName) return;

    // Only record if we've been on this SAME JID for at least 2 consecutive checks
    // This prevents false positives during chat switching (JID from old messages)
    if (_lastChatJid !== chatJid) return;

    // Name changed! Record it
    console.log("[EZAP-SYNC] Name change detected:", lastKnown, "->", currentName);
    supa("/rest/v1/chat_name_history", "POST", {
      chat_jid: chatJid,
      old_name: lastKnown,
      new_name: currentName,
      detected_by: getUserId()
    }, "return=minimal");

    // Also update chat_name in message_notes for this chat
    supa("/rest/v1/message_notes?chat_jid=eq." + encodeURIComponent(chatJid), "PATCH", {
      chat_name: currentName
    }, "return=minimal");
  }

  // ===== Poll for chat changes =====
  function checkCurrentChat() {
    var chat = getCurrentChat();
    if (!chat) return;
    if (!chat.jid) {
      // JID not found — log once per chat name to debug
      if (chat.name && chat.name !== _lastDebugName) {
        _lastDebugName = chat.name;
        console.log("[EZAP-SYNC] Chat detected but no JID:", chat.name);
      }
      return;
    }

    // Track name changes (for all chats, not just groups)
    trackNameChange(chat.jid, chat.name);

    // Sync group members (only for groups)
    if (chat.isGroup) {
      syncGroupMembers(chat.jid, chat.name);
    }

    _lastChatJid = chat.jid;
  }

  // ===== Init =====
  function init() {
    if (!getUserId()) return;
    console.log("[EZAP-SYNC] Group sync + name history initialized");

    // Check every 3 seconds for chat changes
    setInterval(checkCurrentChat, 3000);

    // Initial check after a delay
    setTimeout(checkCurrentChat, 3000);
  }

  document.addEventListener("wcrm-auth-ready", function() {
    setTimeout(init, 3000);
  });
  if (window.__wcrmAuth) setTimeout(init, 5000);
})();
