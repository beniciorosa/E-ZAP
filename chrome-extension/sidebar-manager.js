// ===== E-ZAP Sidebar Manager =====
// Centralized sidebar lifecycle: mutual exclusion, app width, floating buttons,
// tab bar navigation, resizable width, drag-and-drop button reordering
// Usage: ezapSidebar.register("crm", { show, hide, onOpen }), ezapSidebar.toggle("crm")
(function() {
  "use strict";
  var _sidebars = {};
  var SIDEBAR_W = 340; // Loaded from storage on init
  var RAIL_W = 62;
  var MIN_W = 280;
  var MAX_W = 500;
  var STORAGE_KEY_WIDTH = "ezap_sidebar_width";
  var STORAGE_KEY_ORDER = "ezap_button_order";

  // Load saved sidebar width
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.get(STORAGE_KEY_WIDTH, function(data) {
      if (data && data[STORAGE_KEY_WIDTH]) {
        SIDEBAR_W = Math.max(MIN_W, Math.min(MAX_W, data[STORAGE_KEY_WIDTH]));
        _applySidebarWidth();
      }
    });
  }

  function _applySidebarWidth() {
    document.documentElement.style.setProperty('--ezap-sidebar-w', SIDEBAR_W + 'px');
    // Update any open sidebar
    var anyShrinkOpen = Object.keys(_sidebars).some(function(k) {
      return _sidebars[k].isOpen && _sidebars[k].shrinkApp;
    });
    if (anyShrinkOpen) _setAppWidth(true);
    // Update shifted rail
    var container = document.getElementById("ezap-float-container");
    if (container && container.classList.contains("ezap-rail--shifted")) {
      container.style.right = SIDEBAR_W + "px";
    }
    // Update all open sidebars width
    document.querySelectorAll(".ezap-sidebar.open").forEach(function(sb) {
      sb.style.width = SIDEBAR_W + "px";
    });
  }

  /**
   * Adjust WhatsApp app width when sidebar opens/closes
   */
  function _setAppWidth(open) {
    var appEl = document.getElementById("app");
    if (!appEl) return;
    if (open) {
      appEl.style.width = "calc(100% - " + (SIDEBAR_W + RAIL_W) + "px)";
      appEl.style.maxWidth = "calc(100% - " + (SIDEBAR_W + RAIL_W) + "px)";
      appEl.style.marginRight = "0";
    } else {
      appEl.style.width = "calc(100% - " + RAIL_W + "px)";
      appEl.style.maxWidth = "calc(100% - " + RAIL_W + "px)";
      appEl.style.marginRight = "";
    }
  }

  /**
   * Reposition floating rail when sidebar opens/closes
   */
  function _updateFloats() {
    var container = document.getElementById("ezap-float-container");
    if (!container) return;
    var anyShrinkOpen = Object.keys(_sidebars).some(function(k) {
      return _sidebars[k].isOpen && _sidebars[k].shrinkApp;
    });
    if (anyShrinkOpen) {
      container.classList.add("ezap-rail--shifted");
      container.style.right = SIDEBAR_W + "px";
    } else {
      container.classList.remove("ezap-rail--shifted");
      container.style.right = "";
    }
    container.style.display = "flex";
    // Cleanup legacy collapse button if still in DOM
    var oldCollapseBtn = document.getElementById("ezap-collapse-btn");
    if (oldCollapseBtn) oldCollapseBtn.remove();
    _highlightActiveButton();
    _positionResizeHandle();
  }

  // ===== Tab Bar =====
  var _tabIcons = {
    crm: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    msg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    abas: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
    geia: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1v3h-1.07A7 7 0 0 1 14 20h-4a7 7 0 0 1-6.93-2H2v-3h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/></svg>',
    admin_overlay: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    calls: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>'
  };

  var _tabLabels = {
    crm: "CRM", msg: "MSG", abas: "ABAS", geia: "GEIA", admin_overlay: "SPV", calls: "CALLS"
  };

  var _tabFeatures = {
    crm: "crm", msg: "msg", abas: "abas", geia: "geia", admin_overlay: "admin_overlay", calls: "calls"
  };

  function _buildTabBar(activeName) {
    var bar = document.createElement("div");
    bar.className = "ezap-tab-bar";
    bar.id = "ezap-tab-bar";

    var tabOrder = ["crm", "msg", "abas", "geia", "admin_overlay", "calls"];
    tabOrder.forEach(function(name) {
      if (!_sidebars[name]) return;
      // Check feature flag
      if (window.__ezapHasFeature && !window.__ezapHasFeature(_tabFeatures[name])) return;

      var tab = document.createElement("button");
      tab.className = "ezap-tab-item" + (name === activeName ? " ezap-tab-item--active" : "");
      tab.dataset.tab = name;
      tab.title = _tabLabels[name] || name;
      tab.innerHTML = (_tabIcons[name] || '') + '<span>' + (_tabLabels[name] || name) + '</span>';
      tab.addEventListener("click", function(e) {
        e.stopPropagation();
        if (name === activeName) return; // Already active
        window.ezapSidebar.open(name);
      });
      bar.appendChild(tab);
    });
    return bar;
  }

  function _injectTabBar(sidebarName) {
    // Remove old tab bar from any sidebar
    var old = document.getElementById("ezap-tab-bar");
    if (old) old.remove();

    // Find the open sidebar element
    var sidebarEl = null;
    var sidebarIds = {
      crm: "wcrm-sidebar", msg: "wcrm-msg-sidebar", abas: "wcrm-abas-sidebar",
      geia: "geia-sidebar", admin_overlay: "admin-overlay-sidebar",
      calls: "calls-sidebar"
    };
    var elId = sidebarIds[sidebarName];
    if (elId) sidebarEl = document.getElementById(elId);
    if (!sidebarEl) return;

    var bar = _buildTabBar(sidebarName);
    // Insert after the header (first child)
    var header = sidebarEl.querySelector(".ezap-header");
    if (header && header.nextSibling) {
      sidebarEl.insertBefore(bar, header.nextSibling);
    } else if (header) {
      sidebarEl.appendChild(bar);
    } else {
      sidebarEl.insertBefore(bar, sidebarEl.firstChild);
    }
  }

  // ===== Resize Handle =====
  // Resize handle — positioned on body as fixed element, aligned to sidebar left edge
  function _ensureResizeHandle() {
    if (document.getElementById("ezap-sidebar-resize-handle")) return;
    var handle = document.createElement("div");
    handle.id = "ezap-sidebar-resize-handle";
    handle.className = "ezap-resize-handle";
    document.body.appendChild(handle);
    _positionResizeHandle();

    var startX, startW;
    handle.addEventListener("mousedown", function(e) {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startW = SIDEBAR_W;
      handle.classList.add("ezap-resize-handle--active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      function onMove(ev) {
        var diff = startX - ev.clientX; // Moving left = wider
        var newW = Math.max(MIN_W, Math.min(MAX_W, startW + diff));
        SIDEBAR_W = newW;
        _applySidebarWidth();
        _positionResizeHandle();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        handle.classList.remove("ezap-resize-handle--active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        var obj = {};
        obj[STORAGE_KEY_WIDTH] = SIDEBAR_W;
        if (chrome.storage) chrome.storage.local.set(obj);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function _positionResizeHandle() {
    var handle = document.getElementById("ezap-sidebar-resize-handle");
    if (!handle) return;
    var anyShrinkOpen = Object.keys(_sidebars).some(function(k) {
      return _sidebars[k].isOpen && _sidebars[k].shrinkApp;
    });
    if (anyShrinkOpen) {
      handle.style.display = "block";
      handle.style.right = (SIDEBAR_W + RAIL_W - 3) + "px";
    } else {
      handle.style.display = "none";
    }
  }

  // ===== Drag-and-Drop Button Reorder =====
  var _dragSrc = null;

  function _enableButtonReorder() {
    var container = document.getElementById("ezap-float-container");
    if (!container) return;
    var btns = container.querySelectorAll(".ezap-float-btn");
    btns.forEach(function(btn) {
      if (btn.getAttribute("draggable") === "true") return; // Already set up
      btn.setAttribute("draggable", "true");

      btn.addEventListener("dragstart", function(e) {
        _dragSrc = btn;
        btn.classList.add("ezap-btn-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", btn.id);
      });

      btn.addEventListener("dragend", function() {
        btn.classList.remove("ezap-btn-dragging");
        container.querySelectorAll(".ezap-float-btn").forEach(function(b) {
          b.classList.remove("ezap-btn-dragover");
        });
        _dragSrc = null;
      });

      btn.addEventListener("dragover", function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (_dragSrc && _dragSrc !== btn) {
          btn.classList.add("ezap-btn-dragover");
        }
      });

      btn.addEventListener("dragleave", function() {
        btn.classList.remove("ezap-btn-dragover");
      });

      btn.addEventListener("drop", function(e) {
        e.preventDefault();
        btn.classList.remove("ezap-btn-dragover");
        if (!_dragSrc || _dragSrc === btn) return;
        // Reorder in DOM
        var allBtns = Array.from(container.querySelectorAll(".ezap-float-btn"));
        var srcIdx = allBtns.indexOf(_dragSrc);
        var dstIdx = allBtns.indexOf(btn);
        if (srcIdx < dstIdx) {
          container.insertBefore(_dragSrc, btn.nextSibling);
        } else {
          container.insertBefore(_dragSrc, btn);
        }
        _saveButtonOrder();
      });
    });
  }

  function _saveButtonOrder() {
    var container = document.getElementById("ezap-float-container");
    if (!container) return;
    var order = [];
    container.querySelectorAll(".ezap-float-btn").forEach(function(btn) {
      if (btn.id) order.push(btn.id);
    });
    var obj = {};
    obj[STORAGE_KEY_ORDER] = order;
    if (chrome.storage) chrome.storage.local.set(obj);
  }

  function _restoreButtonOrder() {
    if (!chrome.storage) return;
    chrome.storage.local.get(STORAGE_KEY_ORDER, function(data) {
      var order = data && data[STORAGE_KEY_ORDER];
      if (!order || !Array.isArray(order) || order.length === 0) return;
      var container = document.getElementById("ezap-float-container");
      if (!container) return;
      // Reorder buttons based on saved order
      order.forEach(function(btnId) {
        var btn = document.getElementById(btnId);
        if (btn && btn.parentElement === container) {
          container.appendChild(btn); // Move to end (builds order)
        }
      });
      _enableButtonReorder();
    });
  }

  /**
   * Add/remove visual indicator on the button of the currently open sidebar
   */
  var _buttonMap = {
    crm: "wcrm-toggle",
    msg: "wcrm-msg-toggle",
    abas: "wcrm-abas-toggle",
    geia: "geia-toggle",
    admin_overlay: "admin-overlay-toggle",
    calls: "calls-toggle",
  };

  function _highlightActiveButton() {
    Object.keys(_buttonMap).forEach(function(name) {
      var btn = document.getElementById(_buttonMap[name]);
      if (!btn) return;
      var sb = _sidebars[name];
      if (sb && sb.isOpen) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  window.ezapSidebar = {
    register: function(name, opts) {
      _sidebars[name] = {
        isOpen: false,
        show: opts.show,
        hide: opts.hide,
        onOpen: opts.onOpen || null,
        shrinkApp: opts.shrinkApp !== false,
        closesOthers: opts.closesOthers !== false,
      };
    },

    open: function(name) {
      var sb = _sidebars[name];
      if (!sb || sb.isOpen) return;
      if (sb.closesOthers) {
        Object.keys(_sidebars).forEach(function(key) {
          if (key !== name && _sidebars[key].isOpen && _sidebars[key].closesOthers) {
            window.ezapSidebar.close(key);
          }
        });
      }
      sb.isOpen = true;
      sb.show();
      if (sb.shrinkApp) _setAppWidth(true);
      _updateFloats();
      _injectTabBar(name);
      _ensureResizeHandle();
      _enableButtonReorder();
      if (sb.onOpen) sb.onOpen();
      if (window.ezapBus) window.ezapBus.emit("sidebar:opened", { name: name });
    },

    close: function(name) {
      var sb = _sidebars[name];
      if (!sb || !sb.isOpen) return;
      sb.isOpen = false;
      sb.hide();
      // Remove tab bar when closing
      var tabBar = document.getElementById("ezap-tab-bar");
      if (tabBar) tabBar.remove();
      var anyShrink = Object.keys(_sidebars).some(function(k) {
        return _sidebars[k].isOpen && _sidebars[k].shrinkApp;
      });
      if (!anyShrink) _setAppWidth(false);
      _updateFloats();
      if (window.ezapBus) window.ezapBus.emit("sidebar:closed", { name: name });
    },

    toggle: function(name) {
      var sb = _sidebars[name];
      if (!sb) return;
      if (sb.isOpen) window.ezapSidebar.close(name);
      else window.ezapSidebar.open(name);
    },

    isOpen: function(name) {
      return _sidebars[name] ? _sidebars[name].isOpen : false;
    },

    anyOpen: function() {
      return Object.keys(_sidebars).some(function(k) { return _sidebars[k].isOpen; });
    },

    closeAll: function() {
      Object.keys(_sidebars).forEach(function(k) {
        if (_sidebars[k].isOpen) window.ezapSidebar.close(k);
      });
    }
  };

  // Restore button order after buttons are created (delay to let modules init)
  setTimeout(_restoreButtonOrder, 4000);

  console.log("[EZAP] Sidebar manager loaded (tabs + resize + reorder)");
})();
