// ===== E-ZAP Event Bus =====
// Centralized pub/sub for decoupled inter-module communication
// Usage: ezapBus.on("chat:changed", fn), ezapBus.emit("chat:changed", data)
(function() {
  "use strict";
  var _listeners = {};

  window.ezapBus = {
    /**
     * Subscribe to an event. Returns unsubscribe function.
     * @param {string} event - Event name (e.g. "sidebar:opened", "chat:changed")
     * @param {function} fn - Handler function
     * @returns {function} unsubscribe
     */
    on: function(event, fn) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(fn);
      return function() { window.ezapBus.off(event, fn); };
    },

    /**
     * Unsubscribe from an event
     */
    off: function(event, fn) {
      if (!_listeners[event]) return;
      _listeners[event] = _listeners[event].filter(function(f) { return f !== fn; });
    },

    /**
     * Emit an event to all subscribers
     * @param {string} event - Event name
     * @param {*} data - Data to pass to handlers
     */
    emit: function(event, data) {
      var fns = _listeners[event];
      if (!fns) return;
      for (var i = 0; i < fns.length; i++) {
        try { fns[i](data); } catch (e) { console.error("[EZAP BUS] Error in '" + event + "' handler:", e); }
      }
    },

    /**
     * Subscribe to an event once (auto-unsubscribes after first call)
     */
    once: function(event, fn) {
      var unsub = window.ezapBus.on(event, function(data) {
        unsub();
        fn(data);
      });
      return unsub;
    }
  };

  console.log("[EZAP] Event bus loaded");
})();
