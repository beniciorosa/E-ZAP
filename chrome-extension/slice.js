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

// ===== Apply ABAS filter (Plano B - custom list) =====
// ABA ativa: esconde lista nativa do WA e renderiza nossa custom list.
// ABA inativa: restaura lista nativa + limpa filter-active/hidden/synth.
function applyConversationFilters() {
  var hasAbasFilter = typeof selectedAbaId !== 'undefined' && selectedAbaId !== null;
  var overlayEnabled = window.__ezapOverlayEnabled === true;
  var runLegacyCleanup = function(idx) { _hideCustomAbaList(); _stopCustomListPolling(); _runFiltersSync(idx); };
  var runCustom = function(idx) {
    var tab = _getAbaTabEntry(selectedAbaId);
    if (!tab) { runLegacyCleanup(idx); return; }
    var container = findChatListContainer();
    if (container) {
      container.classList.remove('wcrm-filter-active');
      var hidden = container.querySelectorAll('.wcrm-hidden');
      for (var h = 0; h < hidden.length; h++) hidden[h].classList.remove('wcrm-hidden');
      var synth = container.querySelectorAll('.wcrm-synth-row');
      for (var s = 0; s < synth.length; s++) synth[s].parentNode.removeChild(synth[s]);
    }
    _showCustomAbaList(tab, idx);
    _startCustomListPolling();
  };
  var runOverlay = function(idx) {
    _showCustomAbaList(null, idx);
    _startCustomListPolling();
  };
  if (window.ezapBuildChatIndex) {
    window.ezapBuildChatIndex(hasAbasFilter || overlayEnabled ? { force: true } : null).then(function(idx) {
      if (hasAbasFilter) runCustom(idx);
      else if (overlayEnabled) runOverlay(idx);
      else runLegacyCleanup(idx);
    });
  } else {
    if (hasAbasFilter) runCustom(null);
    else if (overlayEnabled) runOverlay(null);
    else runLegacyCleanup(null);
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

  // Force scroll to top: garante que WA renderize as primeiras rows
  // (fundamental para contatos no topo da lista aparecerem)
  var scrollParent = container.parentElement;
  if (scrollParent && scrollParent.scrollTop > 0) {
    scrollParent.scrollTop = 0;
  }

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

  // Reorder: pinned contacts first.
  // Usa DocumentFragment p/ mover todas as pinned rows atomicamente,
  // preservando a ordem relativa entre elas. Isso e mais robusto que
  // insertBefore em loop (que inverte ordem) e evita race com o
  // virtual scroll do WA re-renderizando entre as inseerts.
  if (pinnedRows.length > 0) {
    // Skip DOM move se pins ja estao nas primeiras posicoes (evita loop
    // com o MutationObserver).
    var alreadyOrdered = true;
    for (var po = 0; po < pinnedRows.length; po++) {
      if (container.children[po] !== pinnedRows[po]) { alreadyOrdered = false; break; }
    }
    if (!alreadyOrdered) {
      var frag = document.createDocumentFragment();
      pinnedRows.forEach(function(r) { frag.appendChild(r); });
      container.insertBefore(frag, container.firstChild);
      var firstName = '?';
      try {
        var firstEl = container.firstElementChild;
        var ftitle = firstEl && firstEl.querySelector && firstEl.querySelector('span[title]');
        if (ftitle) firstName = ftitle.getAttribute('title') || '?';
        else if (firstEl && firstEl.getAttribute) firstName = firstEl.getAttribute('data-ezap-name') || '?';
      } catch (e) {}
      console.log("[WCRM FILTER] Moveu", pinnedRows.length, "pinned rows pro topo. Primeira row agora:", firstName);
    }
  }

  setupFilterObserver();
}

// ===== PLANO B: Custom List (v1.8.25 - resgatado + tempo real) =====
// Quando a ABA esta ativa, esconde a lista do WA e renderiza nossa
// propria lista com os contatos da aba. Zero dependencia de virtual scroll.
// Polling de 3s atualiza unread/timestamp/preview de mensagem em tempo real.
// Click abre conversa via store-bridge (Store.Chat) ou search bar fallback.
// Guarda ultimo tema aplicado pra detectar mudanca
var _wcrmLastThemeMode = null;

// Helper: retorna cor de texto ideal (branco ou escuro) baseado na luminosidade do fundo
function _pillTextColor(bgHex) {
  if (!bgHex || bgHex.charAt(0) !== '#') return '#fff';
  var hex = bgHex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  var r = parseInt(hex.substring(0, 2), 16);
  var g = parseInt(hex.substring(2, 4), 16);
  var b = parseInt(hex.substring(4, 6), 16);
  // Luminancia relativa (formula W3C)
  var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? '#1a1a1a' : '#ffffff';
}
// Helper: escurece cor hex por fator (0-1)
function _darkenColor(hex, factor) {
  if (!hex || hex.charAt(0) !== '#') return hex;
  var h = hex.replace('#', '');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  var r = Math.max(0, Math.round(parseInt(h.substring(0, 2), 16) * (1 - factor)));
  var g = Math.max(0, Math.round(parseInt(h.substring(2, 4), 16) * (1 - factor)));
  var b = Math.max(0, Math.round(parseInt(h.substring(4, 6), 16) * (1 - factor)));
  return '#' + ('0'+r.toString(16)).slice(-2) + ('0'+g.toString(16)).slice(-2) + ('0'+b.toString(16)).slice(-2);
}

// Cache de labels/etiquetas: contact_key -> { labels: [{name, color}] }
var _wcrmLabelsCache = {};
function _loadLabelsCache() {
  try {
    chrome.storage.local.get('wcrm_labels', function(data) {
      _wcrmLabelsCache = (data && data.wcrm_labels) || {};
      console.log('[WCRM LABELS] Cache loaded:', Object.keys(_wcrmLabelsCache).length, 'contacts');
    });
  } catch(e) {}
}
// Carrega labels ao inicializar
_loadLabelsCache();
// Recarrega quando labels mudam (content.js salva)
try {
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area === 'local' && changes.wcrm_labels) {
      _wcrmLabelsCache = changes.wcrm_labels.newValue || {};
    }
  });
} catch(e) {}

// Retorna labels de um contato pelo JID
function _getLabelsForJid(jid) {
  if (!jid || !_wcrmLabelsCache) return [];
  // Extrai digitos do JID (ex: 5511999887766@c.us -> 5511999887766)
  var digits = jid.replace(/@.*$/, '').replace(/\D/g, '');
  if (!digits) return [];
  // Tenta match exato
  if (_wcrmLabelsCache[digits] && _wcrmLabelsCache[digits].labels) {
    return _wcrmLabelsCache[digits].labels;
  }
  // Tenta match parcial (chaves podem ter formato diferente)
  var keys = Object.keys(_wcrmLabelsCache);
  for (var i = 0; i < keys.length; i++) {
    var keyDigits = keys[i].replace(/\D/g, '');
    if (keyDigits && keyDigits.length >= 8 && (digits.indexOf(keyDigits) >= 0 || keyDigits.indexOf(digits) >= 0)) {
      if (_wcrmLabelsCache[keys[i]] && _wcrmLabelsCache[keys[i]].labels) {
        return _wcrmLabelsCache[keys[i]].labels;
      }
    }
  }
  return [];
}

// Constroi a row de pills das abas (reutilizado em overlay e aba mode)
function _buildAbaPillsRow(theme) {
  var t = theme;
  var _abasData = window._wcrmAbasCache || { tabs: [] };
  if (!_abasData.tabs || _abasData.tabs.length === 0) return null;

  var abaRow = document.createElement('div');
  abaRow.id = 'ezap-overlay-aba-row';
  abaRow.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 0;';

  // Seta esquerda
  var arrowL = document.createElement('button');
  arrowL.className = 'ezap-aba-arrow ezap-aba-arrow-l';
  arrowL.innerHTML = '&#9664;';
  arrowL.style.cssText = 'display:none;align-items:center;justify-content:center;background:none;border:none;color:' + t.textSecondary + ';cursor:pointer;padding:0 2px;font-size:11px;flex-shrink:0;font-family:inherit;';
  abaRow.appendChild(arrowL);

  // Container scroll
  var abaScroll = document.createElement('div');
  abaScroll.className = 'ezap-aba-scroll';
  abaScroll.style.cssText = 'display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none;flex:1;min-width:0;';

  _abasData.tabs.forEach(function(tab) {
    var isActive = (typeof selectedAbaId !== 'undefined') && selectedAbaId === tab.id;
    var count = (tab.contacts || []).length;
    var tabColor = tab.color || '#4d96ff';
    var textOnColor = _pillTextColor(tabColor);
    // Pill inativa: bolinha colorida + texto neutro, fundo sutil
    // Pill ativa: fundo da cor da aba, texto com contraste, sombra
    var pill = document.createElement('button');
    pill.setAttribute('data-aba-id', tab.id);
    if (isActive) {
      // Cores claras (amarelo, verde claro) precisam de borda mais escura
      var borderDarken = _darkenColor(tabColor, 0.25);
      var shadowColor = _darkenColor(tabColor, 0.3);
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:5px;' +
        'background:' + tabColor + ';' +
        'color:' + textOnColor + ';' +
        'border:1.5px solid ' + borderDarken + ';' +
        'border-radius:20px;padding:4px 14px;font-size:12px;font-weight:700;' +
        'cursor:pointer;white-space:nowrap;font-family:inherit;transition:all 0.15s;flex-shrink:0;' +
        'box-shadow:0 2px 6px ' + shadowColor + '50;';
    } else {
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:5px;' +
        'background:transparent;' +
        'color:' + t.text + ';' +
        'border:1px solid ' + (t.border || '#3b4a54') + ';' +
        'border-radius:20px;padding:4px 12px;font-size:12px;font-weight:500;' +
        'cursor:pointer;white-space:nowrap;font-family:inherit;transition:all 0.15s;flex-shrink:0;';
    }
    var dotColor = isActive ? textOnColor : tabColor;
    pill.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';flex-shrink:0"></span>' +
      '<span>' + (tab.name.length > 15 ? tab.name.substring(0, 15) + '..' : tab.name) + '</span>' +
      '<span style="font-size:10px;opacity:0.6">' + count + '</span>';
    pill.addEventListener('click', function(ev) {
      ev.stopPropagation();
      if (typeof selectedAbaId !== 'undefined' && selectedAbaId === tab.id) {
        if (typeof clearAbasFilter === 'function') clearAbasFilter();
      } else {
        selectedAbaId = tab.id;
        if (typeof applyConversationFilters === 'function') applyConversationFilters();
        if (typeof updateAbasIndicator === 'function') updateAbasIndicator();
      }
    });
    pill.addEventListener('mouseenter', function() { pill.style.filter = 'brightness(1.15)'; });
    pill.addEventListener('mouseleave', function() { pill.style.filter = ''; });
    abaScroll.appendChild(pill);
  });
  abaRow.appendChild(abaScroll);

  // Seta direita
  var arrowR = document.createElement('button');
  arrowR.className = 'ezap-aba-arrow ezap-aba-arrow-r';
  arrowR.innerHTML = '&#9654;';
  arrowR.style.cssText = 'display:none;align-items:center;justify-content:center;background:none;border:none;color:' + t.textSecondary + ';cursor:pointer;padding:0 2px;font-size:11px;flex-shrink:0;font-family:inherit;';
  abaRow.appendChild(arrowR);

  // Arrow logic
  var _updateArrows = function() {
    var hasOvf = abaScroll.scrollWidth > abaScroll.clientWidth + 2;
    var atL = abaScroll.scrollLeft <= 2;
    var atR = abaScroll.scrollLeft + abaScroll.clientWidth >= abaScroll.scrollWidth - 2;
    arrowL.style.display = (hasOvf && !atL) ? 'flex' : 'none';
    arrowR.style.display = (hasOvf && !atR) ? 'flex' : 'none';
  };
  setTimeout(_updateArrows, 100);
  abaScroll.addEventListener('scroll', _updateArrows);
  arrowL.addEventListener('click', function(ev) { ev.stopPropagation(); abaScroll.scrollBy({ left: -150, behavior: 'smooth' }); });
  arrowR.addEventListener('click', function(ev) { ev.stopPropagation(); abaScroll.scrollBy({ left: 150, behavior: 'smooth' }); });

  return abaRow;
}

function _ensureCustomListCSS(force) {
  var isDark = (typeof isDarkMode === 'function') ? isDarkMode() : true;
  var themeMode = isDark ? 'dark' : 'light';
  var existing = document.getElementById('wcrm-custom-list-css');
  // Se CSS existe e tema nao mudou (e nao e force), nada a fazer
  if (existing && _wcrmLastThemeMode === themeMode && !force) return;
  // Remove CSS antigo pra recriar com novo tema
  if (existing) existing.parentNode.removeChild(existing);
  _wcrmLastThemeMode = themeMode;

  var t = (typeof getTheme === 'function') ? getTheme() : {
    bg: '#111b21', bgSecondary: '#202c33', bgHover: '#2a3942',
    text: '#e9edef', textSecondary: '#8696a0', border: '#2a3942',
    headerBg: '#202c33'
  };

  var s = document.createElement('style');
  s.id = 'wcrm-custom-list-css';
  var accent = t.accent || '#00a884';
  var accentRgb = (typeof _hexToRgb === 'function') ? _hexToRgb(accent) : [0,168,132];
  s.textContent = [
    '#wcrm-custom-list { overflow-y: auto; background: ' + t.bg + '; color: ' + t.text + '; font-family: "Segoe UI", Helvetica, "Helvetica Neue", Arial, sans-serif; }',
    '.wcrm-custom-row { display: flex; align-items: stretch; padding: 0 15px; min-height: 72px; box-sizing: border-box; cursor: pointer; background: transparent; position: relative; }',
    '.wcrm-custom-row:hover { background: ' + t.bgSecondary + '; }',
    '.wcrm-custom-row:active { background: ' + t.bgHover + '; }',
    '.wcrm-custom-row.wcrm-row-loading { opacity: 0.6; pointer-events: none; }',
    '.wcrm-custom-row.wcrm-row-active { background: ' + t.bgHover + ' !important; }',
    '.wcrm-custom-row.wcrm-row-new-msg { animation: wcrmFlash 1.2s ease-out; }',
    '@keyframes wcrmFlash { 0% { background: rgba(' + accentRgb.join(',') + ',0.35); } 100% { background: transparent; } }',
    '.wcrm-custom-avatar { width: 49px; height: 49px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 500; flex-shrink: 0; margin: 11px 15px 11px 0; overflow: hidden; align-self: center; }',
    '.wcrm-custom-avatar-has-img { background: transparent !important; }',
    '.wcrm-custom-avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }',
    '.wcrm-custom-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; padding-right: 6px; border-top: 1px solid ' + t.border + '; }',
    '.wcrm-custom-row:first-child .wcrm-custom-meta { border-top: none; }',
    '.wcrm-custom-line1 { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }',
    '.wcrm-custom-name { color: ' + t.text + '; font-size: 17px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; line-height: 1.4; padding-bottom: 2px; }',
    '.wcrm-custom-time { color: ' + t.textSecondary + '; font-size: 12px; flex-shrink: 0; }',
    '.wcrm-custom-time.wcrm-time-unread { color: ' + accent + '; }',
    '.wcrm-custom-line2 { display: flex; align-items: center; gap: 6px; }',
    '.wcrm-custom-preview { color: ' + t.textSecondary + '; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; line-height: 20px; }',
    '.wcrm-custom-preview svg { display: inline !important; vertical-align: -2px; flex-shrink: 0; }',
    '.wcrm-custom-pin { color: ' + t.textSecondary + '; font-size: 12px; flex-shrink: 0; opacity: 0.7; display: inline-flex; align-items: center; }',
    '.wcrm-custom-badge { background: ' + accent + '; color: ' + (isDark ? '#111b21' : '#ffffff') + '; font-size: 12px; font-weight: 500; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }',
    '.wcrm-custom-empty { padding: 40px 20px; text-align: center; color: ' + t.textSecondary + '; font-size: 14px; }',
    '.wcrm-custom-header { padding: 10px 15px; color: ' + t.textSecondary + '; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; background: ' + t.headerBg + '; position: sticky; top: 0; z-index: 1; border-bottom: 1px solid ' + t.border + '; }',
    '#ezap-overlay-aba-row::-webkit-scrollbar { display: none; }',
    '#ezap-overlay-aba-row button:hover { filter: brightness(1.2); }',
    '.ezap-aba-scroll::-webkit-scrollbar { display: none; }',
    '.ezap-aba-arrow:hover { color: #e9edef !important; background: rgba(134,150,160,0.15) !important; border-radius:4px; }',
    '.wcrm-custom-labels { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 2px; }',
    '.wcrm-custom-label-tag { font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 3px; white-space: nowrap; line-height: 1.4; }'
  ].join('\n');
  document.head.appendChild(s);
}

// ===== CONTEXT MENU (right-click) =====
var _ctxMenu = null;

function _ensureContextMenuCSS() {
  if (document.getElementById('ezap-ctx-css')) return;
  var t = (typeof getTheme === 'function') ? getTheme() : {
    bg: '#111b21', bgSecondary: '#202c33', bgHover: '#2a3942',
    text: '#e9edef', textSecondary: '#8696a0', border: '#2a3942'
  };
  var s = document.createElement('style');
  s.id = 'ezap-ctx-css';
  s.textContent = [
    '#ezap-ctx-menu { position: fixed; z-index: 9999; min-width: 200px; background: ' + t.bgSecondary + '; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.45); padding: 8px 0; font-family: "Segoe UI", Helvetica, Arial, sans-serif; }',
    '.ezap-ctx-item { display: flex; align-items: center; gap: 12px; padding: 10px 20px; color: ' + t.text + '; font-size: 14px; cursor: pointer; white-space: nowrap; }',
    '.ezap-ctx-item:hover { background: ' + t.bgHover + '; }',
    '.ezap-ctx-item-icon { width: 20px; text-align: center; font-size: 16px; flex-shrink: 0; }',
    '.ezap-ctx-sep { height: 1px; background: ' + t.border + '; margin: 4px 0; }',
    '.ezap-ctx-item.ezap-ctx-danger { color: #f15c6d; }',
    '.ezap-ctx-item.ezap-ctx-danger:hover { background: #f15c6d18; }'
  ].join('\n');
  document.head.appendChild(s);
}

function _showContextMenu(e, rowData) {
  e.preventDefault();
  e.stopPropagation();
  _closeContextMenu();
  _ensureContextMenuCSS();

  var jid = rowData.jid;
  var displayName = rowData.displayName || rowData.name || '';
  var isGroup = jid && jid.indexOf('@g.us') >= 0;
  var isPinned = rowData.isPinned;

  var menu = document.createElement('div');
  menu.id = 'ezap-ctx-menu';

  var items = [
    { icon: _waIcons.pin, label: isPinned ? 'Desafixar conversa' : 'Fixar conversa', action: 'togglePin' },
    { icon: '<svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align:middle"><path fill="#8696a0" d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>', label: 'Arquivar conversa', action: 'archive' }
  ];

  items.forEach(function(item) {
    if (item.sep) {
      var sep = document.createElement('div');
      sep.className = 'ezap-ctx-sep';
      menu.appendChild(sep);
      return;
    }
    var el = document.createElement('div');
    el.className = 'ezap-ctx-item' + (item.danger ? ' ezap-ctx-danger' : '');
    el.innerHTML = '<span class="ezap-ctx-item-icon">' + item.icon + '</span><span>' + item.label + '</span>';
    el.addEventListener('click', function(ev) {
      ev.stopPropagation();
      _closeContextMenu();
      _handleContextAction(item.action, jid, displayName, rowData);
    });
    menu.appendChild(el);
  });

  // Posiciona no cursor
  document.body.appendChild(menu);
  var mx = e.clientX, my = e.clientY;
  var mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (mx + mw > window.innerWidth) mx = window.innerWidth - mw - 8;
  if (my + mh > window.innerHeight) my = window.innerHeight - mh - 8;
  menu.style.left = mx + 'px';
  menu.style.top = my + 'px';
  _ctxMenu = menu;

  // Fecha ao clicar fora
  setTimeout(function() {
    document.addEventListener('click', _closeContextMenu, { once: true });
    document.addEventListener('contextmenu', _closeContextMenu, { once: true });
  }, 50);
}

function _closeContextMenu() {
  if (_ctxMenu) {
    try { _ctxMenu.parentNode && _ctxMenu.parentNode.removeChild(_ctxMenu); } catch(e) {}
    _ctxMenu = null;
  }
}

function _handleContextAction(action, jid, displayName, rowData) {
  // Helper: mostra feedback visual temporario na row
  function _flashRow(jid, color) {
    var row = document.querySelector('.wcrm-custom-row[data-ezap-jid="' + jid + '"]');
    if (!row) return;
    var orig = row.style.backgroundColor;
    row.style.transition = 'background-color 0.3s';
    row.style.backgroundColor = color;
    setTimeout(function() {
      row.style.backgroundColor = orig;
      setTimeout(function() { row.style.transition = ''; }, 300);
    }, 600);
  }

  switch (action) {
    case 'togglePin':
      // Pin/Unpin custom E-ZAP (per-context: overlay ou aba ativa)
      var hasAba = typeof selectedAbaId !== 'undefined' && selectedAbaId !== null;
      var pinCtx = hasAba ? selectedAbaId : '__overlay__';
      if (typeof togglePinInCtx === 'function') {
        var nowPinned = togglePinInCtx(pinCtx, displayName, jid);
        console.log('[EZAP-CTX] Pin toggle:', displayName, 'in ctx:', pinCtx, '-> pinned:', nowPinned);
        _flashRow(jid, nowPinned ? 'rgba(0,168,132,0.2)' : 'rgba(255,107,107,0.2)');
        // Atualiza icone de pin na row sem rebuild completo
        var pinRow = document.querySelector('.wcrm-custom-row[data-ezap-jid="' + jid + '"]');
        if (pinRow) {
          var pinIcon = pinRow.querySelector('.wcrm-custom-pin');
          if (nowPinned && !pinIcon) {
            var line2El = pinRow.querySelector('.wcrm-custom-line2');
            if (line2El) {
              var newPin = document.createElement('span');
              newPin.className = 'wcrm-custom-pin';
              newPin.innerHTML = _waIcons.pin;
              var badgeEl = line2El.querySelector('.wcrm-custom-badge');
              if (badgeEl) line2El.insertBefore(newPin, badgeEl);
              else line2El.appendChild(newPin);
            }
          } else if (!nowPinned && pinIcon) {
            pinIcon.parentNode.removeChild(pinIcon);
          }
          // Marca data attr pra resort
          pinRow.setAttribute('data-ezap-pinned', nowPinned ? '1' : '0');
        }
        // Reordena rows sem rebuild (resort in-place)
        var customEl = document.getElementById('wcrm-custom-list');
        if (customEl) {
          setTimeout(function() { _resortCustomRows(customEl); }, 450);
        }
        // Atualiza contagem de fixados no header
        setTimeout(function() {
          var countEl = document.getElementById('ezap-overlay-count');
          if (countEl && customEl) {
            var allR = customEl.querySelectorAll('.wcrm-custom-row');
            var pinC = 0;
            for (var pc = 0; pc < allR.length; pc++) {
              if (allR[pc].querySelector('.wcrm-custom-pin')) pinC++;
            }
            var totalR = allR.length;
            var label = (!selectedAbaId) ? 'conversa' : 'contato';
            countEl.textContent = totalR + ' ' + label + (totalR !== 1 ? 's' : '') +
              (pinC > 0 ? ' \u00b7 ' + pinC + ' fixado' + (pinC !== 1 ? 's' : '') : '');
          }
        }, 500);
        // Atualiza botao pin do header/sidebar
        if (typeof updateHeaderButtons === 'function') {
          setTimeout(updateHeaderButtons, 200);
        }
      }
      break;

    case 'archive':
      if (window.ezapChatAction) {
        window.ezapChatAction(jid, 'archive').then(function(r) {
          console.log('[EZAP-CTX] Archive result:', r);
          if (r && r.ok) {
            // Remove row do overlay com animacao
            var archRow = document.querySelector('.wcrm-custom-row[data-ezap-jid="' + jid + '"]');
            if (archRow) {
              archRow.style.transition = 'opacity 0.3s, height 0.3s';
              archRow.style.opacity = '0';
              archRow.style.height = '0';
              archRow.style.overflow = 'hidden';
              setTimeout(function() { if (archRow.parentNode) archRow.parentNode.removeChild(archRow); }, 300);
            }
          } else {
            if (window.ezapOpenChat) window.ezapOpenChat(jid);
          }
        });
      }
      break;
  }
}

// Acha o elemento que tem overflow scrollavel (parent do grid da lista)
function _findScrollParent(startEl) {
  var cur = startEl;
  while (cur && cur !== document.body) {
    try {
      var cs = getComputedStyle(cur);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return cur;
    } catch (e) {}
    cur = cur.parentElement;
  }
  return null;
}

// Seta a imagem no avatar de uma row custom (substitui inicial por foto)
function _setAvatarImg(avatar, picUrl) {
  if (!avatar || !picUrl) return;
  var existingImg = avatar.querySelector('img');
  if (existingImg) { existingImg.src = picUrl; return; }
  var initialText = avatar.textContent;
  var img = document.createElement('img');
  img.className = 'wcrm-custom-avatar-img';
  img.src = picUrl;
  img.loading = 'lazy';
  img.draggable = false;
  img.onerror = function() {
    try { img.parentNode && img.parentNode.removeChild(img); } catch(e) {}
    avatar.textContent = initialText;
    avatar.classList.remove('wcrm-custom-avatar-has-img');
  };
  avatar.textContent = '';
  avatar.classList.add('wcrm-custom-avatar-has-img');
  avatar.appendChild(img);
}

// ===== PROFILE PIC VIA NATIVE DOM SCAN =====
// Scrolla a lista nativa (escondida atras do overlay) pra forcar o WhatsApp
// a renderizar rows em cada posicao. Captura as <img> do DOM nativo e aplica
// no overlay. O proprio WA carrega as fotos — zero dependencia de webpack.
var _nativeScanTimer = null;
var _nativeScanPos = 0;
var _nativeScanDone = false;
var _nativePicCache = {};  // nome -> picUrl (acumula de todas as posicoes)

function _startNativePicScan() {
  // Primeiro aplica fotos do cache imediatamente (instantaneo)
  var custom = document.getElementById('wcrm-custom-list');
  if (custom && Object.keys(_nativePicCache).length > 0) {
    _applyNativePicsToOverlay(custom);
  }
  if (_nativeScanDone) return; // Scan ja completo, cache ja ta populado
  _nativeScanPos = 0;
  // NAO limpa cache! Fotos ja carregadas ficam disponiveis entre rebuilds
  // Delay inicial pra overlay estar estavel
  _nativeScanTimer = setTimeout(_nativeScanStep, 1000);
  console.log('[EZAP-PIC] Starting native DOM scan for profile pics (cache:', Object.keys(_nativePicCache).length, ')');
}

function _nativeScanStep() {
  var hidden = document.querySelector('[data-ezap-hidden="1"]');
  if (!hidden) { console.log('[EZAP-PIC] Native scrollParent not found'); return; }
  var custom = document.getElementById('wcrm-custom-list');
  if (!custom) return;

  // Temporariamente habilita scroll (overlay esta por cima, invisivel pro user)
  hidden.style.overflow = 'auto';
  hidden.scrollTop = _nativeScanPos;

  // Espera WA renderizar rows nessa posicao
  setTimeout(function() {
    // Captura fotos das rows nativas renderizadas
    var pane = document.getElementById('pane-side');
    var foundThisStep = 0;
    if (pane) {
      var rows = pane.querySelectorAll('[role="row"], [role="listitem"]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].closest && rows[i].closest('#wcrm-custom-list')) continue;
        var span = rows[i].querySelector('span[title]');
        if (!span) continue;
        var title = span.getAttribute('title') || '';
        if (!title || _nativePicCache[title]) continue;
        // Busca img de perfil (avatar) — e a primeira img grande no row
        var img = rows[i].querySelector('img');
        if (!img || !img.src) continue;
        var src = img.src;
        // Ignora icones pequenos e data URIs minusculos
        if (src.indexOf('data:image/gif') === 0) continue;
        if (src.indexOf('data:image') === 0 && src.length < 200) continue;
        _nativePicCache[title] = src;
        foundThisStep++;
      }
    }

    // Aplica fotos encontradas nas rows do overlay
    var applied = _applyNativePicsToOverlay(custom);

    // Re-congela
    hidden.style.overflow = 'hidden';

    // Avanca posicao (pula ~1 tela)
    var stepSize = hidden.clientHeight || 600;
    _nativeScanPos += stepSize;

    var totalPics = Object.keys(_nativePicCache).length;
    console.log('[EZAP-PIC] Scan step at', _nativeScanPos, '- found', foundThisStep, 'new pics (total:', totalPics, ', applied:', applied, ')');

    if (_nativeScanPos < (hidden.scrollHeight || 0)) {
      // Proxima posicao
      _nativeScanTimer = setTimeout(_nativeScanStep, 250);
    } else {
      // Scan completo — volta scroll pro topo
      hidden.style.overflow = 'auto';
      hidden.scrollTop = 0;
      hidden.style.overflow = 'hidden';
      _nativeScanDone = true;
      console.log('[EZAP-PIC] Native scan COMPLETE. Total pics:', totalPics);
    }
  }, 200);
}

function _applyNativePicsToOverlay(custom) {
  if (!custom) return 0;
  var applied = 0;
  var overlayRows = custom.querySelectorAll('.wcrm-custom-row');
  for (var j = 0; j < overlayRows.length; j++) {
    var avatar = overlayRows[j].querySelector('.wcrm-custom-avatar');
    if (avatar && avatar.classList.contains('wcrm-custom-avatar-has-img')) continue;
    var displayName = overlayRows[j].getAttribute('data-display') || '';
    var dataName = overlayRows[j].getAttribute('data-name') || '';
    var picUrl = _nativePicCache[displayName] || _nativePicCache[dataName];
    if (!picUrl) {
      // Match fuzzy: tenta match parcial (contato renomeado, pipe, etc)
      var keys = Object.keys(_nativePicCache);
      for (var ki = 0; ki < keys.length; ki++) {
        if (window.ezapMatchContact && (window.ezapMatchContact(displayName, keys[ki]) || window.ezapMatchContact(dataName, keys[ki]))) {
          picUrl = _nativePicCache[keys[ki]];
          break;
        }
      }
    }
    if (picUrl) {
      _setAvatarImg(avatar, picUrl);
      applied++;
    }
  }
  return applied;
}

function _stopNativePicScan() {
  if (_nativeScanTimer) { clearTimeout(_nativeScanTimer); _nativeScanTimer = null; }
  // NAO reseta _nativeScanDone nem _nativePicCache: mante cache entre rebuilds
  // Quando o overlay e recriado, fotos ja carregadas sao aplicadas instantaneamente
  _nativeScanPos = 0;
}

// Scan da lista nativa do WA pra extrair foto + preview de cada row visivel.
// Retorna { nome -> {picUrl, preview} } das rows que WA ja renderizou.
function _buildNativePicMap() {
  var map = {};
  try {
    var pane = document.getElementById('pane-side');
    if (!pane) return map;
    var rows = pane.querySelectorAll('[role="row"], [role="listitem"]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].closest && rows[i].closest('#wcrm-custom-list')) continue;
      var span = rows[i].querySelector('span[title]');
      if (!span) continue;
      var title = span.getAttribute('title') || '';
      if (!title) continue;
      var img = rows[i].querySelector('img');
      var picUrl = (img && img.src && img.src.indexOf('data:') !== 0) ? img.src : '';
      map[title] = picUrl;
    }
  } catch (e) {}
  return map;
}

// Scan da lista nativa para extrair preview de ultima mensagem.
// Usado como fallback quando fiber store nao tem lastMsgText.
// Retorna { nome -> preview }
//
// Estrategia: WA renderiza cada row como 2 linhas (name+timestamp, preview+badge).
// Encontramos o titulo via span[title], depois pegamos o SEGUNDO nivel do row
// (linha 2) que contem a preview. Removemos contagem de badge + simbolos WA.
function _buildNativePreviewMap() {
  var map = {};
  try {
    var pane = document.getElementById('pane-side');
    if (!pane) return map;
    var rows = pane.querySelectorAll('[role="row"], [role="listitem"]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].closest && rows[i].closest('#wcrm-custom-list')) continue;
      var titleSpan = rows[i].querySelector('span[title]');
      if (!titleSpan) continue;
      var title = titleSpan.getAttribute('title') || '';
      if (!title) continue;

      // Usa innerText do row inteiro (ignora SVGs/hidden elements)
      // e depois remove o titulo e timestamp pra sobrar o preview.
      var rowText = '';
      try { rowText = (rows[i].innerText || '').trim(); } catch (e2) {}
      if (!rowText) continue;

      // Quebra em linhas e remove a que contem o titulo
      var lines = rowText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
      // Normaliza agressivamente: remove TUDO exceto alfanumerico
      function _stripToAlpha(s) { return (s || '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
      var titleStripped = _stripToAlpha(title);
      var previewParts = [];
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        var lineStripped = _stripToAlpha(line);
        // Pula se e o titulo (ignora QUALQUER diferenca de formatacao/espacos/unicode)
        if (lineStripped === titleStripped) continue;
        // Pula se e substring do titulo ou titulo e substring da linha
        if (titleStripped.indexOf(lineStripped) >= 0 && lineStripped.length > 8) continue;
        if (lineStripped.indexOf(titleStripped) >= 0 && titleStripped.length > 8) continue;
        // Pula timestamps isolados
        if (/^\d{1,2}:\d{2}$/.test(line)) continue;
        if (/^(ontem|hoje)$/i.test(line)) continue;
        if (/^(dom|seg|ter|qua|qui|sex|sab|segunda|terca|quarta|quinta|sexta|sabado|domingo)[\-\s]?.*$/i.test(line) && line.length < 15) continue;
        if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(line)) continue;
        // Pula badge numerico isolado
        if (/^\d{1,3}\+?$/.test(line)) continue;
        previewParts.push(line);
      }
      var preview = previewParts.join(' ').trim();
      // Remove badge numerico no final
      preview = preview.replace(/\s+\d{1,3}\+?\s*$/, '').trim();

      if (preview && preview.length >= 2) {
        map[title] = preview;
      }
    }
  } catch (e) {}
  return map;
}

function _showCustomAbaList(abaTab, chatIndex) {
  _ensureCustomListCSS();

  var container = findChatListContainer();
  if (!container) return false;

  // Acha o container pai que e scrollavel
  var scrollParent = _findScrollParent(container) || container.parentElement;
  if (!scrollParent) return false;

  // MUDANCA v1.8.27: NAO escondemos mais o scrollParent. Fazemos overlay
  // do custom list POR CIMA dele. Isso permite que dispatchEvent nas
  // rows nativas funcione (elemento em flow + visivel).
  var overlayParent = scrollParent.parentNode;
  if (!overlayParent) return false;

  // Congela scroll do scrollParent pra WA nao ficar reciclando rows
  if (!scrollParent.hasAttribute('data-ezap-hidden')) {
    scrollParent.setAttribute('data-ezap-hidden', '1');
    scrollParent.setAttribute('data-ezap-orig-display', scrollParent.style.display || '');
    scrollParent.setAttribute('data-ezap-orig-overflow', scrollParent.style.overflow || '');
    scrollParent.setAttribute('data-ezap-orig-pointerevents', scrollParent.style.pointerEvents || '');
  }
  // Scroll ao topo ANTES de congelar pra capturar rows do topo
  try { if (scrollParent.scrollTop > 0) scrollParent.scrollTop = 0; } catch(e) {}
  // Congela: sem scroll, sem pointer events, sem visibilidade
  scrollParent.style.overflow = 'hidden';
  scrollParent.style.pointerEvents = 'none';

  // Garante position:relative no parent pro overlay absolute funcionar
  var parentPos = getComputedStyle(overlayParent).position;
  if (parentPos === 'static') {
    overlayParent.setAttribute('data-ezap-orig-pos', parentPos);
    overlayParent.style.position = 'relative';
  }

  // Cria nossa lista custom como OVERLAY absoluto (ou reusa)
  var custom = document.getElementById('wcrm-custom-list');
  if (!custom) {
    custom = document.createElement('div');
    custom.id = 'wcrm-custom-list';
    overlayParent.appendChild(custom);
  }
  // Posiciona overlay cobrindo o scrollParent
  custom.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:block;';
  custom.innerHTML = '';

  // Resolve contatos da aba (nome + JID + pin status + nome de display)
  var isOverlayMode = !abaTab;
  var contacts, contactJids;
  if (isOverlayMode && chatIndex && chatIndex.byJid) {
    // Overlay mode: build contacts from ALL chats in the store (exceto arquivados)
    contacts = [];
    contactJids = {};
    Object.keys(chatIndex.byJid).forEach(function(jid) {
      var meta = chatIndex.byJid[jid];
      if (meta && meta.name && !meta.isArchived) {
        contacts.push(meta.name);
        contactJids[meta.name] = jid;
      }
    });
  } else {
    contacts = (abaTab && abaTab.contacts) || [];
    contactJids = (abaTab && abaTab.contactJids) || {};
  }
  var pinned = window._wcrmPinned || {};
  var pinJids = window._wcrmPinnedJids || {};
  var nativePicMap = _buildNativePicMap();        // nome -> picUrl do DOM nativo
  var nativePrevMap = _buildNativePreviewMap();   // nome -> preview do DOM nativo

  if (contacts.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'wcrm-custom-empty';

    var emptyText = document.createElement('div');
    emptyText.textContent = isOverlayMode ? 'Carregando conversas...' : 'Nenhum contato nessa aba ainda';
    empty.appendChild(emptyText);

    if (!isOverlayMode) {
      var emptyBtn = document.createElement('button');
      emptyBtn.textContent = 'Limpar filtro';
      emptyBtn.style.cssText = 'margin-top:16px;background:none;border:1px solid #ff6b6b40;color:#ff6b6b;font-size:13px;cursor:pointer;font-weight:600;padding:8px 20px;border-radius:8px;font-family:inherit;';
      emptyBtn.addEventListener('mouseenter', function() { emptyBtn.style.background = '#ff6b6b20'; });
      emptyBtn.addEventListener('mouseleave', function() { emptyBtn.style.background = 'none'; });
      emptyBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (typeof clearAbasFilter === 'function') clearAbasFilter();
      });
      empty.appendChild(emptyBtn);
    }

    custom.appendChild(empty);
    console.log("[WCRM CUSTOM]", isOverlayMode ? "Overlay aguardando dados" : "Aba vazia");
    return true;
  }

  var abaName = (abaTab && abaTab.name) || '';
  var rows = contacts.map(function(n) {
    var jid = contactJids[n];
    if (!jid && chatIndex && window.ezapFindJidInIndex) {
      jid = window.ezapFindJidInIndex(chatIndex, n);
    }
    var displayName = n;
    var picUrl = '';
    var lastTs = 0;
    var unread = 0;
    var lastMsgText = '';
    var lastMsgFromMe = false;
    var lastMsgSender = '';
    if (jid && chatIndex && chatIndex.byJid && chatIndex.byJid[jid]) {
      var meta = chatIndex.byJid[jid];
      if (meta.name) displayName = meta.name;
      if (meta.profilePicUrl) picUrl = meta.profilePicUrl;
      if (meta.lastTs) lastTs = meta.lastTs;
      if (meta.unread) unread = meta.unread;
      if (meta.lastMsgText) lastMsgText = meta.lastMsgText;
      if (meta.lastMsgFromMe) lastMsgFromMe = meta.lastMsgFromMe;
      if (meta.lastMsgSender) lastMsgSender = meta.lastMsgSender;
    }
    // Filtra fiber lastMsgText se eh so o nome do contato/grupo repetido
    // (eventos de rename retornam o nome como body). Limpa ANTES do
    // fallback pra nativePrevMap ter chance de rodar.
    if (lastMsgText && _stripAlpha(lastMsgText) === _stripAlpha(displayName)) {
      lastMsgText = '';
    }
    if (lastMsgText && n !== displayName && _stripAlpha(lastMsgText) === _stripAlpha(n)) {
      lastMsgText = '';
    }
    // Fallback: pega foto de perfil do DOM nativo do WA (mais confiavel)
    if (!picUrl && nativePicMap) {
      picUrl = nativePicMap[n] || nativePicMap[displayName] || '';
      // Match tolerante
      if (!picUrl && window.ezapMatchContact) {
        var mapNames = Object.keys(nativePicMap);
        for (var mi = 0; mi < mapNames.length; mi++) {
          if (window.ezapMatchContact(n, mapNames[mi]) || window.ezapMatchContact(displayName, mapNames[mi])) {
            picUrl = nativePicMap[mapNames[mi]];
            break;
          }
        }
      }
    }
    // Fallback: pega preview de ultima mensagem do DOM nativo
    if (!lastMsgText && nativePrevMap) {
      lastMsgText = nativePrevMap[n] || nativePrevMap[displayName] || '';
      if (!lastMsgText && window.ezapMatchContact) {
        var prevNames = Object.keys(nativePrevMap);
        for (var pi = 0; pi < prevNames.length; pi++) {
          if (window.ezapMatchContact(n, prevNames[pi]) || window.ezapMatchContact(displayName, prevNames[pi])) {
            lastMsgText = nativePrevMap[prevNames[pi]];
            break;
          }
        }
      }
    }
    // Detecta pin (per-context E-ZAP custom) e mute
    var isPinned = false;
    var nativeIsMuted = false;
    // Resolve contexto: aba ativa ou overlay geral
    var _pinCtxId = isOverlayMode ? '__overlay__' : (selectedAbaId || '__overlay__');
    if (typeof isPinnedInCtx === 'function') {
      isPinned = isPinnedInCtx(_pinCtxId, n, jid);
    } else {
      // Fallback legacy
      isPinned = !!pinned[n];
      if (!isPinned && jid && pinJids) {
        var pkeys = Object.keys(pinJids);
        for (var pk = 0; pk < pkeys.length; pk++) {
          if (pinJids[pkeys[pk]] === jid) { isPinned = true; break; }
        }
      }
    }
    // Mute nativo do WA
    if (jid && chatIndex && chatIndex.byJid && chatIndex.byJid[jid]) {
      nativeIsMuted = !!chatIndex.byJid[jid].isMuted;
    }
    return {
      name: n, displayName: displayName, jid: jid, isPinned: isPinned,
      picUrl: picUrl, lastTs: lastTs, unread: unread, abaName: abaName,
      lastMsgText: lastMsgText, lastMsgFromMe: lastMsgFromMe, lastMsgSender: lastMsgSender,
      isMuted: nativeIsMuted
    };
  });

  // Ordena: pinned primeiro, depois por lastTs desc (mais recente em cima),
  // fallback alfabetico quando nao tem timestamp
  rows.sort(function(a, b) {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.lastTs !== b.lastTs) return (b.lastTs || 0) - (a.lastTs || 0);
    return (a.displayName || '').localeCompare(b.displayName || '');
  });

  // Header com contagem + botao limpar (ou search bar no overlay)
  var header = document.createElement('div');
  header.className = 'wcrm-custom-header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';

  var pinnedCount = rows.filter(function(r) { return r.isPinned; }).length;

  if (isOverlayMode) {
    // --- OVERLAY MODE HEADER: search bar + count ---
    header.style.flexDirection = 'column';
    header.style.alignItems = 'stretch';
    header.style.gap = '6px';
    header.style.padding = '8px 12px';

    // Search bar
    var searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'position:relative;display:flex;align-items:center;';
    var searchIcon = document.createElement('span');
    searchIcon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    searchIcon.style.cssText = 'position:absolute;left:8px;color:#8696a0;pointer-events:none;display:flex;';
    searchWrap.appendChild(searchIcon);

    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Buscar conversa...';
    searchInput.id = 'ezap-overlay-search';
    var _st = (typeof getTheme === 'function') ? getTheme() : { bgHover: '#2a3942', border: '#3b4a54', text: '#e9edef', textSecondary: '#8696a0', accent: '#00a884' };
    var _sa = _st.accent || '#00a884';
    searchInput.style.cssText = 'width:100%;padding:6px 10px 6px 30px;border-radius:8px;border:1px solid ' + _st.border + ';background:' + _st.bgHover + ';color:' + _st.text + ';font-size:13px;outline:none;font-family:inherit;';
    searchInput.addEventListener('focus', function() { searchInput.style.borderColor = _sa; });
    searchInput.addEventListener('blur', function() { searchInput.style.borderColor = _st.border; });
    searchInput.addEventListener('input', function() {
      var q = searchInput.value.toLowerCase().trim();
      var listEl = document.getElementById('wcrm-custom-list');
      if (!listEl) return;
      var items = listEl.querySelectorAll('.wcrm-custom-row');
      var visibleCount = 0;
      for (var si = 0; si < items.length; si++) {
        var rowName = (items[si].getAttribute('data-name') || '').toLowerCase();
        var rowDisplay = (items[si].getAttribute('data-display') || '').toLowerCase();
        var match = !q || rowName.indexOf(q) >= 0 || rowDisplay.indexOf(q) >= 0;
        items[si].style.display = match ? '' : 'none';
        if (match) visibleCount++;
      }
      // Update count
      var countEl = document.getElementById('ezap-overlay-count');
      if (countEl) countEl.textContent = visibleCount + ' conversa' + (visibleCount !== 1 ? 's' : '');
    });
    searchWrap.appendChild(searchInput);
    header.appendChild(searchWrap);

    // --- ABA PILLS ROW (inside overlay header) ---
    var abaPillsRow = _buildAbaPillsRow(_st);
    if (abaPillsRow) header.appendChild(abaPillsRow);

    // Count row
    var countRow = document.createElement('div');
    countRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    var countLabel = document.createElement('span');
    countLabel.id = 'ezap-overlay-count';
    countLabel.style.cssText = 'font-size:11px;color:#8696a0;';
    countLabel.textContent = rows.length + ' conversa' + (rows.length !== 1 ? 's' : '') +
      (pinnedCount > 0 ? ' \u00b7 ' + pinnedCount + ' fixado' + (pinnedCount !== 1 ? 's' : '') : '');
    countRow.appendChild(countLabel);

    var overlayBadge = document.createElement('span');
    overlayBadge.style.cssText = 'font-size:10px;font-weight:600;color:#00a884;letter-spacing:0.5px;';
    overlayBadge.textContent = 'E-ZAP';
    countRow.appendChild(overlayBadge);

    header.appendChild(countRow);
  } else {
    // --- ABA FILTER MODE HEADER (mesmo layout do overlay) ---
    var _tAba = (typeof getTheme === 'function') ? getTheme() : { textSecondary: '#8696a0', border: '#3b4a54', bgHover: '#2a3942', text: '#e9edef', accent: '#00a884' };
    header.style.flexDirection = 'column';
    header.style.alignItems = 'stretch';
    header.style.gap = '6px';
    header.style.padding = '8px 12px';

    // Search bar (identico ao overlay)
    var searchWrapAba = document.createElement('div');
    searchWrapAba.style.cssText = 'position:relative;display:flex;align-items:center;';
    var searchIconAba = document.createElement('span');
    searchIconAba.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    searchIconAba.style.cssText = 'position:absolute;left:8px;color:#8696a0;pointer-events:none;display:flex;';
    searchWrapAba.appendChild(searchIconAba);
    var searchInputAba = document.createElement('input');
    searchInputAba.type = 'text';
    searchInputAba.placeholder = 'Buscar conversa...';
    searchInputAba.id = 'ezap-overlay-search';
    searchInputAba.style.cssText = 'width:100%;padding:6px 10px 6px 30px;border-radius:8px;border:1px solid ' + _tAba.border + ';background:' + _tAba.bgHover + ';color:' + _tAba.text + ';font-size:13px;outline:none;font-family:inherit;';
    searchInputAba.addEventListener('focus', function() { searchInputAba.style.borderColor = _tAba.accent; });
    searchInputAba.addEventListener('blur', function() { searchInputAba.style.borderColor = _tAba.border; });
    searchInputAba.addEventListener('input', function() {
      var q = searchInputAba.value.toLowerCase().trim();
      var listEl = document.getElementById('wcrm-custom-list');
      if (!listEl) return;
      var items = listEl.querySelectorAll('.wcrm-custom-row');
      var visibleCount = 0;
      for (var si = 0; si < items.length; si++) {
        var rowName = (items[si].getAttribute('data-name') || '').toLowerCase();
        var rowDisplay = (items[si].getAttribute('data-display') || '').toLowerCase();
        var match = !q || rowName.indexOf(q) >= 0 || rowDisplay.indexOf(q) >= 0;
        items[si].style.display = match ? '' : 'none';
        if (match) visibleCount++;
      }
      var countEl = document.getElementById('ezap-overlay-count');
      if (countEl) countEl.textContent = visibleCount + ' contato' + (visibleCount !== 1 ? 's' : '');
    });
    searchWrapAba.appendChild(searchInputAba);
    header.appendChild(searchWrapAba);

    // Aba pills row (identico ao overlay)
    var abaPillsRowAba = _buildAbaPillsRow(_tAba);
    if (abaPillsRowAba) header.appendChild(abaPillsRowAba);

    // Count row (identico ao overlay, com Limpar no lugar de E-ZAP)
    var countRowAba = document.createElement('div');
    countRowAba.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    var countLabelAba = document.createElement('span');
    countLabelAba.id = 'ezap-overlay-count';
    countLabelAba.style.cssText = 'font-size:11px;color:#8696a0;';
    countLabelAba.textContent = rows.length + ' contato' + (rows.length !== 1 ? 's' : '') +
      (pinnedCount > 0 ? ' \u00b7 ' + pinnedCount + ' fixado' + (pinnedCount !== 1 ? 's' : '') : '');
    countRowAba.appendChild(countLabelAba);

    var _abaColor = (abaTab && abaTab.color) ? abaTab.color : '#cc5de8';
    var _abaTextOnBg = _pillTextColor(_abaColor);
    var abaNameBadge = document.createElement('span');
    abaNameBadge.style.cssText = 'font-size:10px;font-weight:700;color:' + _abaTextOnBg + ';letter-spacing:0.3px;' +
      'background:' + _abaColor + ';padding:2px 10px;border-radius:10px;text-transform:uppercase;';
    abaNameBadge.textContent = abaTab ? abaTab.name : '';
    countRowAba.appendChild(abaNameBadge);

    var clearBtn = document.createElement('button');
    clearBtn.innerHTML = '&#10005; Limpar';
    clearBtn.style.cssText = 'background:#ff6b6b18;border:1px solid #ff6b6b50;color:#ff6b6b;font-size:10px;cursor:pointer;font-weight:600;padding:3px 10px;border-radius:10px;font-family:inherit;transition:all 0.15s;';
    clearBtn.addEventListener('mouseenter', function() { clearBtn.style.background = '#ff6b6b30'; clearBtn.style.borderColor = '#ff6b6b'; });
    clearBtn.addEventListener('mouseleave', function() { clearBtn.style.background = '#ff6b6b18'; clearBtn.style.borderColor = '#ff6b6b50'; });
    clearBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (typeof clearAbasFilter === 'function') clearAbasFilter();
    });
    countRowAba.appendChild(clearBtn);
    header.appendChild(countRowAba);
  }
  custom.appendChild(header);

  // Arquivadas row (estilo nativo WA) - so no overlay mode
  if (isOverlayMode) {
    var _tArch = (typeof getTheme === 'function') ? getTheme() : { bgSecondary: '#202c33', text: '#e9edef', textSecondary: '#8696a0', border: '#2a3942' };
    var archRow = document.createElement('div');
    archRow.style.cssText = 'display:flex;align-items:center;padding:10px 15px;cursor:pointer;border-bottom:1px solid ' + _tArch.border + ';';
    archRow.addEventListener('mouseenter', function() { archRow.style.background = _tArch.bgSecondary; });
    archRow.addEventListener('mouseleave', function() { archRow.style.background = 'transparent'; });
    var archIcon = document.createElement('span');
    archIcon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="' + (_tArch.accent || '#00a884') + '" stroke-width="2"><path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5" rx="1"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
    archIcon.style.cssText = 'display:flex;align-items:center;margin-right:15px;';
    archRow.appendChild(archIcon);
    var archText = document.createElement('span');
    archText.textContent = 'Arquivadas';
    archText.style.cssText = 'font-size:14px;color:' + (_tArch.accent || '#00a884') + ';font-weight:500;';
    archRow.appendChild(archText);
    archRow.addEventListener('click', function(e) {
      e.stopPropagation();
      _hideCustomAbaList();
      _stopNativePicScan();
      setTimeout(function() {
        var archiveEl = document.querySelector('[aria-label*="rquivad"], [data-icon="archived"], [title*="rquivad"]');
        if (archiveEl) { archiveEl.click(); }
      }, 300);
      var _archW = setInterval(function() {
        var pane = document.getElementById('pane-side');
        var archPanel = document.querySelector('[data-animate-drawer-title*="rquivad"]');
        if (pane && !archPanel) {
          clearInterval(_archW);
          if (window.__ezapOverlayEnabled) {
            setTimeout(function() { if (typeof window._wcrmApplyOverlay === 'function') window._wcrmApplyOverlay(); }, 500);
          }
        }
      }, 500);
      setTimeout(function() { clearInterval(_archW); }, 300000);
    });
    custom.appendChild(archRow);
  }

  var frag = document.createDocumentFragment();
  rows.forEach(function(r) { frag.appendChild(_createCustomRow(r)); });
  custom.appendChild(frag);

  console.log("[WCRM CUSTOM] Renderizou", rows.length, "contatos,", pinnedCount, "pinned");

  // Inicia scan progressivo da lista nativa pra capturar fotos
  _startNativePicScan();

  return true;
}

// Hash simples nome -> cor (placeholders nunca sao cinza chapado, parece
// mais profissional que um uniforme #6b7c85)
var _wcrmAvatarPalette = [
  '#dfa79e', '#e8b58e', '#ddb16c', '#c8b57c', '#a8c792',
  '#7ec88e', '#5fc8b0', '#5fb8d4', '#7aa6db', '#9592dc',
  '#b785c9', '#d67fb3', '#d88995', '#c7a691', '#998f85'
];
function _wcrmAvatarColor(s) {
  var str = String(s || '').trim();
  if (!str) return _wcrmAvatarPalette[0];
  var h = 0;
  for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return _wcrmAvatarPalette[Math.abs(h) % _wcrmAvatarPalette.length];
}

function _wcrmFormatTime(ts) {
  if (!ts) return '';
  var d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return '';
  var now = new Date();
  var sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    return hh + ':' + mm;
  }
  var diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) {
    var days = ['domingo','segunda-feira','ter\u00e7a-feira','quarta-feira','quinta-feira','sexta-feira','s\u00e1bado'];
    return days[d.getDay()];
  }
  var dd = ('0' + d.getDate()).slice(-2);
  var mo = ('0' + (d.getMonth() + 1)).slice(-2);
  return dd + '/' + mo + '/' + String(d.getFullYear()).slice(-2);
}

function _stripAlpha(s) { return (s || '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }

// SVGs inline estilo WhatsApp nativo (14px, inline com texto)
var _icoS = 'display:inline;vertical-align:-2px;margin-right:2px;flex-shrink:0;';
var _waIcons = {
  ptt: '<svg viewBox="0 0 24 24" width="15" height="15" style="' + _icoS + '"><path fill="#8696a0" d="M7 5.5c0-2.76142 2.23858-5 5-5 2.7614 0 5 2.23858 5 5v5.5c0 2.7614-2.2386 5-5 5-2.76142 0-5-2.2386-5-5z"/><path fill="#8696a0" d="M12.006 18c-.002 0-.004 0-.006 0s-.004 0-.006 0c-2.93324-.0028-5.44639-1.81-6.48477-4.3752-.20722-.5119-.79022-.7589-1.30215-.5517s-.75895.7902-.55172 1.3021c1.21491 3.0014 4.00322 5.2002 7.34464 5.5698v3.055c0 .5523.4477 1 1 1s1-.4477 1-1v-3.0548c3.3421-.3692 6.1311-2.5682 7.3462-5.57.2072-.5119-.0398-1.0949-.5517-1.3021-.512-.2072-1.095.0398-1.3022.5517-1.0385 2.5657-3.5524 4.3731-6.4863 4.3752z"/></svg>',
  camera: '<svg viewBox="0 0 16 14" width="15" height="15" style="' + _icoS + '"><path fill="#8696a0" d="M11 0H5L3.5 2H1a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1h-2.5L11 0zM8 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm0-1.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>',
  video: '<svg viewBox="0 0 16 14" width="15" height="15" style="' + _icoS + '"><path fill="#8696a0" d="M15 3.5l-4 2.5V3a1 1 0 0 0-1-1H1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V8l4 2.5v-7z"/></svg>',
  doc: '<svg viewBox="0 0 13 16" width="13" height="15" style="' + _icoS + '"><path fill="#8696a0" d="M0 1.5A1.5 1.5 0 0 1 1.5 0h6.379a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 12.5 4.622V14.5a1.5 1.5 0 0 1-1.5 1.5H1.5A1.5 1.5 0 0 1 0 14.5v-13zM1.5 1a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V5H8.5A1.5 1.5 0 0 1 7 3.5V1H1.5zM8 1.293V3.5a.5.5 0 0 0 .5.5h2.207L8 1.293z"/></svg>',
  sticker: '<svg viewBox="0 0 16 16" width="15" height="15" style="' + _icoS + '"><path fill="#8696a0" d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm2.5 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm-5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm6.03 5.5a.5.5 0 0 1-.68.18A6.98 6.98 0 0 1 8 12a6.98 6.98 0 0 1-2.85-1.32.5.5 0 1 1 .5-.86A5.97 5.97 0 0 0 8 11c.87 0 1.71-.24 2.35-.68a.5.5 0 0 1 .68.18z"/></svg>',
  location: '<svg viewBox="0 0 12 17" width="13" height="15" style="' + _icoS + '"><path fill="#8696a0" d="M6 0C2.69 0 0 2.69 0 6c0 4.5 6 11 6 11s6-6.5 6-11c0-3.31-2.69-6-6-6zm0 8.5A2.5 2.5 0 1 1 6 3.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  contact: '<svg viewBox="0 0 16 16" width="15" height="15" style="' + _icoS + '"><path fill="#8696a0" d="M8 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1c-3.3 0-6 2-6 4.5V14h12v-1.5C14 10 11.3 8 8 8z"/></svg>',
  pin: '<svg viewBox="0 0 32 32" width="18" height="18" style="display:inline;vertical-align:middle"><path fill="#8696a0" d="m28.1 12.7-8.8-8.8c-.4-.4-1-.4-1.4 0l-3.2 3.2c-.5.5-.3 1.1 0 1.4l.7.7-3 3c-1.5-.3-5.6-1-7.8 1.2-.4.4-.4 1 0 1.4l5.7 5.7-6.3 6.3c-.4.4-.4 1 0 1.4s1.1.3 1.4 0l6.3-6.3 5.7 5.7c.6.5 1.2.3 1.4 0 2.2-2.2 1.5-6.3 1.2-7.8l3-3 .7.7c.4.4 1 .4 1.4 0l3.2-3.2c.2-.6.2-1.2-.2-1.6zm-3.9 2.5-.7-.7c-.4-.4-1-.4-1.4 0l-4.1 4.2c-.3.3-.4.6-.3 1 .3 1.1.8 3.8 0 5.6l-11-11c1.7-.8 4.5-.3 5.6 0 .3.1.7 0 1-.3l4.1-4.1c.6-.6.3-1.1 0-1.4l-.7-.7 1.9-1.8 7.4 7.4z"/></svg>',
  muted: '<svg viewBox="0 0 24 24" width="14" height="14" style="display:inline;vertical-align:middle"><path fill="#8696a0" d="M12 4.5c-1.2 0-2.3.5-3.1 1.3L3.5 12.2 12 20.5V4.5zm7.5 7.7l-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1 2.1-2.1-1.4-1.4-2.1 2.1z"/></svg>'
};

// Substitui emojis de tipo de midia por SVGs nativos no preview
function _previewToHTML(txt) {
  if (!txt) return '';
  // Escapa HTML primeiro
  var safe = txt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Substitui emojis por SVGs
  safe = safe.replace(/\ud83c\udf99|\ud83c\udfa4|\ud83c\udfa7|\ud83d\udc68\u200d\ud83c\udfa4|🎤/g, _waIcons.ptt);
  safe = safe.replace(/📷|📸/g, _waIcons.camera);
  safe = safe.replace(/🎥|📹/g, _waIcons.video);
  safe = safe.replace(/📄|📎/g, _waIcons.doc);
  safe = safe.replace(/🖼️|🖼/g, _waIcons.sticker);
  safe = safe.replace(/📍/g, _waIcons.location);
  safe = safe.replace(/👤/g, _waIcons.contact);
  return safe;
}

function _formatPreview(data) {
  var txt = data.lastMsgText || '';
  if (!txt) return '';
  // Filtra se o preview eh basicamente o nome do contato/grupo
  var nameRef = data.displayName || data.name || '';
  if (nameRef && _stripAlpha(txt) === _stripAlpha(nameRef)) return '';
  // Prefixo de quem mandou
  var isSystemEvent = /saiu|entrou|adicionou|removeu|criou o grupo|mudou o/i.test(txt);
  if (data.lastMsgFromMe && !isSystemEvent && !/^Voc[eê]:?\s/i.test(txt)) {
    txt = 'Voc\u00ea: ' + txt;
  } else if (data.lastMsgSender && !data.lastMsgFromMe && !isSystemEvent) {
    var sender = data.lastMsgSender;
    var senderLabel = sender;
    if (sender.charAt(0) !== '+') {
      senderLabel = sender.split(/\s+/)[0];
    }
    if (senderLabel && !/^Voc[eê]/i.test(txt)) {
      txt = '~ ' + senderLabel + ': ' + txt;
    }
  }
  return txt;
}

// Versao HTML do preview (com SVGs no lugar de emojis)
function _formatPreviewHTML(data) {
  return _previewToHTML(_formatPreview(data));
}

// Atualiza incrementalmente uma row existente com novos dados (sem re-render)
// Retorna true se algo mudou (pra sinalizar necessidade de re-sort)
function _updateCustomRow(row, data) {
  if (!row) return false;
  var changed = false;
  var prevTs = Number(row.getAttribute('data-ezap-lastts') || 0);
  var prevUnread = Number(row.getAttribute('data-ezap-unread') || 0);

  // Nome (pode mudar se grupo renomeado ou contato mudou pushname)
  if (data.displayName) {
    var nameEl = row.querySelector('.wcrm-custom-name');
    if (nameEl && nameEl.textContent !== data.displayName) {
      nameEl.textContent = data.displayName;
      nameEl.setAttribute('title', data.displayName);
      changed = true;
    }
  }

  // Timestamp
  var timeEl = row.querySelector('.wcrm-custom-time');
  if (timeEl) {
    var newTime = _wcrmFormatTime(data.lastTs);
    if (timeEl.textContent !== newTime) { timeEl.textContent = newTime; changed = true; }
    if (data.unread > 0) timeEl.classList.add('wcrm-time-unread');
    else timeEl.classList.remove('wcrm-time-unread');
  }

  // Preview: nao sobrescreve com vazio se ja tem conteudo
  var prevEl = row.querySelector('.wcrm-custom-preview');
  if (prevEl) {
    var newPrev = _formatPreview(data);
    var newPrevHTML = _previewToHTML(newPrev);
    if (newPrev && prevEl.innerHTML !== newPrevHTML) { prevEl.innerHTML = newPrevHTML; changed = true; }
  }

  // Badge de unread
  var badge = row.querySelector('.wcrm-custom-badge');
  if (badge) {
    if (data.unread > 0) {
      var txt = data.unread > 99 ? '99+' : String(data.unread);
      if (badge.textContent !== txt) { badge.textContent = txt; changed = true; }
      badge.style.display = '';
    } else {
      if (badge.style.display !== 'none') { badge.style.display = 'none'; changed = true; }
    }
  }

  // Attrs pra proxima comparacao
  row.setAttribute('data-ezap-lastts', String(data.lastTs || 0));
  row.setAttribute('data-ezap-unread', String(data.unread || 0));

  // Se recebeu mensagem nova (unread subiu), pisca o row
  if (data.unread > prevUnread && prevUnread >= 0) {
    row.classList.remove('wcrm-row-new-msg');
    // Force reflow pra reativar animacao
    void row.offsetWidth;
    row.classList.add('wcrm-row-new-msg');
  }

  return changed || (data.lastTs !== prevTs);
}

function _createCustomRow(data) {
  var row = document.createElement('div');
  row.className = 'wcrm-custom-row';
  row.setAttribute('data-ezap-jid', data.jid || '');
  row.setAttribute('data-ezap-name', data.name || '');
  row.setAttribute('data-name', data.name || '');
  row.setAttribute('data-display', data.displayName || data.name || '');
  row.setAttribute('data-ezap-lastts', String(data.lastTs || 0));
  row.setAttribute('data-ezap-unread', String(data.unread || 0));
  row.setAttribute('data-ezap-abaname', data.abaName || '');

  var avatar = document.createElement('div');
  avatar.className = 'wcrm-custom-avatar';
  var label = (data.displayName || data.name || '?').trim();
  var initial = (label.charAt(0) || '?').toUpperCase();
  avatar.style.background = _wcrmAvatarColor(label);
  // Usa picUrl: aceita data: URI ou cached pic do _nativePicCache
  var picToUse = '';
  if (data.picUrl && data.picUrl.indexOf('data:') === 0) {
    picToUse = data.picUrl;
  } else {
    // Tenta cache de fotos da sessao
    var cacheKey = data.displayName || data.name || '';
    picToUse = _nativePicCache[cacheKey] || _nativePicCache[data.name] || '';
  }
  var usePic = !!picToUse;
  if (usePic) {
    var img = document.createElement('img');
    img.className = 'wcrm-custom-avatar-img';
    img.src = picToUse;
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    img.onerror = function() {
      avatar.textContent = initial;
      avatar.classList.remove('wcrm-custom-avatar-has-img');
    };
    avatar.classList.add('wcrm-custom-avatar-has-img');
    avatar.appendChild(img);
  } else {
    avatar.textContent = initial;
  }
  row.appendChild(avatar);

  var meta = document.createElement('div');
  meta.className = 'wcrm-custom-meta';

  var line1 = document.createElement('div');
  line1.className = 'wcrm-custom-line1';
  var name = document.createElement('span');
  name.className = 'wcrm-custom-name';
  name.setAttribute('title', data.displayName || data.name || '');
  name.textContent = data.displayName || data.name || '';
  line1.appendChild(name);
  var time = document.createElement('span');
  time.className = 'wcrm-custom-time' + (data.unread ? ' wcrm-time-unread' : '');
  time.textContent = _wcrmFormatTime(data.lastTs);
  line1.appendChild(time);
  meta.appendChild(line1);

  // Labels/Etiquetas do contato
  var contactLabels = _getLabelsForJid(data.jid);
  if (contactLabels.length > 0) {
    var labelsRow = document.createElement('div');
    labelsRow.className = 'wcrm-custom-labels';
    for (var li = 0; li < contactLabels.length && li < 3; li++) {
      var tag = document.createElement('span');
      tag.className = 'wcrm-custom-label-tag';
      tag.textContent = contactLabels[li].name || '';
      var tagColor = contactLabels[li].color || '#25d366';
      tag.style.background = tagColor + '30';
      tag.style.color = tagColor;
      labelsRow.appendChild(tag);
    }
    if (contactLabels.length > 3) {
      var moreTag = document.createElement('span');
      moreTag.className = 'wcrm-custom-label-tag';
      moreTag.textContent = '+' + (contactLabels.length - 3);
      moreTag.style.cssText = 'background:rgba(134,150,160,0.15);color:#8696a0;';
      labelsRow.appendChild(moreTag);
    }
    meta.appendChild(labelsRow);
  }

  var line2 = document.createElement('div');
  line2.className = 'wcrm-custom-line2';
  var preview = document.createElement('span');
  preview.className = 'wcrm-custom-preview';
  preview.innerHTML = _formatPreviewHTML(data);
  line2.appendChild(preview);
  if (data.isMuted) {
    var muteIcon = document.createElement('span');
    muteIcon.className = 'ezap-mute-icon';
    muteIcon.innerHTML = _waIcons.muted;
    muteIcon.style.cssText = 'opacity:0.7;flex-shrink:0;display:inline-flex;align-items:center;';
    line2.appendChild(muteIcon);
  }
  if (data.isPinned) {
    var pin = document.createElement('span');
    pin.className = 'wcrm-custom-pin';
    pin.innerHTML = _waIcons.pin;
    line2.appendChild(pin);
  }
  var badge = document.createElement('span');
  badge.className = 'wcrm-custom-badge';
  if (data.unread > 0) {
    badge.textContent = data.unread > 99 ? '99+' : String(data.unread);
  } else {
    badge.style.display = 'none';
  }
  line2.appendChild(badge);
  meta.appendChild(line2);

  row.appendChild(meta);

  row.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.ezapOpenChat) {
      console.warn("[WCRM CUSTOM] ezapOpenChat nao disponivel");
      return;
    }
    // Marca row como selecionada (remove de todas as outras)
    var allRows = document.querySelectorAll('.wcrm-custom-row.wcrm-row-active');
    for (var ri = 0; ri < allRows.length; ri++) allRows[ri].classList.remove('wcrm-row-active');
    row.classList.add('wcrm-row-active');
    var jid = row.getAttribute('data-ezap-jid');
    var cname = row.getAttribute('data-ezap-name');
    row.classList.add('wcrm-row-loading');
    window.ezapOpenChat(jid, cname).then(function(result) {
      console.log("[WCRM CUSTOM] openChat:", cname, "->", result);
      row.classList.remove('wcrm-row-loading');
    });
  });

  // Context menu (right-click)
  row.addEventListener('contextmenu', function(e) {
    _showContextMenu(e, data);
  });

  return row;
}

// ===== Polling de tempo real (Plan B) =====
// Enquanto custom list visivel, busca updates a cada 3s e patcha rows.
// Pausa quando tab em background.
var _customListPollTimer = null;
var _customListLastUpdate = 0;

function _startCustomListPolling() {
  _stopCustomListPolling();
  _customListPollTimer = setInterval(_pollCustomListUpdates, 3000);
  // Primeira atualizacao rapida apos 1s (ja tem chatIndex em cache)
  setTimeout(_pollCustomListUpdates, 1000);
}

function _stopCustomListPolling() {
  if (_customListPollTimer) { clearInterval(_customListPollTimer); _customListPollTimer = null; }
}

var _pollThemeCheckCounter = 0;
function _pollCustomListUpdates() {
  // Pausa se tab em background ou custom list escondida
  if (document.hidden) return;
  var custom = document.getElementById('wcrm-custom-list');
  if (!custom || custom.style.display === 'none') { _stopCustomListPolling(); return; }
  if (!window.ezapBuildChatIndex) return;
  // A cada 10 ciclos (~30s), checa se tema mudou e re-aplica CSS
  _pollThemeCheckCounter++;
  if (_pollThemeCheckCounter % 10 === 0) _ensureCustomListCSS();

  window.ezapBuildChatIndex({ force: true }).then(function(idx) {
    if (!idx || !idx.byJid) return;
    var rows = custom.querySelectorAll('.wcrm-custom-row');
    var nativePicMap = _buildNativePicMap();
    var nativePrevMap = _buildNativePreviewMap();
    var anyReordered = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var jid = row.getAttribute('data-ezap-jid');
      var cname = row.getAttribute('data-ezap-name') || '';
      if (!jid) continue;
      var meta = idx.byJid[jid];
      if (!meta) continue;
      // Preview: fiber > native map > manter existente
      var msgText = meta.lastMsgText || '';
      // Filtra fiber text se eh o nome do contato/grupo repetido
      if (msgText && _stripAlpha(msgText) === _stripAlpha(meta.name || '')) msgText = '';
      if (msgText && _stripAlpha(msgText) === _stripAlpha(cname)) msgText = '';
      if (!msgText && nativePrevMap) {
        msgText = nativePrevMap[meta.name] || nativePrevMap[cname] || '';
        if (!msgText && window.ezapMatchContact) {
          var pkeys = Object.keys(nativePrevMap);
          for (var pk = 0; pk < pkeys.length; pk++) {
            if (window.ezapMatchContact(cname, pkeys[pk]) || window.ezapMatchContact(meta.name, pkeys[pk])) {
              msgText = nativePrevMap[pkeys[pk]]; break;
            }
          }
        }
      }
      var data = {
        lastTs: meta.lastTs || 0,
        unread: meta.unread || 0,
        lastMsgText: msgText,
        lastMsgFromMe: !!meta.lastMsgFromMe,
        lastMsgSender: meta.lastMsgSender || '',
        abaName: row.getAttribute('data-ezap-abaname') || '',
        displayName: meta.name || '',
        name: cname
      };
      var changed = _updateCustomRow(row, data);
      if (changed) anyReordered = true;
      // Atualiza foto se nao tem ainda
      var avatar = row.querySelector('.wcrm-custom-avatar');
      if (avatar && !avatar.classList.contains('wcrm-custom-avatar-has-img')) {
        var picUrl = meta.profilePicUrl || nativePicMap[meta.name] || '';
        if (picUrl) _setAvatarImg(avatar, picUrl);
      }
    }
    // Overlay mode: detect new chats not yet rendered and add them
    // APENAS no overlay real (sem aba ativa), senao polui a lista da aba
    var hasAbaActive = typeof selectedAbaId !== 'undefined' && selectedAbaId !== null;
    if (window.__ezapOverlayEnabled && !hasAbaActive) {
      var renderedJids = {};
      for (var rj = 0; rj < rows.length; rj++) {
        var rjid = rows[rj].getAttribute('data-ezap-jid');
        if (rjid) renderedJids[rjid] = true;
      }
      var newRows = [];
      Object.keys(idx.byJid).forEach(function(jid) {
        if (renderedJids[jid]) return;
        var meta = idx.byJid[jid];
        if (!meta || !meta.name || meta.isArchived) return;
        // Pin nativo do WA (pinTs > 0)
        var isPinned = !!(meta.pinTs && meta.pinTs > 0);
        newRows.push({
          name: meta.name, displayName: meta.name, jid: jid, isPinned: isPinned,
          picUrl: meta.profilePicUrl || nativePicMap[meta.name] || '',
          lastTs: meta.lastTs || 0, unread: meta.unread || 0, abaName: '',
          lastMsgText: meta.lastMsgText || '', lastMsgFromMe: !!meta.lastMsgFromMe,
          lastMsgSender: meta.lastMsgSender || '', isMuted: !!meta.isMuted
        });
      });
      if (newRows.length > 0) {
        var frag = document.createDocumentFragment();
        newRows.forEach(function(r) { frag.appendChild(_createCustomRow(r)); });
        custom.appendChild(frag);
        anyReordered = true;
        // Update count
        var totalRows = custom.querySelectorAll('.wcrm-custom-row').length;
        var pinnedRows = custom.querySelectorAll('.wcrm-custom-pin').length;
        var countEl = document.getElementById('ezap-overlay-count');
        var hasAbaFilter = typeof selectedAbaId !== 'undefined' && selectedAbaId !== null;
        var unitLabel = hasAbaFilter ? 'contato' : 'conversa';
        if (countEl) countEl.textContent = totalRows + ' ' + unitLabel + (totalRows !== 1 ? 's' : '') +
          (pinnedRows > 0 ? ' \u00b7 ' + pinnedRows + ' fixado' + (pinnedRows !== 1 ? 's' : '') : '');
        // Aplica fotos do cache nativo nas novas rows
        var cust = document.getElementById('wcrm-custom-list');
        if (cust) _applyNativePicsToOverlay(cust);
      }
    }
    if (anyReordered) _resortCustomRows(custom);
  });
}

// Reordena rows do custom list baseado em data-ezap-lastts (pinned first, depois ts desc)
function _resortCustomRows(custom) {
  if (!custom) return;
  var rows = Array.prototype.slice.call(custom.querySelectorAll('.wcrm-custom-row'));
  if (rows.length <= 1) return;
  rows.sort(function(a, b) {
    var aPinned = !!a.querySelector('.wcrm-custom-pin');
    var bPinned = !!b.querySelector('.wcrm-custom-pin');
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    var aTs = Number(a.getAttribute('data-ezap-lastts') || 0);
    var bTs = Number(b.getAttribute('data-ezap-lastts') || 0);
    return bTs - aTs;
  });
  // Check se ja esta na ordem certa
  var currentOrder = Array.prototype.slice.call(custom.querySelectorAll('.wcrm-custom-row'));
  var sameOrder = true;
  for (var i = 0; i < rows.length; i++) {
    if (currentOrder[i] !== rows[i]) { sameOrder = false; break; }
  }
  if (sameOrder) return;
  // Reordena via DocumentFragment
  var frag = document.createDocumentFragment();
  rows.forEach(function(r) { frag.appendChild(r); });
  // Preserva header + arquivadas row no topo
  // Encontra o ultimo elemento non-row antes das chat rows
  var insertAfter = custom.querySelector('.wcrm-custom-header');
  if (insertAfter) {
    // Pula Arquivadas row (proximo sibling que nao e .wcrm-custom-row)
    var next = insertAfter.nextSibling;
    while (next && !next.classList.contains('wcrm-custom-row')) {
      insertAfter = next;
      next = next.nextSibling;
    }
  }
  if (insertAfter && insertAfter.nextSibling) {
    custom.insertBefore(frag, insertAfter.nextSibling);
  } else if (insertAfter) {
    custom.appendChild(frag);
  } else {
    custom.appendChild(frag);
  }
}

// Reinicia polling quando tab volta ao foreground
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) {
    var custom = document.getElementById('wcrm-custom-list');
    if (custom && custom.style.display !== 'none' && !_customListPollTimer) {
      _startCustomListPolling();
    }
  }
});

function _hideCustomAbaList() {
  _stopNativePicScan();
  var custom = document.getElementById('wcrm-custom-list');
  if (custom) {
    custom.style.display = 'none';
    custom.innerHTML = '';
  }
  var hidden = document.querySelector('[data-ezap-hidden="1"]');
  if (hidden) {
    // Restaura overflow e pointer-events do scrollParent
    hidden.style.overflow = hidden.getAttribute('data-ezap-orig-overflow') || '';
    hidden.style.pointerEvents = hidden.getAttribute('data-ezap-orig-pointerevents') || '';
    hidden.removeAttribute('data-ezap-hidden');
    hidden.removeAttribute('data-ezap-orig-display');
    hidden.removeAttribute('data-ezap-orig-overflow');
    hidden.removeAttribute('data-ezap-orig-pointerevents');
    // Restaura position do parent se mudamos
    var parent = hidden.parentNode;
    if (parent && parent.hasAttribute('data-ezap-orig-pos')) {
      parent.style.position = parent.getAttribute('data-ezap-orig-pos');
      parent.removeAttribute('data-ezap-orig-pos');
    }
    // Nudge scroll pra WA re-renderizar virtual scroll
    try {
      var pos = hidden.scrollTop;
      hidden.scrollTop = pos + 1;
      setTimeout(function() { hidden.scrollTop = pos; }, 50);
    } catch(e) {}
  }
}

// Expoe pra outras partes da extensao poderem esconder/mostrar manualmente
window._wcrmHideCustomList = _hideCustomAbaList;
window._wcrmShowCustomList = _showCustomAbaList;

// Cria uma row sintetica pra contato que nao esta no virtual scroll.
// CLONA uma row nativa do WA como template (quando disponivel) pra ter
// visual 100% identico. Fallback: constroi do zero com estilo aproximado.
// Click abre o chat via ezapOpenChat (search bar fallback).
// Tenta clonar uma row nativa do WA como template. Retorna clone ou null.
function _cloneNativeRowTemplate(container) {
  if (!container) return null;
  for (var i = 0; i < container.children.length; i++) {
    var row = container.children[i];
    if (!row || !row.classList) continue;
    if (row.classList.contains('wcrm-synth-row')) continue;
    if (row.classList.contains('wcrm-hidden')) continue;
    // Row nativa valida: tem span[title] com conteudo
    var t = row.querySelector && row.querySelector('span[title]');
    if (t && t.getAttribute('title')) {
      return row.cloneNode(true);
    }
  }
  return null;
}

// Ajusta um clone de row nativa para representar outro contato (nosso synth).
function _hydrateClonedRow(clone, name, jid, isPinned) {
  if (!clone) return null;
  clone.classList.add('wcrm-synth-row');
  clone.setAttribute('data-ezap-jid', jid || '');
  clone.setAttribute('data-ezap-name', name || '');
  // Neutraliza position:absolute/top inline (virtual scroll)
  try { clone.style.position = 'relative'; clone.style.top = 'auto'; clone.style.transform = 'none'; } catch(e) {}

  // Troca nome
  var titleSpan = clone.querySelector('span[title]');
  if (titleSpan) {
    titleSpan.setAttribute('title', name || '');
    titleSpan.textContent = name || '';
  }

  // Zera preview/snippet (evita texto residual do contato clonado)
  var spans = clone.querySelectorAll('span');
  for (var s = 0; s < spans.length; s++) {
    var sp = spans[s];
    if (sp === titleSpan) continue;
    // Mantem timestamps curtos mas limpa previews longos
    var txt = (sp.textContent || '').trim();
    if (txt.length > 0 && !sp.querySelector('img,svg') && sp !== titleSpan) {
      // Se e candidato a preview de mensagem, zera
      if (txt.length > 3 || /mensagem|voce|via/i.test(txt)) {
        // So zera se estiver fora do container do nome
        var parentTitle = sp.closest && sp.closest('[title]');
        if (parentTitle !== titleSpan) sp.textContent = '';
      }
    }
  }

  // Remove avatar img (seria de outro contato), deixa placeholder
  var imgs = clone.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    try { imgs[i].parentNode && imgs[i].parentNode.removeChild(imgs[i]); } catch(e) {}
  }

  // Remove badges de notificacao / unread count do template original
  var badges = clone.querySelectorAll('[aria-label*="nao"], [aria-label*="mensag"], [aria-label*="unread"]');
  for (var b = 0; b < badges.length; b++) {
    try { badges[b].parentNode && badges[b].parentNode.removeChild(badges[b]); } catch(e) {}
  }

  // Pin indicator
  if (isPinned && titleSpan) {
    var pinEl = document.createElement('span');
    pinEl.className = 'wcrm-pin-icon';
    pinEl.textContent = '📌';
    pinEl.style.cssText = 'font-size:12px;margin-left:6px;';
    titleSpan.appendChild(pinEl);
  }

  return clone;
}

// Cria uma row sintetica pra contato fora do virtual scroll.
// Prefere CLONAR row nativa como template (visual identico). Fallback manual.
function _createSyntheticRow(name, jid, isPinned) {
  var container = findChatListContainer();
  var clone = _cloneNativeRowTemplate(container);
  var hydrated = _hydrateClonedRow(clone, name, jid, isPinned);
  if (hydrated) {
    _attachSynthClick(hydrated);
    return hydrated;
  }

  // Fallback: constroi row manual (estilo aproximado WA)
  var row = document.createElement('div');
  row.className = 'wcrm-synth-row';
  row.setAttribute('data-ezap-jid', jid || '');
  row.setAttribute('data-ezap-name', name || '');
  row.style.cssText = 'display:flex;align-items:center;padding:10px 15px;height:72px;box-sizing:border-box;border-bottom:1px solid rgba(134,150,160,0.15);cursor:pointer;background:transparent;';
  row.addEventListener('mouseenter', function() { row.style.background = 'rgba(42,57,66,0.5)'; });
  row.addEventListener('mouseleave', function() { row.style.background = 'transparent'; });

  var initial = (name || '?').trim().charAt(0).toUpperCase();
  var avatar = document.createElement('div');
  avatar.style.cssText = 'width:49px;height:49px;border-radius:50%;background:#6b7c85;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;flex-shrink:0;margin-right:15px;';
  avatar.textContent = initial;
  row.appendChild(avatar);

  var info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;';
  var nameEl = document.createElement('span');
  nameEl.setAttribute('title', name || '');
  nameEl.style.cssText = 'color:#e9edef;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
  nameEl.textContent = name || '';
  info.appendChild(nameEl);
  if (isPinned) {
    var pinIcon = document.createElement('span');
    pinIcon.className = 'wcrm-pin-icon';
    pinIcon.textContent = '📌';
    pinIcon.style.cssText = 'font-size:12px;margin-left:6px;flex-shrink:0;';
    info.appendChild(pinIcon);
  }
  row.appendChild(info);

  _attachSynthClick(row);
  return row;
}

// Attach click handler that opens chat via ezapOpenChat (search fallback).
function _attachSynthClick(row) {
  row.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.ezapOpenChat) {
      console.warn("[WCRM FILTER] ezapOpenChat nao disponivel");
      return;
    }
    // Marca row como selecionada
    var allRows = document.querySelectorAll('.wcrm-custom-row.wcrm-row-active');
    for (var ri = 0; ri < allRows.length; ri++) allRows[ri].classList.remove('wcrm-row-active');
    row.classList.add('wcrm-row-active');
    var lockedJid = row.getAttribute('data-ezap-jid');
    var lockedName = row.getAttribute('data-ezap-name');
    row.style.opacity = '0.6';
    window.ezapOpenChat(lockedJid, lockedName).then(function(result) {
      row.style.opacity = '';
      console.log("[WCRM FILTER] synth openChat result:", result);
      if (!result || !result.ok) {
        console.warn("[WCRM FILTER] Nao consegui abrir o chat:", result);
      }
    });
  });
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
    filterObserver._debounce = setTimeout(applyConversationFilters, 300);
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

// Export for overlay activation from auth.js / abas.js
window._wcrmApplyOverlay = applyConversationFilters;
