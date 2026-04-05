// ===== WhatsApp CRM - Conversation Filter Engine =====
// Shared filter engine used by ABAS (and historically SLICE).
// Applies display filters to the WA Web chat list (virtual scroll aware).
console.log("[WCRM FILTER] Loaded");

var filterObserver = null;

// ===== Inject CSS to override WhatsApp's virtual scroll positioning =====
function injectFilterCSS() {
  if (document.getElementById('wcrm-filter-css')) return;
  var style = document.createElement('style');
  style.id = 'wcrm-filter-css';
  style.textContent =
    '.wcrm-filter-active { height: auto !important; }' +
    '.wcrm-filter-active > * { position: relative !important; transform: none !important; top: auto !important; }' +
    '.wcrm-filter-active > .wcrm-hidden { display: none !important; }';
  document.head.appendChild(style);
}

// ===== Find the chat list container =====
function findChatListContainer() {
  var pane = document.getElementById('pane-side');
  if (!pane) return null;

  // Try ARIA selectors first
  var container = pane.querySelector('[role="grid"]') ||
                  pane.querySelector('[role="list"]') ||
                  pane.querySelector('[role="listbox"]') ||
                  pane.querySelector('[aria-label*="conversa"]') ||
                  pane.querySelector('[aria-label*="chat"]');

  if (container && container.children.length > 2) return container;

  // Fallback: find the div with the most children (the virtual scroll list)
  var best = null;
  var bestCount = 0;
  var divs = pane.querySelectorAll('div');
  for (var i = 0; i < divs.length; i++) {
    var d = divs[i];
    if (d.children.length > bestCount) {
      bestCount = d.children.length;
      best = d;
    }
  }

  return bestCount > 2 ? best : null;
}

// ===== Apply ABAS filter =====
function applyConversationFilters() {
  // Constroi o index do Store (JID por nome) antes de rodar o filtro sync.
  // Se o store-bridge estiver pronto, casamos contatos por JID - assim
  // contatos fora do virtual scroll viewport sao detectados pela aba.
  if (window.ezapBuildChatIndex) {
    window.ezapBuildChatIndex().then(function(idx) { _runFiltersSync(idx); });
  } else {
    _runFiltersSync(null);
  }
}

function _runFiltersSync(chatIndex) {
  injectFilterCSS();

  var container = findChatListContainer();
  if (!container) {
    console.log("[WCRM FILTER] Chat list container not found");
    return;
  }

  var hasAbasFilter = typeof selectedAbaId !== 'undefined' && selectedAbaId !== null;

  console.log("[WCRM FILTER] Applying. Rows:", container.children.length, "ABAS:", selectedAbaId, "JID-index:", !!chatIndex);

  if (!hasAbasFilter) {
    // Remove all filter overrides — let WhatsApp restore normal layout
    container.classList.remove('wcrm-filter-active');
    var hiddenItems = container.querySelectorAll('.wcrm-hidden');
    for (var j = 0; j < hiddenItems.length; j++) {
      hiddenItems[j].classList.remove('wcrm-hidden');
    }
    // Remove synthetic rows
    var synthGone = container.querySelectorAll('.wcrm-synth-row');
    for (var sg = 0; sg < synthGone.length; sg++) synthGone[sg].parentNode.removeChild(synthGone[sg]);
    // Nudge scroll to force WhatsApp to re-render virtual list
    var scrollParent = container.parentElement;
    if (scrollParent) {
      var pos = scrollParent.scrollTop;
      scrollParent.scrollTop = pos + 1;
      setTimeout(function() { scrollParent.scrollTop = pos; }, 50);
    }
    // Re-apply pin order if there are pinned contacts
    if (typeof applyPinnedOrder === 'function') {
      setTimeout(function() { applyPinnedOrder(); }, 100);
    }
    setupFilterObserver();
    return;
  }

  // Pre-computa JIDs do filtro ABAS pra matching sync no loop.
  // Fonte da verdade: tab.contactJids (salvo ao adicionar) + resolucao
  // lazy via chatIndex (pra contatos antigos sem JID).
  var abaJidSet = {};
  var abaJidToName = {};  // mapa JID -> nome salvo (pra sintetizar row)
  var abaNamesFallback = [];
  var tabEntry = _getAbaTabEntry(selectedAbaId);
  var tabContacts = (tabEntry && tabEntry.contacts) || [];
  var tabJids = (tabEntry && tabEntry.contactJids) || {};
  var resolvedCount = 0;
  tabContacts.forEach(function(n) {
    var jid = tabJids[n];
    if (!jid && chatIndex && window.ezapFindJidInIndex) {
      jid = window.ezapFindJidInIndex(chatIndex, n);
    }
    if (jid) { abaJidSet[jid] = true; abaJidToName[jid] = n; resolvedCount++; }
    else abaNamesFallback.push(n);
  });

  console.log("[WCRM FILTER] ABAS contacts:", tabContacts, "JIDs resolvidos:", resolvedCount + "/" + tabContacts.length);
  if (chatIndex) console.log("[WCRM FILTER] Store bridge ready. Total no Store:", chatIndex.chats.length);
  else console.log("[WCRM FILTER] Store bridge NAO pronto - match por nome (DOM-dependent)");
  if (abaNamesFallback.length > 0) {
    console.log("[WCRM FILTER] Contatos sem JID (usando match por nome):", abaNamesFallback);
  }

  // Pre-computa JIDs dos pins (mesma logica)
  var pinJidSet = {};
  var pinJids = window._wcrmPinnedJids || {};
  Object.keys(pinJids).forEach(function(n) { if (pinJids[n]) pinJidSet[pinJids[n]] = true; });
  var pinned = (typeof window._wcrmPinned !== 'undefined') ? window._wcrmPinned : {};

  // Enable filter mode: override virtual scroll to normal flow
  container.classList.add('wcrm-filter-active');

  // Remove synthetic rows de rodadas anteriores antes de reiterar
  var oldSynth = container.querySelectorAll('.wcrm-synth-row');
  for (var ss = 0; ss < oldSynth.length; ss++) oldSynth[ss].parentNode.removeChild(oldSynth[ss]);

  var pinnedRows = [];
  var unpinnedRows = [];
  var matchedJids = {};  // JIDs que ja foram matchados via row DOM
  var matchedNames = {}; // nomes (fallback) que ja foram matchados

  for (var i = 0; i < container.children.length; i++) {
    var row = container.children[i];
    // Nao re-processa synthetic rows
    if (row.classList && row.classList.contains('wcrm-synth-row')) continue;
    var nameSpan = row.querySelector('span[title]');

    if (!nameSpan) {
      row.classList.add('wcrm-hidden');
      continue;
    }

    var title = nameSpan.getAttribute('title') || '';
    if (!title) { row.classList.add('wcrm-hidden'); continue; }

    // Resolve JID da row (uma vez) via index
    var rowJid = (chatIndex && window.ezapFindJidInIndex) ? window.ezapFindJidInIndex(chatIndex, title) : null;

    var show = true;

    // ABAS filter
    var found = false;
    if (rowJid && abaJidSet[rowJid]) { found = true; matchedJids[rowJid] = true; }
    if (!found && abaNamesFallback.length > 0) {
      // Fallback nome tolerante (apenas contatos que nao tinham JID)
      var matchedName = null;
      var isMatch = abaNamesFallback.some(function(c) {
        if (window.ezapMatchContact(c, title)) { matchedName = c; return true; }
        return false;
      });
      if (isMatch) { found = true; matchedNames[matchedName] = true; }
    }
    if (!found) show = false;

    if (show) {
      row.classList.remove('wcrm-hidden');
      // Pin match: JID first, fallback nome tolerante
      var isPinnedRow = false;
      if (rowJid && pinJidSet[rowJid]) isPinnedRow = true;
      else isPinnedRow = Object.keys(pinned).some(function(pn) {
        return window.ezapMatchContact(pn, title);
      });
      if (isPinnedRow) {
        pinnedRows.push(row);
        if (typeof addPinIndicator === 'function') addPinIndicator(nameSpan);
      } else {
        unpinnedRows.push(row);
        if (typeof removePinIndicator === 'function') removePinIndicator(nameSpan);
      }
    } else {
      row.classList.add('wcrm-hidden');
    }
  }

  // Sintetiza rows pros contatos da aba que NAO estao na DOM
  // (fora do viewport do virtual scroll). Isso resolve o 4-de-5.
  var synthRows = [];
  Object.keys(abaJidSet).forEach(function(jid) {
    if (matchedJids[jid]) return;
    var name = abaJidToName[jid] || jid;
    var isPinnedSynth = !!pinJidSet[jid];
    var synthRow = _createSyntheticRow(name, jid, isPinnedSynth);
    synthRows.push({ row: synthRow, pinned: isPinnedSynth });
  });
  // Tambem sintetiza pros contatos sem JID (fallback por nome) que nao matcharam
  abaNamesFallback.forEach(function(n) {
    if (matchedNames[n]) return;
    var isPinnedSynth = Object.keys(pinned).some(function(pn) { return window.ezapMatchContact(pn, n); });
    var synthRow = _createSyntheticRow(n, null, isPinnedSynth);
    synthRows.push({ row: synthRow, pinned: isPinnedSynth });
  });

  // Appenda synth rows: pinned no topo, nao-pinned no final
  synthRows.forEach(function(s) {
    container.appendChild(s.row);
    if (s.pinned) pinnedRows.push(s.row);
  });

  if (synthRows.length > 0) {
    console.log("[WCRM FILTER] Adicionou", synthRows.length, "rows sinteticas (contatos fora do virtual scroll)");
  }

  // Reorder: pinned contacts first
  if (pinnedRows.length > 0) {
    pinnedRows.forEach(function(row) {
      container.insertBefore(row, container.firstChild);
    });
  }

  setupFilterObserver();
}

// Cria uma row sintetica pra contato que nao esta no virtual scroll.
// Estilo visual aproximado de uma row do WA (avatar placeholder + nome).
// Click abre o chat via ezapOpenChat.
function _createSyntheticRow(name, jid, isPinned) {
  var row = document.createElement('div');
  row.className = 'wcrm-synth-row';
  row.setAttribute('data-ezap-jid', jid || '');
  row.setAttribute('data-ezap-name', name || '');
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 15px',
    height: '72px',
    boxSizing: 'border-box',
    borderBottom: '1px solid rgba(134,150,160,0.15)',
    cursor: 'pointer',
    background: 'transparent',
    transition: 'background 0.15s'
  });
  row.addEventListener('mouseenter', function() { row.style.background = 'rgba(42,57,66,0.5)'; });
  row.addEventListener('mouseleave', function() { row.style.background = 'transparent'; });

  // Avatar placeholder (circulo cinza com inicial)
  var avatar = document.createElement('div');
  var initial = (name || '?').trim().charAt(0).toUpperCase();
  Object.assign(avatar.style, {
    width: '49px',
    height: '49px',
    borderRadius: '50%',
    background: '#6b7c85',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '20px',
    fontWeight: '600',
    flexShrink: '0',
    marginRight: '15px'
  });
  avatar.textContent = initial;
  row.appendChild(avatar);

  // Nome + indicador
  var info = document.createElement('div');
  Object.assign(info.style, { flex: '1', minWidth: '0', display: 'flex', alignItems: 'center' });
  var nameEl = document.createElement('span');
  nameEl.setAttribute('title', name || '');
  Object.assign(nameEl.style, {
    color: '#e9edef',
    fontSize: '15px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: '1'
  });
  nameEl.textContent = name || '';
  info.appendChild(nameEl);

  if (isPinned) {
    var pinIcon = document.createElement('span');
    pinIcon.className = 'wcrm-pin-icon';
    pinIcon.textContent = '📌';
    Object.assign(pinIcon.style, { fontSize: '12px', marginLeft: '6px', flexShrink: '0' });
    info.appendChild(pinIcon);
  }

  var subtitle = document.createElement('span');
  Object.assign(subtitle.style, {
    color: '#8696a0',
    fontSize: '11px',
    fontStyle: 'italic',
    marginLeft: '8px',
    flexShrink: '0'
  });
  subtitle.textContent = 'fora do scroll';
  info.appendChild(subtitle);

  row.appendChild(info);

  // Click handler: abre o chat via ezapOpenChat
  row.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.ezapOpenChat) {
      console.warn("[WCRM FILTER] ezapOpenChat nao disponivel");
      return;
    }
    var lockedJid = row.getAttribute('data-ezap-jid');
    var lockedName = row.getAttribute('data-ezap-name');
    window.ezapOpenChat(lockedJid, lockedName).then(function(result) {
      console.log("[WCRM FILTER] openChat result:", result);
      if (!result || !result.ok) {
        console.warn("[WCRM FILTER] Nao consegui abrir o chat:", result);
      }
    });
  });

  return row;
}

function setupFilterObserver() {
  if (filterObserver) { try { filterObserver.disconnect(); } catch(e) {} filterObserver = null; }

  var hasAnyFilter = (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null);
  if (!hasAnyFilter) return;

  // CRITICAL: observe o container da lista (direct children only).
  // Usar pane-side com subtree:true captura todas mudancas do WA
  // (typing, presence, reordering) + nossas proprias mudancas de class
  // -> loop infinito que trava a UI.
  var container = findChatListContainer();
  if (!container) return;

  filterObserver = new MutationObserver(function(mutations) {
    // Ignora mutations que sao so nossas (wcrm-hidden / wcrm-filter-active)
    var ourClassesOnly = mutations.every(function(m) {
      if (m.type !== 'attributes') return false;
      if (m.attributeName !== 'class') return false;
      return true; // e attr change de class, quase certeza que e nossa
    });
    if (ourClassesOnly) return;
    // Precisa ser mudanca estrutural (children adicionados/removidos)
    var structural = mutations.some(function(m) {
      return m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0);
    });
    if (!structural) return;
    clearTimeout(filterObserver._debounce);
    filterObserver._debounce = setTimeout(applyConversationFilters, 500);
  });

  filterObserver.observe(container, { childList: true, subtree: false });
}

// Helper for ABAS (defined here so it's available; abas.js populates the data)
function getAbaContacts(abaId) {
  var data = window._wcrmAbasCache;
  if (!data || !data.tabs) return null;
  var tab = data.tabs.find(function(t) { return t.id === abaId; });
  return tab ? tab.contacts : null;
}

// Retorna a tab completa (com contacts + contactJids), pra filtros fazerem JID-match
function _getAbaTabEntry(abaId) {
  var data = window._wcrmAbasCache;
  if (!data || !data.tabs) return null;
  return data.tabs.find(function(t) { return t.id === abaId; }) || null;
}
