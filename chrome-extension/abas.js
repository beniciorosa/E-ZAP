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
  return window.ezapIsExtValid ? window.ezapIsExtValid() : false;
}

// ===== Supabase Helper (thin wrapper over api.js) =====
function supaRest(path, method, body, prefer) {
  return window.ezapSupaRest(path, method, body, prefer);
}

function getUserId() {
  return window.ezapUserId();
}

// ===== Load / Save ABAS (Supabase + chrome.storage cache) =====
var _wcrmAbasSaveGen = 0; // Prevents background sync from overwriting recent saves

function loadAbasData() {
  return new Promise(function(resolve) {
    // Fast: load from local cache first
    chrome.storage.local.get("wcrm_abas", function(result) {
      var localData = result.wcrm_abas || { tabs: [] };
      window._wcrmAbasCache = localData;
      resolve(localData);
    });

    // Background: sync from Supabase
    var uid = getUserId();
    if (!uid) return;

    var gen = _wcrmAbasSaveGen; // Capture generation at start

    supaRest("/rest/v1/abas?user_id=eq." + uid + "&select=id,name,color,created_at").then(function(abas) {
      if (_wcrmAbasSaveGen !== gen) return; // A save happened — don't overwrite with stale data
      if (!abas || !Array.isArray(abas)) return;
      // Load contacts for each aba
      var abaIds = abas.map(function(a) { return a.id; });
      if (abaIds.length === 0) {
        // Only clear cache if no local save happened
        if (_wcrmAbasSaveGen === gen) {
          var data = { tabs: [] };
          window._wcrmAbasCache = data;
          chrome.storage.local.set({ wcrm_abas: data });
        }
        return;
      }

      supaRest("/rest/v1/aba_contacts?aba_id=in.(" + abaIds.join(",") + ")&select=aba_id,contact_name,contact_jid").then(function(contacts) {
        if (_wcrmAbasSaveGen !== gen) return; // A save happened — don't overwrite
        contacts = contacts || [];
        var contactMap = {};
        var jidMap = {};
        contacts.forEach(function(c) {
          if (!contactMap[c.aba_id]) { contactMap[c.aba_id] = []; jidMap[c.aba_id] = {}; }
          contactMap[c.aba_id].push(c.contact_name);
          jidMap[c.aba_id][c.contact_name] = c.contact_jid || null;
        });

        var data = {
          tabs: abas.map(function(a) {
            return {
              id: a.id,
              name: a.name,
              color: a.color,
              contacts: contactMap[a.id] || [],
              contactJids: jidMap[a.id] || {}
            };
          })
        };
        window._wcrmAbasCache = data;
        chrome.storage.local.set({ wcrm_abas: data });
        // Re-render sidebar if open (with fresh Supabase data)
        if (abasSidebarOpen) {
          renderAbasList(data);
          updateAbasIndicator();
        }
      });
    });
  });
}

function saveAbasData(data) {
  _wcrmAbasSaveGen++; // Invalidate any in-flight background syncs
  window._wcrmAbasCache = data;
  // Save to local cache immediately (fast)
  chrome.storage.local.set({ wcrm_abas: data });

  // Sync to Supabase in background
  var uid = getUserId();
  if (!uid) return Promise.resolve();

  return syncAbasToSupabase(uid, data);
}

function isAbaUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function syncAbasToSupabase(uid, data) {
  if (!data.tabs || data.tabs.length === 0) {
    // Just delete all
    return supaRest("/rest/v1/abas?user_id=eq." + uid, "DELETE", null, "return=minimal");
  }

  // Ensure all tab IDs are valid UUIDs (migrate old "aba_" IDs)
  var needsUpdate = false;
  data.tabs.forEach(function(tab) {
    if (!isAbaUUID(tab.id)) {
      tab.id = crypto.randomUUID();
      needsUpdate = true;
    }
  });
  if (needsUpdate) {
    window._wcrmAbasCache = data;
    chrome.storage.local.set({ wcrm_abas: data });
  }

  // Delete all user's abas and re-insert (simple full sync)
  return supaRest("/rest/v1/abas?user_id=eq." + uid, "DELETE", null, "return=minimal").then(function() {
    var abasToInsert = data.tabs.map(function(tab) {
      return { id: tab.id, user_id: uid, name: tab.name, color: tab.color };
    });

    return supaRest("/rest/v1/abas", "POST", abasToInsert).then(function(result) {
      if (result && result.error) {
        console.log("[WCRM ABAS] Supabase insert error:", result.error);
        return;
      }
      // Insert contacts for each aba (incluindo JID quando conhecido)
      var allContacts = [];
      data.tabs.forEach(function(tab) {
        var jids = tab.contactJids || {};
        (tab.contacts || []).forEach(function(contact) {
          allContacts.push({
            aba_id: tab.id,
            contact_name: contact,
            contact_jid: jids[contact] || null
          });
        });
      });
      if (allContacts.length > 0) {
        return supaRest("/rest/v1/aba_contacts", "POST", allContacts, "return=minimal");
      }
    });
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

// ===== Pinned Contacts (Supabase + chrome.storage cache) =====
// Modelo: _wcrmPinned = { 'Nome': true }  (retrocompat)
//         _wcrmPinnedJids = { 'Nome': '5511...@c.us' }  (novo, aditivo)
// Matching de pin:
//   1. resolve JID do titulo do DOM via ezapResolveJid/ezapFindJidInIndex
//   2. se houver JID e alguma entry em _wcrmPinnedJids casar -> pinado
//   3. fallback: ezapMatchContact tolerante com nomes de _wcrmPinned
function loadPinnedContacts() {
  return new Promise(function(resolve) {
    // Fast: load from local cache first
    chrome.storage.local.get(["wcrm_pinned", "wcrm_pinned_jids"], function(result) {
      window._wcrmPinned = result.wcrm_pinned || {};
      window._wcrmPinnedJids = result.wcrm_pinned_jids || {};
      resolve(window._wcrmPinned);
    });

    // Background: sync from Supabase
    var uid = getUserId();
    if (!uid) return;

    supaRest("/rest/v1/pinned_contacts?user_id=eq." + uid + "&select=contact_name,contact_jid").then(function(rows) {
      if (!rows || !Array.isArray(rows)) return;
      var pinned = {};
      var jids = {};
      rows.forEach(function(r) {
        pinned[r.contact_name] = true;
        if (r.contact_jid) jids[r.contact_name] = r.contact_jid;
      });
      window._wcrmPinned = pinned;
      window._wcrmPinnedJids = jids;
      chrome.storage.local.set({ wcrm_pinned: pinned, wcrm_pinned_jids: jids });
    });
  });
}

function savePinnedContacts(data, jids) {
  window._wcrmPinned = data;
  if (jids) window._wcrmPinnedJids = jids;
  else jids = window._wcrmPinnedJids || {};
  if (isExtensionValid()) {
    chrome.storage.local.set({ wcrm_pinned: data, wcrm_pinned_jids: jids });
  }

  // Sync to Supabase
  var uid = getUserId();
  if (!uid) return;

  supaRest("/rest/v1/pinned_contacts?user_id=eq." + uid, "DELETE", null, "return=minimal").then(function() {
    var names = Object.keys(data);
    if (names.length === 0) return;
    var rows = names.map(function(n) {
      return { user_id: uid, contact_name: n, contact_jid: jids[n] || null };
    });
    supaRest("/rest/v1/pinned_contacts", "POST", rows, "return=minimal");
  });
}

function togglePinContact(chatName) {
  // Resolve JID async pra guardar o identificador estavel do chat.
  // Se o bridge (store-bridge.js) ainda nao esta pronto, salva sem JID e
  // o JID sera resolvido preguicosamente depois (ver migratePinJids).
  var jidPromise = window.ezapResolveJid
    ? window.ezapResolveJid(chatName)
    : Promise.resolve(null);

  jidPromise.then(function(resolvedJid) {
    var pinned = window._wcrmPinned || {};
    var jids = window._wcrmPinnedJids || {};
    var existingKey = null;

    // 1) Match por JID (mais confiavel)
    if (resolvedJid) {
      var jidKeys = Object.keys(jids);
      for (var k = 0; k < jidKeys.length; k++) {
        if (jids[jidKeys[k]] === resolvedJid) { existingKey = jidKeys[k]; break; }
      }
    }

    // 2) Fallback: match tolerante por nome (legacy pins sem JID)
    if (!existingKey && window.ezapMatchContact) {
      var keys = Object.keys(pinned);
      for (var i = 0; i < keys.length; i++) {
        if (window.ezapMatchContact(keys[i], chatName)) { existingKey = keys[i]; break; }
      }
    } else if (!existingKey && pinned[chatName]) {
      existingKey = chatName;
    }

    if (existingKey) {
      delete pinned[existingKey];
      delete jids[existingKey];
    } else {
      pinned[chatName] = true;
      if (resolvedJid) jids[chatName] = resolvedJid;
    }
    savePinnedContacts(pinned, jids);
    updateHeaderButtons();
    applyPinnedOrder();
    if (selectedAbaId || (typeof selectedMentor !== 'undefined' && selectedMentor)) {
      applyConversationFilters();
    }
  });
}

// ===== Lazy JID migration =====
// Pins e contatos de aba salvos antes da existencia do bridge nao tem JID.
// Na primeira vez que o store ficar disponivel, percorre os nomes e tenta
// resolver o JID via store-bridge. Salva tudo em uma tacada.
var _wcrmJidMigrationDone = false;
function migrateJidsWhenStoreReady() {
  if (_wcrmJidMigrationDone) return;
  if (!window.ezapStoreReady || !window.ezapBuildChatIndex) return;
  window.ezapStoreReady().then(function(ready) {
    if (!ready) { setTimeout(migrateJidsWhenStoreReady, 3000); return; }
    window.ezapBuildChatIndex().then(function(index) {
      if (!index) return;
      _wcrmJidMigrationDone = true;

      // Migra pins
      var pinned = window._wcrmPinned || {};
      var pinJids = window._wcrmPinnedJids || {};
      var pinDirty = false;
      Object.keys(pinned).forEach(function(name) {
        if (!pinJids[name]) {
          var jid = window.ezapFindJidInIndex(index, name);
          if (jid) { pinJids[name] = jid; pinDirty = true; }
        }
      });
      if (pinDirty) savePinnedContacts(pinned, pinJids);

      // Migra ABAS contacts
      var cache = window._wcrmAbasCache;
      if (cache && cache.tabs) {
        var abasDirty = false;
        cache.tabs.forEach(function(tab) {
          if (!tab.contactJids) tab.contactJids = {};
          (tab.contacts || []).forEach(function(name) {
            if (!tab.contactJids[name]) {
              var jid = window.ezapFindJidInIndex(index, name);
              if (jid) { tab.contactJids[name] = jid; abasDirty = true; }
            }
          });
        });
        if (abasDirty) saveAbasData(cache);
      }

      console.log("[WCRM JID] Migration done. Pins updated:", pinDirty, "Abas updated:", !!cache);
    });
  });
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

// Mark pinned contacts with a visual indicator.
// NOTE: We intentionally do NOT reorder/reposition pinned rows when no filter
// is active, because WhatsApp Web uses a virtual scroll that positions rows
// with absolute `top: Xpx` inline styles. Overriding positioning (via the
// wcrm-filter-active class) or using insertBefore fights WA's renderer and
// causes rows to disappear and the scrollbar to glitch. The pin icon alone
// is enough to identify pinned contacts. When a filter IS active
// (slice/abas), applyConversationFilters already handles pin-at-top safely.
// Helper sync: retorna true se o title corresponde a algum pin,
// comparando primeiro pelo JID (via chatIndex) e depois por nome tolerante.
// chatIndex pode ser null — entao so usa match por nome.
function _isTitlePinned(title, chatIndex) {
  var pinned = window._wcrmPinned || {};
  var pinJids = window._wcrmPinnedJids || {};
  if (chatIndex && window.ezapFindJidInIndex) {
    var jid = window.ezapFindJidInIndex(chatIndex, title);
    if (jid) {
      var keys = Object.keys(pinJids);
      for (var i = 0; i < keys.length; i++) {
        if (pinJids[keys[i]] === jid) return true;
      }
    }
  }
  // Fallback: match tolerante por nome
  var names = Object.keys(pinned);
  for (var j = 0; j < names.length; j++) {
    if (window.ezapMatchContact && window.ezapMatchContact(names[j], title)) return true;
  }
  return false;
}
window._wcrmIsTitlePinned = _isTitlePinned;

function applyPinnedOrder() {
  var pinned = window._wcrmPinned || {};
  var pinnedNames = Object.keys(pinned);

  var container = findChatListContainer();

  // No pins: strip all indicators and exit.
  if (pinnedNames.length === 0) {
    document.querySelectorAll('.wcrm-pin-icon').forEach(function(el) { el.remove(); });
    if (container && container.classList.contains('wcrm-filter-active')) {
      // Make sure we never leave the virtual-scroll-breaking class hanging
      // around from an older version of the extension.
      var hasFilter = (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null) ||
                      (typeof selectedMentor !== 'undefined' && !!selectedMentor);
      if (!hasFilter) container.classList.remove('wcrm-filter-active');
    }
    return;
  }

  if (!container) return;

  // If a filter is active, let applyConversationFilters own the DOM (it
  // handles pin-at-top because it's already overriding the virtual scroll).
  var hasFilter = (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null) ||
                  (typeof selectedMentor !== 'undefined' && !!selectedMentor);
  if (hasFilter) return;

  // Pin-only mode: visual indicator only, no reordering, no CSS override.
  // Strip any stale wcrm-filter-active left over from previous behavior.
  if (container.classList.contains('wcrm-filter-active')) {
    container.classList.remove('wcrm-filter-active');
    container.querySelectorAll('.wcrm-hidden').forEach(function(el) {
      el.classList.remove('wcrm-hidden');
    });
  }
  // Match JID-first (chatIndex do store bridge), fallback nome tolerante.
  // Constroi o index uma vez e passa pro loop sync.
  var indexPromise = window.ezapBuildChatIndex
    ? window.ezapBuildChatIndex()
    : Promise.resolve(null);
  indexPromise.then(function(chatIndex) {
    var c2 = findChatListContainer();
    if (!c2) return;
    for (var i = 0; i < c2.children.length; i++) {
      var row = c2.children[i];
      var nameSpan = row.querySelector('span[title]');
      if (!nameSpan) continue;
      var title = nameSpan.getAttribute('title') || '';
      if (_isTitlePinned(title, chatIndex)) addPinIndicator(nameSpan);
      else removePinIndicator(nameSpan);
    }
    ensurePinObserver();
  });
}

// Observer que re-aplica pin indicators quando o WA recicla linhas.
//
// IMPORTANTE: este observer tem 3 regras pra nao matar o WhatsApp Web:
//
// 1. Observa SO o container da lista (childList direto), nao pane-side.
//    pane-side com subtree:true dispara a cada typing/presence/mensagem,
//    o que causa loop infinito e trava a UI do WA.
//
// 2. Ignora mutacoes que sao apenas nossos proprios .wcrm-pin-icon, senao
//    adicionar/remover um icone dispara o observer que chama de novo,
//    causando loop.
//
// 3. Debounce alto (600ms) pra evitar rajadas durante scroll rapido.
var _pinObserver = null;
var _pinObserverContainer = null;
var _pinDebounce = null;

function _pinMutationIsOursOnly(mutations) {
  // true se todas as mutacoes sao so nossos pin-icons sendo add/remove
  return mutations.every(function(m) {
    var added = Array.prototype.slice.call(m.addedNodes || []);
    var removed = Array.prototype.slice.call(m.removedNodes || []);
    var all = added.concat(removed);
    if (all.length === 0) return true;
    return all.every(function(n) {
      return n && n.nodeType === 1 && n.classList && n.classList.contains('wcrm-pin-icon');
    });
  });
}

function _reapplyPinIndicators() {
  var hasFilter = (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null) ||
                  (typeof selectedMentor !== 'undefined' && !!selectedMentor);
  if (hasFilter) return;
  var pinnedNames = Object.keys(window._wcrmPinned || {});
  if (pinnedNames.length === 0) return;
  var container = findChatListContainer();
  if (!container) return;
  // Usa chatIndex se disponivel (JID-match), senao fallback nome tolerante.
  var indexPromise = window.ezapBuildChatIndex
    ? window.ezapBuildChatIndex()
    : Promise.resolve(null);
  indexPromise.then(function(chatIndex) {
    var c2 = findChatListContainer();
    if (!c2) return;
    var kids = c2.children;
    for (var i = 0; i < kids.length; i++) {
      var row = kids[i];
      if (!row || typeof row.querySelector !== 'function') continue;
      var nameSpan = row.querySelector('span[title]');
      if (!nameSpan) continue;
      var title = nameSpan.getAttribute('title') || '';
      if (_isTitlePinned(title, chatIndex)) addPinIndicator(nameSpan);
      else removePinIndicator(nameSpan);
    }
  });
}

function ensurePinObserver() {
  var container = findChatListContainer();
  if (!container) return;
  // Se container mudou (WA recriou o DOM), recria o observer
  if (_pinObserver && _pinObserverContainer === container) return;
  if (_pinObserver) { try { _pinObserver.disconnect(); } catch (e) {} _pinObserver = null; }
  _pinObserverContainer = container;
  _pinObserver = new MutationObserver(function(mutations) {
    if (_pinMutationIsOursOnly(mutations)) return; // evita loop
    if (_pinDebounce) clearTimeout(_pinDebounce);
    _pinDebounce = setTimeout(_reapplyPinIndicators, 600);
  });
  _pinObserver.observe(container, { childList: true, subtree: false });
}

// ===== Floating Button =====
function createAbasButton() {
  if (document.getElementById("wcrm-abas-toggle")) return;
  var btn = document.createElement("button");
  btn.id = "wcrm-abas-toggle";
  btn.title = "Abas personalizadas";
  btn.addEventListener("click", toggleAbasSidebar);
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
  if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "abas");
  else { btn.textContent = "ABAS"; btn.style.background = "#cc5de8"; btn.style.color = "#fff"; btn.style.fontSize = "9px"; }
  var container = document.getElementById("ezap-float-container");
  if (container) container.appendChild(btn);
  else document.body.appendChild(btn);
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
    // Load fresh data from Supabase when opening sidebar
    loadAbasData().then(function(data) {
      renderAbasList(data);
      updateAbasIndicator();
    });
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
  // Render from local cache (instant) — no Supabase round-trip
  var data = window._wcrmAbasCache || { tabs: [] };
  renderAbasList(data);
  updateAbasIndicator();
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
  // Resolve JID via bridge (async). Se indisponivel, segue sem JID.
  var jidPromise = window.ezapResolveJid
    ? window.ezapResolveJid(chatName)
    : Promise.resolve(null);

  Promise.all([loadAbasData(), jidPromise]).then(function(pair) {
    var data = pair[0];
    var resolvedJid = pair[1];
    var tab = data.tabs.find(function(t) { return t.id === abaId; });
    if (!tab) return;
    if (!tab.contacts) tab.contacts = [];
    if (!tab.contactJids) tab.contactJids = {};

    // Match existing: primeiro por JID, depois por nome tolerante
    var idx = -1;
    if (resolvedJid) {
      idx = tab.contacts.findIndex(function(c) {
        return tab.contactJids[c] === resolvedJid;
      });
    }
    if (idx < 0) {
      idx = tab.contacts.findIndex(function(c) {
        return window.ezapMatchContact && window.ezapMatchContact(c, chatName);
      });
    }

    if (idx >= 0) {
      var removed = tab.contacts[idx];
      tab.contacts.splice(idx, 1);
      delete tab.contactJids[removed];
    } else {
      tab.contacts.push(chatName);
      if (resolvedJid) tab.contactJids[chatName] = resolvedJid;
    }

    saveAbasData(data).then(function() {
      if (abasSidebarOpen) renderAbasSidebar();
      applyConversationFilters();
      updateHeaderButtons();
      updateAbasDotIndicator();
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
  var firstBottomIconTop = sidebarRect.bottom; // default: bottom of sidebar
  for (var k = 1; k < leftIcons.length; k++) {
    var gap = leftIcons[k].rect.top - leftIcons[k - 1].rect.bottom;
    if (gap > 80) {
      // big gap = separator between top section and bottom section
      firstBottomIconTop = leftIcons[k].rect.top;
      break;
    }
    lastTopIcon = leftIcons[k];
  }

  return {
    sidebarEl: (sidebarEl && sidebarEl !== document.body) ? sidebarEl : null,
    sidebarRect: sidebarRect,
    lastTopIconBottom: lastTopIcon.rect.bottom,
    firstBottomIconTop: firstBottomIconTop,
    centerX: sidebarRect.left + sidebarRect.width / 2,
  };
}

function calcButtonSizes(availableHeight) {
  // Full size: label(12) + gap(4) + 3 buttons(40 each) + gaps(4*2) + padding(8) = ~132px
  // Compact: label(10) + gap(2) + 3 buttons(34 each) + gaps(2*2) + padding(4) = ~120px
  // Mini: label(10) + gap(1) + 3 buttons(28 each) + gaps(1*2) + padding(2) = ~99px
  // Tight: no label + 3 buttons(26 each) + gaps(1*2) + padding(2) = ~82px

  if (availableHeight >= 132) {
    return { btnSize: 40, iconSize: 20, gap: 4, padding: 8, labelSize: 8, labelMargin: 4, showLabel: true };
  } else if (availableHeight >= 110) {
    return { btnSize: 34, iconSize: 18, gap: 2, padding: 4, labelSize: 7, labelMargin: 2, showLabel: true };
  } else if (availableHeight >= 90) {
    return { btnSize: 28, iconSize: 16, gap: 1, padding: 2, labelSize: 7, labelMargin: 1, showLabel: true };
  } else {
    return { btnSize: 26, iconSize: 14, gap: 1, padding: 2, labelSize: 0, labelMargin: 0, showLabel: false };
  }
}

function injectSidebarButtons() {
  // If widget mode is "floating", remove sidebar buttons and let widget.js handle rendering
  var wc = window.__ezapWidgetConfig || {};
  if (wc.position === "floating") {
    var oldWrapper = document.getElementById('wcrm-sidebar-buttons');
    if (oldWrapper) oldWrapper.remove();
    return;
  }

  var info = findSidebarInfo();
  if (!info) return;

  // Calculate available space between top icons and bottom icons
  var topY = info.lastTopIconBottom + 8;
  var bottomY = info.firstBottomIconTop - 4;
  var availableHeight = bottomY - topY;
  var sizes = calcButtonSizes(availableHeight);

  var existing = document.getElementById('wcrm-sidebar-buttons');
  if (existing) {
    // Reposition and resize (layout may have shifted)
    existing.style.left = info.sidebarRect.left + 'px';
    existing.style.top = topY + 'px';
    existing.style.width = info.sidebarRect.width + 'px';
    existing.style.gap = sizes.gap + 'px';
    existing.style.paddingTop = sizes.padding + 'px';

    // Resize label
    var label = document.getElementById('wcrm-sidebar-hub-label');
    if (label) {
      label.style.display = sizes.showLabel ? 'block' : 'none';
      label.style.fontSize = sizes.labelSize + 'px';
      label.style.marginBottom = sizes.labelMargin + 'px';
    }

    // Resize buttons
    var btns = existing.querySelectorAll('[role="button"]');
    for (var b = 0; b < btns.length; b++) {
      btns[b].style.width = sizes.btnSize + 'px';
      btns[b].style.height = sizes.btnSize + 'px';
      var svg = btns[b].querySelector('svg');
      if (svg) {
        svg.setAttribute('width', sizes.iconSize);
        svg.setAttribute('height', sizes.iconSize);
      }
    }

    updateSidebarButtonStates();
    return;
  }

  var t = getTheme();

  // Wrapper for our custom buttons
  var wrapper = document.createElement('div');
  wrapper.id = 'wcrm-sidebar-buttons';
  Object.assign(wrapper.style, {
    position: 'fixed',
    left: info.sidebarRect.left + 'px',
    top: topY + 'px',
    width: info.sidebarRect.width + 'px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: sizes.gap + 'px',
    paddingTop: sizes.padding + 'px',
    borderTop: '1px solid ' + t.border,
    zIndex: '99998',
  });

  // E-ZAP label
  var hubLabel = document.createElement('div');
  hubLabel.id = 'wcrm-sidebar-hub-label';
  Object.assign(hubLabel.style, {
    fontSize: sizes.labelSize + 'px',
    fontWeight: '700',
    color: '#25d366',
    textAlign: 'center',
    letterSpacing: '1px',
    marginBottom: sizes.labelMargin + 'px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    userSelect: 'none',
    display: sizes.showLabel ? 'block' : 'none',
  });
  hubLabel.textContent = 'E-ZAP';

  // Pin button
  var pinBtn = document.createElement('div');
  pinBtn.id = 'wcrm-sidebar-pin';
  pinBtn.setAttribute('role', 'button');
  Object.assign(pinBtn.style, {
    width: sizes.btnSize + 'px',
    height: sizes.btnSize + 'px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'background 0.15s',
  });
  var chatName = typeof currentName !== 'undefined' ? currentName : null;
  updatePinButtonState(pinBtn, chatName, t, sizes.iconSize);
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

  // ABAS button (with purple dot indicator)
  var abasBtn = document.createElement('div');
  abasBtn.id = 'wcrm-sidebar-abas';
  abasBtn.setAttribute('role', 'button');
  Object.assign(abasBtn.style, {
    width: sizes.btnSize + 'px',
    height: sizes.btnSize + 'px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'background 0.15s',
    position: 'relative',
  });
  abasBtn.innerHTML = '<svg viewBox="0 0 24 24" width="' + sizes.iconSize + '" height="' + sizes.iconSize + '" fill="' + t.iconColor + '"><path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z" opacity="0.85"/></svg>';
  abasBtn.title = 'Abas';
  // Purple dot indicator (hidden by default)
  var abasDot = document.createElement('span');
  abasDot.id = 'wcrm-sidebar-abas-dot';
  Object.assign(abasDot.style, {
    position: 'absolute',
    top: '4px',
    right: '4px',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#cc5de8',
    display: 'none',
    border: '2px solid ' + t.bg,
  });
  abasBtn.appendChild(abasDot);
  abasBtn.addEventListener('mouseenter', function() { abasBtn.style.background = getTheme().bgHover; });
  abasBtn.addEventListener('mouseleave', function() { abasBtn.style.background = 'transparent'; });
  abasBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var cn = typeof currentName !== 'undefined' ? currentName : null;
    if (cn) showHeaderAbasDropdown(abasBtn, cn);
  });

  // TAG button (label selector)
  var tagBtn = document.createElement('div');
  tagBtn.id = 'wcrm-sidebar-tag';
  tagBtn.setAttribute('role', 'button');
  Object.assign(tagBtn.style, {
    width: sizes.btnSize + 'px',
    height: sizes.btnSize + 'px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'background 0.15s',
  });
  tagBtn.innerHTML = '<svg viewBox="0 0 24 24" width="' + sizes.iconSize + '" height="' + sizes.iconSize + '" fill="' + t.iconColor + '"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z" opacity="0.85"/></svg>';
  tagBtn.title = 'Etiquetas';
  tagBtn.addEventListener('mouseenter', function() { tagBtn.style.background = getTheme().bgHover; });
  tagBtn.addEventListener('mouseleave', function() { tagBtn.style.background = 'transparent'; });
  tagBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (typeof toggleTagSidebar === 'function') toggleTagSidebar();
  });

  wrapper.appendChild(hubLabel);
  wrapper.appendChild(pinBtn);
  wrapper.appendChild(abasBtn);
  wrapper.appendChild(tagBtn);
  document.body.appendChild(wrapper);

  // Set initial abas dot state
  updateAbasDotIndicator();
}

function updateSidebarButtonStates() {
  var chatName = typeof currentName !== 'undefined' ? currentName : null;
  var pinBtn = document.getElementById('wcrm-sidebar-pin');
  if (pinBtn) {
    updatePinButtonState(pinBtn, chatName);
  }
  updateAbasDotIndicator();
}

// Verifica se chatName pertence a alguma aba. Aceita chatIndex opcional
// pra fazer match por JID (mais robusto pra apelidos / pipe).
function isContactInAnyAba(chatName, chatIndex) {
  if (!chatName) return false;
  var data = window._wcrmAbasCache || { tabs: [] };
  // JID match (quando temos index)
  var jid = (chatIndex && window.ezapFindJidInIndex) ? window.ezapFindJidInIndex(chatIndex, chatName) : null;
  for (var i = 0; i < data.tabs.length; i++) {
    var tab = data.tabs[i];
    var contacts = tab.contacts || [];
    var jids = tab.contactJids || {};
    if (jid) {
      for (var k = 0; k < contacts.length; k++) {
        if (jids[contacts[k]] === jid) return true;
      }
    }
    // Fallback nome tolerante
    for (var j = 0; j < contacts.length; j++) {
      if (window.ezapMatchContact && window.ezapMatchContact(contacts[j], chatName)) return true;
    }
  }
  return false;
}

function updateAbasDotIndicator() {
  var dot = document.getElementById('wcrm-sidebar-abas-dot');
  if (!dot) return;
  var chatName = typeof currentName !== 'undefined' ? currentName : null;
  dot.style.display = isContactInAnyAba(chatName) ? 'block' : 'none';
}

function updatePinButtonState(btn, chatName, theme, iconSz) {
  var t = theme || getTheme();
  var sz = iconSz || 20;
  // Pass 1 (sync, fallback nome tolerante). Pass 2 refina com JID (async).
  var isPinned = !!chatName && _isTitlePinned(chatName, null);
  _paintPinBtn(btn, isPinned, t, sz);

  if (chatName && window.ezapBuildChatIndex) {
    window.ezapBuildChatIndex().then(function(idx) {
      if (!idx) return;
      var refined = _isTitlePinned(chatName, idx);
      if (refined !== isPinned) _paintPinBtn(btn, refined, t, sz);
    });
  }
  return;
}
function _paintPinBtn(btn, isPinned, t, sz) {
  if (isPinned) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="#25d366"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg>';
    btn.style.background = isDarkMode() ? '#25d36615' : '#25d36610';
    btn.title = 'Desafixar contato';
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + t.iconColor + '"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2zM9 4v7.75L7.5 14h9L15 11.75V4H9z"/></svg>';
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
  var isWidget = anchorBtn.id && anchorBtn.id.indexOf("ezap-widget-btn-") === 0;
  var dropdown = document.createElement("div");
  dropdown.id = "wcrm-header-abas-dropdown";
  var minW = 200;
  var posStyle = isWidget
    ? { top: (rect.bottom + 12) + "px", left: Math.max(8, rect.left + (rect.width / 2) - (minW / 2)) + "px" }
    : { top: rect.top + "px", left: (rect.right + 8) + "px" };
  Object.assign(dropdown.style, {
    position: "fixed",
    top: posStyle.top,
    left: posStyle.left,
    background: t.bgSecondary,
    border: "1px solid " + t.border,
    borderRadius: "10px",
    padding: "6px",
    zIndex: "999999",
    minWidth: minW + "px",
    maxHeight: "360px",
    overflowY: "auto",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  });

  var html = '';
  if (!data.tabs || data.tabs.length === 0) {
    html += '<div style="padding:10px 12px;color:' + t.textSecondary + ';font-size:12px;font-style:italic;text-align:center">Nenhuma aba criada</div>';
  }
  data.tabs.forEach(function(tab) {
    var isIn = (tab.contacts || []).some(function(c) {
      return window.ezapMatchContact && window.ezapMatchContact(c, chatName);
    });
    var icon = isIn ? '&#10003;' : '&plus;';
    var iconColor = isIn ? tab.color : t.textSecondary;
    html += '<div class="wcrm-header-aba-opt" data-aba-id="' + tab.id + '" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;transition:background 0.1s">';
    html += '<span style="width:10px;height:10px;border-radius:50%;background:' + tab.color + ';display:inline-block;flex-shrink:0"></span>';
    html += '<span style="font-size:12px;color:' + t.text + ';flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + tab.name + '</span>';
    html += '<span style="color:' + iconColor + ';font-size:14px;font-weight:bold">' + icon + '</span>';
    html += '</div>';
  });
  // Divider + "Criar nova aba"
  html += '<div style="height:1px;background:' + t.border + ';margin:6px 4px"></div>';
  html += '<div id="wcrm-header-abas-create" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;transition:background 0.1s">';
  html += '<span style="color:#20c997;font-size:16px;font-weight:bold;width:10px;display:inline-block;text-align:center">+</span>';
  html += '<span style="font-size:12px;color:' + t.text + ';font-weight:500">Criar nova aba</span>';
  html += '</div>';

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
  var createBtn = document.getElementById("wcrm-header-abas-create");
  if (createBtn) {
    createBtn.addEventListener('mouseenter', function() { createBtn.style.background = t.bgHover; });
    createBtn.addEventListener('mouseleave', function() { createBtn.style.background = 'transparent'; });
    createBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      dropdown.remove();
      if (typeof toggleAbasSidebar === "function") toggleAbasSidebar();
    });
  }

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
        data.tabs.push({ id: crypto.randomUUID(), name: name, color: selectedColor, contacts: [] });
      }
      saveAbasData(data).then(function() { overlay.remove(); renderAbasSidebar(); });
    });
  });

  document.getElementById("wcrm-aba-name-input").focus();
}

function deleteAba(abaId) {
  var cached = window._wcrmAbasCache || { tabs: [] };
  var tab = cached.tabs.find(function(t) { return t.id === abaId; });
  var tabName = tab ? tab.name : "esta aba";
  if (!confirm('Excluir a aba "' + tabName + '" e todos os contatos dela?')) return;

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
  var abasEnabled = window.__ezapAbasEnabled !== false;
  var pinEnabled = window.__ezapPinEnabled !== false;

  if (abasEnabled) {
    createAbasButton();
    createAbasSidebar();
    loadAbasData();
    loadKnownContacts();
  }

  if (pinEnabled) {
    loadPinnedContacts().then(function() {
      setTimeout(function() { applyPinnedOrder(); }, 2000);
    });
  }

  // Tenta migrar JIDs assim que o store-bridge ficar pronto.
  // (Pins e contatos de aba antigos nao tem JID - resolve preguicosamente.)
  setTimeout(migrateJidsWhenStoreReady, 5000);

  var abasInterval = setInterval(function() {
    if (!isExtensionValid()) {
      clearInterval(abasInterval);
      console.log("[WCRM ABAS] Extension context invalidated, stopping interval");
      return;
    }
    if (abasEnabled) scanAndStoreContacts();
    injectSidebarButtons();
  }, 3000);
}

// Start after authentication (only if 'abas' or 'pin' feature is enabled)
document.addEventListener("wcrm-auth-ready", function() {
  var hasAbas = window.__ezapHasFeature && window.__ezapHasFeature("abas");
  var hasPin = window.__ezapHasFeature && window.__ezapHasFeature("pin");
  if (hasAbas || hasPin) {
    // Pass feature flags so initAbas knows what to enable
    window.__ezapAbasEnabled = hasAbas;
    window.__ezapPinEnabled = hasPin;
    setTimeout(initAbas, 700);
  } else {
    console.log("[WCRM ABAS] ABAS/PIN features not enabled for this user");
  }
});
if (window.__wcrmAuth) {
  var _hasAbas = window.__ezapHasFeature && window.__ezapHasFeature("abas");
  var _hasPin = window.__ezapHasFeature && window.__ezapHasFeature("pin");
  if (_hasAbas || _hasPin) {
    window.__ezapAbasEnabled = _hasAbas;
    window.__ezapPinEnabled = _hasPin;
    setTimeout(initAbas, 1200);
  }
}
