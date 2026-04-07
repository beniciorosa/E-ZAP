// ===== E-ZAP Early Hide =====
// Runs at document_start to hide native WA chat list before overlay loads.
// Reads cached overlay state from chrome.storage.local for instant decision.
(function() {
  // Inject early-hide CSS immediately
  var style = document.createElement('style');
  style.id = 'ezap-early-hide-css';
  style.textContent =
    'body.ezap-overlay-loading #pane-side > div { visibility: hidden !important; }' +
    'body.ezap-overlay-loading #pane-side { background: var(--panel-background, #fff) !important; }';
  (document.head || document.documentElement).appendChild(style);

  // Check cached overlay state
  chrome.storage.local.get('ezap_overlay_enabled', function(result) {
    if (chrome.runtime.lastError) return;
    if (result && result.ezap_overlay_enabled === true) {
      // Overlay is enabled - hide native list immediately
      var apply = function() {
        if (document.body) {
          document.body.classList.add('ezap-overlay-loading');
        } else {
          // Body not ready yet, wait for it
          var obs = new MutationObserver(function() {
            if (document.body) {
              document.body.classList.add('ezap-overlay-loading');
              obs.disconnect();
            }
          });
          obs.observe(document.documentElement, { childList: true });
        }
      };
      apply();
    }
  });
})();
