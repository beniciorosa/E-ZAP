// ===== E-ZAP Floating Top Widget (Pin + Abas + Etiquetas) =====
console.log("[EZAP WIDGET] Loaded");

var EZAP_WIDGET_ID = "ezap-top-widget";
var _ezapWidgetStateHash = "";

// ===== Style variants =====
function getWidgetStyleVariants() {
  var dark = typeof isDarkMode === "function" ? isDarkMode() : false;
  return {
    pill: dark ? {
      bg: "rgba(32,44,51,0.92)", border: "rgba(255,255,255,0.08)", shadow: "0 4px 20px rgba(0,0,0,0.35)",
      icon: "#d1d7db", iconHover: "#ffffff", accent: "#00a884", accentGlow: "#00a88430",
      dividerColor: "rgba(255,255,255,0.10)", backdropFilter: "blur(10px) saturate(140%)"
    } : {
      bg: "rgba(255,255,255,0.92)", border: "rgba(0,0,0,0.06)", shadow: "0 4px 20px rgba(0,0,0,0.12)",
      icon: "#54656f", iconHover: "#111b21", accent: "#00a884", accentGlow: "#00a88420",
      dividerColor: "rgba(0,0,0,0.08)", backdropFilter: "blur(10px) saturate(140%)"
    },
    glass: dark ? {
      bg: "linear-gradient(135deg, rgba(0,168,132,0.12) 0%, rgba(32,44,51,0.85) 100%)",
      border: "rgba(0,168,132,0.25)", shadow: "0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,168,132,0.1)",
      icon: "#e9edef", iconHover: "#00a884", accent: "#00a884", accentGlow: "#00a88440",
      dividerColor: "rgba(255,255,255,0.08)", backdropFilter: "blur(16px) saturate(180%)"
    } : {
      bg: "linear-gradient(135deg, rgba(0,168,132,0.10) 0%, rgba(255,255,255,0.92) 100%)",
      border: "rgba(0,168,132,0.20)", shadow: "0 8px 32px rgba(0,168,132,0.15), 0 0 0 1px rgba(0,168,132,0.08)",
      icon: "#3b4a54", iconHover: "#00a884", accent: "#00a884", accentGlow: "#00a88430",
      dividerColor: "rgba(0,0,0,0.06)", backdropFilter: "blur(16px) saturate(180%)"
    },
    minimal: dark ? {
      bg: "transparent", border: "transparent", shadow: "none",
      icon: "#8696a0", iconHover: "#00a884", accent: "#00a884", accentGlow: "#00a88425",
      dividerColor: "rgba(255,255,255,0.08)", backdropFilter: "none"
    } : {
      bg: "transparent", border: "transparent", shadow: "none",
      icon: "#667781", iconHover: "#00a884", accent: "#00a884", accentGlow: "#00a88420",
      dividerColor: "rgba(0,0,0,0.06)", backdropFilter: "none"
    },
    solid: dark ? {
      bg: "#202c33", border: "#2a3942", shadow: "0 2px 8px rgba(0,0,0,0.25)",
      icon: "#d1d7db", iconHover: "#ffffff", accent: "#00a884", accentGlow: "#00a88430",
      dividerColor: "#2a3942", backdropFilter: "none"
    } : {
      bg: "#ffffff", border: "#e9edef", shadow: "0 2px 8px rgba(11,20,26,0.08)",
      icon: "#54656f", iconHover: "#111b21", accent: "#00a884", accentGlow: "#00a88420",
      dividerColor: "#e9edef", backdropFilter: "none"
    }
  };
}

function getCurrentWidgetStyle() {
  var wc = window.__ezapWidgetConfig || {};
  var variant = wc.style || "pill";
  var variants = getWidgetStyleVariants();
  return variants[variant] || variants.pill;
}

// ===== Locate the chat header to anchor widget =====
function findChatHeaderRect() {
  var headers = document.querySelectorAll('header');
  for (var i = 0; i < headers.length; i++) {
    var r = headers[i].getBoundingClientRect();
    if (r.top < 80 && r.width > 300 && r.left > 200) {
      return r;
    }
  }
  return null;
}

function isChatOpen() {
  var inputBox = document.querySelector('[contenteditable="true"][data-tab="10"]') ||
                 document.querySelector('footer [contenteditable="true"]') ||
                 document.querySelector('div[role="textbox"][data-tab]');
  if (inputBox) return true;
  var header = findChatHeaderRect();
  return !!header;
}

// ===== Widget icons (SVG) =====
function svgPinOutline(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '" style="pointer-events:none"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2zM9 4v7.75L7.5 14h9L15 11.75V4H9z"/></svg>';
}
function svgPinFilled(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '" style="pointer-events:none"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg>';
}
function svgAbas(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '" style="pointer-events:none"><path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z"/></svg>';
}
function svgTag(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '" style="pointer-events:none"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>';
}
function svgSignature(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '" style="pointer-events:none"><path d="M20.71 4.04c-.39-.39-1.02-.39-1.41 0L14 9.34l-1.34-1.34c-.39-.39-1.02-.39-1.41 0s-.39 1.02 0 1.41l2.05 2.05c.39.39 1.02.39 1.41 0l6-6c.39-.39.39-1.02 0-1.42zM3.41 20.41l2.1-5.08 2.97 2.97-5.07 2.11zM9.17 16.62L6.38 13.83 16.45 3.76l2.79 2.79L9.17 16.62z"/></svg>';
}

// ===== Compute state hash (determines when full rebuild is needed) =====
function computeWidgetHash() {
  var wc = window.__ezapWidgetConfig || {};
  var chatName = typeof currentName !== "undefined" ? currentName : null;
  // JID-aware pin check (sync fallback por nome, refinado depois)
  var isPinned = !!(chatName && typeof window._wcrmIsTitlePinned === "function" && window._wcrmIsTitlePinned(chatName, null));
  var inAba = !!(chatName && typeof isContactInAnyAba === "function" && isContactInAnyAba(chatName));
  var dark = typeof isDarkMode === "function" ? isDarkMode() : false;
  var sigOn = !!(window.__wcrmAuth && window.__wcrmAuth.signatureEnabled);
  return JSON.stringify({
    pos: wc.position || "sidebar",
    style: wc.style || "pill",
    widgets: wc.widgets || {},
    chat: chatName,
    pinned: isPinned,
    inAba: inAba,
    sigOn: sigOn,
    dark: dark
  });
}

// ===== Build widget from scratch (only when state changes) =====
function buildWidget() {
  var wc = window.__ezapWidgetConfig || {};
  if (wc.position !== "floating") {
    var existing = document.getElementById(EZAP_WIDGET_ID);
    if (existing) existing.remove();
    _ezapWidgetStateHash = "";
    return null;
  }

  var s = getCurrentWidgetStyle();
  var variant = wc.style || "pill";

  var widget = document.getElementById(EZAP_WIDGET_ID);
  if (!widget) {
    widget = document.createElement("div");
    widget.id = EZAP_WIDGET_ID;
    document.body.appendChild(widget);
  }

  var gap = variant === "minimal" ? "2px" : "4px";
  var padding = variant === "minimal" ? "4px 8px" : "6px 10px";
  var borderRadius = variant === "glass" ? "14px" : "999px";

  Object.assign(widget.style, {
    position: "fixed",
    display: "flex",
    alignItems: "center",
    gap: gap,
    padding: padding,
    background: s.bg,
    border: "1px solid " + s.border,
    borderRadius: borderRadius,
    boxShadow: s.shadow,
    backdropFilter: s.backdropFilter,
    webkitBackdropFilter: s.backdropFilter,
    zIndex: "99999",
    pointerEvents: "auto",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    transition: "top 0.15s ease, left 0.15s ease"
  });

  widget.innerHTML = "";

  var btnSize = variant === "minimal" ? 32 : 36;
  var iconSize = variant === "minimal" ? 18 : 19;

  var widgets = (wc.widgets || {});
  // sig widget requires "signature" feature permission
  var hasSigFeature = window.__ezapHasFeature && window.__ezapHasFeature("signature");
  var items = [
    { key: "pin",  cfg: widgets.pin  || { enabled: true, order: 1 } },
    { key: "abas", cfg: widgets.abas || { enabled: true, order: 2 } },
    { key: "tags", cfg: widgets.tags || { enabled: true, order: 3 } },
    { key: "sig",  cfg: widgets.sig  || { enabled: false, order: 4 } }
  ].filter(function(x) {
    if (x.cfg.enabled === false) return false;
    if (x.key === "sig" && !hasSigFeature) return false;
    return true;
  });
  items.sort(function(a, b) { return (a.cfg.order || 0) - (b.cfg.order || 0); });

  items.forEach(function(item, idx) {
    if (idx > 0 && variant !== "minimal") {
      var divider = document.createElement("span");
      Object.assign(divider.style, {
        width: "1px", height: "20px", background: s.dividerColor, margin: "0 2px",
        pointerEvents: "none"
      });
      widget.appendChild(divider);
    }
    widget.appendChild(buildWidgetButton(item.key, btnSize, iconSize, s));
  });

  return widget;
}

function buildWidgetButton(key, btnSize, iconSize, s) {
  var btn = document.createElement("div");
  btn.setAttribute("role", "button");
  btn.id = "ezap-widget-btn-" + key;
  Object.assign(btn.style, {
    width: btnSize + "px",
    height: btnSize + "px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "all 0.15s ease",
    position: "relative",
    pointerEvents: "auto"
  });

  var chatName = typeof currentName !== "undefined" ? currentName : null;

  if (key === "pin") {
    // Match JID-first (via _wcrmIsTitlePinned), fallback nome tolerante.
    var isPinned = !!chatName && typeof window._wcrmIsTitlePinned === "function" && window._wcrmIsTitlePinned(chatName, null);
    btn.innerHTML = isPinned
      ? svgPinFilled(s.accent, iconSize)
      : svgPinOutline(s.icon, iconSize);
    btn.title = isPinned ? "Desafixar contato" : "Fixar contato";
    if (isPinned) btn.style.background = s.accentGlow;
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      e.preventDefault();
      var cn = typeof currentName !== "undefined" ? currentName : null;
      if (cn && typeof togglePinContact === "function") {
        togglePinContact(cn);
        setTimeout(function() { _ezapWidgetStateHash = ""; ensureWidget(); }, 100);
      }
    });
  } else if (key === "abas") {
    btn.innerHTML = svgAbas(s.icon, iconSize);
    btn.title = "Abas";
    if (chatName && typeof isContactInAnyAba === "function" && isContactInAnyAba(chatName)) {
      var dot = document.createElement("span");
      Object.assign(dot.style, {
        position: "absolute", top: "4px", right: "4px",
        width: "8px", height: "8px", borderRadius: "50%",
        background: "#8b5cf6", border: "1.5px solid " + (isDarkMode() ? "#111b21" : "#ffffff"),
        pointerEvents: "none"
      });
      btn.appendChild(dot);
    }
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      e.preventDefault();
      var cn = typeof currentName !== "undefined" ? currentName : null;
      if (cn && typeof showHeaderAbasDropdown === "function") {
        showHeaderAbasDropdown(btn, cn);
      }
    });
  } else if (key === "tags") {
    btn.innerHTML = svgTag(s.icon, iconSize);
    btn.title = "Etiquetas";
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      e.preventDefault();
      var cn = typeof currentName !== "undefined" ? currentName : null;
      if (cn && typeof showHeaderTagDropdown === "function") {
        showHeaderTagDropdown(btn, cn);
      } else if (typeof toggleTagSidebar === "function") {
        toggleTagSidebar();
      }
    });
  } else if (key === "sig") {
    var sigActive = !!(window.__wcrmAuth && window.__wcrmAuth.signatureEnabled);
    btn.innerHTML = svgSignature(sigActive ? s.accent : s.icon, iconSize);
    btn.title = sigActive ? "Assinatura ativada" : "Assinatura desativada";
    if (sigActive) btn.style.background = s.accentGlow;
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      e.preventDefault();
      if (typeof window.__ezapToggleSignature === "function") {
        window.__ezapToggleSignature();
        setTimeout(function() { _ezapWidgetStateHash = ""; ensureWidget(); }, 100);
      }
    });
  }

  btn.addEventListener("mouseenter", function() {
    btn.style.background = s.accentGlow;
    var svg = btn.querySelector("svg");
    if (svg && key !== "pin" && key !== "sig") svg.setAttribute("fill", s.iconHover);
  });
  btn.addEventListener("mouseleave", function() {
    var cn = typeof currentName !== "undefined" ? currentName : null;
    var isPinnedNow = key === "pin" && !!cn && typeof window._wcrmIsTitlePinned === "function" && window._wcrmIsTitlePinned(cn, null);
    var isSigOn = key === "sig" && !!(window.__wcrmAuth && window.__wcrmAuth.signatureEnabled);
    var keepActive = isPinnedNow || isSigOn;
    btn.style.background = keepActive ? s.accentGlow : "transparent";
    var svg = btn.querySelector("svg");
    if (svg && !keepActive && key !== "pin" && key !== "sig") svg.setAttribute("fill", s.icon);
  });

  return btn;
}

// ===== Lightweight position-only update (no DOM rebuild) =====
function positionWidget() {
  var wc = window.__ezapWidgetConfig || {};
  if (wc.position !== "floating") return;

  var widget = document.getElementById(EZAP_WIDGET_ID);
  if (!widget) return;

  if (!isChatOpen()) {
    widget.style.display = "none";
    return;
  }
  var header = findChatHeaderRect();
  if (!header) return;

  var variant = wc.style || "pill";
  var centerX = header.left + header.width / 2;
  var widgetHeight = variant === "minimal" ? 38 : 48;
  var top = header.top + (header.height - widgetHeight) / 2;

  widget.style.top = top + "px";
  widget.style.left = centerX + "px";
  widget.style.transform = "translateX(-50%)";
  widget.style.display = "flex";
}

// ===== Smart update: rebuild only on state change, reposition always =====
function ensureWidget() {
  var wc = window.__ezapWidgetConfig || {};
  if (wc.position !== "floating") {
    var existing = document.getElementById(EZAP_WIDGET_ID);
    if (existing) existing.remove();
    _ezapWidgetStateHash = "";
    return;
  }

  var newHash = computeWidgetHash();
  if (newHash !== _ezapWidgetStateHash || !document.getElementById(EZAP_WIDGET_ID)) {
    buildWidget();
    _ezapWidgetStateHash = newHash;
  }
  positionWidget();
}

// ===== Debounced scheduler =====
function scheduleReposition() {
  if (window.__ezapWidgetRaf) return;
  window.__ezapWidgetRaf = requestAnimationFrame(function() {
    window.__ezapWidgetRaf = null;
    positionWidget();
  });
}

window.addEventListener("resize", scheduleReposition);
window.addEventListener("scroll", scheduleReposition, true);

// Observe only structural DOM changes (chat switch), throttled
var _widgetEnsureTimer = null;
var widgetObserver = new MutationObserver(function() {
  scheduleReposition();
  // Also schedule a state-check (debounced 200ms) to catch chat switches fast
  if (_widgetEnsureTimer) clearTimeout(_widgetEnsureTimer);
  _widgetEnsureTimer = setTimeout(ensureWidget, 200);
});

function startWidgetObserver() {
  if (document.body) {
    widgetObserver.observe(document.body, { childList: true, subtree: true });
  }
}

// ===== Init =====
function initWidget() {
  startWidgetObserver();
  // Safety-net polling every 4s (primary detection is now event-based via __ezapRefreshWidget)
  setInterval(ensureWidget, 4000);
  ensureWidget();
}

document.addEventListener("wcrm-auth-ready", function() {
  var hasAbas = window.__ezapHasFeature && window.__ezapHasFeature("abas");
  var hasPin = window.__ezapHasFeature && window.__ezapHasFeature("pin");
  var hasSig = !!(window.__wcrmAuth && window.__wcrmAuth.signatureEnabled !== undefined);
  if (hasAbas || hasPin || hasSig) {
    setTimeout(initWidget, 1500);
  }
});
if (window.__wcrmAuth) {
  var _hasAbasW = window.__ezapHasFeature && window.__ezapHasFeature("abas");
  var _hasPinW = window.__ezapHasFeature && window.__ezapHasFeature("pin");
  var _hasSigW = !!(window.__wcrmAuth && window.__wcrmAuth.signatureEnabled !== undefined);
  if (_hasAbasW || _hasPinW || _hasSigW) {
    setTimeout(initWidget, 2000);
  }
}

window.__ezapRefreshWidget = function() { _ezapWidgetStateHash = ""; ensureWidget(); };
