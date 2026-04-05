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

  // Clique direto na row se ela ja estiver no DOM (virtual scroll viewport).
  // Mais rapido/reliable que search quando disponivel.
  function _tryDomClick(nameHint) {
    if (!nameHint) return false;
    try {
      var pane = document.getElementById('pane-side');
      if (!pane) return false;
      var rows = pane.querySelectorAll('[role="row"]');
      for (var i = 0; i < rows.length; i++) {
        var span = rows[i].querySelector('span[title]');
        if (!span) continue;
        var t = span.getAttribute('title') || '';
        if (ezapMatchContact(nameHint, t)) {
          var clickable = span.closest('[role="listitem"]') || span.closest('div[tabindex]') || rows[i];
          if (!clickable) continue;
          clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          clickable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // Acha o campo de busca do WA. WA muda atributos entre versoes, entao
  // varre TODOS os contenteditable fora do compose box (#main) e da nossa
  // custom list, e escolhe o que parece ser search (title/aria-label
  // contem "search"/"pesquisa", ou data-tab="3").
  function _findWASearchField() {
    var all = document.querySelectorAll('div[contenteditable="true"]');
    var best = null;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest('#main')) continue;               // compose box
      if (el.closest('#wcrm-sidebar')) continue;       // nossa sidebar
      if (el.closest('#wcrm-custom-list')) continue;   // nossa lista
      if (el.closest('#wcrm-widget')) continue;        // nosso widget
      var title = el.getAttribute('title') || '';
      var aria = el.getAttribute('aria-label') || '';
      var dataTab = el.getAttribute('data-tab') || '';
      var role = el.getAttribute('role') || '';
      // Match forte: tem keywords de search
      if (/search|pesquis|busca/i.test(title + ' ' + aria) || dataTab === '3') {
        return el;
      }
      // Match fraco: primeiro role=textbox fora do main
      if (!best && role === 'textbox') best = el;
    }
    if (best) return best;
    // Ultimo recurso: primeiro contenteditable que sobrou
    for (var j = 0; j < all.length; j++) {
      var el2 = all[j];
      if (el2.closest('#main') || el2.closest('#wcrm-sidebar') || el2.closest('#wcrm-custom-list') || el2.closest('#wcrm-widget')) continue;
      return el2;
    }
    return null;
  }

  function _clearSearchField(field) {
    if (!field) return;
    try {
      field.focus();
      // Seleciona tudo e deleta
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      // Fallback: dispara Escape pra fechar a busca
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) {}
  }

  // Espera ate achar uma row com titulo que casa com 'name' dentro de timeout
  function _waitForSearchResult(name, timeoutMs) {
    return new Promise(function(resolve) {
      var deadline = Date.now() + (timeoutMs || 2000);
      var pane = document.getElementById('pane-side');
      if (!pane) { resolve(null); return; }
      var attempt = function() {
        // Evita contemplar rows dentro do nosso custom-list
        var rows = pane.querySelectorAll('[role="row"], [role="listitem"]');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].closest && rows[i].closest('#wcrm-custom-list')) continue;
          var span = rows[i].querySelector('span[title]');
          if (!span) continue;
          var t = span.getAttribute('title') || '';
          if (ezapMatchContact(name, t)) { resolve(rows[i]); return; }
        }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(attempt, 80);
      };
      attempt();
    });
  }

  // Abre o chat digitando o nome na search bar do WA.
  // Funciona pra qualquer contato (mesmo fora do virtual scroll viewport)
  // porque WA busca na lista completa quando digitamos.
  function ezapOpenChatViaSearch(name) {
    return new Promise(function(resolve) {
      if (!name) { resolve({ ok: false, reason: 'no-name' }); return; }
      var field = _findWASearchField();
      console.log('[EZAP-SEARCH] field found:', !!field, field && field.outerHTML && field.outerHTML.slice(0, 120));
      if (!field) { resolve({ ok: false, reason: 'no-search-field' }); return; }

      // Se a custom list esta visivel, ela pode estar cobrindo a area da
      // lista do WA. Esconde temporariamente pra WA renderizar resultados.
      var customList = document.getElementById('wcrm-custom-list');
      var hiddenEl = document.querySelector('[data-ezap-hidden="1"]');
      var customWasVisible = customList && customList.style.display !== 'none';
      if (customWasVisible) {
        customList.style.display = 'none';
        if (hiddenEl) hiddenEl.style.display = hiddenEl.getAttribute('data-ezap-orig-display') || '';
      }

      var restore = function() {
        if (customWasVisible) {
          if (hiddenEl) hiddenEl.style.display = 'none';
          customList.style.display = 'block';
        }
      };

      // Foca, limpa, digita
      var searchTerm;
      try {
        field.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        // Pega so nome antes de pipe pra buscar melhor
        searchTerm = (name.split(/\s*\|\s*/)[0] || name).trim();
        // Digita (execCommand.insertText funciona com React contenteditable)
        var inserted = document.execCommand('insertText', false, searchTerm);
        console.log('[EZAP-SEARCH] typed "' + searchTerm + '" inserted=' + inserted);
        if (!inserted) {
          // Fallback manual
          field.textContent = searchTerm;
          field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: searchTerm }));
        }
      } catch (e) {
        console.log('[EZAP-SEARCH] type err:', e.message);
        restore();
        resolve({ ok: false, reason: 'type-failed', error: e.message });
        return;
      }

      // Aguarda resultado aparecer
      _waitForSearchResult(name, 2500).then(function(resultRow) {
        console.log('[EZAP-SEARCH] result found:', !!resultRow, 'for "' + name + '"');
        if (!resultRow) {
          _clearSearchField(field);
          restore();
          resolve({ ok: false, reason: 'no-search-match' });
          return;
        }
        // Clica no resultado
        try {
          var clickable = resultRow.closest('[role="listitem"]') || resultRow;
          var rect = clickable.getBoundingClientRect();
          var x = rect.left + rect.width / 2;
          var y = rect.top + rect.height / 2;
          var mk = function(type) {
            return new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y });
          };
          clickable.dispatchEvent(mk('mousedown'));
          clickable.dispatchEvent(mk('mouseup'));
          clickable.dispatchEvent(mk('click'));
          console.log('[EZAP-SEARCH] clicked on result');
        } catch (e) {
          console.log('[EZAP-SEARCH] click err:', e.message);
          _clearSearchField(field);
          restore();
          resolve({ ok: false, reason: 'click-failed', error: e.message });
          return;
        }
        // Limpa a busca e restaura custom list
        setTimeout(function() {
          _clearSearchField(field);
          setTimeout(restore, 100);
        }, 300);
        resolve({ ok: true, via: 'search' });
      });
    });
  }

  // Abre um chat com varias estrategias em ordem de confiabilidade:
  // 1) DOM click (row ja no viewport do virtual scroll) — instantaneo
  // 2) Search bar do WA — funciona pra contatos fora do viewport
  // 3) Bridge RPC (Store.Cmd via fiber) — fallback experimental
  function ezapOpenChat(jid, nameHint) {
    return new Promise(function(resolve) {
      // Strategy 1: DOM click (so funciona se row esta no viewport E
      // custom list nao esta cobrindo)
      var customList = document.getElementById('wcrm-custom-list');
      var customVisible = customList && customList.style.display !== 'none';
      if (!customVisible && _tryDomClick(nameHint)) {
        resolve({ ok: true, via: 'dom-click' });
        return;
      }

      // Strategy 2: search bar (reliable pra qualquer contato)
      ezapOpenChatViaSearch(nameHint).then(function(result) {
        if (result && result.ok) { resolve(result); return; }

        // Strategy 3: bridge RPC (fallback)
        var id = ++_ezapRpcId;
        var timer = setTimeout(function() {
          delete _ezapRpcPending[id];
          resolve({ ok: false, reason: 'all-strategies-failed', searchResult: result });
        }, 3000);
        _ezapRpcPending[id] = function(data) {
          clearTimeout(timer);
          resolve(data && data.result ? data.result : { ok: false, reason: 'no-response' });
        };
        try { window.postMessage({ type: '_ezap_open_chat_req', id: id, jid: jid }, '*'); }
        catch (e) { clearTimeout(timer); delete _ezapRpcPending[id]; resolve({ ok: false, reason: 'postmessage-failed' }); }
      });
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
  window.ezapOpenChatViaSearch = ezapOpenChatViaSearch;
})();
