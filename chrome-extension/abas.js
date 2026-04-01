// ===== WhatsApp CRM - ABAS (Custom Tab Groups) =====
console.log("[WCRM ABAS] Loaded");

var abasSidebarOpen = false;
var selectedAbaId = null;

var ABAS_COLORS = [
  "#ff6b6b", "#ff922b", "#ffd93d", "#25d366", "#4d96ff",
  "#cc5de8", "#20c997", "#748ffc", "#f06595", "#868e96",
];

// ===== Theme Detection =====
function isDarkMode() {
  var body = document.body;
  if (!body) return true;
  var bg = getComputedStyle(body).backgroundColor;
  if (!bg || bg === 'transparent') {
    // Check WhatsApp's app element
    var app = document.getElementById('app');
    if (app) bg = getComputedStyle(app).backgroundColor;
  }
  if (!bg || bg === 'transparent') return true;
  var match = bg.match(/\d+/g);
  if (!match) return true;
  var brightness = (parseInt(match[0]) + parseInt(match[1]) + parseInt(match[2])) / 3;
  return brightness < 128;
}

function getTheme() {
  var dark = isDarkMode();
  return {
    bg: dark ? '#111b21' : '#ffffff',
    bgSecondary: dark ? '#202c33' : '#f0f2f5',
    bgHover: dark ? '#2a3942' : '#e9edef',
    bgItem: dark ? '#1a2730' : '#ffffff',
    border: dark ? '#2a3942' : '#e9edef',
    borderLight: dark ? '#3b4a54' : '#d1d7db',
    text: dark ? '#e9edef' : '#111b21',
    textSecondary: dark ? '#8696a0' : '#667781',
    headerBg: dark ? '#202c33' : '#f0f2f5',
    iconColor: dark ? '#aebac1' : '#54656f',
  };
}

// ===== Extension Context Guard =====
function isExtensionValid() {
  try { return !!chrome.runtime && !!chrome.runtime.id; } catch(e) { return false; }
}

// ===== Load / Save =====
function loadAbasData() {
  return new Promise(function(resolve) {
    chrome.storage.local.get("wcrm_abas", function(result) {
      var data = result.wcrm_abas || { tabs: [] };
      window._wcrmAbasCache = data;
      resolve(data);
    });
  });
}

function saveAbasData(data) {
  window._wcrmAbasCache = data;
  return new Promise(function(resolve) {
    chrome.storage.local.set({ wcrm_abas: data }, resolve);
  });
}

// ===== Known Contacts Store =====
function scanAndStoreContacts() {
  var container = findChatListContainer();
  if (!container) return;
  var stored = window._wcrmKnownContacts || {};

  for (var i = 0; i < container.children.length; i++) {
    var row = container.children[i];
    var nameSpan = row.querySelector("span[title]");
    if (!nameSpan) continue;
    var title = (nameSpan.getAttribute("title") || "").trim();
    if (title && title.length > 1 && !stored[title]) {
      stored[title] = true;
    }
  }

  window._wcrmKnownContacts = stored;
  if (isExtensionValid()) chrome.storage.local.set({ wcrm_known_contacts: stored });
}

function loadKnownContacts() {
  return new Promise(function(resolve) {
    if (!isExtensionValid()) { resolve({}); return; }
    window._wcrmKnownContacts = {};
    chrome.storage.local.set({ wcrm_known_contacts: {} });
    scanAndStoreContacts();
    resolve(window._wcrmKnownContacts || {});
  });
}

function getAllKnownContacts() {
  scanAndStoreContacts();
  var contacts = window._wcrmKnownContacts || {};
  return Object.keys(contacts).sort(function(a, b) {
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
}

// ===== Pinned Contacts =====
function loadPinnedContacts() {
  return new Promise(function(resolve) {
    chrome.storage.local.get("wcrm_pinned", function(result) {
      window._wcrmPinned = result.wcrm_pinned || {};
      resolve(window._wcrmPinned);
    });
  });
}

function savePinnedContacts(data) {
  window._wcrmPinned = data;
  if (isExtensionValid()) chrome.storage.local.set({ wcrm_pinned: data });
}

function togglePinContact(chatName) {
  var pinned = window._wcrmPinned || {};
  if (pinned[chatName]) {
    delete pinned[chatName];
  } else {
    pinned[chatName] = true;
  }
  savePinnedContacts(pinned);
  updateHeaderButtons();
  // Always reorder: pin/unpin the conversation in the chat list
  applyPinnedOrder();
  // Also re-apply filter if active
  if (selectedAbaId || (typeof selectedMentor !== 'undefined' && selectedMentor)) {
    applyConversationFilters();
  }
}

// ===== Pin Indicator in Chat List =====
function addPinIndicator(nameSpan) {
  if (!nameSpan || nameSpan.parentElement.querySelector('.wcrm-pin-icon')) return;
  var icon = document.createElement('span');
  icon.className = 'wcrm-pin-icon';
  icon.textContent = '📌';
  Object.assign(icon.style, {
    fontSize: '11px',
    marginRight: '4px',
    flexShrink: '0',
  });
  nameSpan.parentElement.insertBefore(icon, nameSpan);
}

function removePinIndicator(nameSpan) {
  if (!nameSpan) return;
  var icon = nameSpan.parentElement.querySelector('.wcrm-pin-icon');
  if (icon) icon.remove();
}

// Move pinned contacts to the top of the chat list
function applyPinnedOrder() {
  var pinned = window._wcrmPinned || {};
  var pinnedNames = Object.keys(pinned);
  if (pinnedNames.length === 0) {
    // Remove all pin indicators
    document.querySelectorAll('.wcrm-pin-icon').forEach(function(el) { el.remove(); });
    // Remove pin mode if no pins
    var container = findChatListContainer();
    if (container && container.classList.contains('wcrm-pin-active')) {
      container.classList.remove('wcrm-pin-active');
      var scrollParent = container.parentElement;
      if (scrollParent) {
        var pos = scrollParent.scrollTop;
        scrollParent.scrollTop = pos + 1;
        setTimeout(function() { scrollParent.scrollTop = pos; }, 50);
      }
    }
    return;
  }

  injectFilterCSS();
  var container = findChatListContainer();
  if (!container) return;

  // Only enable pin reordering if no filter is active (filters handle their own pinning)
  var hasFilter = (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null) ||
                  (typeof selectedMentor !== 'undefined' && !!selectedMentor);
  if (hasFilter) return;

  container.classList.add('wcrm-filter-active');

  var pinnedRows = [];
  for (var i = 0; i < container.children.length; i++) {
    var row = container.children[i];
    var nameSpan = row.querySelector('span[title]');
    if (!nameSpan) continue;
    var title = nameSpan.getAttribute('title') || '';
    if (pinned[title]) {
      pinnedRows.push(row);
      addPinIndicator(nameSpan);
    } else {
      removePinIndicator(nameSpan);
    }
  }

  // Move pinned rows to the top
  for (var j = pinnedRows.length - 1; j >= 0; j--) {
    container.insertBefore(pinnedRows[j], container.firstChild);
  }
}

// ===== Floating Button =====
function createAbasButton() {
  if (document.getElementById("wcrm-abas-toggle")) return;
  var btn = document.createElement("button");
  btn.id = "wcrm-abas-toggle";
  btn.textContent = "ABAS";
  btn.title = "Abas personalizadas";
  btn.addEventListener("click", toggleAbasSidebar);
  Object.assign(btn.style, {
    position: "fixed",
    top: "260px",
    right: "16px",
    width: "50px",
    height: "50px",
    borderRadius: "50%",
    background: "#cc5de8",
    color: "#fff",
    border: "none",
    fontSize: "9px",
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

// ===== Sidebar =====
function createAbasSidebar() {
  if (document.getElementById("wcrm-abas-sidebar")) return;

  var sidebar = document.createElement("div");
  sidebar.id = "wcrm-abas-sidebar";
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

  sidebar.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#202c33;border-bottom:1px solid #2a3942;min-height:48px">' +
      '<h3 style="margin:0;font-size:15px;font-weight:600;color:#e9edef">ABAS</h3>' +
      '<button id="wcrm-abas-close" style="background:none;border:none;color:#8696a0;font-size:22px;cursor:pointer;padding:4px 8px">&times;</button>' +
    '</div>' +
    '<div style="padding:12px 16px;flex:1;overflow-y:auto">' +
      '<button id="wcrm-abas-create" style="width:100%;background:#cc5de8;color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:12px">+ Criar Aba</button>' +
      '<div id="wcrm-abas-active-filter" style="display:none;background:#cc5de820;border:1px solid #cc5de8;border-radius:8px;padding:8px 12px;margin-bottom:12px;align-items:center;justify-content:space-between">' +
        '<span style="color:#cc5de8;font-size:12px;font-weight:600">Filtro: <span id="wcrm-abas-filter-name"></span></span>' +
        '<button id="wcrm-abas-clear-filter" style="background:none;border:none;color:#ff6b6b;font-size:11px;cursor:pointer;font-weight:600;padding:2px 6px">Limpar</button>' +
      '</div>' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin-bottom:8px;font-weight:600">SUAS ABAS</div>' +
      '<div id="wcrm-abas-list"></div>' +
    '</div>';

  document.body.appendChild(sidebar);

  document.getElementById("wcrm-abas-close").addEventListener("click", toggleAbasSidebar);
  document.getElementById("wcrm-abas-create").addEventListener("click", openCreateAbaModal);
  document.getElementById("wcrm-abas-clear-filter").addEventListener("click", clearAbasFilter);
}

// ===== Toggle =====
function toggleAbasSidebar() {
  if (typeof sidebarOpen !== 'undefined' && sidebarOpen) toggleSidebar();
  if (typeof msgSidebarOpen !== 'undefined' && msgSidebarOpen) closeMsgSidebar();
  if (typeof sliceSidebarOpen !== 'undefined' && sliceSidebarOpen) closeSliceSidebar();

  abasSidebarOpen = !abasSidebarOpen;
  document.getElementById("wcrm-abas-sidebar").style.display = abasSidebarOpen ? "flex" : "none";

  var appEl = document.getElementById("app");
  if (appEl) {
    if (abasSidebarOpen) {
      appEl.style.width = "calc(100% - 320px)";
      appEl.style.maxWidth = "calc(100% - 320px)";
    } else {
      appEl.style.width = "";
      appEl.style.maxWidth = "";
    }
  }

  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();

  if (abasSidebarOpen) {
    renderAbasSidebar();
  }
}

function closeAbasSidebar() {
  if (!abasSidebarOpen) return;
  abasSidebarOpen = false;
  var sb = document.getElementById("wcrm-abas-sidebar");
  if (sb) sb.style.display = "none";
  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();
}

// ===== Render Sidebar =====
function renderAbasSidebar() {
  loadAbasData().then(function(data) {
    renderAbasList(data);
    updateAbasIndicator();
  });
}

function renderAbasList(data) {
  var list = document.getElementById("wcrm-abas-list");
  if (!list) return;

  if (!data.tabs || data.tabs.length === 0) {
    list.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:16px;font-style:italic">Nenhuma aba criada</div>';
    return;
  }

  var html = '';
  data.tabs.forEach(function(tab) {
    var isSelected = selectedAbaId === tab.id;
    var bgColor = isSelected ? tab.color + '30' : '#1a2730';
    var borderColor = isSelected ? tab.color : '#3b4a54';
    var count = (tab.contacts || []).length;
    var expandedKey = '_wcrmAbaExpanded_' + tab.id;

    html += '<div class="wcrm-aba-item" data-aba-id="' + tab.id + '" style="background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;transition:all 0.15s">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center">';
    html += '<div style="display:flex;align-items:center;gap:8px">';
    html += '<span style="width:12px;height:12px;border-radius:50%;background:' + tab.color + ';display:inline-block;flex-shrink:0"></span>';
    html += '<span style="font-size:13px;font-weight:500;color:#e9edef">' + tab.name + '</span>';
    if (isSelected) html += '<span style="color:' + tab.color + ';font-size:11px">&#10003;</span>';
    html += '</div>';
    html += '<div style="display:flex;align-items:center;gap:4px">';
    html += '<span style="color:#8696a0;font-size:11px;margin-right:2px">' + count + '</span>';
    // Expand/collapse contacts button
    if (count > 0) {
      html += '<span class="wcrm-aba-expand" data-aba-id="' + tab.id + '" style="color:#8696a0;font-size:12px;cursor:pointer;padding:2px 4px" title="Ver contatos">&#9660;</span>';
    }
    html += '<span class="wcrm-aba-add-contacts" data-aba-id="' + tab.id + '" style="color:#25d366;font-size:14px;cursor:pointer;padding:2px 4px" title="Adicionar/Remover contatos">&#128101;</span>';
    html += '<span class="wcrm-aba-edit" data-aba-id="' + tab.id + '" style="color:#4d96ff;font-size:12px;cursor:pointer;padding:2px 4px" title="Editar">&#9998;</span>';
    html += '<span class="wcrm-aba-delete" data-aba-id="' + tab.id + '" style="color:#ff6b6b;font-size:12px;cursor:pointer;padding:2px 4px" title="Excluir">&#128465;</span>';
    html += '</div>';
    html += '</div>';
    // Expandable contacts list (hidden by default)
    if (count > 0) {
      html += '<div class="wcrm-aba-contacts-list" data-aba-id="' + tab.id + '" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid #3b4a5440">';
      tab.contacts.forEach(function(contact, ci) {
        var displayName = contact.split(/\s*\|\s*/)[0].trim();
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0">';
        html += '<span style="color:#8696a0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px">' + displayName + '</span>';
        html += '<span class="wcrm-aba-remove-contact" data-aba-id="' + tab.id + '" data-contact-idx="' + ci + '" style="color:#ff6b6b;font-size:10px;cursor:pointer;flex-shrink:0" title="Remover">&times;</span>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
  });

  list.innerHTML = html;

  // Click tab to filter (toggle)
  list.querySelectorAll('.wcrm-aba-item').forEach(function(el) {
    el.addEventListener('click', function(e) {
      if (e.target.closest('.wcrm-aba-edit') || e.target.closest('.wcrm-aba-delete') || e.target.closest('.wcrm-aba-remove-contact') || e.target.closest('.wcrm-aba-expand') || e.target.closest('.wcrm-aba-add-contacts')) return;
      var abaId = el.dataset.abaId;
      if (selectedAbaId === abaId) {
        clearAbasFilter();
      } else {
        selectedAbaId = abaId;
        applyConversationFilters();
        renderAbasSidebar();
        updateAbasIndicator();
      }
    });
  });

  // Expand/collapse contacts
  list.querySelectorAll('.wcrm-aba-expand').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var abaId = btn.dataset.abaId;
      var contactsList = list.querySelector('.wcrm-aba-contacts-list[data-aba-id="' + abaId + '"]');
      if (contactsList) {
        var isVisible = contactsList.style.display !== 'none';
        contactsList.style.display = isVisible ? 'none' : 'block';
        btn.innerHTML = isVisible ? '&#9660;' : '&#9650;';
      }
    });
  });

  // Add contacts button
  list.querySelectorAll('.wcrm-aba-add-contacts').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      openContactPickerModal(btn.dataset.abaId);
    });
  });

  // Edit button
  list.querySelectorAll('.wcrm-aba-edit').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      openEditAbaModal(btn.dataset.abaId);
    });
  });

  // Delete button
  list.querySelectorAll('.wcrm-aba-delete').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      deleteAba(btn.dataset.abaId);
    });
  });

  // Remove contact from tab
  list.querySelectorAll('.wcrm-aba-remove-contact').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var abaId = btn.dataset.abaId;
      var ci = parseInt(btn.dataset.contactIdx);
      loadAbasData().then(function(data) {
        var tab = data.tabs.find(function(t) { return t.id === abaId; });
        if (tab && tab.contacts) {
          tab.contacts.splice(ci, 1);
          saveAbasData(data).then(function() {
            renderAbasSidebar();
            applyConversationFilters();
          });
        }
      });
    });
  });
}

function toggleContactInAba(abaId, chatName) {
  loadAbasData().then(function(data) {
    var tab = data.tabs.find(function(t) { return t.id === abaId; });
    if (!tab) return;
    if (!tab.contacts) tab.contacts = [];

    var idx = tab.contacts.findIndex(function(c) {
      return c.toLowerCase().trim() === chatName.toLowerCase().trim();
    });

    if (idx >= 0) {
      tab.contacts.splice(idx, 1);
    } else {
      tab.contacts.push(chatName);
    }

    saveAbasData(data).then(function() {
      if (abasSidebarOpen) renderAbasSidebar();
      applyConversationFilters();
      updateHeaderButtons();
    });
  });
}

// ===== Contact Picker Modal =====
function openContactPickerModal(abaId) {
  loadAbasData().then(function(data) {
    var tab = data.tabs.find(function(t) { return t.id === abaId; });
    if (!tab) return;

    var allContacts = getAllKnownContacts();
    var selectedSet = {};
    (tab.contacts || []).forEach(function(c) { selectedSet[c.toLowerCase().trim()] = c; });

    var existing = document.getElementById("wcrm-contact-picker-overlay");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "wcrm-contact-picker-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      background: "rgba(0,0,0,0.6)",
      zIndex: "999999",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });

    var modal = document.createElement("div");
    Object.assign(modal.style, {
      background: "#fff",
      borderRadius: "12px",
      padding: "24px",
      width: "460px",
      maxWidth: "90%",
      maxHeight: "80vh",
      display: "flex",
      flexDirection: "column",
      color: "#111",
    });

    modal.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">' +
        '<div>' +
          '<h3 style="margin:0;font-size:18px;font-weight:700;color:#111">Adicionar/Remover contatos na aba</h3>' +
          '<p style="margin:4px 0 0;font-size:13px;color:#666">Selecione os contatos para adicionar ou remover da aba</p>' +
        '</div>' +
        '<button id="wcrm-picker-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#666;padding:0 4px">&times;</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:12px">' +
        '<input id="wcrm-picker-search" type="text" placeholder="Pesquise por nome ou numero do contato" style="flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;outline:none">' +
        '<button id="wcrm-picker-select-all" style="background:#25d366;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">Selecionar tudo</button>' +
      '</div>' +
      '<div id="wcrm-picker-list" style="flex:1;overflow-y:auto;border:1px solid #eee;border-radius:8px;max-height:50vh"></div>' +
      '<button id="wcrm-picker-save" style="margin-top:12px;background:#25d366;color:#fff;border:none;border-radius:8px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;width:auto;align-self:center;padding-left:40px;padding-right:40px">Salvar</button>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function renderContactList(filter) {
      var listEl = document.getElementById("wcrm-picker-list");
      if (!listEl) return;
      var filterLower = (filter || "").toLowerCase();
      var filtered = allContacts.filter(function(c) {
        return !filterLower || c.toLowerCase().includes(filterLower);
      });

      var html = '';
      filtered.forEach(function(contact) {
        var isSelected = !!selectedSet[contact.toLowerCase().trim()];
        var checkColor = isSelected ? '#25d366' : '#ccc';
        var checkIcon = isSelected ? '&#10003;' : '';
        var displayName = contact.length > 45 ? contact.substring(0, 45) + '...' : contact;

        html += '<div class="wcrm-picker-item" data-contact="' + contact.replace(/"/g, '&quot;') + '" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #f0f0f0;cursor:pointer;transition:background 0.1s">';
        html += '<span class="wcrm-picker-check" style="width:22px;height:22px;border-radius:50%;border:2px solid ' + checkColor + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;color:#fff;background:' + (isSelected ? '#25d366' : 'transparent') + '">' + checkIcon + '</span>';
        html += '<span style="font-size:13px;color:#111;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + displayName + '</span>';
        html += '</div>';
      });

      if (filtered.length === 0) {
        html = '<div style="padding:20px;text-align:center;color:#999;font-size:13px">Nenhum contato encontrado</div>';
      }

      listEl.innerHTML = html;

      listEl.querySelectorAll('.wcrm-picker-item').forEach(function(el) {
        el.addEventListener('click', function() {
          var c = el.dataset.contact;
          var key = c.toLowerCase().trim();
          if (selectedSet[key]) {
            delete selectedSet[key];
          } else {
            selectedSet[key] = c;
          }
          renderContactList(document.getElementById("wcrm-picker-search").value);
        });
      });
    }

    renderContactList("");

    document.getElementById("wcrm-picker-search").addEventListener("input", function() {
      renderContactList(this.value);
    });

    document.getElementById("wcrm-picker-select-all").addEventListener("click", function() {
      var filterVal = document.getElementById("wcrm-picker-search").value.toLowerCase();
      var filtered = allContacts.filter(function(c) {
        return !filterVal || c.toLowerCase().includes(filterVal);
      });
      var allSelected = filtered.every(function(c) { return !!selectedSet[c.toLowerCase().trim()]; });
      filtered.forEach(function(c) {
        var key = c.toLowerCase().trim();
        if (allSelected) {
          delete selectedSet[key];
        } else {
          selectedSet[key] = c;
        }
      });
      renderContactList(filterVal);
    });

    document.getElementById("wcrm-picker-close").addEventListener("click", function() { overlay.remove(); });
    overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });

    document.getElementById("wcrm-picker-save").addEventListener("click", function() {
      loadAbasData().then(function(latestData) {
        var t = latestData.tabs.find(function(x) { return x.id === abaId; });
        if (t) {
          t.contacts = Object.values(selectedSet);
          saveAbasData(latestData).then(function() {
            overlay.remove();
            if (abasSidebarOpen) renderAbasSidebar();
            applyConversationFilters();
          });
        }
      });
    });

    document.getElementById("wcrm-picker-search").focus();
  });
}

// ===== Filter =====
function clearAbasFilter() {
  selectedAbaId = null;
  applyConversationFilters();
  if (abasSidebarOpen) renderAbasSidebar();
  updateAbasIndicator();
}

function updateAbasIndicator() {
  var indicator = document.getElementById("wcrm-abas-active-filter");
  var nameEl = document.getElementById("wcrm-abas-filter-name");
  if (indicator) {
    if (selectedAbaId) {
      var data = window._wcrmAbasCache || { tabs: [] };
      var tab = data.tabs.find(function(t) { return t.id === selectedAbaId; });
      indicator.style.display = "flex";
      if (nameEl) nameEl.textContent = tab ? tab.name : selectedAbaId;
    } else {
      indicator.style.display = "none";
    }
  }

  var btn = document.getElementById("wcrm-abas-toggle");
  if (btn) {
    btn.style.boxShadow = selectedAbaId
      ? "0 0 0 3px #cc5de880, 0 4px 12px rgba(0,0,0,0.4)"
      : "0 4px 12px rgba(0,0,0,0.4)";
  }
}

// ===== Sidebar Buttons (Pin + ABAS) — injected into WhatsApp's left nav sidebar =====
function findSidebarInfo() {
  // Find sidebar icons by POSITION: they live on the far left of the viewport (x < 70px).
  // This works regardless of what data-icon names WhatsApp uses.
  var allIcons = document.querySelectorAll('span[data-icon]');
  var leftIcons = [];

  for (var i = 0; i < allIcons.length; i++) {
    var rect = allIcons[i].getBoundingClientRect();
    if (rect.left < 70 && rect.width > 0 && rect.height > 0) {
      leftIcons.push({ el: allIcons[i], rect: rect });
    }
  }

  if (leftIcons.length < 2) return null;

  // Sort by Y position to find the last icon in the top section
  leftIcons.sort(function(a, b) { return a.rect.top - b.rect.top; });

  // Find the sidebar column element by walking up from the first left icon
  var firstBtn = leftIcons[0].el.closest('[role="button"]') || leftIcons[0].el.closest('button') || leftIcons[0].el.parentElement;
  var sidebarEl = firstBtn;
  while (sidebarEl && sidebarEl !== document.body) {
    sidebarEl = sidebarEl.parentElement;
    if (!sidebarEl) break;
    if (sidebarEl.offsetWidth < 120 && sidebarEl.offsetHeight > 200) {
      // Confirm it contains multiple left icons
      var count = 0;
      for (var j = 0; j < leftIcons.length; j++) {
        if (sidebarEl.contains(leftIcons[j].el)) count++;
      }
      if (count >= 2) break;
    }
  }

  // Determine sidebar geometry
  var sidebarRect = sidebarEl && sidebarEl !== document.body
    ? sidebarEl.getBoundingClientRect()
    : { left: 0, width: 56, top: 0, bottom: window.innerHeight };

  // Find the gap between top icons and bottom icons (settings/profile).
  // Top icons are clustered together; bottom icons have a big Y gap.
  var lastTopIcon = leftIcons[0];
  for (var k = 1; k < leftIcons.length; k++) {
    var gap = leftIcons[k].rect.top - leftIcons[k - 1].rect.bottom;
    if (gap > 80) break; // big gap = separator between top section and bottom section
    lastTopIcon = leftIcons[k];
  }

  return {
    sidebarEl: (sidebarEl && sidebarEl !== document.body) ? sidebarEl : null,
    sidebarRect: sidebarRect,
    lastTopIconBottom: lastTopIcon.rect.bottom,
    centerX: sidebarRect.left + sidebarRect.width / 2,
  };
}

function injectSidebarButtons() {
  var existing = document.getElementById('wcrm-sidebar-buttons');
  if (existing) {
    // Buttons already injected — just update state for current chat
    updateSidebarButtonStates();
    return;
  }

  var info = findSidebarInfo();
  if (!info) return;

  var t = getTheme();

  // Wrapper for our custom buttons
  var wrapper = document.createElement('div');
  wrapper.id = 'wcrm-sidebar-buttons';
  Object.assign(wrapper.style, {
    position: 'fixed',
    left: info.sidebarRect.left + 'px',
    top: (info.lastTopIconBottom + 12) + 'px',
    width: info.sidebarRect.width + 'px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    paddingTop: '8px',
    borderTop: '1px solid ' + t.border,
    zIndex: '99998',
  });

  // Pin button
  var pinBtn = document.createElement('div');
  pinBtn.id = 'wcrm-sidebar-pin';
  pinBtn.setAttribute('role', 'button');
  Object.assign(pinBtn.style, {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'background 0.15s',
  });
  var chatName = typeof currentName !== 'undefined' ? currentName : null;
  updatePinButtonState(pinBtn, chatName, t);
  pinBtn.addEventListener('mouseenter', function() { pinBtn.style.background = getTheme().bgHover; });
  pinBtn.addEventListener('mouseleave', function() {
    var cn = typeof currentName !== 'undefined' ? currentName : null;
    var isPinned = cn && (window._wcrmPinned || {})[cn];
    pinBtn.style.background = isPinned ? (isDarkMode() ? '#25d36615' : '#25d36610') : 'transparent';
  });
  pinBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var cn = typeof currentName !== 'undefined' ? currentName : null;
    if (cn) togglePinContact(cn);
  });

  // ABAS button
  var abasBtn = document.createElement('div');
  abasBtn.id = 'wcrm-sidebar-abas';
  abasBtn.setAttribute('role', 'button');
  Object.assign(abasBtn.style, {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'background 0.15s',
  });
  abasBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="' + t.iconColor + '"><path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z" opacity="0.85"/></svg>';
  abasBtn.title = 'Abas';
  abasBtn.addEventListener('mouseenter', function() { abasBtn.style.background = getTheme().bgHover; });
  abasBtn.addEventListener('mouseleave', function() { abasBtn.style.background = 'transparent'; });
  abasBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var cn = typeof currentName !== 'undefined' ? currentName : null;
    if (cn) showHeaderAbasDropdown(abasBtn, cn);
  });

  wrapper.appendChild(pinBtn);
  wrapper.appendChild(abasBtn);
  document.body.appendChild(wrapper);
}

function updateSidebarButtonStates() {
  var chatName = typeof currentName !== 'undefined' ? currentName : null;
  var pinBtn = document.getElementById('wcrm-sidebar-pin');
  if (pinBtn) {
    updatePinButtonState(pinBtn, chatName);
  }
}

function updatePinButtonState(btn, chatName, theme) {
  var t = theme || getTheme();
  var pinned = window._wcrmPinned || {};
  var isPinned = !!pinned[chatName];

  if (isPinned) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="#25d366"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg>';
    btn.style.background = isDarkMode() ? '#25d36615' : '#25d36610';
    btn.title = 'Desafixar contato';
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="' + t.iconColor + '"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2zM9 4v7.75L7.5 14h9L15 11.75V4H9z"/></svg>';
    btn.style.background = 'transparent';
    btn.title = 'Fixar contato';
  }
}

function updateHeaderButtons() {
  updateSidebarButtonStates();
}

function removeHeaderButtons() {
  // Sidebar buttons persist across chat changes — just close dropdown and refresh state
  var dropdown = document.getElementById("wcrm-header-abas-dropdown");
  if (dropdown) dropdown.remove();
  updateSidebarButtonStates();
}

function showHeaderAbasDropdown(anchorBtn, chatName) {
  var existing = document.getElementById("wcrm-header-abas-dropdown");
  if (existing) { existing.remove(); return; }

  // Load data fresh if cache is empty
  var data = window._wcrmAbasCache || { tabs: [] };
  if (data.tabs.length === 0) {
    loadAbasData().then(function(freshData) {
      if (freshData.tabs.length > 0) {
        _showHeaderAbasDropdownInner(anchorBtn, chatName, freshData);
      }
    });
    return;
  }
  _showHeaderAbasDropdownInner(anchorBtn, chatName, data);
}

function _showHeaderAbasDropdownInner(anchorBtn, chatName, data) {

  var t = getTheme();
  var rect = anchorBtn.getBoundingClientRect();
  var dropdown = document.createElement("div");
  dropdown.id = "wcrm-header-abas-dropdown";
  Object.assign(dropdown.style, {
    position: "fixed",
    top: rect.top + "px",
    left: (rect.right + 8) + "px",
    background: t.bgSecondary,
    border: "1px solid " + t.border,
    borderRadius: "8px",
    padding: "6px",
    zIndex: "999999",
    minWidth: "180px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  });

  var html = '';
  data.tabs.forEach(function(tab) {
    var isIn = (tab.contacts || []).some(function(c) {
      return c.toLowerCase().trim() === chatName.toLowerCase().trim();
    });
    var icon = isIn ? '&#10003;' : '&plus;';
    var iconColor = isIn ? tab.color : t.textSecondary;
    html += '<div class="wcrm-header-aba-opt" data-aba-id="' + tab.id + '" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;transition:background 0.1s">';
    html += '<span style="width:10px;height:10px;border-radius:50%;background:' + tab.color + ';display:inline-block;flex-shrink:0"></span>';
    html += '<span style="font-size:12px;color:' + t.text + ';flex:1">' + tab.name + '</span>';
    html += '<span style="color:' + iconColor + ';font-size:14px;font-weight:bold">' + icon + '</span>';
    html += '</div>';
  });

  dropdown.innerHTML = html;
  document.body.appendChild(dropdown);

  // Hover effects
  dropdown.querySelectorAll('.wcrm-header-aba-opt').forEach(function(el) {
    el.addEventListener('mouseenter', function() { el.style.background = t.bgHover; });
    el.addEventListener('mouseleave', function() { el.style.background = 'transparent'; });
    el.addEventListener('click', function() {
      toggleContactInAba(el.dataset.abaId, chatName);
      dropdown.remove();
    });
  });

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

// ===== Create / Edit Aba Modal =====
function openCreateAbaModal() {
  showAbaModal(null);
}

function openEditAbaModal(abaId) {
  showAbaModal(abaId);
}

function showAbaModal(editId) {
  var existing = document.getElementById("wcrm-aba-modal-overlay");
  if (existing) existing.remove();

  var editTab = null;
  if (editId && window._wcrmAbasCache) {
    editTab = window._wcrmAbasCache.tabs.find(function(t) { return t.id === editId; });
  }

  var overlay = document.createElement("div");
  overlay.id = "wcrm-aba-modal-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    background: "rgba(0,0,0,0.6)",
    zIndex: "999999",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  var modal = document.createElement("div");
  Object.assign(modal.style, {
    background: "#111b21",
    border: "1px solid #2a3942",
    borderRadius: "12px",
    padding: "24px",
    width: "340px",
    maxWidth: "90%",
  });

  var selectedColor = editTab ? editTab.color : ABAS_COLORS[0];

  var colorsHtml = '';
  ABAS_COLORS.forEach(function(c) {
    var sel = c === selectedColor;
    colorsHtml += '<span class="wcrm-aba-color-opt" data-color="' + c + '" style="width:28px;height:28px;border-radius:50%;background:' + c + ';cursor:pointer;border:3px solid ' + (sel ? '#fff' : 'transparent') + ';display:inline-block"></span>';
  });

  modal.innerHTML =
    '<h3 style="margin:0 0 16px;font-size:16px;font-weight:600;color:#e9edef">' + (editTab ? 'Editar Aba' : 'Criar Aba') + '</h3>' +
    '<input id="wcrm-aba-name-input" type="text" placeholder="Nome da aba..." maxlength="30" value="' + (editTab ? editTab.name : '') + '" style="width:100%;background:#2a3942;border:1px solid #3b4a54;border-radius:8px;padding:10px 12px;color:#e9edef;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box">' +
    '<div style="font-size:11px;color:#8696a0;margin-bottom:6px">COR</div>' +
    '<div id="wcrm-aba-color-picker" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px">' + colorsHtml + '</div>' +
    '<div style="display:flex;gap:8px">' +
      '<button id="wcrm-aba-modal-cancel" style="flex:1;background:#2a3942;color:#8696a0;border:1px solid #3b4a54;border-radius:8px;padding:10px;font-size:13px;cursor:pointer">Cancelar</button>' +
      '<button id="wcrm-aba-modal-save" style="flex:1;background:#cc5de8;color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer">' + (editTab ? 'Salvar' : 'Criar') + '</button>' +
    '</div>';

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  var pickerEl = document.getElementById("wcrm-aba-color-picker");
  pickerEl.querySelectorAll('.wcrm-aba-color-opt').forEach(function(dot) {
    dot.addEventListener('click', function() {
      selectedColor = dot.dataset.color;
      pickerEl.querySelectorAll('.wcrm-aba-color-opt').forEach(function(d) {
        d.style.border = '3px solid transparent';
      });
      dot.style.border = '3px solid #fff';
    });
  });

  document.getElementById("wcrm-aba-modal-cancel").addEventListener("click", function() { overlay.remove(); });
  overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });

  document.getElementById("wcrm-aba-modal-save").addEventListener("click", function() {
    var name = document.getElementById("wcrm-aba-name-input").value.trim();
    if (!name) return;

    loadAbasData().then(function(data) {
      if (editTab) {
        var tab = data.tabs.find(function(t) { return t.id === editId; });
        if (tab) { tab.name = name; tab.color = selectedColor; }
      } else {
        data.tabs.push({ id: "aba_" + Date.now(), name: name, color: selectedColor, contacts: [] });
      }
      saveAbasData(data).then(function() { overlay.remove(); renderAbasSidebar(); });
    });
  });

  document.getElementById("wcrm-aba-name-input").focus();
}

function deleteAba(abaId) {
  loadAbasData().then(function(data) {
    data.tabs = data.tabs.filter(function(t) { return t.id !== abaId; });
    if (selectedAbaId === abaId) {
      selectedAbaId = null;
      applyConversationFilters();
    }
    saveAbasData(data).then(function() { renderAbasSidebar(); updateAbasIndicator(); });
  });
}

// ===== Init =====
function initAbas() {
  createAbasButton();
  createAbasSidebar();
  loadAbasData();
  loadKnownContacts();
  loadPinnedContacts().then(function() {
    // Apply pinned order on startup after a delay for WhatsApp to load
    setTimeout(function() { applyPinnedOrder(); }, 2000);
  });

  var abasInterval = setInterval(function() {
    if (!isExtensionValid()) {
      clearInterval(abasInterval);
      console.log("[WCRM ABAS] Extension context invalidated, stopping interval");
      return;
    }
    scanAndStoreContacts();
    injectSidebarButtons();
  }, 3000);
}

// Start after authentication
document.addEventListener("wcrm-auth-ready", function() {
  setTimeout(initAbas, 700);
});
if (window.__wcrmAuth) setTimeout(initAbas, 1200);
