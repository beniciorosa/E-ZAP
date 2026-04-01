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

// ===== Create button IMMEDIATELY =====
function createToggleButton() {
  if (document.getElementById("wcrm-toggle")) return;
  console.log("[WCRM] Creating toggle button");
  const btn = document.createElement("button");
  btn.id = "wcrm-toggle";
  btn.textContent = "CRM";
  btn.title = "WhatsApp CRM";
  btn.addEventListener("click", toggleSidebar);
  // Inline styles to guarantee visibility
  Object.assign(btn.style, {
    position: "fixed",
    top: "80px",
    right: "16px",
    width: "50px",
    height: "50px",
    borderRadius: "50%",
    background: "#25d366",
    color: "#111b21",
    border: "none",
    fontSize: "12px",
    fontWeight: "bold",
    cursor: "pointer",
    zIndex: "99999",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  document.body.appendChild(btn);
  console.log("[WCRM] Toggle button added to page");
}

// ===== Sidebar =====
function createSidebar() {
  if (document.getElementById("wcrm-sidebar")) return;
  console.log("[WCRM] Creating sidebar");

  const sidebar = document.createElement("div");
  sidebar.id = "wcrm-sidebar";
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
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    color: "#e9edef",
    fontSize: "13px",
    overflow: "hidden",
  });

  sidebar.innerHTML = `
    <style>
      #wcrm-notes-editor ul, #wcrm-notes-editor ol { margin:4px 0; padding-left:18px; }
      #wcrm-notes-editor ul { list-style-type:disc !important; }
      #wcrm-notes-editor ol { list-style-type:decimal !important; }
      #wcrm-notes-editor li { display:list-item !important; list-style:inherit !important; margin-bottom:2px; }
      .wcrm-note-item ul { list-style-type:disc !important; padding-left:16px; margin:2px 0; }
      .wcrm-note-item li { display:list-item !important; list-style:inherit !important; }
    </style>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#202c33;border-bottom:1px solid #2a3942;min-height:48px">
      <h3 style="margin:0;font-size:15px;font-weight:600;color:#e9edef">WhatsApp CRM</h3>
      <button id="wcrm-close-btn" style="background:none;border:none;color:#8696a0;font-size:22px;cursor:pointer;padding:4px 8px">&times;</button>
    </div>
    <div id="wcrm-content" style="flex:1;overflow-y:auto;padding:16px">
      <div id="wcrm-no-chat" style="color:#8696a0;font-size:13px;text-align:center;padding:20px;font-style:italic">
        Abra uma conversa para ver as informacoes do contato
      </div>
      <div id="wcrm-chat-info" style="display:none">
        <div id="wcrm-name" style="font-size:17px;font-weight:600;color:#e9edef;margin-bottom:4px"></div>
        <div id="wcrm-phone" style="font-size:13px;color:#8696a0;margin-bottom:16px"></div>

        <div style="margin-bottom:20px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin-bottom:8px;font-weight:600">ETIQUETAS</div>
          <div id="wcrm-labels-container" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <input type="text" id="wcrm-label-input" placeholder="Nova etiqueta..." maxlength="30"
              style="flex:1;background:#2a3942;border:1px solid #3b4a54;border-radius:8px;padding:6px 10px;color:#e9edef;font-size:12px;outline:none">
            <button id="wcrm-add-label-btn"
              style="background:#25d366;color:#111b21;border:none;border-radius:8px;padding:6px 12px;font-size:14px;font-weight:600;cursor:pointer">+</button>
          </div>
          <div id="wcrm-color-picker" style="display:flex;gap:4px;margin-top:6px"></div>
        </div>

        <div style="margin-bottom:20px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin-bottom:8px;font-weight:600">OBSERVAÇÕES</div>
          <div style="background:#2a3942;border:1px solid #3b4a54;border-radius:8px;overflow:hidden">
            <div id="wcrm-editor-toolbar" style="display:flex;gap:2px;padding:4px 6px;border-bottom:1px solid #3b4a54;background:#202c33">
              <button data-cmd="bold" style="background:none;border:none;color:#8696a0;font-size:13px;font-weight:700;cursor:pointer;padding:2px 6px;border-radius:4px" title="Negrito"><b>B</b></button>
              <button data-cmd="italic" style="background:none;border:none;color:#8696a0;font-size:13px;font-style:italic;cursor:pointer;padding:2px 6px;border-radius:4px" title="Italico"><i>I</i></button>
              <button data-cmd="underline" style="background:none;border:none;color:#8696a0;font-size:13px;text-decoration:underline;cursor:pointer;padding:2px 6px;border-radius:4px" title="Sublinhado"><u>U</u></button>
              <button data-cmd="insertUnorderedList" style="background:none;border:none;color:#8696a0;font-size:13px;cursor:pointer;padding:2px 6px;border-radius:4px" title="Lista">• ≡</button>
            </div>
            <div id="wcrm-notes-editor" contenteditable="true" style="min-height:70px;padding:8px 10px;color:#e9edef;font-size:12px;font-family:inherit;outline:none;max-height:150px;overflow-y:auto" data-placeholder="Escreva uma observação..."></div>
          </div>
          <button id="wcrm-save-note-btn" style="margin-top:6px;width:100%;background:#4d96ff;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:600;cursor:pointer">Salvar Observação</button>
          <div id="wcrm-save-status" style="font-size:10px;text-align:center;margin-top:4px;min-height:14px"></div>
          <div id="wcrm-notes-history" style="margin-top:8px"></div>
        </div>

        <div style="height:1px;background:#2a3942;margin:16px 0"></div>

        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin-bottom:8px;font-weight:600">HUBSPOT CRM</div>
          <div id="wcrm-hubspot-container">
            <div style="color:#8696a0;font-size:12px;text-align:center;padding:8px">Buscando no HubSpot...</div>
          </div>
        </div>

        <div style="height:1px;background:#2a3942;margin:16px 0"></div>

        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin-bottom:8px;font-weight:600">REUNIOES</div>
          <div id="wcrm-meetings-container">
            <div style="color:#8696a0;font-size:12px;text-align:center;padding:8px;font-style:italic">Aguardando dados do HubSpot...</div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(sidebar);

  // Events
  document.getElementById("wcrm-close-btn").addEventListener("click", toggleSidebar);
  document.getElementById("wcrm-add-label-btn").addEventListener("click", addLabel);
  document.getElementById("wcrm-label-input").addEventListener("keydown", function(e) {
    if (e.key === "Enter") addLabel();
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

  // Save note button
  document.getElementById("wcrm-save-note-btn").addEventListener("click", saveNote);

  renderColorPicker();
  console.log("[WCRM] Sidebar created");
}

// ===== Toggle =====
function toggleSidebar() {
  // Close other sidebars if open
  if (typeof msgSidebarOpen !== 'undefined' && msgSidebarOpen) closeMsgSidebar();
  if (typeof sliceSidebarOpen !== 'undefined' && sliceSidebarOpen) closeSliceSidebar();
  if (typeof abasSidebarOpen !== 'undefined' && abasSidebarOpen) closeAbasSidebar();

  var sidebar = document.getElementById("wcrm-sidebar");
  sidebarOpen = !sidebarOpen;
  sidebar.style.display = sidebarOpen ? "flex" : "none";

  // Shrink WhatsApp app to make room for sidebar
  var appEl = document.getElementById("app");
  if (appEl) {
    if (sidebarOpen) {
      appEl.style.width = "calc(100% - 320px)";
      appEl.style.maxWidth = "calc(100% - 320px)";
      appEl.style.marginRight = "0";
    } else {
      appEl.style.width = "";
      appEl.style.maxWidth = "";
      appEl.style.marginRight = "";
    }
  }

  // Hide/show floating buttons
  updateFloatingButtons();

  if (sidebarOpen && currentPhone) {
    renderContactInfo();
  }
}

function updateFloatingButtons() {
  var crmBtn = document.getElementById("wcrm-toggle");
  var msgBtn = document.getElementById("wcrm-msg-toggle");
  var sliceBtn = document.getElementById("wcrm-slice-toggle");
  var abasBtn = document.getElementById("wcrm-abas-toggle");
  var anySidebarOpen = sidebarOpen ||
    (typeof msgSidebarOpen !== 'undefined' && msgSidebarOpen) ||
    (typeof sliceSidebarOpen !== 'undefined' && sliceSidebarOpen) ||
    (typeof abasSidebarOpen !== 'undefined' && abasSidebarOpen);
  if (crmBtn) crmBtn.style.display = anySidebarOpen ? "none" : "flex";
  if (msgBtn) msgBtn.style.display = anySidebarOpen ? "none" : "flex";
  if (sliceBtn) sliceBtn.style.display = anySidebarOpen ? "none" : "flex";
  if (abasBtn) abasBtn.style.display = anySidebarOpen ? "none" : "flex";
}

// ===== Color Picker =====
function renderColorPicker() {
  var picker = document.getElementById("wcrm-color-picker");
  if (!picker) return;
  picker.innerHTML = "";
  LABEL_COLORS.forEach(function(color, i) {
    var dot = document.createElement("div");
    dot.style.cssText = "width:20px;height:20px;border-radius:50%;cursor:pointer;border:2px solid transparent;background:" + color;
    dot.dataset.color = color;
    if (i === 0) dot.dataset.selected = "1";
    dot.addEventListener("click", function() {
      picker.querySelectorAll("div").forEach(function(d) {
        d.dataset.selected = "";
        d.style.borderColor = "transparent";
      });
      dot.dataset.selected = "1";
      dot.style.borderColor = "#e9edef";
    });
    if (i === 0) dot.style.borderColor = "#e9edef";
    picker.appendChild(dot);
  });
}

function getSelectedColor() {
  var picker = document.getElementById("wcrm-color-picker");
  if (!picker) return LABEL_COLORS[0];
  var selected = picker.querySelector('div[data-selected="1"]');
  return selected ? selected.dataset.color : LABEL_COLORS[0];
}

// ===== Storage =====
function loadLabelsData() {
  return new Promise(function(resolve) {
    chrome.storage.local.get("wcrm_labels", function(data) {
      labelsData = (data && data.wcrm_labels) || {};
      // Clean up buggy empty key
      if (labelsData[""]) { delete labelsData[""]; saveLabelsData(); }
      console.log("[WCRM] Labels loaded:", Object.keys(labelsData).length, "contacts");
      resolve();
    });
  });
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
function addLabel() {
  var input = document.getElementById("wcrm-label-input");
  var name = input.value.trim();
  if (!name || !currentPhone) return;

  var data = getContactData(currentPhone);
  if (!data.labels) data.labels = [];
  var exists = data.labels.some(function(l) { return l.name.toLowerCase() === name.toLowerCase(); });
  if (exists) return;

  data.labels.push({ name: name, color: getSelectedColor() });
  setContactData(currentPhone, data);
  input.value = "";
  renderLabels();
}

function removeLabel(index) {
  var data = getContactData(currentPhone);
  data.labels.splice(index, 1);
  setContactData(currentPhone, data);
  renderLabels();
}

function renderLabels() {
  var container = document.getElementById("wcrm-labels-container");
  if (!container) return;
  var data = getContactData(currentPhone);
  container.innerHTML = "";

  if (!data.labels || data.labels.length === 0) {
    container.innerHTML = '<span style="color:#8696a0;font-size:12px;font-style:italic">Nenhuma etiqueta</span>';
    return;
  }

  data.labels.forEach(function(label, i) {
    var el = document.createElement("span");
    el.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:500;color:#111b21;background:" + label.color;
    el.innerHTML = label.name + '<span style="cursor:pointer;font-size:14px;opacity:0.6;margin-left:2px" data-idx="' + i + '">&times;</span>';
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
  window._wcrmEditingHsId = null;
  window._wcrmLoadId = Date.now(); // Unique ID to prevent stale async responses

  document.getElementById("wcrm-name").textContent = currentName || "Desconhecido";
  document.getElementById("wcrm-phone").textContent = currentPhone;

  renderLabels();

  var data = getContactData(currentPhone);
  document.getElementById("wcrm-notes-editor").innerHTML = "";

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
      Object.assign(bar.style, {
        width: "100%",
        height: "3px",
        background: "#2a3942",
        overflow: "hidden",
        borderRadius: "2px",
        margin: "4px 0 8px",
      });
      var fill = document.createElement("div");
      fill.id = "wcrm-loading-bar-fill";
      Object.assign(fill.style, {
        width: "30%",
        height: "100%",
        background: "#25d366",
        borderRadius: "2px",
        animation: "wcrm-loading 1.2s ease-in-out infinite",
      });
      bar.appendChild(fill);

      // Inject animation keyframes if not yet present
      if (!document.getElementById("wcrm-loading-css")) {
        var style = document.createElement("style");
        style.id = "wcrm-loading-css";
        style.textContent = "@keyframes wcrm-loading { 0% { margin-left: 0; width: 30%; } 50% { margin-left: 40%; width: 50%; } 100% { margin-left: 100%; width: 10%; } }";
        document.head.appendChild(style);
      }

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

// ===== HubSpot =====
function sendBgMessage(msg) {
  return new Promise(function(resolve) {
    // Timeout after 15s
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; resolve({ error: "Timeout - background worker nao respondeu" }); }
    }, 15000);

    try {
      chrome.runtime.sendMessage(msg, function(response) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { error: "Sem resposta" });
        }
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); resolve({ error: e.message }); }
    }
  });
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

function fetchHubSpotData() {
  var container = document.getElementById("wcrm-hubspot-container");
  if (!container || !currentPhone) return;

  var loadId = window._wcrmLoadId; // Capture current load ID to detect stale responses
  container.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:8px">Buscando no HubSpot...</div>';
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
        container.innerHTML = hsCard("not-found", "Nao encontrado", "Nenhum ticket de mentoria encontrado para este contato.");
        var meetingsC = document.getElementById("wcrm-meetings-container");
        if (meetingsC) meetingsC.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:8px;font-style:italic">Sem dados</div>';
        showLoadingBar(false);
        return;
      }

      // Build the card
      var ticketUrl = ticket ? "https://app.hubspot.com/contacts/49377285/record/0-5/" + ticket.id : "";

      var html = '<div style="background:#202c33;border-radius:8px;padding:12px">';
      html += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
      html += '<span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#25d36620;color:#25d366">Encontrado no HubSpot</span>';
      if (ticket) {
        html += '<a href="' + ticketUrl + '" target="_blank" style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#cc5de820;color:#cc5de8;text-decoration:none;cursor:pointer" title="Abrir ticket no HubSpot">Ver Ticket ↗</a>';
        html += '<span class="wcrm-copy-btn" data-copy="' + ticketUrl + '" style="cursor:pointer;font-size:11px;color:#8696a0;padding:2px 4px;border-radius:3px" title="Copiar link do ticket">📋</span>';
        window._wcrmTicketId = ticket.id;
      }
      html += '</div>';
      html += '<div style="margin-top:10px">';
      html += rowCopy("Nome", displayName, displayName);
      // Ticket creation date
      if (ticket && ticket.properties.createdate) {
        var ticketDate = new Date(ticket.properties.createdate);
        var dd = String(ticketDate.getDate()).padStart(2, "0");
        var mm = String(ticketDate.getMonth() + 1).padStart(2, "0");
        var yyyy = ticketDate.getFullYear();
        html += row("Criado em", dd + "/" + mm + "/" + yyyy);
      }
      // Calls adquiridas from ticket
      if (ticket && ticket.properties.nm__total_de_calls_adquiridas__starter__pro__business_) {
        html += row("Reunioes Adquiridas", ticket.properties.nm__total_de_calls_adquiridas__starter__pro__business_);
      }
      // Only show contact details if the contact actually matches
      if (contactMatches) {
        if (contactProps.email) html += row("Email", contactProps.email);
        if (contactProps.phone) html += row("Telefone", contactProps.phone);
        if (contactProps.lifecyclestage) html += row("Lifecycle", contactProps.lifecyclestage);
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
            btn.textContent = "✓";
            btn.style.color = "#25d366";
            setTimeout(function() { btn.textContent = orig; btn.style.color = "#8696a0"; }, 1500);
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
    });
  });
}

// ===== Meetings =====
function fetchMeetings(ticketId, contactId) {
  var container = document.getElementById("wcrm-meetings-container");
  if (!container) return;
  var loadId = window._wcrmLoadId;

  if (!ticketId && !contactId) {
    container.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:8px;font-style:italic">Sem ticket/contato para buscar reunioes</div>';
    return;
  }

  container.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:8px">Buscando reunioes...</div>';

  sendBgMessage({ action: "hubspot_get_meetings", ticketId: ticketId, contactId: contactId }).then(function(result) {
    if (window._wcrmLoadId !== loadId) return; // Contact changed, abort
    console.log("[WCRM] Meetings result:", result);

    if (!result || !result.meetings || result.meetings.length === 0) {
      container.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:8px;font-style:italic">Nenhuma reuniao encontrada</div>';
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

    var html = '';

    // Futuras
    if (futuras.length > 0) {
      html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#ff922b;margin-bottom:6px;font-weight:600">Proximas (' + futuras.length + ')</div>';
      futuras.forEach(function(m) {
        html += renderMeetingItem(m, true);
      });
    }

    // Realizadas
    if (realizadas.length > 0) {
      html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin:' + (futuras.length > 0 ? '10px' : '0') + ' 0 6px;font-weight:600">Realizadas (' + realizadas.length + ')</div>';
      realizadas.forEach(function(m) {
        html += renderMeetingItem(m, false);
      });
    }

    container.innerHTML = html;
  });
}

function renderMeetingItem(meeting, isFuture) {
  var mp = meeting.properties;
  var title = mp.hs_meeting_title || "Reuniao sem titulo";
  var startTime = mp.hs_meeting_start_time || mp.hs_timestamp || "";
  var dateStr = "";
  if (startTime) {
    var d = new Date(startTime);
    dateStr = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) +
      " as " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  var borderColor = isFuture ? "#ff922b" : "#3b4a54";
  var dateColor = isFuture ? "#ff922b" : "#8696a0";

  var html = '<div style="background:#1a2730;border-radius:6px;padding:8px 10px;margin-bottom:4px;border-left:3px solid ' + borderColor + '">';
  html += '<div style="font-size:12px;font-weight:600;color:#e9edef;line-height:1.3">' + title + '</div>';
  if (dateStr) {
    html += '<div style="font-size:10px;color:' + dateColor + ';margin-top:3px">' + dateStr + '</div>';
  }
  html += '</div>';
  return html;
}

// ===== Notes =====
function saveNote() {
  var editor = document.getElementById("wcrm-notes-editor");
  var statusEl = document.getElementById("wcrm-save-status");
  var noteHtml = editor.innerHTML.trim();

  if (!noteHtml || noteHtml === "<br>" || noteHtml === '<div><br></div>') {
    statusEl.innerHTML = '<span style="color:#ff6b6b">Escreva algo antes de salvar</span>';
    return;
  }

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
        statusEl.innerHTML = '<span style="color:#25d366">Atualizado no HubSpot ✓</span>';
      } else {
        statusEl.innerHTML = '<span style="color:#ff6b6b">Erro ao atualizar: ' + (result && result.error || "erro") + '</span>';
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
        setContactData(key, data);
        statusEl.innerHTML = '<span style="color:#25d366">Salvo no HubSpot ✓</span>';
      } else {
        statusEl.innerHTML = '<span style="color:#ff922b">Salvo local. HubSpot: ' + (result && result.error || "erro") + '</span>';
      }
      editor.innerHTML = "";
      renderNotesHistory();
    });
  } else {
    btn.disabled = false;
    btn.textContent = "Salvar Observação"; window._wcrmEditingIdx = null;
    statusEl.innerHTML = '<span style="color:#ff922b">Salvo localmente (sem ticket vinculado)</span>';
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

  var html = '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin-bottom:6px;font-weight:600">HISTÓRICO</div>';

  // Store allNotes on window so event handlers can access them
  window._wcrmAllNotes = allNotes;

  visibleNotes.forEach(function(note, visIdx) {
    var dateStr = note.date ? new Date(note.date).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    var sourceTag = note.source === "hs"
      ? '<span style="color:#25d366;font-size:10px" title="Do HubSpot">HS</span>'
      : '<span style="color:#8696a0;font-size:10px">local</span>';

    // Use visIdx to find the note in allNotes; store note type + id
    var noteType = note.hsId ? "hs" : "local";
    var noteRef = note.hsId ? note.hsId : note.localIdx;

    html += '<div class="wcrm-note-item" data-note-type="' + noteType + '" data-note-ref="' + noteRef + '" data-vis-idx="' + visIdx + '" style="background:#1a2730;border-radius:6px;padding:8px;margin-bottom:4px;border-left:2px solid #3b4a54;transition:background 0.15s" onmouseover="this.style.background=\'#243340\'" onmouseout="this.style.background=\'#1a2730\'">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
    html += '<span style="color:#8696a0;font-size:10px">' + dateStr + '</span>';
    html += '<div style="display:flex;align-items:center;gap:6px">';
    html += sourceTag;
    html += '<span class="wcrm-note-edit" data-note-type="' + noteType + '" data-note-ref="' + noteRef + '" data-vis-idx="' + visIdx + '" style="color:#4d96ff;font-size:12px;cursor:pointer;padding:2px 4px;line-height:1;border-radius:3px;transition:background 0.15s" title="Editar" onmouseover="this.style.background=\'#2a3942\'" onmouseout="this.style.background=\'none\'">✏️</span>';
    html += '<span class="wcrm-note-delete" data-note-type="' + noteType + '" data-note-ref="' + noteRef + '" data-vis-idx="' + visIdx + '" style="color:#ff6b6b;font-size:12px;cursor:pointer;padding:2px 4px;line-height:1;border-radius:3px;transition:background 0.15s" title="Excluir" onmouseover="this.style.background=\'#2a3942\'" onmouseout="this.style.background=\'none\'">🗑️</span>';
    html += '</div></div>';
    // Content with max-height and click-to-expand
    html += '<div class="wcrm-note-content" style="color:#e9edef;font-size:11px;line-height:1.4;max-height:60px;overflow:hidden;position:relative">' + note.html + '</div>';
    html += '</div>';
  });

  // "Ver mais" / "Ver menos" toggle
  if (hasMore) {
    if (expanded) {
      html += '<div id="wcrm-notes-toggle" style="text-align:center;padding:6px;cursor:pointer;color:#4d96ff;font-size:11px;font-weight:600">▲ Ver menos</div>';
    } else {
      html += '<div id="wcrm-notes-toggle" style="text-align:center;padding:6px;cursor:pointer;color:#4d96ff;font-size:11px;font-weight:600">▼ Ver mais (' + (allNotes.length - DEFAULT_SHOW) + ')</div>';
    }
  }

  container.innerHTML = html;

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
      contentEl.insertAdjacentHTML("beforeend", '<div style="position:absolute;bottom:0;left:0;right:0;height:20px;background:linear-gradient(transparent,#1a2730);pointer-events:none" class="wcrm-fade-overlay"></div>');
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

      if (noteType === "local") {
        // Delete local note
        var idx = parseInt(noteRef);
        var key = contactKey(currentPhone);
        var data = getContactData(key);
        if (data.notesHistory && data.notesHistory[idx] !== undefined) {
          data.notesHistory.splice(idx, 1);
          setContactData(key, data);
          renderNotesHistory();
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
            if (statusEl) statusEl.innerHTML = '<span style="color:#25d366">Nota excluída do HubSpot ✓</span>';
          } else {
            btn.textContent = "🗑️";
            var statusEl = document.getElementById("wcrm-save-status");
            if (statusEl) statusEl.innerHTML = '<span style="color:#ff6b6b">Erro ao excluir: ' + (result && result.error || "erro") + '</span>';
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

    html += '<a href="' + ticketUrl + '" target="_blank" style="display:block;background:#1a2730;border-radius:6px;padding:10px;margin-bottom:6px;border-left:3px solid #cc5de8;text-decoration:none;cursor:pointer;transition:background 0.2s"';
    html += ' onmouseover="this.style.background=\'#243340\'" onmouseout="this.style.background=\'#1a2730\'">';
    html += '<div style="font-weight:600;font-size:12px;color:#e9edef;margin-bottom:4px">' + (tp.subject || "Ticket sem nome") + '</div>';
    html += '<div style="color:#ff922b;font-size:11px;margin-bottom:4px">Status: ' + stageName + '</div>';
    html += '<div style="display:flex;align-items:center;gap:4px;color:#4d96ff;font-size:11px">Abrir no HubSpot <span style="font-size:13px">→</span></div>';
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

  var html = '<div style="background:#1a2730;border-radius:6px;padding:10px;margin-bottom:6px;border-left:3px solid #cc5de8">';
  html += '<div style="font-weight:600;font-size:13px;margin-bottom:4px">' + (tp.subject || "Ticket sem nome") + '</div>';
  html += '<div style="color:#ff922b;font-size:11px;margin-bottom:6px">Status: ' + stageName + '</div>';

  if (modelo) html += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#8696a0;font-size:11px">Modelo</span><span style="color:#cc5de8;font-size:11px;font-weight:600">' + modelo + '</span></div>';

  html += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#8696a0;font-size:11px">Calls Adquiridas</span><span style="color:#e9edef;font-size:11px;font-weight:600">' + callsTotal + '</span></div>';
  html += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#8696a0;font-size:11px">Calls Realizadas</span><span style="color:#ffd93d;font-size:11px;font-weight:600">' + callsRealizadas + ' <span style="color:#8696a0;font-size:10px">(Meli: ' + callsMeli + ' | Espec: ' + callsEspec + ')</span></span></div>';
  html += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#8696a0;font-size:11px">Calls Restantes</span><span style="color:#25d366;font-size:11px;font-weight:600">' + callsRest + '</span></div>';

  html += '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #2a3942">';
  html += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#8696a0;font-size:11px">Inicio dos Blocos</span><span style="color:#e9edef;font-size:11px">' + fmtDate(dataInicio) + '</span></div>';
  html += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#8696a0;font-size:11px">Termino 1o bloco</span><span style="color:#e9edef;font-size:11px">' + fmtDate(dataFim1) + '</span></div>';
  html += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#8696a0;font-size:11px">Termino 2o bloco</span><span style="color:#e9edef;font-size:11px">' + fmtDate(dataFim) + '</span></div>';
  html += '</div>';

  html += '</div>';
  return html;
}

// ===== Supabase / Mercado Livre Data =====
function fetchSellerData(container, sellerId) {
  container.innerHTML += '<div id="wcrm-ml-loading" style="color:#8696a0;font-size:11px;text-align:center;padding:8px;margin-top:8px">Carregando dados Mercado Livre...</div>';

  sendBgMessage({ action: "supabase_seller_data", sellerId: sellerId }).then(function(data) {
    var loadingEl = document.getElementById("wcrm-ml-loading");
    if (loadingEl) loadingEl.remove();

    if (!data || data.error) {
      container.innerHTML += '<div style="color:#f44336;font-size:11px;padding:4px">Erro ML: ' + (data && data.error || "desconhecido") + '</div>';
      return;
    }

    var html = sectionTitle("MERCADO LIVRE");

    // Revenue cards
    html += '<div style="background:#1a2730;border-radius:6px;padding:10px;margin-bottom:6px;border-left:3px solid #ffd93d">';
    html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#ffd93d;margin-bottom:6px;font-weight:600">FATURAMENTO</div>';
    html += revenueRow("Ultimos 7 dias", data.revenue.days7);
    html += revenueRow("Ultimos 14 dias", data.revenue.days14);
    html += revenueRow("Ultimos 30 dias", data.revenue.days30);
    html += '</div>';

    // Top products
    if (data.topProducts && data.topProducts.length > 0) {
      html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#4d96ff;margin:8px 0 6px;font-weight:600">TOP PRODUTOS (all-time)</div>';
      data.topProducts.forEach(function(p, i) {
        var thumb = p.thumbnail ? p.thumbnail.replace("http://", "https://") : "";
        var revenue = (p.sold_quantity * p.price);

        html += '<div style="background:#1a2730;border-radius:6px;padding:8px;margin-bottom:4px;display:flex;align-items:center;gap:8px">';
        if (thumb) {
          html += '<img src="' + thumb + '" style="width:40px;height:40px;border-radius:4px;object-fit:cover;flex-shrink:0" onerror="this.style.display=\'none\'">';
        }
        html += '<div style="flex:1;min-width:0">';
        html += '<div style="font-size:11px;font-weight:600;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (i + 1) + '. ' + (p.family_name || "Produto") + '</div>';
        html += '<div style="display:flex;gap:8px;margin-top:2px">';
        html += '<span style="color:#25d366;font-size:10px;font-weight:600">' + p.sold_quantity + ' vendas</span>';
        html += '<span style="color:#ffd93d;font-size:10px">R$ ' + revenue.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span>';
        html += '</div>';
        html += '</div></div>';
      });
    }

    container.innerHTML += html;
  });
}

function revenueRow(label, value) {
  var formatted = "R$ " + (value || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var color = value > 0 ? "#25d366" : "#8696a0";
  return '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="color:#8696a0;font-size:12px">' + label + '</span><span style="color:' + color + ';font-size:12px;font-weight:700">' + formatted + '</span></div>';
}

function sectionTitle(text) {
  return '<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin:12px 0 8px;font-weight:600">' + text + '</div>';
}

function hsCard(type, title, msg) {
  var colors = { "no-key": "#9e9e9e", "not-found": "#f44336", "error": "#f44336" };
  var c = colors[type] || "#9e9e9e";
  return '<div style="background:#202c33;border-radius:8px;padding:12px"><span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:' + c + '20;color:' + c + '">' + title + '</span><p style="margin:8px 0 0;color:#8696a0;font-size:12px">' + msg + '</p></div>';
}

function row(label, value) {
  return '<div style="display:flex;justify-content:space-between;padding:4px 0;gap:8px"><span style="color:#8696a0;font-size:12px;flex-shrink:0">' + label + '</span><span style="color:#e9edef;font-size:12px;font-weight:500;text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + value + '">' + value + '</span></div>';
}

function rowCopy(label, value, copyValue) {
  var cv = (copyValue || value || "").replace(/"/g, '&quot;');
  return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;gap:8px">' +
    '<span style="color:#8696a0;font-size:12px;flex-shrink:0">' + label + '</span>' +
    '<span style="display:flex;align-items:center;gap:4px;max-width:65%;min-width:0">' +
      '<span style="color:#e9edef;font-size:12px;font-weight:500;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + value + '">' + value + '</span>' +
      '<span class="wcrm-copy-btn" data-copy="' + cv + '" style="cursor:pointer;font-size:11px;color:#8696a0;padding:2px 4px;border-radius:3px;flex-shrink:0" title="Copiar">📋</span>' +
    '</span></div>';
}

// ===== Chat Observer =====
function observeChatChanges() {
  var observer = new MutationObserver(function() {
    detectCurrentChat();
  });

  var app = document.getElementById("app");
  if (app) {
    observer.observe(app, { childList: true, subtree: true });
    console.log("[WCRM] Observing chat changes");
  }

  var crmInterval = setInterval(function() {
    try { if (!chrome.runtime || !chrome.runtime.id) { clearInterval(crmInterval); return; } } catch(e) { clearInterval(crmInterval); return; }
    detectCurrentChat();
  }, 2000);
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

    // Auto-switch from SLICE/ABAS to CRM when user clicks a contact
    if (typeof sliceSidebarOpen !== 'undefined' && sliceSidebarOpen) {
      closeSliceSidebar();
      if (!sidebarOpen) toggleSidebar();
      return;
    }
    if (typeof abasSidebarOpen !== 'undefined' && abasSidebarOpen) {
      // Refresh ABAS contact toggles
      if (typeof renderAbasSidebar === 'function') renderAbasSidebar();
    }

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
    observeChatChanges();
    console.log("[WCRM] Ready!");
  });
}

// Start after authentication
document.addEventListener("wcrm-auth-ready", function() {
  setTimeout(init, 500);
});
if (window.__wcrmAuth) setTimeout(init, 2000);
