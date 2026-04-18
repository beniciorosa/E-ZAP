// ===== WhatsApp CRM - ABAS (Custom Tab Groups) =====
console.log("[WCRM ABAS] Loaded");

var abasSidebarOpen = false;
var selectedAbaId = null;
var _adminAbas = [];

var ABAS_COLORS = [
  "#ff6b6b", "#ff922b", "#ffd93d", "#25d366", "#4d96ff",
  "#cc5de8", "#20c997", "#748ffc", "#f06595", "#868e96",
];

// Theme functions moved to theme.js (isDarkMode, getTheme, _readColor, _hexToRgb, _adjustColor, __ezapRefreshTheme)

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

// ===== Admin ABAS (read-only, criadas pelo admin) =====
function _filterAdminAbasForUser(abas) {
  var uid = getUserId();
  if (!uid) return [];
  return (abas || []).filter(function(a) {
    // visible_to null/vazio = visível para todos
    if (!a.visible_to || a.visible_to.length === 0) return true;
    return a.visible_to.indexOf(uid) >= 0;
  });
}

function loadAdminAbas() {
  // Cache first
  chrome.storage.local.get("ezap_admin_abas", function(data) {
    var cached = (data && data.ezap_admin_abas) || [];
    _adminAbas = _filterAdminAbasForUser(cached);
    window._adminAbas = _adminAbas;
    if (abasSidebarOpen) renderAbasSidebar();
  });
  chrome.storage.local.get("ezap_hubspot_ticket_cache", function(data) {
    window._ezapHubSpotTicketCache = (data && data.ezap_hubspot_ticket_cache) || {};
  });
  // Supabase sync
  supaRest("/rest/v1/admin_abas?active=eq.true&order=position.asc&select=*").then(function(abas) {
    if (!abas || !Array.isArray(abas)) return;
    var abaIds = abas.map(function(a) { return a.id; });
    if (abaIds.length === 0) {
      _adminAbas = [];
      chrome.storage.local.set({ ezap_admin_abas: [] });
      if (abasSidebarOpen) renderAbasSidebar();
      return;
    }
    supaRest("/rest/v1/admin_aba_contacts?aba_id=in.(" + abaIds.join(",") + ")&select=*").then(function(contacts) {
      contacts = contacts || [];
      abas.forEach(function(aba) {
        aba.contacts = contacts.filter(function(c) { return c.aba_id === aba.id; }).map(function(c) { return c.contact_name; });
        aba.contactJids = {};
        contacts.filter(function(c) { return c.aba_id === aba.id && c.contact_jid; }).forEach(function(c) {
          aba.contactJids[c.contact_name] = c.contact_jid;
        });
        aba.isAdmin = true;
      });
      // Cache TODAS as abas; o filtro acontece no momento de uso
      chrome.storage.local.set({ ezap_admin_abas: abas });
      _adminAbas = _filterAdminAbasForUser(abas);
      window._adminAbas = _adminAbas;
      if (abasSidebarOpen) renderAbasSidebar();

      // Resolve HubSpot ticket_ids dos critérios via tabela mentorados
      _resolveHubSpotTickets(_adminAbas);
    });
  });
}

// Extrai todos os hubspot IDs dos critérios das admin abas e resolve
// para whatsapp numbers via tabela mentorados (populada via webhook HubSpot)
function _resolveHubSpotTickets(abas) {
  var ids = {};
  (abas || []).forEach(function(aba) {
    var crits = aba.criteria || [];
    crits.forEach(function(crit) {
      var id = _extractHubSpotId(crit);
      if (id) ids[id] = true;
    });
  });
  var idList = Object.keys(ids);
  if (idList.length === 0) return;

  // Query mentorados table for these ticket_ids
  var url = "/rest/v1/mentorados?ticket_id=in.(" + idList.join(",") + ")&select=ticket_id,whatsapp_do_mentorado";
  supaRest(url).then(function(rows) {
    if (!Array.isArray(rows)) return;
    var cache = window._ezapHubSpotTicketCache || {};
    rows.forEach(function(r) {
      if (r.ticket_id && r.whatsapp_do_mentorado) {
        // Extrai só os dígitos do telefone
        var digits = String(r.whatsapp_do_mentorado).replace(/\D/g, '');
        if (digits.length >= 8) {
          cache[String(r.ticket_id)] = digits;
        }
      }
    });
    window._ezapHubSpotTicketCache = cache;
    chrome.storage.local.set({ ezap_hubspot_ticket_cache: cache });
    // Trigger re-render do overlay pra atualizar os ícones
    if (typeof window._wcrmApplyOverlay === 'function') {
      try { window._wcrmApplyOverlay(); } catch(e) {}
    }
  });
}

// Extrai o hubspot ID de uma string de critério
// Formatos aceitos:
//   "hubspot:12345"
//   "https://app.hubspot.com/contacts/X/ticket/12345"
//   "https://app.hubspot.com/contacts/X/record/0-5/12345"
function _extractHubSpotId(crit) {
  if (!crit) return null;
  var s = String(crit).toLowerCase().trim();
  if (s.indexOf('hubspot:') === 0) {
    var id = s.substring(8).replace(/\D/g, '');
    return id.length > 0 ? id : null;
  }
  if (s.indexOf('hubspot.com/') >= 0) {
    // Pega último segmento numérico da URL
    var match = s.match(/\/(\d{3,})(?:\?|$|\/)/g);
    if (match && match.length > 0) {
      var last = match[match.length - 1];
      var num = last.replace(/\D/g, '');
      return num.length > 0 ? num : null;
    }
  }
  return null;
}

function isAdminAba(abaId) {
  return _adminAbas.some(function(a) { return a.id === abaId; });
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

  // Notify all subscribers immediately (real-time pills update)
  if (window.ezapBus) window.ezapBus.emit('abas:changed', data);

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
    // Carrega contatos salvos anteriormente (merge, não zera)
    chrome.storage.local.get("wcrm_known_contacts", function(result) {
      var saved = result.wcrm_known_contacts || {};
      var current = window._wcrmKnownContacts || {};
      // Merge: preserva contatos já conhecidos
      for (var k in saved) { if (saved.hasOwnProperty(k)) current[k] = true; }
      window._wcrmKnownContacts = current;
      scanAndStoreContacts();
      resolve(window._wcrmKnownContacts || {});
    });
  });
}

function getAllKnownContacts() {
  scanAndStoreContacts();
  var contacts = window._wcrmKnownContacts || {};
  return Object.keys(contacts).sort(function(a, b) {
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
}

// ===== Per-Context Pinned Contacts =====
// Cada contexto (overlay geral, cada aba) tem seus proprios pins independentes.
// Modelo: _wcrmPinnedCtx = { "__overlay__": { "Nome": true }, "aba-uuid": { "Nome": true } }
//         _wcrmPinnedCtxJids = { "__overlay__": { "Nome": "5511...@c.us" }, ... }
var OVERLAY_PIN_CTX = '__overlay__';

function _getPinCtx() {
  return window._wcrmPinnedCtx || {};
}
function _getPinCtxJids() {
  return window._wcrmPinnedCtxJids || {};
}

function loadPinnedCtx() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(["wcrm_pinned_ctx", "wcrm_pinned_ctx_jids", "wcrm_pinned", "wcrm_pinned_jids"], function(result) {
      var ctx = result.wcrm_pinned_ctx || {};
      var ctxJids = result.wcrm_pinned_ctx_jids || {};
      // Migra pins antigos (globais) pro contexto __overlay__ se ainda nao migrou
      var oldPinned = result.wcrm_pinned || {};
      var oldJids = result.wcrm_pinned_jids || {};
      if (Object.keys(oldPinned).length > 0 && !ctx[OVERLAY_PIN_CTX]) {
        ctx[OVERLAY_PIN_CTX] = oldPinned;
        ctxJids[OVERLAY_PIN_CTX] = oldJids;
        chrome.storage.local.set({ wcrm_pinned_ctx: ctx, wcrm_pinned_ctx_jids: ctxJids });
        console.log('[WCRM PINS] Migrated global pins to __overlay__ context');
      }
      window._wcrmPinnedCtx = ctx;
      window._wcrmPinnedCtxJids = ctxJids;
      // Retrocompat: popula _wcrmPinned com o ctx do overlay
      window._wcrmPinned = ctx[OVERLAY_PIN_CTX] || {};
      window._wcrmPinnedJids = ctxJids[OVERLAY_PIN_CTX] || {};
      resolve(ctx);
    });
  });
}

function savePinnedCtx(ctxId, pinned, jids) {
  var ctx = _getPinCtx();
  var ctxJids = _getPinCtxJids();
  ctx[ctxId] = pinned;
  ctxJids[ctxId] = jids || {};
  window._wcrmPinnedCtx = ctx;
  window._wcrmPinnedCtxJids = ctxJids;
  // Retrocompat
  if (ctxId === OVERLAY_PIN_CTX) {
    window._wcrmPinned = pinned;
    window._wcrmPinnedJids = jids || {};
  }
  if (isExtensionValid()) {
    chrome.storage.local.set({ wcrm_pinned_ctx: ctx, wcrm_pinned_ctx_jids: ctxJids });
  }
}

function getPinnedForCtx(ctxId) {
  var ctx = _getPinCtx();
  return ctx[ctxId] || {};
}
function getPinnedJidsForCtx(ctxId) {
  var ctxJids = _getPinCtxJids();
  return ctxJids[ctxId] || {};
}

function togglePinInCtx(ctxId, chatName, jid) {
  var pinned = getPinnedForCtx(ctxId);
  var jids = getPinnedJidsForCtx(ctxId);
  // Copia pra nao mutar referencia
  pinned = JSON.parse(JSON.stringify(pinned));
  jids = JSON.parse(JSON.stringify(jids));

  var existingKey = null;
  // Match por JID
  if (jid) {
    var jidKeys = Object.keys(jids);
    for (var k = 0; k < jidKeys.length; k++) {
      if (jids[jidKeys[k]] === jid) { existingKey = jidKeys[k]; break; }
    }
  }
  // Fallback: match por nome
  if (!existingKey && window.ezapMatchContact) {
    var keys = Object.keys(pinned);
    for (var i = 0; i < keys.length; i++) {
      if (window.ezapMatchContact(keys[i], chatName)) { existingKey = keys[i]; break; }
    }
  } else if (!existingKey && pinned[chatName]) {
    existingKey = chatName;
  }

  var wasPinned = !!existingKey;
  if (existingKey) {
    delete pinned[existingKey];
    delete jids[existingKey];
  } else {
    pinned[chatName] = true;
    if (jid) jids[chatName] = jid;
  }
  savePinnedCtx(ctxId, pinned, jids);
  return !wasPinned; // retorna true se agora esta pinado
}

function isPinnedInCtx(ctxId, chatName, jid) {
  var pinned = getPinnedForCtx(ctxId);
  var jids = getPinnedJidsForCtx(ctxId);
  // Match por JID
  if (jid) {
    var jidVals = Object.keys(jids);
    for (var k = 0; k < jidVals.length; k++) {
      if (jids[jidVals[k]] === jid) return true;
    }
  }
  // Match por nome
  if (pinned[chatName]) return true;
  if (window.ezapMatchContact) {
    var keys = Object.keys(pinned);
    for (var i = 0; i < keys.length; i++) {
      if (window.ezapMatchContact(keys[i], chatName)) return true;
    }
  }
  return false;
}

// ===== Pinned Contacts LEGACY (Supabase + chrome.storage cache) =====
// Modelo: _wcrmPinned = { 'Nome': true }  (retrocompat)
//         _wcrmPinnedJids = { 'Nome': '5511...@c.us' }  (novo, aditivo)
// Matching de pin:
//   1. resolve JID do titulo do DOM via ezapResolveJid/ezapFindJidInIndex
//   2. se houver JID e alguma entry em _wcrmPinnedJids casar -> pinado
//   3. fallback: ezapMatchContact tolerante com nomes de _wcrmPinned
function loadPinnedContacts() {
  return new Promise(function(resolve) {
    // Carrega sistema per-context primeiro
    loadPinnedCtx().then(function() {
      // Fast: load from local cache first (retrocompat)
      chrome.storage.local.get(["wcrm_pinned", "wcrm_pinned_jids"], function(result) {
        // Se ja migrou pro ctx, _wcrmPinned ja foi populado por loadPinnedCtx
        if (!window._wcrmPinned || Object.keys(window._wcrmPinned).length === 0) {
          window._wcrmPinned = result.wcrm_pinned || {};
          window._wcrmPinnedJids = result.wcrm_pinned_jids || {};
        }
        resolve(window._wcrmPinned);
      });
    });

    // Background: sync from Supabase (retrocompat - pins globais antigos)
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
  var jidPromise = window.ezapResolveJid
    ? window.ezapResolveJid(chatName)
    : Promise.resolve(null);

  jidPromise.then(function(resolvedJid) {
    // Determina contexto ativo: aba selecionada ou overlay geral
    var ctxId = selectedAbaId || OVERLAY_PIN_CTX;
    togglePinInCtx(ctxId, chatName, resolvedJid);
    // Retrocompat: sincroniza _wcrmPinned global com contexto ativo
    window._wcrmPinned = getPinnedForCtx(ctxId);
    window._wcrmPinnedJids = getPinnedJidsForCtx(ctxId);
    // Legacy save (Supabase retrocompat)
    savePinnedContacts(window._wcrmPinned, window._wcrmPinnedJids);
    updateHeaderButtons();
    applyPinnedOrder();
    applyConversationFilters();
  });
}

// ===== Lazy JID migration =====
// Pins e contatos de aba salvos antes da existencia do bridge nao tem JID.
// Na primeira vez que o store ficar disponivel, percorre os nomes e tenta
// resolver o JID via store-bridge. Salva tudo em uma tacada.
// Migra JIDs faltantes. Reroda enquanto houver contatos sem JID (ate 10 tentativas).
var _wcrmJidMigrationAttempts = 0;
function migrateJidsWhenStoreReady() {
  if (!window.ezapStoreReady || !window.ezapBuildChatIndex) {
    setTimeout(migrateJidsWhenStoreReady, 2000);
    return;
  }
  window.ezapStoreReady().then(function(ready) {
    if (!ready) { setTimeout(migrateJidsWhenStoreReady, 3000); return; }
    window.ezapBuildChatIndex().then(function(index) {
      if (!index) return;
      _wcrmJidMigrationAttempts++;

      // Migra pins
      var pinned = window._wcrmPinned || {};
      var pinJids = window._wcrmPinnedJids || {};
      var pinDirty = false;
      var pinMissing = 0;
      Object.keys(pinned).forEach(function(name) {
        if (!pinJids[name]) {
          var jid = window.ezapFindJidInIndex(index, name);
          if (jid) { pinJids[name] = jid; pinDirty = true; }
          else pinMissing++;
        }
      });
      if (pinDirty) savePinnedContacts(pinned, pinJids);

      // Migra ABAS contacts
      var cache = window._wcrmAbasCache;
      var abasMissing = 0;
      if (cache && cache.tabs) {
        var abasDirty = false;
        cache.tabs.forEach(function(tab) {
          if (!tab.contactJids) tab.contactJids = {};
          (tab.contacts || []).forEach(function(name) {
            if (!tab.contactJids[name]) {
              var jid = window.ezapFindJidInIndex(index, name);
              if (jid) { tab.contactJids[name] = jid; abasDirty = true; }
              else abasMissing++;
            }
          });
        });
        if (abasDirty) saveAbasData(cache);
      }

      var totalMissing = pinMissing + abasMissing;
      console.log("[WCRM JID] Migration attempt #" + _wcrmJidMigrationAttempts + ". Updated pins:" + pinDirty + " abas:" + (abasDirty || false) + " missing:" + totalMissing);

      // Se ainda ha faltando e nao passou de 10 tentativas, tenta de novo
      if (totalMissing > 0 && _wcrmJidMigrationAttempts < 10) {
        setTimeout(migrateJidsWhenStoreReady, 5000);
      }
    });
  });
}

// Expoe pra uso manual via console: window.ezapForceMigrateJids()
window.ezapForceMigrateJids = function() {
  _wcrmJidMigrationAttempts = 0;
  migrateJidsWhenStoreReady();
};

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
// (abas), applyConversationFilters already handles pin-at-top safely.
// Helper sync: retorna true se o title corresponde a algum pin,
// comparando primeiro pelo JID (via chatIndex) e depois por nome tolerante.
// chatIndex pode ser null — entao so usa match por nome.
function _isTitlePinned(title, chatIndex) {
  // Determina contexto ativo: aba selecionada ou overlay geral
  var ctxId = (typeof selectedAbaId !== 'undefined' && selectedAbaId) ? selectedAbaId : OVERLAY_PIN_CTX;
  // Usa sistema per-context se disponivel
  if (typeof isPinnedInCtx === 'function') {
    var jid = null;
    if (chatIndex && window.ezapFindJidInIndex) {
      jid = window.ezapFindJidInIndex(chatIndex, title);
    }
    return isPinnedInCtx(ctxId, title, jid);
  }
  // Fallback legacy
  var pinned = window._wcrmPinned || {};
  var pinJids = window._wcrmPinnedJids || {};
  if (chatIndex && window.ezapFindJidInIndex) {
    var jid2 = window.ezapFindJidInIndex(chatIndex, title);
    if (jid2) {
      var keys = Object.keys(pinJids);
      for (var i = 0; i < keys.length; i++) {
        if (pinJids[keys[i]] === jid2) return true;
      }
    }
  }
  var names = Object.keys(pinned);
  for (var j = 0; j < names.length; j++) {
    if (window.ezapMatchContact && window.ezapMatchContact(names[j], title)) return true;
  }
  return false;
}
window._wcrmIsTitlePinned = _isTitlePinned;

// Injeta CSS do modo filter-active caso ainda nao esteja na pagina.
// Copia o mesmo CSS usado em slice.js p/ casos em que applyPinnedOrder
// roda antes do filter engine carregar.
function _ensurePinCSS() {
  if (document.getElementById('wcrm-filter-css')) return;
  var style = document.createElement('style');
  style.id = 'wcrm-filter-css';
  style.textContent =
    '.wcrm-filter-active { height: auto !important; }' +
    '.wcrm-filter-active > * { position: relative !important; transform: none !important; top: auto !important; }' +
    '.wcrm-filter-active > .wcrm-hidden { display: none !important; }';
  document.head.appendChild(style);
}

// Percorre rows do container, aplica pin indicator e move pins pro topo
// atomicamente via DocumentFragment. Compartilhado entre applyPinnedOrder
// (trigger inicial) e _reapplyPinIndicators (trigger do observer).
function _reorderPinsToTop(container, chatIndex) {
  if (!container) return 0;
  var pinnedRows = [];
  for (var i = 0; i < container.children.length; i++) {
    var row = container.children[i];
    if (row.classList && row.classList.contains('wcrm-synth-row')) continue;
    if (!row.querySelector) continue;
    var nameSpan = row.querySelector('span[title]');
    if (!nameSpan) continue;
    var title = nameSpan.getAttribute('title') || '';
    if (_isTitlePinned(title, chatIndex)) {
      pinnedRows.push(row);
      addPinIndicator(nameSpan);
    } else {
      removePinIndicator(nameSpan);
    }
  }
  if (pinnedRows.length > 0) {
    // Skip DOM move se pins ja estao nas primeiras posicoes (evita loop
    // com o MutationObserver). Confere ordem exata entre pinnedRows e
    // os primeiros N children do container.
    var alreadyOrdered = true;
    for (var p = 0; p < pinnedRows.length; p++) {
      if (container.children[p] !== pinnedRows[p]) { alreadyOrdered = false; break; }
    }
    if (!alreadyOrdered) {
      var frag = document.createDocumentFragment();
      pinnedRows.forEach(function(r) { frag.appendChild(r); });
      container.insertBefore(frag, container.firstChild);
    }
  }
  return pinnedRows.length;
}

function applyPinnedOrder() {
  var pinned = window._wcrmPinned || {};
  var pinnedNames = Object.keys(pinned);

  var container = findChatListContainer();

  // No pins: strip all indicators and clear filter class.
  if (pinnedNames.length === 0) {
    document.querySelectorAll('.wcrm-pin-icon').forEach(function(el) { el.remove(); });
    if (container && container.classList.contains('wcrm-filter-active')) {
      var hasFilter = (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null);
      if (!hasFilter) container.classList.remove('wcrm-filter-active');
    }
    return;
  }

  if (!container) return;

  // Garante observer vivo ANTES de qualquer reorder (assim se o reorder
  // falhar, futuras mutacoes do WA ainda vao re-aplicar pins).
  ensurePinObserver();

  // If a filter is active, let applyConversationFilters own the DOM
  // (it already handles pin-at-top via wcrm-filter-active + fragment).
  var hasFilter = (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null);
  if (hasFilter) return;

  // Pin-only mode (sem ABA ativa): NAO reordena rows porque
  // wcrm-filter-active (position:relative) briga com o virtual scroll
  // do WA e causa tremor na lista. Apenas adiciona icone 📌 nos pinned.
  var indexPromise = window.ezapBuildChatIndex
    ? window.ezapBuildChatIndex()
    : Promise.resolve(null);
  indexPromise.then(function(chatIndex) {
    var c2 = findChatListContainer();
    if (!c2) return;
    // So adiciona icones, sem mover rows
    for (var pi = 0; pi < c2.children.length; pi++) {
      var row = c2.children[pi];
      if (!row.querySelector) continue;
      var nameSpan = row.querySelector('span[title]');
      if (!nameSpan) continue;
      var title = nameSpan.getAttribute('title') || '';
      if (_isTitlePinned(title, chatIndex)) {
        addPinIndicator(nameSpan);
      } else {
        removePinIndicator(nameSpan);
      }
    }
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
  var hasFilter = (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null);
  if (hasFilter) return;
  var pinnedNames = Object.keys(window._wcrmPinned || {});
  if (pinnedNames.length === 0) return;
  var container = findChatListContainer();
  if (!container) return;
  // Pin-only mode: so aplica icones, NAO reordena (virtual scroll briga)
  var indexPromise = window.ezapBuildChatIndex
    ? window.ezapBuildChatIndex()
    : Promise.resolve(null);
  indexPromise.then(function(chatIndex) {
    var c2 = findChatListContainer();
    if (!c2) return;
    for (var i = 0; i < c2.children.length; i++) {
      var row = c2.children[i];
      if (!row.querySelector) continue;
      var nameSpan = row.querySelector('span[title]');
      if (!nameSpan) continue;
      var title = nameSpan.getAttribute('title') || '';
      if (_isTitlePinned(title, chatIndex)) {
        addPinIndicator(nameSpan);
      } else {
        removePinIndicator(nameSpan);
      }
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
    _pinDebounce = setTimeout(_reapplyPinIndicators, 400);
  });
  _pinObserver.observe(container, { childList: true, subtree: false });
}

// ===== Floating Button =====
function createAbasButton() {
  if (document.getElementById("wcrm-abas-toggle")) return;
  var btn = document.createElement("button");
  btn.id = "wcrm-abas-toggle";
  btn.className = "escalada-crm ezap-float-btn";
  btn.setAttribute("data-tooltip", "Abas personalizadas");
  btn.addEventListener("click", toggleAbasSidebar);
  if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "abas");
  else { btn.textContent = "ABAS"; btn.style.background = "#8b5cf6"; btn.style.color = "#fff"; }
  var container = document.getElementById("ezap-float-container");
  if (container) container.appendChild(btn);
  else document.body.appendChild(btn);
}

// ===== Sidebar =====
function createAbasSidebar() {
  if (document.getElementById("wcrm-abas-sidebar")) return;

  var sidebar = document.createElement("div");
  sidebar.id = "wcrm-abas-sidebar";
  sidebar.className = "escalada-crm ezap-sidebar";

  sidebar.innerHTML =
    '<div class="ezap-header">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:#8b5cf6;display:flex;align-items:center;justify-content:center"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z"/></svg></div>' +
        '<h3 class="ezap-header-title">ABAS</h3>' +
      '</div>' +
      '<button id="wcrm-abas-close" class="ezap-header-close">&times;</button>' +
    '</div>' +
    '<div class="ezap-content">' +
      '<button id="wcrm-abas-create" class="ezap-btn ezap-btn--accent ezap-btn--full" style="margin-bottom:12px">+ Criar Aba</button>' +
      '<div id="wcrm-abas-active-filter" class="ezap-card ezap-card--accent" style="display:none;margin-bottom:12px;align-items:center;justify-content:space-between">' +
        '<span style="color:var(--ezap-accent);font-size:var(--ezap-text-sm);font-weight:var(--ezap-font-semibold)">Filtro: <span id="wcrm-abas-filter-name"></span></span>' +
        '<button id="wcrm-abas-clear-filter" class="ezap-btn ezap-btn--danger ezap-btn--sm">Limpar</button>' +
      '</div>' +
      '<div class="ezap-section-title" style="margin-bottom:8px">SUAS ABAS</div>' +
      '<div id="wcrm-abas-list"></div>' +
    '</div>';

  document.body.appendChild(sidebar);

  document.getElementById("wcrm-abas-close").addEventListener("click", toggleAbasSidebar);
  document.getElementById("wcrm-abas-create").addEventListener("click", openCreateAbaModal);
  document.getElementById("wcrm-abas-clear-filter").addEventListener("click", clearAbasFilter);

  // Register with sidebar manager
  if (window.ezapSidebar) {
    window.ezapSidebar.register('abas', {
      show: function() { abasSidebarOpen = true; document.getElementById("wcrm-abas-sidebar").classList.add("open"); },
      hide: function() { abasSidebarOpen = false; var sb = document.getElementById("wcrm-abas-sidebar"); if (sb) sb.classList.remove("open"); },
      onOpen: function() {
        loadAbasData().then(function(data) {
          renderAbasList(data);
          updateAbasIndicator();
        });
      }
    });
  }
}

// ===== Toggle =====
function toggleAbasSidebar() {
  if (window.ezapSidebar) { ezapSidebar.toggle('abas'); return; }
  // Fallback
  abasSidebarOpen = !abasSidebarOpen;
  var sb = document.getElementById("wcrm-abas-sidebar");
  if (abasSidebarOpen) sb.classList.add("open"); else sb.classList.remove("open");
  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();
  if (abasSidebarOpen) {
    loadAbasData().then(function(data) { renderAbasList(data); updateAbasIndicator(); });
  }
}

function closeAbasSidebar() {
  if (window.ezapSidebar) { ezapSidebar.close('abas'); return; }
  if (!abasSidebarOpen) return;
  abasSidebarOpen = false;
  var sb = document.getElementById("wcrm-abas-sidebar");
  if (sb) sb.classList.remove("open");
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

  var adminTabs = _adminAbas.map(function(a) {
    return { id: a.id, name: a.name, color: a.color || '#4d96ff', icon: a.icon || '', criteria: a.criteria || [], resolved_phones: a.resolved_phones || [], resolved_jids: a.resolved_jids || [], contacts: a.contacts || [], contactJids: a.contactJids || {}, isAdmin: true };
  });
  var userTabs = (data.tabs || []).map(function(t) {
    return Object.assign({}, t, { isAdmin: false });
  });

  if (adminTabs.length === 0 && userTabs.length === 0) {
    list.innerHTML = '<div class="ezap-empty">Nenhuma aba criada</div>';
    return;
  }

  var html = '';

  // === SEÇÃO: ABAS COMPARTILHADAS (admin) ===
  if (adminTabs.length > 0) {
    html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--ezap-text-secondary);font-weight:600;padding:0 4px;margin:4px 0 8px;display:flex;align-items:center;gap:6px">';
    html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
    html += 'ABAS Compartilhadas';
    html += '</div>';
    adminTabs.forEach(function(tab) {
      html += _renderSingleAbaItem(tab);
    });
  }

  // === SEÇÃO: MINHAS ABAS ===
  if (userTabs.length > 0) {
    if (adminTabs.length > 0) {
      html += '<hr style="border:none;border-top:1px solid var(--ezap-border);margin:12px 4px 8px">';
    }
    html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--ezap-text-secondary);font-weight:600;padding:0 4px;margin:4px 0 8px">Minhas Abas</div>';
    userTabs.forEach(function(tab) {
      html += _renderSingleAbaItem(tab);
    });
  }

  list.innerHTML = html;
  _wireAbaItemEvents(list);
}

function _renderSingleAbaItem(tab) {
  var isSelected = selectedAbaId === tab.id;
  var bgColor = isSelected ? tab.color + '30' : '#1a2730';
  var borderColor = isSelected ? tab.color : '#3b4a54';
  // Conta chats DISTINTOS (deduplica @lid/@c.us do mesmo contato, grupos pelo nome)
  // Usa window._ezapCountAbaChats se disponível (calculado via chatIndex)
  var count;
  if (typeof window._ezapCountAbaChats === 'function') {
    count = window._ezapCountAbaChats(tab);
  } else {
    count = (tab.contacts || []).length + (tab.isAdmin && tab.resolved_jids ? tab.resolved_jids.length : 0);
  }
  var html = '';

  html += '<div class="wcrm-aba-item ezap-aba-item" data-aba-id="' + tab.id + '" style="background:' + bgColor + ';border-color:' + borderColor + '">';
  html += '<div class="ezap-aba-header">';
  html += '<div class="ezap-aba-name">';
  // Se é admin aba e tem ícone, mostra ícone em vez do dot colorido
  if (tab.isAdmin && tab.icon) {
    html += '<span class="ezap-aba-icon" style="font-size:14px;line-height:1;margin-right:4px" title="ABA Compartilhada">' + tab.icon + '</span>';
  } else {
    html += '<span class="ezap-aba-color" style="background:' + tab.color + '"></span>';
    if (tab.isAdmin) html += '<span style="font-size:11px;opacity:0.5;margin-right:2px" title="Aba do admin">\uD83D\uDD12</span>';
  }
  html += '<span>' + tab.name + '</span>';
  if (isSelected) html += '<span style="color:' + tab.color + ';font-size:var(--ezap-text-sm)">&#10003;</span>';
  html += '</div>';
  html += '<div class="ezap-aba-actions">';
  html += '<span class="ezap-badge ezap-badge--muted">' + count + '</span>';
  if (count > 0) {
    html += '<button class="wcrm-aba-expand ezap-aba-action-icon" data-aba-id="' + tab.id + '" title="Ver contatos">&#9660;</button>';
  }
  html += '<button class="wcrm-aba-add-contacts ezap-aba-action-icon" data-aba-id="' + tab.id + '" title="Adicionar/Remover contatos" style="color:var(--ezap-success)">&#128101;</button>';
  if (!tab.isAdmin) {
    html += '<button class="wcrm-aba-edit ezap-aba-action-icon" data-aba-id="' + tab.id + '" title="Editar" style="color:var(--ezap-secondary)">&#9998;</button>';
    html += '<button class="wcrm-aba-delete ezap-aba-action-icon" data-aba-id="' + tab.id + '" title="Excluir" style="color:var(--ezap-danger)">&#128465;</button>';
  }
  html += '</div>';
  html += '</div>';

  if (count > 0) {
    html += '<div class="wcrm-aba-contacts-list" data-aba-id="' + tab.id + '" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--ezap-border)">';
    tab.contacts.forEach(function(contact, ci) {
      var displayName = contact.split(/\s*\|\s*/)[0].trim();
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0">';
      html += '<span style="color:var(--ezap-text-secondary);font-size:var(--ezap-text-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px">' + displayName + '</span>';
      if (!tab.isAdmin) {
        html += '<span class="wcrm-aba-remove-contact" data-aba-id="' + tab.id + '" data-contact-idx="' + ci + '" style="color:var(--ezap-danger);font-size:var(--ezap-text-xs);cursor:pointer;flex-shrink:0" title="Remover">&times;</span>';
      }
      html += '</div>';
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function _wireAbaItemEvents(list) {
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

  list.querySelectorAll('.wcrm-aba-add-contacts').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      openContactPickerModal(btn.dataset.abaId);
    });
  });

  list.querySelectorAll('.wcrm-aba-edit').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      openEditAbaModal(btn.dataset.abaId);
    });
  });

  list.querySelectorAll('.wcrm-aba-delete').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      deleteAba(btn.dataset.abaId);
    });
  });

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

    // Busca TODOS os chats do Store (incluindo arquivados) via store-bridge
    var getChats = window.ezapGetAllChats ? window.ezapGetAllChats({ force: true }) : Promise.resolve(null);
    return getChats.then(function(storeChats) {
    // allContacts: array de {name, jid} — fonte: Store bridge ou fallback DOM
    var allContacts = [];
    var _jidMap = {}; // name → jid (para salvar JIDs ao final)
    if (storeChats && storeChats.length) {
      // Todos os chats (DMs + grupos) ordenados por nome
      var seen = {};
      storeChats.forEach(function(c) {
        var name = (c.name || '').trim();
        if (!name || name.length < 2) return;
        var key = name.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        allContacts.push(name);
        _jidMap[key] = c.jid;
      });
      allContacts.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    } else {
      // Fallback: contatos do DOM (virtual scroll limitado)
      allContacts = getAllKnownContacts();
    }

    var selectedSet = {};
    (tab.contacts || []).forEach(function(c) { selectedSet[c.toLowerCase().trim()] = c; });

    var existing = document.getElementById("wcrm-contact-picker-overlay");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "wcrm-contact-picker-overlay";
    overlay.className = "escalada-crm ezap-overlay";

    var modal = document.createElement("div");
    modal.className = "ezap-modal";
    Object.assign(modal.style, {
      width: "460px",
      maxHeight: "80vh",
      display: "flex",
      flexDirection: "column",
    });

    modal.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">' +
        '<div>' +
          '<div class="ezap-modal-title" style="margin-bottom:4px">Adicionar/Remover contatos na aba</div>' +
          '<p style="margin:0;font-size:var(--ezap-text-base);color:var(--ezap-text-secondary)">Selecione os contatos para adicionar ou remover da aba</p>' +
        '</div>' +
        '<button id="wcrm-picker-close" class="ezap-header-close">&times;</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:12px">' +
        '<input id="wcrm-picker-search" class="ezap-input" type="text" placeholder="Pesquise por nome ou número do contato" style="flex:1">' +
        '<button id="wcrm-picker-select-all" class="ezap-btn ezap-btn--primary ezap-btn--sm" style="white-space:nowrap">Selecionar tudo</button>' +
      '</div>' +
      '<div id="wcrm-picker-list" style="flex:1;overflow-y:auto;border:1px solid var(--ezap-border);border-radius:var(--ezap-radius-md);max-height:50vh"></div>' +
      '<button id="wcrm-picker-save" class="ezap-btn ezap-btn--primary" style="margin-top:12px;align-self:center;padding-left:40px;padding-right:40px">Salvar</button>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function renderContactList(filter) {
      var listEl = document.getElementById("wcrm-picker-list");
      if (!listEl) return;
      var filterNorm = (typeof ezapNormalizeName === 'function') ? ezapNormalizeName(filter || "") : (filter || "").toLowerCase();
      var filtered = allContacts.filter(function(c) {
        if (!filterNorm) return true;
        var cNorm = (typeof ezapNormalizeName === 'function') ? ezapNormalizeName(c) : c.toLowerCase();
        return cNorm.includes(filterNorm);
      });

      var html = '';
      filtered.forEach(function(contact) {
        var isSelected = !!selectedSet[contact.toLowerCase().trim()];
        var checkColor = isSelected ? '#00a884' : '#ccc';
        var checkIcon = isSelected ? '&#10003;' : '';
        var displayName = contact.length > 45 ? contact.substring(0, 45) + '...' : contact;

        html += '<div class="wcrm-picker-item" data-contact="' + contact.replace(/"/g, '&quot;') + '" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--ezap-border);cursor:pointer;transition:background var(--ezap-transition-fast)">';
        html += '<span class="wcrm-picker-check" style="width:22px;height:22px;border-radius:50%;border:2px solid ' + checkColor + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;color:#fff;background:' + (isSelected ? 'var(--ezap-primary)' : 'transparent') + '">' + checkIcon + '</span>';
        html += '<span style="font-size:var(--ezap-text-base);color:var(--ezap-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + displayName + '</span>';
        html += '</div>';
      });

      if (filtered.length === 0) {
        html = '<div class="ezap-empty">Nenhum contato encontrado</div>';
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
      var filterVal = (typeof ezapNormalizeName === 'function') ? ezapNormalizeName(document.getElementById("wcrm-picker-search").value) : document.getElementById("wcrm-picker-search").value.toLowerCase();
      var filtered = allContacts.filter(function(c) {
        if (!filterVal) return true;
        var cNorm = (typeof ezapNormalizeName === 'function') ? ezapNormalizeName(c) : c.toLowerCase();
        return cNorm.includes(filterVal);
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
          // Popular contactJids com os JIDs do Store (evita resolução async posterior)
          if (!t.contactJids) t.contactJids = {};
          Object.keys(selectedSet).forEach(function(key) {
            var name = selectedSet[key];
            if (_jidMap[key]) {
              t.contactJids[name] = _jidMap[key];
            }
          });
          saveAbasData(latestData).then(function() {
            overlay.remove();
            if (abasSidebarOpen) renderAbasSidebar();
            applyConversationFilters();
          });
        }
      });
    });

    document.getElementById("wcrm-picker-search").focus();
    }); // fecha getChats.then
  });
}

// ===== Filter =====
function clearAbasFilter() {
  selectedAbaId = null;
  applyConversationFilters();
  if (abasSidebarOpen) renderAbasSidebar();
  updateAbasIndicator();
  injectQuickAbaSelector();
}

function updateAbasIndicator() {
  var indicator = document.getElementById("wcrm-abas-active-filter");
  var nameEl = document.getElementById("wcrm-abas-filter-name");
  if (indicator) {
    if (selectedAbaId) {
      var data = window._wcrmAbasCache || { tabs: [] };
      var tab = data.tabs.find(function(t) { return t.id === selectedAbaId; });
      if (!tab) tab = _adminAbas.find(function(a) { return a.id === selectedAbaId; });
      indicator.style.display = "flex";
      if (nameEl) nameEl.textContent = tab ? tab.name : selectedAbaId;
    } else {
      indicator.style.display = "none";
    }
  }

  var btn = document.getElementById("wcrm-abas-toggle");
  if (btn) {
    // Active state is managed by sidebar-manager (_highlightActiveButton)
    // Only add extra glow if a filter is active, don't remove the sidebar-managed .active
    var sidebarIsOpen = window.ezapSidebar && window.ezapSidebar.isOpen("abas");
    if (selectedAbaId || sidebarIsOpen) btn.classList.add("active"); else btn.classList.remove("active");
  }

  // Update quick aba selector active states
  injectQuickAbaSelector();
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
    color: '#00a884',
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
    pinBtn.style.background = isPinned ? (isDarkMode() ? '#00a88415' : '#00a88410') : 'transparent';
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
    background: '#8b5cf6',
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
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="#00a884"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg>';
    btn.style.background = isDarkMode() ? '#00a88415' : '#00a88410';
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
  dropdown.className = "escalada-crm ezap-dropdown";
  var minW = 200;
  var posStyle = isWidget
    ? { top: (rect.bottom + 12) + "px", left: Math.max(8, rect.left + (rect.width / 2) - (minW / 2)) + "px" }
    : { top: rect.top + "px", left: (rect.right + 8) + "px" };
  Object.assign(dropdown.style, {
    top: posStyle.top,
    left: posStyle.left,
    minWidth: minW + "px",
  });

  var html = '';
  if (!data.tabs || data.tabs.length === 0) {
    html += '<div class="ezap-empty">Nenhuma aba criada</div>';
  }
  data.tabs.forEach(function(tab) {
    var isIn = (tab.contacts || []).some(function(c) {
      return window.ezapMatchContact && window.ezapMatchContact(c, chatName);
    });
    var icon = isIn ? '&#10003;' : '&plus;';
    var iconColor = isIn ? tab.color : 'var(--ezap-text-secondary)';
    html += '<div class="wcrm-header-aba-opt ezap-dropdown-item" data-aba-id="' + tab.id + '">';
    html += '<span class="ezap-aba-color" style="background:' + tab.color + ';width:10px;height:10px"></span>';
    html += '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + tab.name + '</span>';
    html += '<span style="color:' + iconColor + ';font-size:14px;font-weight:bold">' + icon + '</span>';
    html += '</div>';
  });
  // Divider + "Criar nova aba"
  html += '<div class="ezap-dropdown-divider"></div>';
  html += '<div id="wcrm-header-abas-create" class="ezap-dropdown-item">';
  html += '<span style="color:var(--ezap-success);font-size:16px;font-weight:bold;width:10px;display:inline-block;text-align:center">+</span>';
  html += '<span style="font-weight:var(--ezap-font-medium)">Criar nova aba</span>';
  html += '</div>';

  dropdown.innerHTML = html;
  document.body.appendChild(dropdown);

  // Hover effects
  dropdown.querySelectorAll('.wcrm-header-aba-opt').forEach(function(el) {
    el.addEventListener('click', function() {
      toggleContactInAba(el.dataset.abaId, chatName);
      dropdown.remove();
    });
  });
  var createBtn = document.getElementById("wcrm-header-abas-create");
  if (createBtn) {
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
  overlay.className = "escalada-crm ezap-overlay";

  var modal = document.createElement("div");
  modal.className = "ezap-modal";
  modal.style.width = "340px";

  var selectedColor = editTab ? editTab.color : ABAS_COLORS[0];

  var colorsHtml = '';
  ABAS_COLORS.forEach(function(c) {
    var sel = c === selectedColor;
    colorsHtml += '<span class="wcrm-aba-color-opt ezap-color-dot' + (sel ? ' selected' : '') + '" data-color="' + c + '" style="width:28px;height:28px;background:' + c + '"></span>';
  });

  modal.innerHTML =
    '<div class="ezap-modal-title">' + (editTab ? 'Editar Aba' : 'Criar Aba') + '</div>' +
    '<input id="wcrm-aba-name-input" class="ezap-input" type="text" placeholder="Nome da aba..." maxlength="30" value="' + (editTab ? editTab.name : '') + '" style="margin-bottom:12px">' +
    '<div class="ezap-section-title" style="margin-bottom:6px">COR</div>' +
    '<div id="wcrm-aba-color-picker" class="ezap-color-picker" style="margin-bottom:20px">' + colorsHtml + '</div>' +
    '<div style="display:flex;gap:8px">' +
      '<button id="wcrm-aba-modal-cancel" class="ezap-btn ezap-btn--ghost" style="flex:1;border:1px solid var(--ezap-border-light)">Cancelar</button>' +
      '<button id="wcrm-aba-modal-save" class="ezap-btn ezap-btn--accent" style="flex:1">' + (editTab ? 'Salvar' : 'Criar') + '</button>' +
    '</div>';

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  var pickerEl = document.getElementById("wcrm-aba-color-picker");
  pickerEl.querySelectorAll('.wcrm-aba-color-opt').forEach(function(dot) {
    dot.addEventListener('click', function() {
      selectedColor = dot.dataset.color;
      pickerEl.querySelectorAll('.wcrm-aba-color-opt').forEach(function(d) {
        d.classList.remove('selected');
      });
      dot.classList.add('selected');
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
  if (isAdminAba(abaId)) {
    alert('Esta aba foi criada pelo administrador e não pode ser excluída.');
    return;
  }
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

// ===== Quick Aba Selector (injected above WA chat list) =====
function _truncateAbaName(name, max) {
  max = max || 15;
  if (!name || name.length <= max) return name;
  return name.substring(0, max).replace(/\s+$/, '') + '\u2026';
}

function injectQuickAbaSelector() {
  var pane = document.getElementById('pane-side');
  if (!pane) return;

  // Se overlay esta ativo, as pills ficam dentro do header do overlay (slice.js)
  // Nao precisa da barra externa que fica escondida atras do overlay
  var overlayEl = document.getElementById('wcrm-custom-list');
  if (overlayEl && overlayEl.style.display !== 'none' && window.__ezapOverlayEnabled) {
    var old2 = document.getElementById('wcrm-quick-aba-bar');
    if (old2) old2.remove();
    return;
  }

  var data = window._wcrmAbasCache || { tabs: [] };
  if (!data.tabs || data.tabs.length === 0) {
    var old = document.getElementById('wcrm-quick-aba-bar');
    if (old) old.remove();
    return;
  }

  var t = (typeof getTheme === 'function') ? getTheme() : {
    bg: '#111b21', bgSecondary: '#202c33', bgHover: '#2a3942',
    text: '#e9edef', textSecondary: '#8696a0', border: '#2a3942',
    headerBg: '#202c33'
  };

  var existing = document.getElementById('wcrm-quick-aba-bar');

  // Build pills HTML using CSS classes
  var pillsHtml = '';
  data.tabs.forEach(function(tab) {
    var isActive = selectedAbaId === tab.id;
    var count = (tab.contacts || []).length;
    var displayName = _truncateAbaName(tab.name, 15);
    // Active pill gets background color + .active class; inactive uses CSS defaults
    var activeStyle = isActive ? 'background:' + tab.color + ';border-color:' + tab.color + ';' : '';
    pillsHtml +=
      '<button class="wcrm-quick-aba-pill' + (isActive ? ' active' : '') + '" data-aba-id="' + tab.id + '" title="' + tab.name + '"' +
        (activeStyle ? ' style="' + activeStyle + '"' : '') + '>' +
        '<span class="ezap-pill-dot" style="background:' + (isActive ? '#fff' : tab.color) + '"></span>' +
        '<span>' + displayName + '</span>' +
        '<span class="ezap-pill-count">' + count + '</span>' +
      '</button>';
  });

  var barHtml =
    '<div style="display:flex;align-items:center;position:relative">' +
      '<button class="wcrm-quick-aba-arrow wcrm-quick-aba-arrow-left">&#9664;</button>' +
      '<div class="wcrm-quick-aba-scroll">' +
        pillsHtml +
      '</div>' +
      '<button class="wcrm-quick-aba-arrow wcrm-quick-aba-arrow-right">&#9654;</button>' +
    '</div>';

  // Preserve scroll position across re-renders
  var savedScroll = 0;
  if (existing) {
    var oldScroll = existing.querySelector('.wcrm-quick-aba-scroll');
    if (oldScroll) savedScroll = oldScroll.scrollLeft;
    existing.innerHTML = barHtml;
    existing.style.background = t.headerBg;
    // Restore scroll position
    var newScroll = existing.querySelector('.wcrm-quick-aba-scroll');
    if (newScroll && savedScroll > 0) newScroll.scrollLeft = savedScroll;
  } else {
    var bar = document.createElement('div');
    bar.id = 'wcrm-quick-aba-bar';
    bar.style.cssText = 'background:' + t.headerBg + ';';
    bar.innerHTML = barHtml;

    // Inject before the scrollable chat list container
    var chatContainer = null;
    var grid = pane.querySelector('[role="grid"]') || pane.querySelector('[role="list"]') || pane.querySelector('[role="listbox"]');
    if (grid) {
      var cur = grid;
      while (cur && cur !== pane) {
        try {
          var cs = getComputedStyle(cur);
          if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
            chatContainer = cur;
            break;
          }
        } catch(e) {}
        cur = cur.parentElement;
      }
    }

    if (chatContainer && chatContainer.parentNode) {
      chatContainer.parentNode.insertBefore(bar, chatContainer);
    } else {
      var firstChild = pane.querySelector('div');
      if (firstChild) {
        var headers = pane.querySelectorAll('header');
        var lastHeader = headers.length > 0 ? headers[headers.length - 1] : null;
        if (lastHeader && lastHeader.parentNode) {
          lastHeader.parentNode.insertBefore(bar, lastHeader.nextSibling);
        } else {
          pane.insertBefore(bar, pane.firstChild);
        }
      } else {
        pane.appendChild(bar);
      }
    }

    _injectQuickAbaCSS();
  }

  // Arrow navigation + visibility
  var scrollEl = document.querySelector('#wcrm-quick-aba-bar .wcrm-quick-aba-scroll');
  var arrowLeft = document.querySelector('#wcrm-quick-aba-bar .wcrm-quick-aba-arrow-left');
  var arrowRight = document.querySelector('#wcrm-quick-aba-bar .wcrm-quick-aba-arrow-right');

  if (scrollEl && arrowLeft && arrowRight) {
    var _updateArrows = function() {
      var hasOverflow = scrollEl.scrollWidth > scrollEl.clientWidth + 2;
      var atStart = scrollEl.scrollLeft <= 2;
      var atEnd = scrollEl.scrollLeft + scrollEl.clientWidth >= scrollEl.scrollWidth - 2;
      arrowLeft.style.display = (hasOverflow && !atStart) ? 'flex' : 'none';
      arrowRight.style.display = (hasOverflow && !atEnd) ? 'flex' : 'none';
    };
    _updateArrows();
    scrollEl.addEventListener('scroll', _updateArrows);

    arrowLeft.addEventListener('click', function(e) {
      e.stopPropagation();
      scrollEl.scrollBy({ left: -120, behavior: 'smooth' });
    });
    arrowRight.addEventListener('click', function(e) {
      e.stopPropagation();
      scrollEl.scrollBy({ left: 120, behavior: 'smooth' });
    });
  }

  // Bind pill click events
  var pills = document.querySelectorAll('#wcrm-quick-aba-bar .wcrm-quick-aba-pill');
  pills.forEach(function(pill) {
    pill.addEventListener('click', function(e) {
      e.stopPropagation();
      var abaId = pill.dataset.abaId;
      if (selectedAbaId === abaId) {
        clearAbasFilter();
      } else {
        selectedAbaId = abaId;
        applyConversationFilters();
        if (abasSidebarOpen) renderAbasSidebar();
        updateAbasIndicator();
      }
      injectQuickAbaSelector();
    });
  });
}

function _injectQuickAbaCSS() {
  if (document.getElementById('wcrm-quick-aba-css')) return;
  var style = document.createElement('style');
  style.id = 'wcrm-quick-aba-css';
  style.textContent = '';  // Styles now in sidebar.css
  document.head.appendChild(style);
}

// ===== Boot Pin Retry Loop =====
// Tenta aplicar pins ate 8x a cada 1200ms. Garante que o observer fique
// vivo mesmo se container demorar a existir ou pins nao estiverem no viewport.
function _bootPinRetryLoop() {
  var maxTries = 8;
  var interval = 1200;
  var attempt = 0;
  var observerAlive = false;

  var tick = function() {
    attempt++;
    var container = findChatListContainer();
    if (!container) {
      if (attempt === 1 || attempt === maxTries) {
        console.log("[WCRM PIN] Boot retry #" + attempt + ": container nao encontrado");
      }
      if (attempt < maxTries) setTimeout(tick, interval);
      return;
    }
    // Container existe — garante observer antes de qualquer reorder
    try { ensurePinObserver(); observerAlive = true; } catch(e) {}
    applyPinnedOrder();
    var pinnedNames = Object.keys(window._wcrmPinned || {});
    var pinsVisible = document.querySelectorAll('.wcrm-pin-icon').length;
    if (attempt === 1) {
      console.log("[WCRM PIN] Boot retry #1: container OK, observer ativo, pins=" + pinnedNames.length + ", visible=" + pinsVisible);
    }
    // Para se observer ta vivo E tem pelo menos 1 pin visivel
    // (ou nao tem pins pra aplicar)
    if (pinnedNames.length === 0) return;
    if (pinsVisible > 0) {
      console.log("[WCRM PIN] Boot done em retry #" + attempt + ": " + pinsVisible + " pins visiveis");
      return;
    }
    if (attempt < maxTries) {
      setTimeout(tick, interval);
    } else {
      console.log("[WCRM PIN] Boot retry esgotou (" + maxTries + "x). Observer continua vivo=" + observerAlive);
    }
  };
  setTimeout(tick, 800);
}

// ===== Init =====
function initAbas() {
  var abasEnabled = window.__ezapAbasEnabled !== false;
  var pinEnabled = window.__ezapPinEnabled !== false;

  if (abasEnabled) {
    createAbasButton();
    createAbasSidebar();
    loadAbasData().then(function() {
      // Inject quick selector after data is loaded
      injectQuickAbaSelector();
    });
    loadAdminAbas();
    loadKnownContacts();
  }

  if (pinEnabled) {
    loadPinnedContacts().then(function() {
      _bootPinRetryLoop();
    });
  }

  // Tenta migrar JIDs assim que o store-bridge ficar pronto.
  // (Pins e contatos de aba antigos nao tem JID - resolve preguicosamente.)
  setTimeout(migrateJidsWhenStoreReady, 5000);

  // Overlay activation: if overlay is enabled and no ABA filter is active,
  // apply the overlay after store-bridge has time to populate chatIndex
  setTimeout(function() {
    var overlayEnabled = window.__ezapOverlayEnabled === true;
    var hasAbaFilter = typeof selectedAbaId !== 'undefined' && selectedAbaId !== null;
    if (overlayEnabled && !hasAbaFilter && typeof window._wcrmApplyOverlay === 'function') {
      console.log("[WCRM ABAS] Activating overlay on boot");
      window._wcrmApplyOverlay();
    }
  }, 3000);

  var abasInterval = setInterval(function() {
    if (!isExtensionValid()) {
      clearInterval(abasInterval);
      console.log("[WCRM ABAS] Extension context invalidated, stopping interval");
      return;
    }
    injectSidebarButtons();
    if (abasEnabled) injectQuickAbaSelector();
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
