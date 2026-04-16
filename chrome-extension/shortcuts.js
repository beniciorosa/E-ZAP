// ===== E-ZAP Keyboard Shortcuts =====
// Atalhos de teclado para sidebars e acoes rapidas
// Ctrl+Shift+C = CRM, Ctrl+Shift+M = MSG, Ctrl+Shift+A = ABAS,
// Ctrl+Shift+G = GEIA, Ctrl+Shift+S = SPV (admin), Escape = Fechar sidebar
(function() {
  "use strict";

  var SHORTCUTS = {
    "C": { sidebar: "crm",           feature: "crm" },
    "M": { sidebar: "msg",           feature: "msg" },
    "A": { sidebar: "abas",          feature: "abas" },
    "G": { sidebar: "geia",          feature: "geia" },
    "S": { sidebar: "admin_overlay", feature: "admin_overlay" }
  };

  function _isInputFocused() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    // WhatsApp compose box
    if (el.getAttribute("role") === "textbox") return true;
    return false;
  }

  document.addEventListener("keydown", function(e) {
    // Escape: fechar sidebar aberto (funciona mesmo com input focado)
    if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (window.ezapSidebar && window.ezapSidebar.anyOpen()) {
        e.preventDefault();
        e.stopPropagation();
        window.ezapSidebar.closeAll();
        return;
      }
    }

    // Ctrl+Shift+<Key> shortcuts
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;

    var key = e.key.toUpperCase();
    var shortcut = SHORTCUTS[key];
    if (!shortcut) return;

    // Nao interceptar se input estiver focado (exceto nossos proprios atalhos)
    if (_isInputFocused()) return;

    // Checar feature flag
    if (window.__ezapHasFeature && !window.__ezapHasFeature(shortcut.feature)) return;

    // Checar se sidebar manager existe
    if (!window.ezapSidebar) return;

    e.preventDefault();
    e.stopPropagation();
    window.ezapSidebar.toggle(shortcut.sidebar);
  }, true); // capture phase pra pegar antes do WhatsApp

  console.log("[EZAP] Keyboard shortcuts loaded");
})();
