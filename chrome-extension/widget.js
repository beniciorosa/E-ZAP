// ===== E-ZAP Floating Top Widget (Pin + Abas + Etiquetas) =====
console.log("[EZAP WIDGET] Loaded");

var EZAP_WIDGET_ID = "ezap-top-widget";

// ===== Style variants =====
function getWidgetStyleVariants() {
  var dark = typeof isDarkMode === "function" ? isDarkMode() : false;
  return {
    pill: dark ? {
      bg: "rgba(32,44,51,0.92)", border: "rgba(255,255,255,0.08)", shadow: "0 4px 20px rgba(0,0,0,0.35)",
      icon: "#d1d7db", iconHover: "#ffffff", accent: "#25d366", accentGlow: "#25d36630",
      dividerColor: "rgba(255,255,255,0.10)", backdropFilter: "blur(10px) saturate(140%)"
    } : {
      bg: "rgba(255,255,255,0.92)", border: "rgba(0,0,0,0.06)", shadow: "0 4px 20px rgba(0,0,0,0.12)",
      icon: "#54656f", iconHover: "#111b21", accent: "#00a884", accentGlow: "#00a88420",
      dividerColor: "rgba(0,0,0,0.08)", backdropFilter: "blur(10px) saturate(140%)"
    },
    glass: dark ? {
      bg: "linear-gradient(135deg, rgba(37,211,102,0.12) 0%, rgba(32,44,51,0.85) 100%)",
      border: "rgba(37,211,102,0.25)", shadow: "0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(37,211,102,0.1)",
      icon: "#e9edef", iconHover: "#25d366", accent: "#25d366", accentGlow: "#25d36640",
      dividerColor: "rgba(255,255,255,0.08)", backdropFilter: "blur(16px) saturate(180%)"
    } : {
      bg: "linear-gradient(135deg, rgba(0,168,132,0.10) 0%, rgba(255,255,255,0.92) 100%)",
      border: "rgba(0,168,132,0.20)", shadow: "0 8px 32px rgba(0,168,132,0.15), 0 0 0 1px rgba(0,168,132,0.08)",
      icon: "#3b4a54", iconHover: "#00a884", accent: "#00a884", accentGlow: "#00a88430",
      dividerColor: "rgba(0,0,0,0.06)", backdropFilter: "blur(16px) saturate(180%)"
    },
    minimal: dark ? {
      bg: "transparent", border: "transparent", shadow: "none",
      icon: "#8696a0", iconHover: "#25d366", accent: "#25d366", accentGlow: "#25d36625",
      dividerColor: "rgba(255,255,255,0.08)", backdropFilter: "none"
    } : {
      bg: "transparent", border: "transparent", shadow: "none",
      icon: "#667781", iconHover: "#00a884", accent: "#00a884", accentGlow: "#00a88420",
      dividerColor: "rgba(0,0,0,0.06)", backdropFilter: "none"
    },
    solid: dark ? {
      bg: "#202c33", border: "#2a3942", shadow: "0 2px 8px rgba(0,0,0,0.25)",
      icon: "#d1d7db", iconHover: "#ffffff", accent: "#25d366", accentGlow: "#25d36630",
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
  // WhatsApp header = top bar of the conversation pane
  var headers = document.querySelectorAll('header');
  for (var i = 0; i < headers.length; i++) {
    var r = headers[i].getBoundingClientRect();
    // Looking for a header that is not on the far left (chat list column)
    // and is at the top of the viewport
    if (r.top < 80 && r.width > 300 && r.left > 200) {
      return r;
    }
  }
  return null;
}

function isChatOpen() {
  // Conversation is open if input box exists
  var inputBox = document.querySelector('[contenteditable="true"][data-tab="10"]') ||
                 document.querySelector('footer [contenteditable="true"]') ||
                 document.querySelector('div[role="textbox"][data-tab]');
  if (inputBox) return true;
  // Fallback: chat header with contact name is visible
  var header = findChatHeaderRect();
  return !!header;
}

// ===== Widget icons (SVG) =====
function svgPinOutline(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2zM9 4v7.75L7.5 14h9L15 11.75V4H9z"/></svg>';
}
function svgPinFilled(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '"><path d="M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z"/></svg>';
}
function svgAbas(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '"><path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z"/></svg>';
}
function svgTag(color, sz) {
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="' + color + '"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>';
}

// ===== Create / update widget =====
function ensureWidget() {
  var wc = window.__ezapWidgetConfig || {};
  if (wc.position !== "floating") {
    var existing = document.getElementById(EZAP_WIDGET_ID);
    if (existing) existing.remove();
    return;
  }

  if (!isChatOpen()) {
    var w0 = document.getElementById(EZAP_WIDGET_ID);
    if (w0) w0.style.display = "none";
    return;
  }

  var header = findChatHeaderRect();
  if (!header) return;

  var s = getCurrentWidgetStyle();
  var variant = (window.__ezapWidgetConfig || {}).style || "pill";

  var widget = document.getElementById(EZAP_WIDGET_ID);
  if (!widget) {
    widget = document.createElement("div");
    widget.id = EZAP_WIDGET_ID;
    document.body.appendChild(widget);
  }

  // Size & style by variant
  var btnSize = variant === "minimal" ? 32 : 36;
  var iconSize = variant === "minimal" ? 18 : 19;
  var padding = variant === "minimal" ? "4px 8px" : "6px 10px";
  var gap = variant === "minimal" ? "2px" : "4px";
  var borderRadius = variant === "glass" ? "14px" : "999px";

  // Position centered in header area (above or inside)
  var centerX = header.left + header.width / 2;
  var top = header.top + (header.height - (variant === "minimal" ? 38 : 48)) / 2;

  Object.assign(widget.style, {
    position: "fixed",
    top: top + "px",
    left: centerX + "px",
    transform: "translateX(-50%)",
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
    zIndex: "999",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    transition: "top 0.15s ease, left 0.15s ease"
  });

  // Clear and rebuild (preserves styles, rebuilds children)
  widget.innerHTML = "";

  // Build buttons in order
  var widgets = (wc.widgets || {});
  var items = [
    { key: "pin",  cfg: widgets.pin  || { enabled: true, order: 1 } },
    { key: "abas", cfg: widgets.abas || { enabled: true, order: 2 } },
    { key: "tags", cfg: widgets.tags || { enabled: true, order: 3 } }
  ].filter(function(x) { return x.cfg.enabled !== false; });
  items.sort(function(a, b) { return (a.cfg.order || 0) - (b.cfg.order || 0); });

  items.forEach(function(item, idx) {
    if (idx > 0 && variant !== "minimal") {
      var divider = document.createElement("span");
      Object.assign(divider.style, {
        width: "1px", height: "20px", background: s.dividerColor, margin: "0 2px"
      });
      widget.appendChild(divider);
    }
    widget.appendChild(buildWidgetButton(item.key, btnSize, iconSize, s));
  });

  widget.style.display = "flex";
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
    position: "relative"
  });

  var chatName = typeof currentName !== "undefined" ? currentName : null;

  if (key === "pin") {
    var isPinned = !!(chatName && (window._wcrmPinned || {})[chatName]);
    btn.innerHTML = isPinned
      ? svgPinFilled(s.accent, iconSize)
      : svgPinOutline(s.icon, iconSize);
    btn.title = isPinned ? "Desafixar contato" : "Fixar contato";
    if (isPinned) btn.style.background = s.accentGlow;
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      var cn = typeof currentName !== "undefined" ? currentName : null;
      if (cn && typeof togglePinContact === "function") {
        togglePinContact(cn);
        setTimeout(ensureWidget, 100);
      }
    });
  } else if (key === "abas") {
    btn.innerHTML = svgAbas(s.icon, iconSize);
    btn.title = "Abas";
    // Indicator dot
    if (chatName && typeof isContactInAnyAba === "function" && isContactInAnyAba(chatName)) {
      var dot = document.createElement("span");
      Object.assign(dot.style, {
        position: "absolute", top: "4px", right: "4px",
        width: "8px", height: "8px", borderRadius: "50%",
        background: "#cc5de8", border: "1.5px solid " + (isDarkMode() ? "#111b21" : "#ffffff")
      });
      btn.appendChild(dot);
    }
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
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
      if (typeof toggleTagSidebar === "function") toggleTagSidebar();
    });
  }

  btn.addEventListener("mouseenter", function() {
    btn.style.background = s.accentGlow;
    var svg = btn.querySelector("svg");
    if (svg && key !== "pin") svg.setAttribute("fill", s.iconHover);
  });
  btn.addEventListener("mouseleave", function() {
    var cn = typeof currentName !== "undefined" ? currentName : null;
    var isPinnedNow = key === "pin" && !!(cn && (window._wcrmPinned || {})[cn]);
    btn.style.background = isPinnedNow ? s.accentGlow : "transparent";
    var svg = btn.querySelector("svg");
    if (svg && !isPinnedNow && key !== "pin") svg.setAttribute("fill", s.icon);
  });

  return btn;
}

// ===== Reposition on resize / scroll / sidebar toggles =====
function scheduleWidgetUpdate() {
  if (window.__ezapWidgetRaf) return;
  window.__ezapWidgetRaf = requestAnimationFrame(function() {
    window.__ezapWidgetRaf = null;
    ensureWidget();
  });
}

window.addEventListener("resize", scheduleWidgetUpdate);
window.addEventListener("scroll", scheduleWidgetUpdate, true);

// Observe DOM changes (chat switches, sidebar opens/closes)
var widgetObserver = new MutationObserver(function() { scheduleWidgetUpdate(); });

function startWidgetObserver() {
  if (document.body) {
    widgetObserver.observe(document.body, { childList: true, subtree: true });
  }
}

// ===== Init =====
function initWidget() {
  startWidgetObserver();
  setInterval(ensureWidget, 2000);
  ensureWidget();
}

document.addEventListener("wcrm-auth-ready", function() {
  var hasAbas = window.__ezapHasFeature && window.__ezapHasFeature("abas");
  var hasPin = window.__ezapHasFeature && window.__ezapHasFeature("pin");
  if (hasAbas || hasPin) {
    setTimeout(initWidget, 1500);
  }
});
if (window.__wcrmAuth) {
  var _hasAbasW = window.__ezapHasFeature && window.__ezapHasFeature("abas");
  var _hasPinW = window.__ezapHasFeature && window.__ezapHasFeature("pin");
  if (_hasAbasW || _hasPinW) {
    setTimeout(initWidget, 2000);
  }
}

window.__ezapRefreshWidget = ensureWidget;
