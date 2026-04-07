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
    if (d.type === '_ezap_get_chats_res' || d.type === '_ezap_store_ready_res' || d.type === '_ezap_open_chat_res' || d.type === '_ezap_get_profile_pics_res' || d.type === '_ezap_chat_action_res') {
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
  //
  // IMPORTANTE: quando custom list esta ativa, a lista nativa do WA esta
  // display:none (via scrollParent). Click em elemento display:none nao
  // propaga pros handlers do React. Por isso temporariamente "desesconde"
  // o scrollParent de forma invisivel (opacity 0 + pointer-events none)
  // antes do click, e restaura depois.
  // Acha o React fiber associado a um elemento DOM.
  // React 16+: prop keys com prefixo __reactProps$ ou __reactInternalInstance$
  function _findReactPropsKey(el) {
    if (!el) return null;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('__reactProps') === 0) return k;
      if (k.indexOf('__reactEventHandlers') === 0) return k;
    }
    return null;
  }

  function _findReactFiberKey(el) {
    if (!el) return null;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('__reactFiber') === 0) return k;
      if (k.indexOf('__reactInternalInstance') === 0) return k;
    }
    return null;
  }

  // Walk fiber parents procurando onClick em memoizedProps
  function _walkFiberForHandler(fiber, maxDepth) {
    var cur = fiber;
    var depth = 0;
    var handlers = ['onClick', 'onPointerUp', 'onMouseUp', 'onPointerDown', 'onMouseDown'];
    while (cur && depth < (maxDepth || 20)) {
      var props = cur.memoizedProps || cur.pendingProps;
      if (props) {
        for (var h = 0; h < handlers.length; h++) {
          if (typeof props[handlers[h]] === 'function') {
            return { handler: props[handlers[h]], name: handlers[h], fiber: cur };
          }
        }
      }
      cur = cur.return;
      depth++;
    }
    return null;
  }

  // Invoca diretamente o onClick do React em um elemento.
  // Retorna true se achou e chamou o handler.
  function _invokeReactOnClick(el) {
    var cur = el;
    var checkedEls = 0;
    var foundPropsEls = 0;
    while (cur && cur !== document.body) {
      checkedEls++;
      var propKey = _findReactPropsKey(cur);
      if (propKey) {
        foundPropsEls++;
        var props = cur[propKey];
        if (props) {
          var handlers = ['onClick', 'onPointerUp', 'onMouseUp', 'onPointerDown', 'onMouseDown'];
          for (var h = 0; h < handlers.length; h++) {
            var handler = props[handlers[h]];
            if (typeof handler === 'function') {
              try {
                var rect = cur.getBoundingClientRect();
                var fakeEvt = {
                  bubbles: true, cancelable: true, isTrusted: true,
                  type: handlers[h].replace(/^on/, '').toLowerCase(),
                  button: 0, buttons: 0, detail: 1,
                  clientX: rect.left + rect.width / 2,
                  clientY: rect.top + rect.height / 2,
                  pageX: rect.left + rect.width / 2,
                  pageY: rect.top + rect.height / 2,
                  target: cur, currentTarget: cur,
                  nativeEvent: null,
                  preventDefault: function() {},
                  stopPropagation: function() {},
                  stopImmediatePropagation: function() {},
                  persist: function() {}
                };
                handler(fakeEvt);
                return { ok: true, handler: handlers[h], el: cur, via: 'props' };
              } catch (e) {
                console.log('[EZAP-DOM] handler ' + handlers[h] + ' err:', e && e.message);
              }
            }
          }
        }
      }
      cur = cur.parentElement;
    }
    console.log('[EZAP-DOM] no React props handler. checked=' + checkedEls + ' withProps=' + foundPropsEls);

    // Fallback via fiber: acessa __reactFiber e sobe a arvore de memoizedProps
    var fiberKey = _findReactFiberKey(el);
    if (fiberKey) {
      var fiber = el[fiberKey];
      var found = _walkFiberForHandler(fiber, 20);
      if (found) {
        try {
          var rect2 = el.getBoundingClientRect();
          var evt2 = {
            bubbles: true, cancelable: true, isTrusted: true,
            type: found.name.replace(/^on/, '').toLowerCase(),
            button: 0, buttons: 0, detail: 1,
            clientX: rect2.left + rect2.width / 2,
            clientY: rect2.top + rect2.height / 2,
            pageX: rect2.left + rect2.width / 2,
            pageY: rect2.top + rect2.height / 2,
            target: el, currentTarget: el,
            nativeEvent: null,
            preventDefault: function() {},
            stopPropagation: function() {},
            stopImmediatePropagation: function() {},
            persist: function() {}
          };
          found.handler(evt2);
          return { ok: true, handler: found.name, el: el, via: 'fiber' };
        } catch (e) {
          console.log('[EZAP-DOM] fiber handler err:', e && e.message);
        }
      } else {
        console.log('[EZAP-DOM] fiber walk: no handler found');
      }
    } else {
      console.log('[EZAP-DOM] no reactFiber key on element');
    }
    // Log debug: lista todas keys do elemento
    try {
      var allKeys = Object.keys(el).filter(function(k) { return k.indexOf('__react') === 0; });
      console.log('[EZAP-DOM] react keys on clickable:', allKeys);
    } catch(e) {}
    return null;
  }

  function _tryDomClick(nameHint) {
    if (!nameHint) return false;
    try {
      var pane = document.getElementById('pane-side');
      if (!pane) return false;
      var rows = pane.querySelectorAll('[role="row"], [role="listitem"]');
      for (var i = 0; i < rows.length; i++) {
        // Pula rows dentro de nossa custom list
        if (rows[i].closest && rows[i].closest('#wcrm-custom-list')) continue;
        var span = rows[i].querySelector('span[title]');
        if (!span) continue;
        var t = span.getAttribute('title') || '';
        if (ezapMatchContact(nameHint, t)) {
          var clickable = span.closest('[role="listitem"]') || span.closest('div[tabindex]') || rows[i];
          if (!clickable) continue;

          // Estrategia 1: invocar onClick do React fiber direto (bypass events)
          var reactResult = _invokeReactOnClick(clickable);
          if (reactResult && reactResult.ok) {
            console.log('[EZAP-DOM] React handler invoked via ' + reactResult.via + ':', reactResult.handler);
            return true;
          }

          // Estrategia 2: element.click() nativo
          try { clickable.click(); console.log('[EZAP-DOM] native .click() called'); return true; } catch (e) {}

          // Estrategia 3: dispatchEvent tradicional (fallback)
          var rect = clickable.getBoundingClientRect();
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          var evInit = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX: cx, clientY: cy };
          try { clickable.dispatchEvent(new PointerEvent('pointerdown', evInit)); } catch (e) {}
          clickable.dispatchEvent(new MouseEvent('mousedown', evInit));
          try { clickable.dispatchEvent(new PointerEvent('pointerup', evInit)); } catch (e) {}
          clickable.dispatchEvent(new MouseEvent('mouseup', evInit));
          clickable.dispatchEvent(new MouseEvent('click', evInit));
          return true;
        }
      }
    } catch (e) { console.log('[EZAP-DOM] err:', e && e.message); }
    return false;
  }

  // Acha o campo de busca do WA. WA muda atributos entre versoes, entao
  // varre TODOS os contenteditable fora do compose box (#main) e da nossa
  // custom list, e escolhe o que parece ser search (title/aria-label
  // contem "search"/"pesquisa", ou data-tab="3").
  function _findWASearchField() {
    // Busca ampla: contenteditable (todos os valores != false) + inputs de texto/search
    // + lexical editor (novo editor React do WA). WA muda atributos entre versoes.
    var selectors = [
      '[contenteditable]:not([contenteditable="false"])',
      'input[type="search"]',
      'input[role="textbox"]',
      'div[data-lexical-editor="true"]',
      '[data-tab="3"]',
      '[aria-label*="search" i]',
      '[aria-label*="pesquis" i]',
      '[aria-label*="busca" i]'
    ];
    var all = document.querySelectorAll(selectors.join(','));
    // Dedupe
    var seen = {};
    var candidates = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (seen[el._ezapId = el._ezapId || (++_ezapElId)]) continue;
      seen[el._ezapId] = true;
      // Exclui areas nossas + compose box do chat
      if (el.closest('#main')) continue;
      if (el.closest('#wcrm-sidebar')) continue;
      if (el.closest('#wcrm-custom-list')) continue;
      if (el.closest('#wcrm-widget')) continue;
      if (el.closest('#wcrm-abas-sidebar')) continue;
      if (el.closest('[data-ezap-synth]')) continue;
      // Exclui elementos invisiveis ou fora da tela
      if (!el.offsetParent && el.tagName !== 'INPUT') continue;
      candidates.push(el);
    }

    // Score pra decidir o melhor candidato
    var scored = candidates.map(function(el) {
      var title = el.getAttribute('title') || '';
      var aria = el.getAttribute('aria-label') || '';
      var ph = el.getAttribute('placeholder') || '';
      var dataTab = el.getAttribute('data-tab') || '';
      var role = el.getAttribute('role') || '';
      var isLexical = el.getAttribute('data-lexical-editor') === 'true';
      var text = (title + ' ' + aria + ' ' + ph).toLowerCase();
      var score = 0;
      if (/search|pesquis|busca/i.test(text)) score += 100;
      if (dataTab === '3') score += 80;
      if (isLexical) score += 40;
      if (role === 'textbox') score += 20;
      // Preferencia por posicao: campo de search fica no topo da pagina
      try {
        var rect = el.getBoundingClientRect();
        if (rect.top < 200 && rect.top > 0) score += 50;
        if (rect.left < 500) score += 20;   // coluna esquerda
        if (rect.width > 100 && rect.width < 600) score += 10;
      } catch (e) {}
      return { el: el, score: score, tag: el.tagName };
    });
    scored.sort(function(a, b) { return b.score - a.score; });

    if (scored.length > 0 && scored[0].score > 0) {
      return scored[0].el;
    }

    // Diagnostico quando falha: loga candidatos pra debug
    console.log('[EZAP-SEARCH] no confident field. candidates:', scored.length);
    scored.slice(0, 5).forEach(function(c, i) {
      console.log('[EZAP-SEARCH] candidate #' + i + ' score=' + c.score + ' tag=' + c.tag + ' outer=', (c.el.outerHTML || '').slice(0, 160));
    });
    // Ultimo recurso: retorna primeiro candidato qualquer
    return scored.length > 0 ? scored[0].el : null;
  }
  var _ezapElId = 0;

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
        // Clicka pra garantir cursor dentro
        try {
          var r = field.getBoundingClientRect();
          field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 10, clientY: r.top + r.height/2 }));
          field.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 10, clientY: r.top + r.height/2 }));
          field.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 10, clientY: r.top + r.height/2 }));
        } catch (e1) {}
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        // Pega so nome antes de pipe pra buscar melhor
        searchTerm = (name.split(/\s*\|\s*/)[0] || name).trim();
        // Dispara beforeinput pra preparar listeners React/Lexical
        try { field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: searchTerm })); } catch (e2) {}
        // Digita (execCommand.insertText funciona com React contenteditable)
        var inserted = document.execCommand('insertText', false, searchTerm);
        console.log('[EZAP-SEARCH] typed "' + searchTerm + '" inserted=' + inserted);
        if (!inserted) {
          // Fallback manual: seta textContent + dispara input event
          if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') {
            field.value = searchTerm;
          } else {
            field.textContent = searchTerm;
          }
          field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: searchTerm }));
        }
        // Dispara input event adicional (alguns listeners Lexical so pegam esse)
        try { field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: searchTerm })); } catch (e3) {}
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
  // Verifica se a conversa de um contato foi aberta checando o header
  function _isChatOpenFor(nameHint) {
    try {
      var main = document.getElementById('main');
      if (!main) return false;
      var header = main.querySelector('header');
      if (!header) return false;
      // Procura em TODOS os span[title] do header (pode ter varios)
      var spans = header.querySelectorAll('span[title]');
      for (var i = 0; i < spans.length; i++) {
        var openedName = spans[i].getAttribute('title') || '';
        if (!openedName) continue;
        if (ezapMatchContact(nameHint, openedName)) return true;
      }
      // Tambem tenta div[title] e elementos com dir="auto" (nome do grupo as vezes)
      var divs = header.querySelectorAll('div[title]');
      for (var j = 0; j < divs.length; j++) {
        var openedName2 = divs[j].getAttribute('title') || '';
        if (!openedName2) continue;
        if (ezapMatchContact(nameHint, openedName2)) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  // Poll ate achar o chat aberto (early-exit) ou timeout
  function _waitChatOpenFor(nameHint, timeoutMs) {
    return new Promise(function(resolve) {
      var deadline = Date.now() + (timeoutMs || 1200);
      var check = function() {
        if (_isChatOpenFor(nameHint)) { resolve(true); return; }
        if (Date.now() > deadline) { resolve(false); return; }
        setTimeout(check, 80);
      };
      check();
    });
  }

  // Tenta abrir via store-bridge (Store.Chat direto, nao usa eventos DOM).
  // Mais confiavel que dispatchEvent/click (que o WA ignora).
  function _ezapOpenViaBridge(jid) {
    return new Promise(function(resolve) {
      if (!jid) { resolve(null); return; }
      var id = ++_ezapRpcId;
      var timer = setTimeout(function() {
        delete _ezapRpcPending[id];
        resolve(null);
      }, 3000);
      _ezapRpcPending[id] = function(data) {
        clearTimeout(timer);
        resolve(data && data.result ? data.result : null);
      };
      try { window.postMessage({ type: '_ezap_open_chat_req', id: id, jid: jid }, '*'); }
      catch (e) { clearTimeout(timer); delete _ezapRpcPending[id]; resolve(null); }
    });
  }

  function ezapOpenChat(jid, nameHint) {
    return new Promise(function(resolve) {
      // Strategy 1: store-bridge (Store.Chat direto, sem DOM events)
      // Se nao tem JID, tenta resolver pelo nome.
      var jidPromise = jid ? Promise.resolve(jid) : ezapResolveJid(nameHint);
      jidPromise.then(function(resolvedJid) {
        if (resolvedJid) {
          _ezapOpenViaBridge(resolvedJid).then(function(bridgeResult) {
            if (bridgeResult && bridgeResult.ok) {
              // Bridge foi bem-sucedido - confia e retorna (sem verificacao,
              // WA pode usar displayName diferente no header e matching falhar)
              console.log('[EZAP-OPEN] bridge success via:', bridgeResult.via);
              resolve({ ok: true, via: 'bridge:' + bridgeResult.via });
              return;
            }
            // Bridge falhou (exception ou nenhum metodo funcionou), tenta DOM
            console.log('[EZAP-OPEN] bridge failed:', bridgeResult && bridgeResult.reason);
            _fallbackDomThenSearch(jid, nameHint, resolve);
          });
        } else {
          _fallbackDomThenSearch(jid, nameHint, resolve);
        }
      });
    });
  }

  // Fallback: DOM click + (se nao abrir) search bar
  function _fallbackDomThenSearch(jid, nameHint, resolve) {
    if (_tryDomClick(nameHint)) {
      _waitChatOpenFor(nameHint, 800).then(function(opened) {
        if (opened) {
          resolve({ ok: true, via: 'dom-click' });
        } else {
          console.log('[EZAP-DOM] click did not open chat, trying search');
          ezapOpenChatViaSearch(nameHint).then(function(r) {
            resolve(r && r.ok ? r : { ok: false, reason: 'all-failed', searchResult: r });
          });
        }
      });
      return;
    }
    // Nao achou no DOM, vai direto pra search
    ezapOpenChatViaSearch(nameHint).then(function(r) {
      resolve(r && r.ok ? r : { ok: false, reason: 'all-failed', searchResult: r });
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
  function ezapBuildChatIndex(opts) {
    return ezapGetAllChats(opts).then(function(chats) {
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

  // Executa acao no chat (archive, mute, pin, etc) via store-bridge
  function ezapChatAction(jid, action) {
    return new Promise(function(resolve) {
      var id = ++_ezapRpcId;
      var timer = setTimeout(function() {
        delete _ezapRpcPending[id];
        resolve({ ok: false, reason: 'timeout' });
      }, 5000);
      _ezapRpcPending[id] = function(data) {
        clearTimeout(timer);
        resolve(data.result || { ok: false });
      };
      try {
        window.postMessage({ type: '_ezap_chat_action_req', id: id, jid: jid, action: action }, '*');
      } catch (e) {
        clearTimeout(timer);
        delete _ezapRpcPending[id];
        resolve({ ok: false, reason: 'postMessage-error' });
      }
    });
  }

  // Busca fotos de perfil sob demanda (batch) via store-bridge
  function ezapFetchProfilePics(jids) {
    return new Promise(function(resolve) {
      if (!jids || !jids.length) { resolve([]); return; }
      var id = ++_ezapRpcId;
      var timer = setTimeout(function() {
        delete _ezapRpcPending[id];
        resolve([]);
      }, 5000);
      _ezapRpcPending[id] = function(data) {
        clearTimeout(timer);
        resolve(data.results || []);
      };
      try {
        window.postMessage({ type: '_ezap_get_profile_pics_req', id: id, jids: jids }, '*');
      } catch (e) {
        clearTimeout(timer);
        delete _ezapRpcPending[id];
        resolve([]);
      }
    });
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
  window.ezapFetchProfilePics = ezapFetchProfilePics;
  window.ezapChatAction = ezapChatAction;
})();
