// ===== E-ZAP Sidebar Manager =====
// Centralized sidebar lifecycle: mutual exclusion, app width, floating buttons
// Usage: ezapSidebar.register("crm", { show, hide, onOpen }), ezapSidebar.toggle("crm")
(function() {
  "use strict";
  var _sidebars = {};
  var SIDEBAR_W = 340;
  var RAIL_W = 62;

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
      // Restore to just rail width
      appEl.style.width = "calc(100% - " + RAIL_W + "px)";
      appEl.style.maxWidth = "calc(100% - " + RAIL_W + "px)";
      appEl.style.marginRight = "";
    }
  }

  /**
   * Reposition floating rail when sidebar opens/closes
   */
  var _collapsed = false;

  function _updateFloats() {
    var container = document.getElementById("ezap-float-container");
    if (!container) return;
    _ensureCollapseButton();
    var anyShrinkOpen = Object.keys(_sidebars).some(function(k) {
      return _sidebars[k].isOpen && _sidebars[k].shrinkApp;
    });
    if (anyShrinkOpen) {
      container.classList.add("ezap-rail--shifted");
    } else {
      container.classList.remove("ezap-rail--shifted");
    }
    container.style.display = "flex";
    _applyCollapse();
    _highlightActiveButton();
    _positionCollapseBtn();
  }

  function _ensureCollapseButton() {
    if (document.getElementById("ezap-collapse-btn")) return;
    var btn = document.createElement("button");
    btn.id = "ezap-collapse-btn";
    // Styled by CSS — half-moon shape attached to right edge
    btn.innerHTML = '<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><path d="M1 1l6 6-6 6"/></svg>';
    btn.title = "Recolher menu";
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      _collapsed = !_collapsed;
      _applyCollapse();
    });
    document.body.appendChild(btn);
  }

  function _positionCollapseBtn() {
    var btn = document.getElementById("ezap-collapse-btn");
    if (!btn) return;
    var container = document.getElementById("ezap-float-container");
    if (!container) return;
    // Position vertically centered with the buttons
    var rect = container.getBoundingClientRect();
    var firstBtn = container.querySelector(".ezap-float-btn");
    if (firstBtn) {
      var btnRect = firstBtn.getBoundingClientRect();
      btn.style.top = (btnRect.top - 10) + "px";
    } else {
      btn.style.top = (rect.top + 70) + "px";
    }
    // Horizontal: match container's right edge
    var anyShrinkOpen = Object.keys(_sidebars).some(function(k) {
      return _sidebars[k].isOpen && _sidebars[k].shrinkApp;
    });
    btn.style.right = anyShrinkOpen ? (SIDEBAR_W + RAIL_W) + "px" : RAIL_W + "px";
  }

  function _applyCollapse() {
    var container = document.getElementById("ezap-float-container");
    var btn = document.getElementById("ezap-collapse-btn");
    if (!container) return;

    // Hide/show all buttons in the container
    var children = container.children;
    for (var i = 0; i < children.length; i++) {
      children[i].style.display = _collapsed ? "none" : "flex";
    }
    // Hide/show the rail background
    container.style.background = _collapsed ? "none" : "";
    container.style.borderLeft = _collapsed ? "none" : "";

    if (btn) {
      btn.innerHTML = _collapsed
        ? '<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><path d="M7 1L1 7l6 6"/></svg>'
        : '<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><path d="M1 1l6 6-6 6"/></svg>';
      btn.title = _collapsed ? "Expandir menu" : "Recolher menu";
      if (_collapsed) btn.classList.add("collapsed");
      else btn.classList.remove("collapsed");
    }
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
      if (sb.onOpen) sb.onOpen();
      if (window.ezapBus) window.ezapBus.emit("sidebar:opened", { name: name });
    },

    close: function(name) {
      var sb = _sidebars[name];
      if (!sb || !sb.isOpen) return;
      sb.isOpen = false;
      sb.hide();
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

  console.log("[EZAP] Sidebar manager loaded");
})();
