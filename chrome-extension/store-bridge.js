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

  var WEBPACK_KEYS = [
    'webpackChunkwhatsapp_web_client',
    'webpackChunkbuild'
  ];
  var INIT_MAX_TRIES = 120;      // ~60s
  var INIT_INTERVAL_MS = 500;
  var _initTries = 0;

  function findWebpackChunk() {
    for (var i = 0; i < WEBPACK_KEYS.length; i++) {
      var k = WEBPACK_KEYS[i];
      if (window[k] && typeof window[k].push === 'function') return window[k];
    }
    return null;
  }

  function scanModules(req) {
    var found = { Chat: null, Contact: null, GroupMetadata: null, Wid: null };
    var keys = Object.keys(req.m || {});
    for (var i = 0; i < keys.length; i++) {
      var mod;
      try { mod = req(keys[i]); } catch (e) { continue; }
      if (!mod) continue;
      var candidates = [mod, mod.default, mod.Chat, mod.Contact, mod.GroupMetadata];
      for (var c = 0; c < candidates.length; c++) {
        var obj = candidates[c];
        if (!obj) continue;
        // Chat collection: has getModelsArray + modelClass name Chat
        if (!found.Chat && typeof obj.getModelsArray === 'function' && obj.modelClass) {
          var mcName = '';
          try { mcName = (obj.modelClass && (obj.modelClass.name || obj.modelClass.prototype && obj.modelClass.prototype.constructor && obj.modelClass.prototype.constructor.name)) || ''; } catch (e) {}
          if (mcName === 'Chat') found.Chat = obj;
          else if (mcName === 'Contact') found.Contact = found.Contact || obj;
          else if (mcName === 'GroupMetadata') found.GroupMetadata = found.GroupMetadata || obj;
        }
        // Wid: has createWid / fromSerialized helpers
        if (!found.Wid && typeof obj.createWid === 'function' && typeof obj.fromSerialized === 'function') {
          found.Wid = obj;
        }
      }
      // Namespaced exports: mod.Chat etc
      if (!found.Chat && mod.Chat && typeof mod.Chat.getModelsArray === 'function') found.Chat = mod.Chat;
      if (!found.Contact && mod.Contact && typeof mod.Contact.getModelsArray === 'function') found.Contact = mod.Contact;
      if (!found.GroupMetadata && mod.GroupMetadata && typeof mod.GroupMetadata.getModelsArray === 'function') found.GroupMetadata = mod.GroupMetadata;
    }
    return found;
  }

  function tryInject() {
    _initTries++;
    var chunk = findWebpackChunk();
    if (!chunk) {
      if (_initTries < INIT_MAX_TRIES) setTimeout(tryInject, INIT_INTERVAL_MS);
      else console.log('[EZAP-STORE] webpack chunk never appeared, giving up');
      return;
    }
    try {
      chunk.push([
        ['_ezap_parasite_' + Date.now()],
        {},
        function(req) {
          var found = scanModules(req);
          window._ezapStore = found;
          window._ezapStoreReady = !!found.Chat;
          console.log('[EZAP-STORE] Hook done:', {
            Chat: !!found.Chat,
            Contact: !!found.Contact,
            GroupMetadata: !!found.GroupMetadata,
            Wid: !!found.Wid
          });
          if (!found.Chat && _initTries < INIT_MAX_TRIES) {
            // Module shape may have changed — retry later, modules keep loading
            setTimeout(tryInject, 2000);
          }
        }
      ]);
    } catch (e) {
      console.log('[EZAP-STORE] webpack push failed:', e && e.message);
      if (_initTries < INIT_MAX_TRIES) setTimeout(tryInject, 1000);
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

  tryInject();
  console.log('[EZAP-STORE] Bridge started');
})();
