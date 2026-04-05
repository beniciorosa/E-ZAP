// ===== E-ZAP Store Bridge (MAIN world) =====
// Acessa window.Store interno do WhatsApp Web via webpack chunk injection.
// Expoe a lista completa de chats (com JID) para content scripts atraves
// de postMessage, sem depender do DOM / virtual scroll.
//
// Por que isso existe:
//   O WA usa virtual scroll, entao a lista de conversas no DOM mostra
//   apenas as linhas visiveis. Filtros (ABAS), PIN e features futuras
//   precisam da lista COMPLETA com identificadores estaveis (JID).
//   O Store do proprio WA Web tem tudo isso em memoria. Acessamos
//   via webpack chunk (tecnica conhecida de wppconnect/moduleRaid).
//
// Canais de comunicacao:
//   - content script envia:   window.postMessage({type:'_ezap_get_chats_req', id})
//   - bridge responde:        window.postMessage({type:'_ezap_get_chats_res', id, ok, chats, ready})
//   - chats = [{jid, name, isGroup, pushname, shortName}, ...]
(function() {
  if (window._ezapStoreReady !== undefined) return;
  window._ezapStoreReady = false;
  window._ezapStore = null;

  var INIT_MAX_TRIES = 240;      // ~2min (WA demora pra carregar Chat module)
  var INIT_INTERVAL_MS = 500;
  var _initTries = 0;
  var _lastWebpackKey = null;
  var _capturedVia = null;

  // ===== EARLY INTERCEPTOR =====
  // Intercepta window.webpackChunkwhatsapp_web_client ANTES do WA criar,
  // usando Object.defineProperty. Quando webpack fizer a primeira push
  // (que e quando __webpack_require__ fica disponivel dentro do runtime),
  // capturamos pelo lado de dentro. Isto e necessario pois em alguns
  // ambientes (ex: com outras extensoes rodando) o competitor ja roubou
  // __webpack_require__ e restaurou push pro nativo antes da gente rodar.
  function installEarlyInterceptor(chunkName) {
    if (window[chunkName]) {
      // Ja existe — chegamos tarde, tenta wrap direto
      wrapArrayPush(window[chunkName]);
      return;
    }
    var _value = null;
    try {
      Object.defineProperty(window, chunkName, {
        configurable: true,
        enumerable: true,   // critico: sem isso Object.keys(window) nao acha
        get: function() { return _value; },
        set: function(v) {
          _value = v;
          if (Array.isArray(v)) {
            console.log('[EZAP-STORE] Intercepted array assignment for', chunkName);
            wrapArrayPush(v);
          }
        }
      });
      console.log('[EZAP-STORE] Early interceptor installed for', chunkName);
    } catch (e) {
      console.log('[EZAP-STORE] defineProperty failed for', chunkName, ':', e && e.message);
    }
  }

  function wrapArrayPush(arr) {
    if (!arr || arr._ezapWrapped) return;
    arr._ezapWrapped = true;
    var _internalPush = arr.push;  // pode ser nativo ainda
    // Intercepta quando webpack substituir push por jsonpCallback
    try {
      Object.defineProperty(arr, 'push', {
        configurable: true,
        get: function() { return _internalPush; },
        set: function(newPush) {
          // Webpack esta instalando seu proprio push (jsonpCallback).
          // Envolvemos pra espionar entries antes de passar pra ele.
          _internalPush = function() {
            for (var i = 0; i < arguments.length; i++) {
              var entry = arguments[i];
              if (entry && entry[2] && typeof entry[2] === 'function' && !window._ezapWebpackRequire) {
                var origRuntime = entry[2];
                entry[2] = function(req) {
                  if (!window._ezapWebpackRequire) {
                    window._ezapWebpackRequire = req;
                    _capturedVia = 'early-interceptor';
                    console.log('[EZAP-STORE] Captured __webpack_require__ via early interceptor');
                    try { onWebpackRequireReady(req); } catch (e) { console.log('[EZAP-STORE] onReady err:', e.message); }
                  }
                  return origRuntime.apply(this, arguments);
                };
              }
            }
            return newPush.apply(arr, arguments);
          };
        }
      });
    } catch (e) {
      console.log('[EZAP-STORE] wrap push failed:', e && e.message);
    }
  }

  function onWebpackRequireReady(req) {
    var found = scanModules(req);
    window._ezapStore = found;
    window._ezapStoreReady = !!found.Chat;
    console.log('[EZAP-STORE] First scan:', {
      Chat: !!found.Chat, Contact: !!found.Contact,
      GroupMetadata: !!found.GroupMetadata, Wid: !!found.Wid
    });
    if (!found.Chat) {
      // Modulos ainda carregando, agenda rescans
      setTimeout(rescan, 2000);
    }
  }

  function rescan() {
    var req = window._ezapWebpackRequire;
    if (!req) return;
    _initTries++;
    var found = scanModules(req);
    window._ezapStore = found;
    window._ezapStoreReady = !!found.Chat;
    if (found.Chat) {
      console.log('[EZAP-STORE] Chat module loaded on rescan', _initTries);
      return;
    }
    if (_initTries < INIT_MAX_TRIES) setTimeout(rescan, 2000);
  }

  // Instala interceptors pros nomes conhecidos
  installEarlyInterceptor('webpackChunkwhatsapp_web_client');
  installEarlyInterceptor('webpackChunkbuild');

  // Scan dinamico: WA pode mudar o nome da key (ex: webpackChunkwhatsapp_web_client,
  // webpackChunkbuild, webpackChunk_N_E_, etc). Procura qualquer chave webpackChunk*
  // que tenha .push e entries com formato [ids, modules, runtime?].
  function findWebpackChunk() {
    var keys = Object.keys(window);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('webpackChunk') !== 0) continue;
      var v = window[k];
      if (v && typeof v.push === 'function' && Array.isArray(v)) {
        _lastWebpackKey = k;
        return v;
      }
    }
    return null;
  }

  function _isCollection(obj) {
    return obj && typeof obj.getModelsArray === 'function'
      && (typeof obj.get === 'function' || typeof obj.add === 'function' || obj._models);
  }
  function _modelClassName(coll) {
    try {
      var mc = coll && coll.modelClass;
      if (!mc) return '';
      if (mc.name) return mc.name;
      if (mc.prototype && mc.prototype.constructor && mc.prototype.constructor.name) {
        return mc.prototype.constructor.name;
      }
    } catch (e) {}
    return '';
  }
  function _sniffCollectionByProbe(coll) {
    // Inspeciona 1 modelo pra decidir se eh Chat/Contact/GroupMetadata
    try {
      var arr = coll.getModelsArray();
      if (!arr || !arr.length) return '';
      var m = arr[0];
      if (!m) return '';
      // Chat: tem lastReceivedKey/unreadCount/msgs/contact
      if ('unreadCount' in m || m.msgs || m.contact || 'archive' in m) return 'Chat';
      // GroupMetadata: tem participants + subject
      if (m.participants && m.subject) return 'GroupMetadata';
      // Contact: tem pushname/verifiedName
      if ('pushname' in m || 'verifiedName' in m || 'isMe' in m) return 'Contact';
    } catch (e) {}
    return '';
  }

  function scanModules(req) {
    var found = { Chat: null, Contact: null, GroupMetadata: null, Wid: null };
    var modSource = req.m || req.c || {};
    var keys = Object.keys(modSource);
    var scanned = 0, errors = 0;
    for (var i = 0; i < keys.length; i++) {
      var mod;
      try { mod = req(keys[i]); scanned++; } catch (e) { errors++; continue; }
      if (!mod) continue;
      // Tenta todos os possiveis lugares onde a collection pode estar
      var candidates = [mod, mod.default, mod.Chat, mod.Contact, mod.GroupMetadata, mod.ChatCollection, mod.ContactCollection];
      for (var c = 0; c < candidates.length; c++) {
        var obj = candidates[c];
        if (!obj) continue;
        if (_isCollection(obj)) {
          // 1. Tenta pelo nome da modelClass
          var mcName = _modelClassName(obj);
          // 2. Se nao achou, sniff pelos atributos do modelo
          if (!mcName) mcName = _sniffCollectionByProbe(obj);
          if (mcName === 'Chat' && !found.Chat) found.Chat = obj;
          else if (mcName === 'Contact' && !found.Contact) found.Contact = obj;
          else if (mcName === 'GroupMetadata' && !found.GroupMetadata) found.GroupMetadata = obj;
        }
        // Wid: helpers globais
        if (!found.Wid && typeof obj.createWid === 'function' && typeof obj.fromSerialized === 'function') {
          found.Wid = obj;
        }
      }
    }
    window._ezapDebug = window._ezapDebug || {};
    window._ezapDebug.lastScan = { scanned: scanned, errors: errors, found: {
      Chat: !!found.Chat, Contact: !!found.Contact, GroupMetadata: !!found.GroupMetadata, Wid: !!found.Wid
    }};
    return found;
  }

  // Helper de diagnostico
  function scanExistingChunks(chunk) {
    var info = { total: chunk.length, withRuntime: 0 };
    for (var i = 0; i < chunk.length; i++) {
      var entry = chunk[i];
      if (entry && entry[2] && typeof entry[2] === 'function') {
        info.withRuntime++;
      }
    }
    return info;
  }

  function getChatName(chat) {
    try {
      if (chat.name) return String(chat.name);
      if (chat.formattedTitle) return String(chat.formattedTitle);
      var ct = chat.contact;
      if (ct) {
        return String(ct.name || ct.verifiedName || ct.pushname || ct.formattedName || ct.shortName || '');
      }
    } catch (e) {}
    return '';
  }

  function getAllChats() {
    if (!window._ezapStoreReady || !window._ezapStore || !window._ezapStore.Chat) return null;
    var models;
    try { models = window._ezapStore.Chat.getModelsArray(); } catch (e) { return null; }
    if (!models || !Array.isArray(models)) return null;
    var out = [];
    for (var i = 0; i < models.length; i++) {
      var c = models[i];
      if (!c || !c.id) continue;
      var jid = '';
      try { jid = c.id._serialized || (c.id.toString && c.id.toString()) || ''; } catch (e) { continue; }
      if (!jid) continue;
      var name = getChatName(c);
      var isGroup = jid.indexOf('@g.us') >= 0;
      out.push({
        jid: jid,
        name: name.trim(),
        isGroup: isGroup,
        pushname: (c.contact && c.contact.pushname) || '',
        shortName: (c.contact && c.contact.shortName) || ''
      });
    }
    return out;
  }

  // ===== RPC via postMessage =====
  window.addEventListener('message', function(event) {
    if (!event.data || event.source !== window) return;
    var d = event.data;
    if (d.type === '_ezap_get_chats_req') {
      var chats = getAllChats();
      window.postMessage({
        type: '_ezap_get_chats_res',
        id: d.id,
        ok: !!chats,
        chats: chats || [],
        ready: window._ezapStoreReady
      }, '*');
    } else if (d.type === '_ezap_store_ready_req') {
      window.postMessage({
        type: '_ezap_store_ready_res',
        id: d.id,
        ready: window._ezapStoreReady
      }, '*');
    }
  });

  // Debug helper exposto no console: window._ezapDebugStore()
  window._ezapDebugStore = function() {
    var allKeys = Object.keys(window).filter(function(k){return k.indexOf('webpackChunk')===0;});
    var chunk = findWebpackChunk();
    return {
      ready: window._ezapStoreReady,
      tries: _initTries,
      lastWebpackKey: _lastWebpackKey,
      allWebpackKeys: allKeys,
      chunkPresent: !!chunk,
      chunkLength: chunk ? chunk.length : null,
      chunksWithRuntime: chunk ? scanExistingChunks(chunk).withRuntime : null,
      pushIsNative: chunk ? /\[native code\]/.test(String(chunk.push)) : null,
      capturedVia: _capturedVia,
      webpackRequireCaptured: !!window._ezapWebpackRequire,
      store: window._ezapStore ? {
        Chat: !!window._ezapStore.Chat,
        Contact: !!window._ezapStore.Contact,
        GroupMetadata: !!window._ezapStore.GroupMetadata,
        Wid: !!window._ezapStore.Wid
      } : null,
      lastScan: (window._ezapDebug && window._ezapDebug.lastScan) || null,
      chatCount: (function(){
        try { return window._ezapStore && window._ezapStore.Chat ? window._ezapStore.Chat.getModelsArray().length : null; } catch(e) { return 'err:'+e.message; }
      })()
    };
  };

  console.log('[EZAP-STORE] Bridge started (v5 early interceptor). Call window._ezapDebugStore() for state.');
})();
