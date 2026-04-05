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

  // Captura __webpack_require__ via modulo parasita (tecnica moduleRaid).
  // Alguns builds do WA nao chamam o callback runtime quando modules={}.
  // Entao registramos um modulo fake e forcamos webpack a carrega-lo.
  var _webpackRequire = null;

  function captureWebpackRequire(onReady) {
    var chunk = findWebpackChunk();
    if (!chunk) return false;
    var parasiteId = 'ezap_parasite_' + Date.now() + '_' + _initTries;
    try {
      var moduleMap = {};
      moduleMap[parasiteId] = function(module, exports, webpack_require) {
        _webpackRequire = webpack_require;
        module.exports = {};
        onReady(webpack_require);
      };
      chunk.push([
        [parasiteId],    // chunkIds
        moduleMap,       // module factories (contem nosso parasita)
        function(req) {  // runtime: trigger para carregar nosso modulo
          try { req(parasiteId); } catch (e) {
            console.log('[EZAP-STORE] parasite require failed:', e && e.message);
          }
        }
      ]);
      return true;
    } catch (e) {
      console.log('[EZAP-STORE] push failed:', e && e.message);
      return false;
    }
  }

  function tryInject() {
    _initTries++;
    var chunk = findWebpackChunk();
    if (!chunk) {
      if (_initTries < INIT_MAX_TRIES) setTimeout(tryInject, INIT_INTERVAL_MS);
      else console.log('[EZAP-STORE] webpack chunk never appeared after', _initTries, 'tries — giving up');
      return;
    }

    // Se ja capturamos __webpack_require__, apenas re-escaneia os modulos
    if (_webpackRequire) {
      var found = scanModules(_webpackRequire);
      window._ezapStore = found;
      window._ezapStoreReady = !!found.Chat;
      if (_initTries <= 3 || found.Chat) {
        console.log('[EZAP-STORE] Rescan try', _initTries, 'found:', {
          Chat: !!found.Chat, Contact: !!found.Contact,
          GroupMetadata: !!found.GroupMetadata, Wid: !!found.Wid
        });
      }
      if (!found.Chat && _initTries < INIT_MAX_TRIES) {
        setTimeout(tryInject, 2000);
      } else if (found.Chat && _initTries > 3) {
        console.log('[EZAP-STORE] Chat module finally loaded on try', _initTries);
      }
      return;
    }

    // Primeira captura: injeta parasita
    var ok = captureWebpackRequire(function(req) {
      console.log('[EZAP-STORE] Captured __webpack_require__ on try', _initTries, 'key:', _lastWebpackKey);
      var found = scanModules(req);
      window._ezapStore = found;
      window._ezapStoreReady = !!found.Chat;
      console.log('[EZAP-STORE] First scan found:', {
        Chat: !!found.Chat, Contact: !!found.Contact,
        GroupMetadata: !!found.GroupMetadata, Wid: !!found.Wid,
        scanned: window._ezapDebug.lastScan.scanned,
        errors: window._ezapDebug.lastScan.errors
      });
      if (!found.Chat && _initTries < INIT_MAX_TRIES) {
        setTimeout(tryInject, 2000);
      }
    });
    if (!ok && _initTries < INIT_MAX_TRIES) {
      setTimeout(tryInject, 1000);
    }
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
    return {
      ready: window._ezapStoreReady,
      tries: _initTries,
      lastWebpackKey: _lastWebpackKey,
      allWebpackKeys: allKeys,
      chunkPresent: !!findWebpackChunk(),
      webpackRequireCaptured: !!_webpackRequire,
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

  tryInject();
  console.log('[EZAP-STORE] Bridge started (v2 robust scan). Call window._ezapDebugStore() for state.');
})();
