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

  // ===== Match de nome de contato (tolerante a pipe) =====
  // Muitos contatos no WA aparecem como "Nome | Mentor" no title,
  // mas podem ter sido salvos (em abas/pin) sem o sufixo. Este helper
  // compara os dois de forma tolerante: antes do pipe, depois do pipe
  // e a string inteira, tudo lowercase + trim.
  function ezapNormalizeName(s) {
    return (s || "").toLowerCase().trim();
  }
  function ezapNameBeforePipe(s) {
    return ezapNormalizeName((s || "").split(/\s*\|\s*/)[0]);
  }
  function ezapMatchContact(stored, chatTitle) {
    if (!stored || !chatTitle) return false;
    var s = ezapNormalizeName(stored);
    var t = ezapNormalizeName(chatTitle);
    if (s === t) return true;
    var sHead = ezapNameBeforePipe(stored);
    var tHead = ezapNameBeforePipe(chatTitle);
    if (sHead && tHead && sHead === tHead) return true;
    // Fallback: um contem o outro (ex: "Dhiego" salvo, title "Dhiego Rosa | ...")
    if (sHead && t.indexOf(sHead) === 0) return true;
    if (tHead && s.indexOf(tHead) === 0) return true;
    return false;
  }

  // ===== WA Store Bridge (ponte p/ store-bridge.js no MAIN world) =====
  // A fonte da verdade pra "quem e quem" no WhatsApp vem do Store interno
  // do WA Web (via store-bridge.js). Aqui no isolated world usamos
  // postMessage pra consultar essa lista e resolver JID a partir de nome.
  //
  // ATENCAO ao virtual scroll: o DOM mostra so linhas visiveis, entao
  // nunca confie em "nome do DOM" pra identificar contato de forma estavel.
  // Sempre que possivel, casar por JID.
  var _ezapRpcId = 0;
  var _ezapRpcPending = {};
  var _ezapChatCache = null;
  var _ezapChatCacheAt = 0;
  var CHAT_CACHE_TTL_MS = 8000;

  window.addEventListener('message', function(event) {
    if (!event.data || event.source !== window) return;
    var d = event.data;
    if (d.type === '_ezap_get_chats_res' || d.type === '_ezap_store_ready_res' || d.type === '_ezap_open_chat_res') {
      var cb = _ezapRpcPending[d.id];
      if (cb) { delete _ezapRpcPending[d.id]; cb(d); }
    }
  });

  function _ezapRpc(reqType, timeoutMs) {
    return new Promise(function(resolve) {
      var id = ++_ezapRpcId;
      var timer = setTimeout(function() {
        delete _ezapRpcPending[id];
        resolve(null);
      }, timeoutMs || 3000);
      _ezapRpcPending[id] = function(data) { clearTimeout(timer); resolve(data); };
      try { window.postMessage({ type: reqType, id: id }, '*'); }
      catch (e) { clearTimeout(timer); delete _ezapRpcPending[id]; resolve(null); }
    });
  }

  // Retorna lista de chats do Store (com JID). null se bridge indisponivel.
  function ezapGetAllChats(opts) {
    var force = !!(opts && opts.force);
    var now = Date.now();
    if (!force && _ezapChatCache && (now - _ezapChatCacheAt) < CHAT_CACHE_TTL_MS) {
      return Promise.resolve(_ezapChatCache);
    }
    return _ezapRpc('_ezap_get_chats_req', 3000).then(function(resp) {
      if (!resp || !resp.ok || !resp.ready) return null;
      _ezapChatCache = resp.chats || [];
      _ezapChatCacheAt = Date.now();
      return _ezapChatCache;
    });
  }

  // Abre um chat por JID usando o bridge. Antes de ir pro bridge,
  // tenta achar a row na DOM e clicar nela — isso cobre os chats que
  // ja estao renderizados pelo virtual scroll (caminho mais confiavel).
  // Se a row nao esta na DOM, vai pro bridge que tenta chamar metodos
  // do chat model / store props do React fiber.
  function ezapOpenChat(jid, nameHint) {
    return new Promise(function(resolve) {
      // Tenta clicar na row da DOM primeiro (caminho mais confiavel)
      try {
        var pane = document.getElementById('pane-side');
        if (pane && nameHint) {
          var rows = pane.querySelectorAll('[role="row"]');
          for (var i = 0; i < rows.length; i++) {
            var span = rows[i].querySelector('span[title]');
            if (!span) continue;
            var t = span.getAttribute('title') || '';
            if (ezapMatchContact(nameHint, t)) {
              // Simula click de usuario - WA listens on mousedown normalmente
              var clickable = span.closest('[role="listitem"]') || span.closest('div[tabindex]') || rows[i];
              if (clickable) {
                try {
                  clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                  clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  clickable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  resolve({ ok: true, via: 'dom-click' });
                  return;
                } catch (e) {}
              }
            }
          }
        }
      } catch (e) {}
      // Fallback: bridge RPC
      var id = ++_ezapRpcId;
      var timer = setTimeout(function() {
        delete _ezapRpcPending[id];
        resolve({ ok: false, reason: 'timeout' });
      }, 3000);
      _ezapRpcPending[id] = function(data) {
        clearTimeout(timer);
        resolve(data && data.result ? data.result : { ok: false, reason: 'no-response' });
      };
      try { window.postMessage({ type: '_ezap_open_chat_req', id: id, jid: jid }, '*'); }
      catch (e) { clearTimeout(timer); delete _ezapRpcPending[id]; resolve({ ok: false, reason: 'postmessage-failed' }); }
    });
  }

  // Diz se o bridge ja conseguiu capturar window.Store
  function ezapStoreReady() {
    return _ezapRpc('_ezap_store_ready_req', 1500).then(function(resp) {
      return !!(resp && resp.ready);
    });
  }

  // Encontra o JID de um chat a partir do titulo (tolerante a pipe).
  // Usa ezapMatchContact pra lidar com "Augusto" vs "Augusto | Thiago".
  function ezapResolveJid(title) {
    if (!title) return Promise.resolve(null);
    return ezapGetAllChats().then(function(chats) {
      if (!chats) return null;
      var best = null;
      for (var i = 0; i < chats.length; i++) {
        var c = chats[i];
        if (!c.name) continue;
        if (ezapMatchContact(c.name, title)) {
          // Preferencia: match exato > antes-do-pipe > prefix
          if (ezapNormalizeName(c.name) === ezapNormalizeName(title)) return c.jid;
          if (!best) best = c;
        }
      }
      return best ? best.jid : null;
    });
  }

  // Constroi lookup { jid -> {jid, name, isGroup} } e { normalizedName -> jid }
  // para filtros/pin que precisam casar rows do DOM com JIDs em lote.
  function ezapBuildChatIndex() {
    return ezapGetAllChats().then(function(chats) {
      if (!chats) return null;
      var byJid = {};
      var byName = {};
      for (var i = 0; i < chats.length; i++) {
        var c = chats[i];
        byJid[c.jid] = c;
        var n = ezapNormalizeName(c.name);
        if (n) byName[n] = c.jid;
      }
      return { byJid: byJid, byName: byName, chats: chats };
    });
  }

  // Dado um titulo do DOM, retorna o JID correspondente (match tolerante)
  // usando um indice pre-construido (mais rapido em loops de filtro).
  function ezapFindJidInIndex(index, title) {
    if (!index || !title) return null;
    var n = ezapNormalizeName(title);
    if (index.byName[n]) return index.byName[n];
    // Fallback: varre todos os nomes com ezapMatchContact
    var chats = index.chats;
    for (var i = 0; i < chats.length; i++) {
      if (ezapMatchContact(chats[i].name, title)) return chats[i].jid;
    }
    return null;
  }

  // Expoe no window para os demais scripts usarem
  window.ezapIsExtValid = ezapIsExtValid;
  window.ezapUserId = ezapUserId;
  window.ezapSendBg = ezapSendBg;
  window.ezapSupaRest = ezapSupaRest;
  window.ezapMatchContact = ezapMatchContact;
  window.ezapNormalizeName = ezapNormalizeName;
  window.ezapNameBeforePipe = ezapNameBeforePipe;
  window.ezapGetAllChats = ezapGetAllChats;
  window.ezapStoreReady = ezapStoreReady;
  window.ezapResolveJid = ezapResolveJid;
  window.ezapBuildChatIndex = ezapBuildChatIndex;
  window.ezapFindJidInIndex = ezapFindJidInIndex;
  window.ezapOpenChat = ezapOpenChat;
})();
