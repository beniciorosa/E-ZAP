// ===== WhatsApp CRM - SLICE (Mentor Filter) =====
console.log("[WCRM SLICE] Loaded");

var sliceSidebarOpen = false;
var selectedMentor = null;
var sliceFilterObserver = null;

// ===== Button =====
function createSliceButton() {
  if (document.getElementById("wcrm-slice-toggle")) return;
  var btn = document.createElement("button");
  btn.id = "wcrm-slice-toggle";
  btn.title = "Filtrar por Mentor";
  btn.addEventListener("click", toggleSliceSidebar);
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
  if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "slice");
  else { btn.textContent = "SLICE"; btn.style.background = "#ff922b"; btn.style.color = "#fff"; btn.style.fontSize = "9px"; }
  var container = document.getElementById("ezap-float-container");
  if (container) container.appendChild(btn);
  else document.body.appendChild(btn);
}

// ===== Sidebar =====
function createSliceSidebar() {
  if (document.getElementById("wcrm-slice-sidebar")) return;

  var sidebar = document.createElement("div");
  sidebar.id = "wcrm-slice-sidebar";
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
      '<h3 style="margin:0;font-size:15px;font-weight:600;color:#e9edef">SLICE - Mentores</h3>' +
      '<button id="wcrm-slice-close" style="background:none;border:none;color:#8696a0;font-size:22px;cursor:pointer;padding:4px 8px">&times;</button>' +
    '</div>' +
    '<div style="padding:12px 16px;flex:1;overflow-y:auto">' +
      '<div id="wcrm-slice-active-filter" style="display:none;background:#ff922b20;border:1px solid #ff922b;border-radius:8px;padding:8px 12px;margin-bottom:12px;align-items:center;justify-content:space-between">' +
        '<span style="color:#ff922b;font-size:12px;font-weight:600">Filtro: <span id="wcrm-slice-filter-name"></span></span>' +
        '<button id="wcrm-slice-clear" style="background:none;border:none;color:#ff6b6b;font-size:11px;cursor:pointer;font-weight:600;padding:2px 6px">Limpar</button>' +
      '</div>' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8696a0;margin-bottom:8px;font-weight:600">MENTORES DETECTADOS</div>' +
      '<button id="wcrm-slice-refresh" style="width:100%;background:#2a3942;color:#8696a0;border:1px solid #3b4a54;border-radius:6px;padding:6px;font-size:11px;cursor:pointer;margin-bottom:10px">Atualizar lista</button>' +
      '<div id="wcrm-slice-mentor-list"></div>' +
    '</div>';

  document.body.appendChild(sidebar);

  document.getElementById("wcrm-slice-close").addEventListener("click", toggleSliceSidebar);
  document.getElementById("wcrm-slice-clear").addEventListener("click", clearSliceFilter);
  document.getElementById("wcrm-slice-refresh").addEventListener("click", scanMentors);
}

// ===== Toggle =====
function toggleSliceSidebar() {
  if (typeof sidebarOpen !== 'undefined' && sidebarOpen) toggleSidebar();
  if (typeof msgSidebarOpen !== 'undefined' && msgSidebarOpen) closeMsgSidebar();
  if (typeof abasSidebarOpen !== 'undefined' && abasSidebarOpen) closeAbasSidebar();

  sliceSidebarOpen = !sliceSidebarOpen;
  document.getElementById("wcrm-slice-sidebar").style.display = sliceSidebarOpen ? "flex" : "none";

  var appEl = document.getElementById("app");
  if (appEl) {
    if (sliceSidebarOpen) {
      appEl.style.width = "calc(100% - 320px)";
      appEl.style.maxWidth = "calc(100% - 320px)";
    } else {
      appEl.style.width = "";
      appEl.style.maxWidth = "";
    }
  }

  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();

  if (sliceSidebarOpen) {
    scanMentors();
  }
}

function closeSliceSidebar() {
  if (!sliceSidebarOpen) return;
  sliceSidebarOpen = false;
  var sb = document.getElementById("wcrm-slice-sidebar");
  if (sb) sb.style.display = "none";
  if (typeof updateFloatingButtons === 'function') updateFloatingButtons();
}

// ===== Scan Mentors from Chat List =====
function scanMentors() {
  var pane = document.getElementById("pane-side");
  var list = document.getElementById("wcrm-slice-mentor-list");
  if (!list) return;

  if (!pane) {
    list.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:16px;font-style:italic">Lista de conversas nao encontrada</div>';
    return;
  }

  // Use the list container approach to find chat names
  var container = findChatListContainer();
  var mentors = {};

  if (container) {
    for (var i = 0; i < container.children.length; i++) {
      var row = container.children[i];
      var nameSpan = row.querySelector('span[title]');
      if (!nameSpan) continue;
      var title = nameSpan.getAttribute('title') || '';
      if (title.includes('|')) {
        var parts = title.split(/\s*\|\s*/);
        if (parts.length >= 2) {
          var mentor = parts[parts.length - 1].trim();
          if (mentor && mentor.length > 1) {
            if (!mentors[mentor]) mentors[mentor] = 0;
            mentors[mentor]++;
          }
        }
      }
    }
  }

  var mentorNames = Object.keys(mentors).sort();
  if (mentorNames.length === 0) {
    list.innerHTML = '<div style="color:#8696a0;font-size:12px;text-align:center;padding:16px;font-style:italic">Nenhum mentor encontrado. Role a lista de conversas e clique em Atualizar.</div>';
    return;
  }

  var html = '';
  mentorNames.forEach(function(name) {
    var isSelected = selectedMentor === name;
    var bgColor = isSelected ? '#ff922b30' : '#1a2730';
    var borderColor = isSelected ? '#ff922b' : '#3b4a54';
    var checkmark = isSelected ? ' <span style="color:#ff922b">&#10003;</span>' : '';
    html += '<div class="wcrm-slice-mentor" data-mentor="' + name + '" style="background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:all 0.15s" onmouseover="this.style.background=\'' + (isSelected ? '#ff922b40' : '#243340') + '\'" onmouseout="this.style.background=\'' + bgColor + '\'">';
    html += '<span style="font-size:13px;font-weight:500;color:#e9edef">' + name + checkmark + '</span>';
    html += '<span style="color:#8696a0;font-size:11px">' + mentors[name] + '</span>';
    html += '</div>';
  });

  list.innerHTML = html;

  list.querySelectorAll('.wcrm-slice-mentor').forEach(function(el) {
    el.addEventListener('click', function() {
      var mentor = el.dataset.mentor;
      if (selectedMentor === mentor) {
        clearSliceFilter();
      } else {
        selectedMentor = mentor;
        applyConversationFilters();
        scanMentors();
        updateSliceIndicator();
      }
    });
  });

  updateSliceIndicator();
}

function clearSliceFilter() {
  selectedMentor = null;
  applyConversationFilters();
  scanMentors();
  updateSliceIndicator();
}

function updateSliceIndicator() {
  var indicator = document.getElementById("wcrm-slice-active-filter");
  var nameEl = document.getElementById("wcrm-slice-filter-name");
  if (indicator) {
    if (selectedMentor) {
      indicator.style.display = "flex";
      if (nameEl) nameEl.textContent = selectedMentor;
    } else {
      indicator.style.display = "none";
    }
  }

  var btn = document.getElementById("wcrm-slice-toggle");
  if (btn) {
    btn.style.boxShadow = selectedMentor
      ? "0 0 0 3px #ff922b80, 0 4px 12px rgba(0,0,0,0.4)"
      : "0 4px 12px rgba(0,0,0,0.4)";
  }
}

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

// ===== Apply both SLICE + ABAS filters =====
function applyConversationFilters() {
  injectFilterCSS();

  var container = findChatListContainer();
  if (!container) {
    console.log("[WCRM FILTER] Chat list container not found");
    return;
  }

  var hasSliceFilter = !!selectedMentor;
  var hasAbasFilter = typeof selectedAbaId !== 'undefined' && selectedAbaId !== null;
  var hasAnyFilter = hasSliceFilter || hasAbasFilter;

  console.log("[WCRM FILTER] Applying. Rows:", container.children.length, "SLICE:", selectedMentor, "ABAS:", selectedAbaId);

  if (!hasAnyFilter) {
    // Remove all filter overrides — let WhatsApp restore normal layout
    container.classList.remove('wcrm-filter-active');
    var hiddenItems = container.querySelectorAll('.wcrm-hidden');
    for (var j = 0; j < hiddenItems.length; j++) {
      hiddenItems[j].classList.remove('wcrm-hidden');
    }
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

  // Debug: loga lista de contatos salvos na aba + titulos presentes no DOM
  if (hasAbasFilter) {
    var _abasContacts = getAbaContacts(selectedAbaId) || [];
    var _visibleTitles = [];
    for (var _vi = 0; _vi < container.children.length; _vi++) {
      var _r = container.children[_vi];
      var _ns = _r && _r.querySelector && _r.querySelector('span[title]');
      if (_ns) _visibleTitles.push(_ns.getAttribute('title') || '');
    }
    console.log("[WCRM FILTER] ABAS stored contacts:", _abasContacts);
    console.log("[WCRM FILTER] Visible chat titles (" + _visibleTitles.length + " rows):", _visibleTitles);
    // Quais salvos NAO batem com nenhum titulo visivel
    var _missing = _abasContacts.filter(function(c) {
      return !_visibleTitles.some(function(t) { return window.ezapMatchContact && window.ezapMatchContact(c, t); });
    });
    if (_missing.length > 0) {
      console.log("[WCRM FILTER] Saved contacts NOT found in visible rows:", _missing, "(role a lista para carregar mais conversas antes de filtrar)");
    }
  }

  // Enable filter mode: override virtual scroll to normal flow
  container.classList.add('wcrm-filter-active');

  var pinnedRows = [];
  var unpinnedRows = [];
  var pinned = (typeof window._wcrmPinned !== 'undefined') ? window._wcrmPinned : {};

  for (var i = 0; i < container.children.length; i++) {
    var row = container.children[i];
    var nameSpan = row.querySelector('span[title]');

    if (!nameSpan) {
      row.classList.add('wcrm-hidden');
      continue;
    }

    var title = nameSpan.getAttribute('title') || '';
    if (!title) { row.classList.add('wcrm-hidden'); continue; }

    var show = true;

    // SLICE filter
    if (hasSliceFilter) {
      if (title.includes('|')) {
        var parts = title.split(/\s*\|\s*/);
        var mentor = parts[parts.length - 1].trim();
        if (mentor.toLowerCase() !== selectedMentor.toLowerCase()) show = false;
      } else {
        show = false;
      }
    }

    // ABAS filter
    if (show && hasAbasFilter) {
      var abasContacts = getAbaContacts(selectedAbaId);
      if (abasContacts) {
        var found = abasContacts.some(function(c) {
          return window.ezapMatchContact(c, title);
        });
        if (!found) show = false;
      } else {
        show = false;
      }
    }

    if (show) {
      row.classList.remove('wcrm-hidden');
      // Separate pinned and unpinned for reordering (tolerant match)
      var isPinnedRow = Object.keys(pinned).some(function(pn) {
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

  // Reorder: pinned contacts first
  if (pinnedRows.length > 0 && hasAnyFilter) {
    pinnedRows.forEach(function(row) {
      container.insertBefore(row, container.firstChild);
    });
  }

  setupFilterObserver();
}

function setupFilterObserver() {
  if (sliceFilterObserver) sliceFilterObserver.disconnect();

  var hasAnyFilter = !!selectedMentor || (typeof selectedAbaId !== 'undefined' && selectedAbaId !== null);
  if (!hasAnyFilter) return;

  var pane = document.getElementById("pane-side");
  if (!pane) return;

  sliceFilterObserver = new MutationObserver(function(mutations) {
    // Only re-apply if children were added/removed (not attribute changes from our classes)
    var dominated = mutations.some(function(m) { return m.addedNodes.length > 0 || m.removedNodes.length > 0; });
    if (!dominated) return;
    clearTimeout(sliceFilterObserver._debounce);
    sliceFilterObserver._debounce = setTimeout(applyConversationFilters, 300);
  });

  sliceFilterObserver.observe(pane, { childList: true, subtree: true });
}

// Helper for ABAS (defined here so it's available; abas.js populates the data)
function getAbaContacts(abaId) {
  var data = window._wcrmAbasCache;
  if (!data || !data.tabs) return null;
  var tab = data.tabs.find(function(t) { return t.id === abaId; });
  return tab ? tab.contacts : null;
}

// ===== Init =====
function initSlice() {
  createSliceButton();
  createSliceSidebar();
}

// Start after authentication (only if 'slice' feature is enabled)
document.addEventListener("wcrm-auth-ready", function() {
  if (window.__ezapHasFeature && window.__ezapHasFeature("slice")) {
    setTimeout(initSlice, 600);
  } else {
    console.log("[WCRM SLICE] SLICE feature not enabled for this user");
  }
});
if (window.__wcrmAuth && window.__ezapHasFeature && window.__ezapHasFeature("slice")) setTimeout(initSlice, 1000);
