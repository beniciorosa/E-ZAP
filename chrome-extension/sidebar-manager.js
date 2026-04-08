// ===== E-ZAP Sidebar Manager =====
// Centralized sidebar lifecycle: mutual exclusion, app width, floating buttons
// Usage: ezapSidebar.register("crm", { show, hide, onOpen }), ezapSidebar.toggle("crm")
(function() {
  "use strict";
  var _sidebars = {};

  /**
   * Adjust WhatsApp app width when sidebar opens/closes
   */
  function _setAppWidth(open) {
    var appEl = document.getElementById("app");
    if (!appEl) return;
    if (open) {
      appEl.style.width = "calc(100% - 320px)";
      appEl.style.maxWidth = "calc(100% - 320px)";
      appEl.style.marginRight = "0";
    } else {
      appEl.style.width = "";
      appEl.style.maxWidth = "";
      appEl.style.marginRight = "";
    }
  }

  /**
   * Reposition floating buttons when sidebar opens/closes
   * Instead of hiding, moves them beside the sidebar so user can switch directly
   */
  function _updateFloats() {
    var container = document.getElementById("ezap-float-container");
    if (!container) return;
    // If WA native drawer is open, keep hidden
    if (_nativeDrawerOpen) {
      container.style.display = "none";
      return;
    }
    var anyShrinkOpen = Object.keys(_sidebars).some(function(k) {
      return _sidebars[k].isOpen && _sidebars[k].shrinkApp;
    });
    if (anyShrinkOpen) {
      container.style.right = "336px";
      container.style.display = "flex";
    } else {
      container.style.right = "16px";
      container.style.display = "flex";
    }
    _highlightActiveButton();
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
        btn.style.outline = "2.5px solid #25d366";
        btn.style.outlineOffset = "2px";
      } else {
        btn.style.outline = "";
        btn.style.outlineOffset = "";
      }
    });
  }

  window.ezapSidebar = {
    /**
     * Register a sidebar with the manager
     * @param {string} name - Unique sidebar name (e.g. "crm", "msg", "abas", "tag", "geia")
     * @param {object} opts
     * @param {function} opts.show - Function to show the sidebar DOM
     * @param {function} opts.hide - Function to hide the sidebar DOM
     * @param {function} [opts.onOpen] - Callback after sidebar opens (e.g. load data)
     * @param {boolean} [opts.shrinkApp=true] - Whether to shrink WhatsApp app when open
     * @param {boolean} [opts.closesOthers=true] - Whether opening this sidebar closes others
     */
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

    /**
     * Open a sidebar (closes mutually exclusive ones first)
     */
    open: function(name) {
      var sb = _sidebars[name];
      if (!sb || sb.isOpen) return;

      // Close mutually exclusive sidebars
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

    /**
     * Close a sidebar
     */
    close: function(name) {
      var sb = _sidebars[name];
      if (!sb || !sb.isOpen) return;

      sb.isOpen = false;
      sb.hide();

      // Restore app width if no shrinkApp sidebar remains open
      var anyShrink = Object.keys(_sidebars).some(function(k) {
        return _sidebars[k].isOpen && _sidebars[k].shrinkApp;
      });
      if (!anyShrink) _setAppWidth(false);

      _updateFloats();
      if (window.ezapBus) window.ezapBus.emit("sidebar:closed", { name: name });
    },

    /**
     * Toggle a sidebar open/closed
     */
    toggle: function(name) {
      var sb = _sidebars[name];
      if (!sb) return;
      if (sb.isOpen) window.ezapSidebar.close(name);
      else window.ezapSidebar.open(name);
    },

    /**
     * Check if a sidebar is currently open
     */
    isOpen: function(name) {
      return _sidebars[name] ? _sidebars[name].isOpen : false;
    },

    /**
     * Check if any sidebar is currently open
     */
    anyOpen: function() {
      return Object.keys(_sidebars).some(function(k) { return _sidebars[k].isOpen; });
    },

    /**
     * Close all open sidebars
     */
    closeAll: function() {
      Object.keys(_sidebars).forEach(function(k) {
        if (_sidebars[k].isOpen) window.ezapSidebar.close(k);
      });
    }
  };

  // ===== Auto-hide floating buttons when WA's native info panel is open =====
  var _nativeDrawerOpen = false;

  function _isNativeDrawerOpen() {
    // WhatsApp's contact/group info panel uses drawers with data-animate-drawer-title
    // or specific testid patterns. Check multiple selectors for reliability.
    return !!(
      document.querySelector('[data-animate-drawer-title]') ||
      document.querySelector('[data-testid="contact-info-drawer"]') ||
      document.querySelector('[data-testid="group-info-drawer"]') ||
      document.querySelector('span[data-testid="contact-info-drawer-title"]')
    );
  }

  function _checkNativeDrawer() {
    var container = document.getElementById("ezap-float-container");
    if (!container) return;

    var drawerOpen = _isNativeDrawerOpen();
    if (drawerOpen === _nativeDrawerOpen) return; // no change

    _nativeDrawerOpen = drawerOpen;
    if (drawerOpen) {
      container.style.display = "none";
    } else {
      container.style.display = "flex";
      _updateFloats(); // restore correct position
    }
  }

  setInterval(_checkNativeDrawer, 500);

  console.log("[EZAP] Sidebar manager loaded");
})();
