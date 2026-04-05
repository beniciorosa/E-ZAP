// ============================================================
// E-ZAP API - Helpers unificados (Supabase, background, auth)
// ============================================================
// Carregado ANTES de todos os outros content scripts.
// Expoe helpers globais que substituem as duplicacoes que
// existiam em abas.js, msg.js, content.js e flow-engine.js.

(function() {
  "use strict";

  // ===== Extension context guard =====
  // WhatsApp Web roda por horas. Se a extensao for recarregada,
  // chrome.runtime pode ficar invalido. Sempre cheque antes de usar.
  function ezapIsExtValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  // ===== User ID (lido do auth injetado por auth.js) =====
  function ezapUserId() {
    return (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
  }

  // ===== Mensagem para background service worker =====
  // opts.timeoutMs: tempo maximo de espera (default 15000).
  // Sempre resolve (nunca rejeita). Em erro/timeout retorna
  // { error: "..." } para manter compat com callers antigos.
  function ezapSendBg(msg, opts) {
    var timeoutMs = (opts && opts.timeoutMs) || 15000;
    return new Promise(function(resolve) {
      if (!ezapIsExtValid()) { resolve({ error: "Extension context invalid" }); return; }
      var done = false;
      var timer = setTimeout(function() {
        if (!done) { done = true; resolve({ error: "Timeout - background worker nao respondeu" }); }
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(msg, function(response) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { error: "Sem resposta" });
          }
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve({ error: e.message }); }
      }
    });
  }

  // ===== Supabase REST via background =====
  // Compat com os wrappers antigos: retorna null em falha.
  function ezapSupaRest(path, method, body, prefer) {
    return new Promise(function(resolve) {
      if (!ezapIsExtValid()) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage({
          action: "supabase_rest",
          path: path,
          method: method || "GET",
          body: body,
          prefer: prefer
        }, function(resp) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Expoe no window para os demais scripts usarem
  window.ezapIsExtValid = ezapIsExtValid;
  window.ezapUserId = ezapUserId;
  window.ezapSendBg = ezapSendBg;
  window.ezapSupaRest = ezapSupaRest;
})();
