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
  var runLegacyCleanup = function(idx) { _hideCustomAbaList(); _stopCustomListPolling(); _runFiltersSync(idx); };
  var runCustom = function(idx) {
    var tab = _getAbaTabEntry(selectedAbaId);
    if (!tab) { runLegacyCleanup(idx); return; }
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
    _startCustomListPolling();
  };
  if (window.ezapBuildChatIndex) {
    window.ezapBuildChatIndex().then(function(idx) {
      if (hasAbasFilter) runCustom(idx); else runLegacyCleanup(idx);
    });
  } else {
    if (hasAbasFilter) runCustom(null); else runLegacyCleanup(null);
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
function _ensureCustomListCSS() {
  if (document.getElementById('wcrm-custom-list-css')) return;
  var s = document.createElement('style');
  s.id = 'wcrm-custom-list-css';
  s.textContent = [
    '#wcrm-custom-list { overflow-y: auto; background: #111b21; color: #e9edef; font-family: "Segoe UI", Helvetica, "Helvetica Neue", Arial, sans-serif; }',
    '.wcrm-custom-row { display: flex; align-items: stretch; padding: 0 15px; height: 72px; box-sizing: border-box; cursor: pointer; background: transparent; position: relative; }',
    '.wcrm-custom-row:hover { background: #202c33; }',
    '.wcrm-custom-row:active { background: #2a3942; }',
    '.wcrm-custom-row.wcrm-row-loading { opacity: 0.6; pointer-events: none; }',
    '.wcrm-custom-row.wcrm-row-active { background: #2a3942; }',
    '.wcrm-custom-row.wcrm-row-new-msg { animation: wcrmFlash 1.2s ease-out; }',
    '@keyframes wcrmFlash { 0% { background: rgba(0,168,132,0.35); } 100% { background: transparent; } }',
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

  // Acha o container pai que e scrollavel
  var scrollParent = _findScrollParent(container) || container.parentElement;
  if (!scrollParent) return false;

  // MUDANCA v1.8.27: NAO escondemos mais o scrollParent. Fazemos overlay
  // do custom list POR CIMA dele. Isso permite que dispatchEvent nas
  // rows nativas funcione (elemento em flow + visivel).
  var overlayParent = scrollParent.parentNode;
  if (!overlayParent) return false;

  // Marca scrollParent pra referencia (mesmo nao sendo escondido)
  if (!scrollParent.hasAttribute('data-ezap-hidden')) {
    scrollParent.setAttribute('data-ezap-hidden', '1');
    scrollParent.setAttribute('data-ezap-orig-display', scrollParent.style.display || '');
  }
  // Scroll nativo ao topo pra primeiras rows carregarem no virtual scroll
  try { if (scrollParent.scrollTop > 0) scrollParent.scrollTop = 0; } catch(e) {}

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
    var lastMsgText = '';
    var lastMsgFromMe = false;
    if (jid && chatIndex && chatIndex.byJid && chatIndex.byJid[jid]) {
      var meta = chatIndex.byJid[jid];
      if (meta.name) displayName = meta.name;
      if (meta.profilePicUrl) picUrl = meta.profilePicUrl;
      if (meta.lastTs) lastTs = meta.lastTs;
      if (meta.unread) unread = meta.unread;
      if (meta.lastMsgText) lastMsgText = meta.lastMsgText;
      if (meta.lastMsgFromMe) lastMsgFromMe = meta.lastMsgFromMe;
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
      picUrl: picUrl, lastTs: lastTs, unread: unread, abaName: abaName,
      lastMsgText: lastMsgText, lastMsgFromMe: lastMsgFromMe
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

function _formatPreview(data) {
  var txt = data.lastMsgText || '';
  if (!txt) return data.abaName ? ('em ' + data.abaName) : '';
  return (data.lastMsgFromMe ? 'Voce: ' : '') + txt;
}

// Atualiza incrementalmente uma row existente com novos dados (sem re-render)
// Retorna true se algo mudou (pra sinalizar necessidade de re-sort)
function _updateCustomRow(row, data) {
  if (!row) return false;
  var changed = false;
  var prevTs = Number(row.getAttribute('data-ezap-lastts') || 0);
  var prevUnread = Number(row.getAttribute('data-ezap-unread') || 0);

  // Timestamp
  var timeEl = row.querySelector('.wcrm-custom-time');
  if (timeEl) {
    var newTime = _wcrmFormatTime(data.lastTs);
    if (timeEl.textContent !== newTime) { timeEl.textContent = newTime; changed = true; }
    if (data.unread > 0) timeEl.classList.add('wcrm-time-unread');
    else timeEl.classList.remove('wcrm-time-unread');
  }

  // Preview
  var prevEl = row.querySelector('.wcrm-custom-preview');
  if (prevEl) {
    var newPrev = _formatPreview(data);
    if (prevEl.textContent !== newPrev) { prevEl.textContent = newPrev; changed = true; }
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
  row.setAttribute('data-ezap-lastts', String(data.lastTs || 0));
  row.setAttribute('data-ezap-unread', String(data.unread || 0));
  row.setAttribute('data-ezap-abaname', data.abaName || '');

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
  preview.textContent = _formatPreview(data);
  line2.appendChild(preview);
  if (data.isPinned) {
    var pin = document.createElement('span');
    pin.className = 'wcrm-custom-pin';
    pin.textContent = '⚲';
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

function _pollCustomListUpdates() {
  // Pausa se tab em background ou custom list escondida
  if (document.hidden) return;
  var custom = document.getElementById('wcrm-custom-list');
  if (!custom || custom.style.display === 'none') { _stopCustomListPolling(); return; }
  if (!window.ezapBuildChatIndex) return;

  window.ezapBuildChatIndex().then(function(idx) {
    if (!idx || !idx.byJid) return;
    var rows = custom.querySelectorAll('.wcrm-custom-row');
    var anyReordered = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var jid = row.getAttribute('data-ezap-jid');
      if (!jid) continue;
      var meta = idx.byJid[jid];
      if (!meta) continue;
      var data = {
        lastTs: meta.lastTs || 0,
        unread: meta.unread || 0,
        lastMsgText: meta.lastMsgText || '',
        lastMsgFromMe: !!meta.lastMsgFromMe,
        abaName: row.getAttribute('data-ezap-abaname') || ''
      };
      var changed = _updateCustomRow(row, data);
      if (changed) anyReordered = true;
    }
    // Se algum lastTs mudou, re-ordena rows (mantem pinned no topo)
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
  // Preserva header no topo
  var header = custom.querySelector('.wcrm-custom-header');
  if (header) custom.insertBefore(frag, header.nextSibling);
  else custom.appendChild(frag);
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
  var custom = document.getElementById('wcrm-custom-list');
  if (custom) {
    custom.style.display = 'none';
    custom.innerHTML = '';
  }
  var hidden = document.querySelector('[data-ezap-hidden="1"]');
  if (hidden) {
    // Nao precisamos mais restaurar display (nao esta mais em none),
    // so removemos os marcadores
    hidden.removeAttribute('data-ezap-hidden');
    hidden.removeAttribute('data-ezap-orig-display');
    // Restaura position do parent se mudamos
    var parent = hidden.parentNode;
    if (parent && parent.hasAttribute('data-ezap-orig-pos')) {
      parent.style.position = parent.getAttribute('data-ezap-orig-pos');
      parent.removeAttribute('data-ezap-orig-pos');
    }
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
