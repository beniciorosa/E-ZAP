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
  // PLANO B: quando ABAS filter ativo, esconde a lista do WA e renderiza
  // nossa propria lista (zero dependencia de virtual scroll). Fora do filtro,
  // usa o caminho antigo (_runFiltersSync pra limpeza/restauracao).
  var hasAbasFilter = typeof selectedAbaId !== 'undefined' && selectedAbaId !== null;
  var runLegacy = function(idx) { _hideCustomAbaList(); _runFiltersSync(idx); };
  var runCustom = function(idx) {
    var tab = _getAbaTabEntry(selectedAbaId);
    if (!tab) { runLegacy(idx); return; }
    // Garante que a lista legacy esta em estado neutro antes de overlay
    var container = findChatListContainer();
    if (container) {
      container.classList.remove('wcrm-filter-active');
      var hidden = container.querySelectorAll('.wcrm-hidden');
      for (var h = 0; h < hidden.length; h++) hidden[h].classList.remove('wcrm-hidden');
      var synth = container.querySelectorAll('.wcrm-synth-row');
      for (var s = 0; s < synth.length; s++) synth[s].parentNode.removeChild(synth[s]);
    }
    _showCustomAbaList(tab, idx);
  };
  if (window.ezapBuildChatIndex) {
    window.ezapBuildChatIndex().then(function(idx) {
      if (hasAbasFilter) runCustom(idx); else runLegacy(idx);
    });
  } else {
    if (hasAbasFilter) runCustom(null); else runLegacy(null);
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

// ===== PLANO B: Custom List (renderizacao propria, zero virtual scroll) =====
// Quando a ABA esta ativa, a gente esconde a lista do WA e renderiza nossa
// propria lista com os contatos da aba. Isso elimina TODOS os problemas
// de virtual scroll (contatos nao carregados, scroll bugado, pin que nao sobe).
//
// Click nos cards abre o chat via search-bar do WA (ezapOpenChatViaSearch),
// que funciona independente de viewport/scroll.

function _ensureCustomListCSS() {
  if (document.getElementById('wcrm-custom-list-css')) return;
  var s = document.createElement('style');
  s.id = 'wcrm-custom-list-css';
  s.textContent = [
    '#wcrm-custom-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; background: #111b21; color: #e9edef; font-family: "Segoe UI", Helvetica, "Helvetica Neue", Arial, sans-serif; }',
    '.wcrm-custom-row { display: flex; align-items: stretch; padding: 0 15px; height: 72px; box-sizing: border-box; cursor: pointer; background: transparent; position: relative; }',
    '.wcrm-custom-row:hover { background: #202c33; }',
    '.wcrm-custom-row:active { background: #2a3942; }',
    '.wcrm-custom-row.wcrm-row-loading { opacity: 0.6; pointer-events: none; }',
    '.wcrm-custom-row.wcrm-row-active { background: #2a3942; }',
    '.wcrm-custom-avatar { width: 49px; height: 49px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 500; flex-shrink: 0; margin: 11px 15px 11px 0; overflow: hidden; align-self: center; }',
    '.wcrm-custom-avatar-has-img { background: transparent !important; }',
    '.wcrm-custom-avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }',
    '.wcrm-custom-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; padding-right: 6px; border-top: 1px solid rgba(134,150,160,0.15); }',
    '.wcrm-custom-row:first-child .wcrm-custom-meta { border-top: none; }',
    '.wcrm-custom-line1 { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }',
    '.wcrm-custom-name { color: #e9edef; font-size: 17px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }',
    '.wcrm-custom-time { color: #8696a0; font-size: 12px; flex-shrink: 0; }',
    '.wcrm-custom-time.wcrm-time-unread { color: #00a884; }',
    '.wcrm-custom-line2 { display: flex; align-items: center; gap: 6px; }',
    '.wcrm-custom-preview { color: #8696a0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }',
    '.wcrm-custom-pin { color: #8696a0; font-size: 14px; flex-shrink: 0; transform: rotate(45deg); }',
    '.wcrm-custom-badge { background: #00a884; color: #111b21; font-size: 12px; font-weight: 500; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }',
    '.wcrm-custom-empty { padding: 40px 20px; text-align: center; color: #8696a0; font-size: 14px; }',
    '.wcrm-custom-header { padding: 10px 15px; color: #8696a0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; background: #0b141a; position: sticky; top: 0; z-index: 1; border-bottom: 1px solid rgba(134,150,160,0.15); }'
  ].join('\n');
  document.head.appendChild(s);
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

function _showCustomAbaList(abaTab, chatIndex) {
  _ensureCustomListCSS();

  var container = findChatListContainer();
  if (!container) return false;

  // Acha o container pai que e scrollavel (esse que vamos esconder)
  var scrollParent = _findScrollParent(container) || container.parentElement;
  if (!scrollParent) return false;

  // Esconde a lista nativa do WA (preserva display original pra restaurar)
  if (!scrollParent.hasAttribute('data-ezap-hidden')) {
    scrollParent.setAttribute('data-ezap-hidden', '1');
    scrollParent.setAttribute('data-ezap-orig-display', scrollParent.style.display || '');
    scrollParent.style.display = 'none';
  }

  // Cria nossa lista custom (ou reusa)
  var custom = document.getElementById('wcrm-custom-list');
  if (!custom) {
    custom = document.createElement('div');
    custom.id = 'wcrm-custom-list';
    // Insere no MESMO pai do scrollParent, logo depois dele
    scrollParent.parentNode.insertBefore(custom, scrollParent.nextSibling);
  }
  custom.style.display = 'block';
  custom.innerHTML = '';

  // Resolve contatos da aba (nome + JID + pin status + nome de display)
  var contacts = (abaTab && abaTab.contacts) || [];
  var contactJids = (abaTab && abaTab.contactJids) || {};
  var pinned = window._wcrmPinned || {};
  var pinJids = window._wcrmPinnedJids || {};

  if (contacts.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'wcrm-custom-empty';
    empty.textContent = 'Nenhum contato nessa aba ainda';
    custom.appendChild(empty);
    console.log("[WCRM CUSTOM] Aba vazia");
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
    if (jid && chatIndex && chatIndex.byJid && chatIndex.byJid[jid]) {
      var meta = chatIndex.byJid[jid];
      if (meta.name) displayName = meta.name;
      if (meta.profilePicUrl) picUrl = meta.profilePicUrl;
      if (meta.lastTs) lastTs = meta.lastTs;
      if (meta.unread) unread = meta.unread;
    }
    var isPinned = !!pinned[n];
    if (!isPinned && jid && pinJids) {
      var pkeys = Object.keys(pinJids);
      for (var pk = 0; pk < pkeys.length; pk++) {
        if (pinJids[pkeys[pk]] === jid) { isPinned = true; break; }
      }
    }
    return {
      name: n, displayName: displayName, jid: jid, isPinned: isPinned,
      picUrl: picUrl, lastTs: lastTs, unread: unread, abaName: abaName
    };
  });

  // Ordena: pinned primeiro, depois por lastTs desc (mais recente em cima),
  // fallback alfabetico quando nao tem timestamp
  rows.sort(function(a, b) {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.lastTs !== b.lastTs) return (b.lastTs || 0) - (a.lastTs || 0);
    return (a.displayName || '').localeCompare(b.displayName || '');
  });

  // Header com contagem
  var header = document.createElement('div');
  header.className = 'wcrm-custom-header';
  var pinnedCount = rows.filter(function(r) { return r.isPinned; }).length;
  header.textContent = rows.length + ' contato' + (rows.length !== 1 ? 's' : '') +
    (pinnedCount > 0 ? ' · ' + pinnedCount + ' fixado' + (pinnedCount !== 1 ? 's' : '') : '');
  custom.appendChild(header);

  var frag = document.createDocumentFragment();
  rows.forEach(function(r) { frag.appendChild(_createCustomRow(r)); });
  custom.appendChild(frag);

  console.log("[WCRM CUSTOM] Renderizou", rows.length, "contatos,", pinnedCount, "pinned");
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
    var days = ['dom','seg','ter','qua','qui','sex','sab'];
    return days[d.getDay()];
  }
  var dd = ('0' + d.getDate()).slice(-2);
  var mo = ('0' + (d.getMonth() + 1)).slice(-2);
  return dd + '/' + mo + '/' + String(d.getFullYear()).slice(-2);
}

function _createCustomRow(data) {
  var row = document.createElement('div');
  row.className = 'wcrm-custom-row';
  row.setAttribute('data-ezap-jid', data.jid || '');
  row.setAttribute('data-ezap-name', data.name || '');

  var avatar = document.createElement('div');
  avatar.className = 'wcrm-custom-avatar';
  var label = (data.displayName || data.name || '?').trim();
  var initial = (label.charAt(0) || '?').toUpperCase();
  avatar.style.background = _wcrmAvatarColor(label);
  if (data.picUrl) {
    var img = document.createElement('img');
    img.className = 'wcrm-custom-avatar-img';
    img.src = data.picUrl;
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

  var line2 = document.createElement('div');
  line2.className = 'wcrm-custom-line2';
  var preview = document.createElement('span');
  preview.className = 'wcrm-custom-preview';
  preview.textContent = data.abaName ? ('em ' + data.abaName) : '';
  line2.appendChild(preview);
  if (data.isPinned) {
    var pin = document.createElement('span');
    pin.className = 'wcrm-custom-pin';
    pin.textContent = '⚲';
    line2.appendChild(pin);
  }
  if (data.unread > 0) {
    var badge = document.createElement('span');
    badge.className = 'wcrm-custom-badge';
    badge.textContent = data.unread > 99 ? '99+' : String(data.unread);
    line2.appendChild(badge);
  }
  meta.appendChild(line2);

  row.appendChild(meta);

  row.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.ezapOpenChat) {
      console.warn("[WCRM CUSTOM] ezapOpenChat nao disponivel");
      return;
    }
    var jid = row.getAttribute('data-ezap-jid');
    var cname = row.getAttribute('data-ezap-name');
    row.classList.add('wcrm-row-loading');
    window.ezapOpenChat(jid, cname).then(function(result) {
      console.log("[WCRM CUSTOM] openChat:", cname, "->", result);
      row.classList.remove('wcrm-row-loading');
    });
  });

  return row;
}

function _hideCustomAbaList() {
  var custom = document.getElementById('wcrm-custom-list');
  if (custom) {
    custom.style.display = 'none';
    custom.innerHTML = '';
  }
  var hidden = document.querySelector('[data-ezap-hidden="1"]');
  if (hidden) {
    var orig = hidden.getAttribute('data-ezap-orig-display') || '';
    hidden.style.display = orig;
    hidden.removeAttribute('data-ezap-hidden');
    hidden.removeAttribute('data-ezap-orig-display');
  }
}

// Expoe pra outras partes da extensao poderem esconder/mostrar manualmente
window._wcrmHideCustomList = _hideCustomAbaList;
window._wcrmShowCustomList = _showCustomAbaList;

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
