// ===== CALLS — Widget do sidebar direito =====
// Mostra as calls da semana agrupadas em HOJE / AMANHA / SEMANA.
// Le direto de calls_events no Supabase (populado pelo cron do whatsapp-server).
// Clique numa linha abre o chat via ezapOpenChat.

console.log("[CALLS] Module loaded");

var _callsCache = null;        // { events, fetchedAt }
var _callsCacheTTL = 30 * 1000; // 30s
var _callsOpen = false;

function callsSupa(path) {
  return window.ezapSupaRest
    ? window.ezapSupaRest(path, "GET")
    : Promise.resolve(null);
}

// ===== Fetch events dos proximos 7 dias =====
function fetchCallsEvents(forceRefresh) {
  if (!forceRefresh && _callsCache && (Date.now() - _callsCache.fetchedAt < _callsCacheTTL)) {
    return Promise.resolve(_callsCache.events);
  }
  // Range: hoje 00:00 BRT -> hoje+7d 23:59 BRT
  var now = new Date();
  var brtNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  var today = brtNow.toISOString().substring(0, 10);
  var startIso = new Date(today + "T00:00:00-03:00").toISOString();
  var endIso = new Date(new Date(today + "T00:00:00-03:00").getTime() + 8 * 24 * 60 * 60 * 1000 - 1000).toISOString();

  var path = "/rest/v1/calls_events" +
    "?start_time=gte." + encodeURIComponent(startIso) +
    "&start_time=lte." + encodeURIComponent(endIso) +
    "&select=meeting_id,start_time,end_time,title,phone,primary_jid,jid_type,contact_name" +
    "&order=start_time.asc";

  return callsSupa(path).then(function(rows) {
    var events = Array.isArray(rows) ? rows : [];
    _callsCache = { events: events, fetchedAt: Date.now() };
    return events;
  }).catch(function(e) {
    console.warn("[CALLS] fetch failed:", e && e.message);
    return [];
  });
}

// ===== Helpers de data =====
function _callsDateKey(d) {
  // Retorna YYYY-MM-DD em BRT (UTC-3)
  var brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().substring(0, 10);
}

function _callsFormatTime(iso) {
  var d = new Date(iso);
  var brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  var hh = String(brt.getUTCHours()).padStart(2, "0");
  var mm = String(brt.getUTCMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}

function _callsFormatDayLabel(key) {
  // key = YYYY-MM-DD, retorna "Quarta 22/04"
  var parts = key.split("-");
  var d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
  var days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  return days[d.getUTCDay()] + " " + parts[2] + "/" + parts[1];
}

// ===== Agrupa events em {today, tomorrow, week: [{dayKey, label, events}]} =====
function groupCallsEvents(events) {
  var now = new Date();
  var brtNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  var todayKey = brtNow.toISOString().substring(0, 10);

  var tomorrowDate = new Date(brtNow.getTime() + 24 * 60 * 60 * 1000);
  var tomorrowKey = tomorrowDate.toISOString().substring(0, 10);

  var today = [];
  var tomorrow = [];
  var weekByDay = {}; // { dayKey: [events] }
  var dayOrder = []; // pra preservar ordem

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var dk = _callsDateKey(new Date(ev.start_time));
    if (dk === todayKey) {
      today.push(ev);
    } else if (dk === tomorrowKey) {
      tomorrow.push(ev);
    } else if (dk > tomorrowKey) {
      if (!weekByDay[dk]) { weekByDay[dk] = []; dayOrder.push(dk); }
      weekByDay[dk].push(ev);
    }
  }
  var week = dayOrder.map(function(dk) {
    return { dayKey: dk, label: _callsFormatDayLabel(dk), events: weekByDay[dk] };
  });
  return { today: today, tomorrow: tomorrow, week: week };
}

// ===== Escape HTML =====
function _callsEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ===== Render =====
function renderCallsContent() {
  var content = document.getElementById("calls-content");
  if (!content) return;
  content.innerHTML = '<div class="ezap-loading"><span class="ezap-spinner ezap-spinner--sm" style="margin-right:8px"></span>Carregando calls...</div>';

  fetchCallsEvents().then(function(events) {
    var groups = groupCallsEvents(events);

    var parts = [];
    parts.push(_renderSection("today", "🎥 HOJE", groups.today, true));
    parts.push(_renderSection("tomorrow", "📅 AMANHÃ", groups.tomorrow, false));
    parts.push(_renderWeekSection(groups.week));

    content.innerHTML = parts.join("");

    // Click handlers
    content.querySelectorAll(".calls-item").forEach(function(li) {
      li.addEventListener("click", function() {
        var jid = this.getAttribute("data-jid");
        var name = this.getAttribute("data-name") || "";
        _openCallChat(jid, name);
      });
    });

    // Accordion toggle
    content.querySelectorAll(".calls-section-header").forEach(function(h) {
      h.addEventListener("click", function() {
        var sec = this.closest(".calls-section");
        if (sec) sec.classList.toggle("collapsed");
      });
    });
  });
}

function _renderSection(key, label, events, expandedByDefault) {
  var cls = "calls-section" + (expandedByDefault ? "" : " collapsed");
  var header = '<div class="calls-section-header">' +
    '<span class="calls-section-chevron">▸</span>' +
    '<span class="calls-section-label">' + _callsEsc(label) + '</span>' +
    '<span class="calls-section-count">' + events.length + '</span>' +
    '</div>';
  var body;
  if (events.length === 0) {
    body = '<div class="calls-empty">Sem calls</div>';
  } else {
    body = '<ul class="calls-list">' + events.map(_renderCallItem).join("") + '</ul>';
  }
  return '<section class="' + cls + '" data-section="' + key + '">' + header +
    '<div class="calls-section-body">' + body + '</div></section>';
}

function _renderWeekSection(weekDays) {
  var total = weekDays.reduce(function(acc, d) { return acc + d.events.length; }, 0);
  var header = '<div class="calls-section-header">' +
    '<span class="calls-section-chevron">▸</span>' +
    '<span class="calls-section-label">🗓 ESTA SEMANA</span>' +
    '<span class="calls-section-count">' + total + '</span>' +
    '</div>';
  var body;
  if (weekDays.length === 0) {
    body = '<div class="calls-empty">Sem calls agendadas</div>';
  } else {
    body = weekDays.map(function(d) {
      return '<div class="calls-week-day">' +
        '<h4 class="calls-week-day-label">' + _callsEsc(d.label) + '</h4>' +
        '<ul class="calls-list">' + d.events.map(_renderCallItem).join("") + '</ul>' +
        '</div>';
    }).join("");
  }
  return '<section class="calls-section collapsed" data-section="week">' + header +
    '<div class="calls-section-body">' + body + '</div></section>';
}

function _renderCallItem(ev) {
  var time = _callsFormatTime(ev.start_time);
  var displayName = ev.contact_name || ev.phone || "Sem nome";
  var typeLabel = ev.jid_type === "group" ? "grupo" : (ev.jid_type === "lid" ? "chat" : "");
  var title = ev.title || "";
  var jid = ev.primary_jid || "";
  var clickable = jid ? "" : " calls-item--disabled";
  return '<li class="calls-item' + clickable + '" data-jid="' + _callsEsc(jid) + '" data-name="' + _callsEsc(displayName) + '" title="' + _callsEsc(title) + '">' +
    '<span class="calls-item-time">' + time + '</span>' +
    '<div class="calls-item-main">' +
      '<span class="calls-item-name">' + _callsEsc(displayName) + '</span>' +
      (typeLabel ? '<span class="calls-item-type">' + typeLabel + '</span>' : '') +
      (title ? '<span class="calls-item-title">' + _callsEsc(title) + '</span>' : '') +
    '</div>' +
  '</li>';
}

function _openCallChat(jid, name) {
  if (!jid) {
    console.warn("[CALLS] jid vazio — não dá pra abrir");
    return;
  }
  if (!window.ezapOpenChat) {
    console.warn("[CALLS] ezapOpenChat não disponível");
    return;
  }
  window.ezapOpenChat(jid, name).then(function(result) {
    if (!result || !result.ok) {
      console.warn("[CALLS] falha ao abrir chat:", result);
    }
  });
}

// ===== Button =====
function createCallsButton() {
  if (document.getElementById("calls-toggle")) return;
  var btn = document.createElement("button");
  btn.id = "calls-toggle";
  btn.className = "escalada-crm ezap-float-btn";
  btn.setAttribute("data-tooltip", "CALLS");
  btn.title = "CALLS — Reuniões da semana";
  btn.addEventListener("click", toggleCallsSidebar);
  if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "calls");
  else { btn.textContent = "CALLS"; btn.style.background = "#ef4444"; btn.style.color = "#fff"; }
  var container = document.getElementById("ezap-float-container");
  if (container) container.appendChild(btn);
  else document.body.appendChild(btn);
}

function toggleCallsSidebar() {
  var sidebar = document.getElementById("calls-sidebar");
  if (!sidebar) {
    createCallsSidebar();
  }
  if (window.ezapSidebar) { ezapSidebar.toggle('calls'); return; }
  _callsOpen = !_callsOpen;
  sidebar = document.getElementById("calls-sidebar");
  if (_callsOpen) {
    sidebar.classList.add("open");
    renderCallsContent();
  } else {
    sidebar.classList.remove("open");
  }
}

function createCallsSidebar() {
  if (document.getElementById("calls-sidebar")) return;

  var sidebar = document.createElement("div");
  sidebar.id = "calls-sidebar";
  sidebar.className = "escalada-crm ezap-sidebar";

  var header = document.createElement("div");
  header.className = "ezap-header";
  header.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px">' +
      '<div style="width:32px;height:32px;border-radius:50%;background:#ef4444;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff">📞</div>' +
      '<h3 class="ezap-header-title">CALLS</h3>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:6px">' +
      '<button id="calls-refresh-btn" title="Recarregar" class="ezap-header-action" style="background:transparent;border:none;color:inherit;cursor:pointer;font-size:16px;padding:4px 8px;border-radius:6px">↻</button>' +
    '</div>';
  var closeBtn = document.createElement("button");
  closeBtn.className = "ezap-header-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", toggleCallsSidebar);
  header.appendChild(closeBtn);
  sidebar.appendChild(header);

  var contentDiv = document.createElement("div");
  contentDiv.id = "calls-content";
  contentDiv.className = "ezap-content calls-content";
  sidebar.appendChild(contentDiv);

  document.body.appendChild(sidebar);

  // Bind refresh
  var refreshBtn = document.getElementById("calls-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      _callsCache = null;
      renderCallsContent();
    });
  }

  if (window.ezapSidebar) {
    window.ezapSidebar.register('calls', {
      show: function() {
        _callsOpen = true;
        var sb = document.getElementById("calls-sidebar");
        if (sb) sb.classList.add("open");
      },
      hide: function() {
        _callsOpen = false;
        var sb = document.getElementById("calls-sidebar");
        if (sb) sb.classList.remove("open");
      },
      onOpen: function() { renderCallsContent(); },
      shrinkApp: true,
      closesOthers: true,
    });
  }
}

// ===== Init =====
function initCalls() {
  console.log("[CALLS] Initializing...");
  createCallsButton();
  createCallsSidebar();
  console.log("[CALLS] Ready!");
}

document.addEventListener("wcrm-auth-ready", function() {
  if (window.__ezapHasFeature && window.__ezapHasFeature("calls")) {
    setTimeout(initCalls, 1200);
  } else {
    console.log("[CALLS] Feature not enabled for this user");
  }
});
if (window.__wcrmAuth && window.__ezapHasFeature && window.__ezapHasFeature("calls")) {
  setTimeout(initCalls, 3200);
}
