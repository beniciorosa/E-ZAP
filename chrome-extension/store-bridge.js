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

  // NAO instalamos mais o early interceptor nos nomes conhecidos porque:
  //   1) WA pode usar um nome DIFERENTE de webpackChunkwhatsapp_web_client
  //   2) Nosso defineProperty parece confundir a bootstrap do WA neste build
  //      (PIN nao carrega). Deixamos WA criar o chunk naturalmente e
  //      detectamos via polling dinamico.

  // ===== PARASITE PUSH POLLING =====
  // Quando outra extensao (ex: WPPConnect/concorrente) rouba nosso descriptor
  // antes do WA assignar, nosso setter nao dispara. Plano B: periodicamente
  // pegar a chunk atual (whoever holds the real value), detectar se webpack
  // ja substituiu .push por jsonpCallback, e entao empurrar uma entrada
  // parasita que webpack vai processar imediatamente chamando nosso runtime
  // com __webpack_require__ (tecnica moduleRaid/wppconnect).
  var _parasitePoll = null;
  var _parasitePushed = {};  // por key, evita spam
  function tryParasitePush() {
    if (window._ezapWebpackRequire) return true;
    var keys = Object.keys(window).filter(function(k){return k.indexOf('webpackChunk')===0;});
    // Fallback: testar nomes conhecidos mesmo se nao aparecem em Object.keys
    ['webpackChunkwhatsapp_web_client','webpackChunkbuild','webpackChunk_N_E_'].forEach(function(n){
      if (keys.indexOf(n) < 0) {
        try { if (window[n]) keys.push(n); } catch(e) {}
      }
    });
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var chunk;
      try { chunk = window[k]; } catch(e) { continue; }
      if (!chunk || typeof chunk.push !== 'function' || !Array.isArray(chunk)) continue;
      // Wrap push (caso webpack ainda nao tenha replaced, vamos ver quando fizer)
      if (!chunk._ezapWrapped) {
        wrapArrayPush(chunk);
        console.log('[EZAP-STORE] Wrapped push on', k, '(len=', chunk.length, 'native=', String(chunk.push).indexOf('[native code]')>=0, ')');
      }
      var isNative = String(chunk.push).indexOf('[native code]') >= 0;
      if (isNative) continue; // webpack ainda nao instalou jsonpCallback, nao adianta parasite ainda
      if (_parasitePushed[k]) continue; // ja empurramos parasita nesse chunk
      try {
        var marker = '_ezap_' + Math.random().toString(36).slice(2);
        var keyRef = k;
        chunk.push([
          [marker],
          {},
          function(req) {
            if (!window._ezapWebpackRequire) {
              window._ezapWebpackRequire = req;
              _capturedVia = 'parasite-poll:' + keyRef;
              _lastWebpackKey = keyRef;
              console.log('[EZAP-STORE] Captured __webpack_require__ via parasite poll on', keyRef);
              try { onWebpackRequireReady(req); } catch(e) { console.log('[EZAP-STORE] onReady err:', e && e.message); }
            }
          }
        ]);
        _parasitePushed[k] = true;
        console.log('[EZAP-STORE] Parasite pushed to', k, '(len=', chunk.length, ')');
      } catch(e) {
        console.log('[EZAP-STORE] parasite push failed on', k, ':', e && e.message);
      }
    }
    return !!window._ezapWebpackRequire;
  }
  _parasitePoll = setInterval(function() {
    if (window._ezapWebpackRequire) { clearInterval(_parasitePoll); return; }
    tryParasitePush();
  }, 200);
  setTimeout(function() { if (_parasitePoll) clearInterval(_parasitePoll); }, 180000);

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

  // ===== REACT FIBER STRATEGY (primary) =====
  // WA Web expose o store inteiro (chats/contacts/messages/actions) nos props
  // do componente virtual-scroll-list ancestral de cada row da lista de chats.
  // Caminhando o fiber de qualquer [role="row"] dentro de #pane-side uns ~13
  // niveis pra cima, achamos um memoizedProps com esses campos. store.chats
  // e um Array JS simples com TODOS os chats do usuario — incluindo os que
  // nao estao renderizados no virtual scroll. Zero dependencia de webpack.
  var _fiberStoreCache = null;
  var _fiberStoreLastFoundAt = 0;
  function findFiberStore() {
    try {
      var pane = document.getElementById('pane-side');
      if (!pane) return null;
      var rows = pane.querySelectorAll('[role="row"]');
      if (!rows.length) return null;
      for (var r = 0; r < Math.min(rows.length, 3); r++) {
        var row = rows[r];
        var keys = Object.keys(row);
        var fiberKey = null;
        for (var kk = 0; kk < keys.length; kk++) {
          if (keys[kk].indexOf('__reactFiber') === 0) { fiberKey = keys[kk]; break; }
        }
        if (!fiberKey) continue;
        var cur = row[fiberKey];
        var depth = 0;
        while (cur && depth < 25) {
          var p = cur.memoizedProps;
          if (p && p.chats && p.contacts && p.messages && Array.isArray(p.chats)) {
            _fiberStoreCache = p;
            _fiberStoreLastFoundAt = Date.now();
            return p;
          }
          cur = cur.return;
          depth++;
        }
      }
    } catch (e) {
      console.log('[EZAP-STORE] findFiberStore err:', e && e.message);
    }
    return null;
  }

  function getFiberProfilePic(chat) {
    try {
      var candidates = [
        chat && chat.contact && chat.contact.profilePicThumb,
        chat && chat.contact && chat.contact.__x_profilePicThumb,
        chat && chat.profilePicThumbObj,
        chat && chat.__x_profilePicThumbObj
      ];
      for (var i = 0; i < candidates.length; i++) {
        var p = candidates[i];
        if (!p) continue;
        var url = p.eurl || p.__x_eurl || p.img || p.__x_img || p.imgFull || p.__x_imgFull;
        if (url && typeof url === 'string') return url;
      }
    } catch (e) {}
    return '';
  }

  function getFiberChatName(chat) {
    try {
      if (typeof chat.name === 'string' && chat.name) return chat.name;
      if (typeof chat.title === 'function') { var t = chat.title(); if (t) return String(t); }
      else if (typeof chat.title === 'string' && chat.title) return chat.title;
      if (chat.__x_formattedTitle) return String(chat.__x_formattedTitle);
      if (chat.formattedTitle) return String(chat.formattedTitle);
      var ct = chat.contact;
      if (ct) {
        if (typeof ct.name === 'string' && ct.name) return ct.name;
        if (ct.verifiedName) return String(ct.verifiedName);
        if (ct.pushname) return String(ct.pushname);
        if (ct.shortName) return String(ct.shortName);
        if (ct.formattedName) return String(ct.formattedName);
        if (ct.__x_name) return String(ct.__x_name);
        if (ct.__x_pushname) return String(ct.__x_pushname);
      }
    } catch (e) {}
    return '';
  }

  function getAllChatsFromFiber() {
    var store = _fiberStoreCache;
    // Valida cache ou re-acha (store pode ficar stale apos re-renders do React)
    if (!store || !store.chats || !Array.isArray(store.chats)) store = findFiberStore();
    if (!store || !Array.isArray(store.chats) || !store.chats.length) return null;
    var chats = store.chats;
    var out = [];
    for (var i = 0; i < chats.length; i++) {
      var c = chats[i];
      if (!c || !c.id) continue;
      var jid = '';
      try {
        if (c.id._serialized) jid = c.id._serialized;
        else if (typeof c.id === 'string') jid = c.id;
        else if (c.id.toString) jid = c.id.toString();
      } catch (e) { continue; }
      if (!jid) continue;
      var name = getFiberChatName(c);
      var isGroup = jid.indexOf('@g.us') >= 0;
      out.push({
        jid: jid,
        name: String(name || '').trim(),
        isGroup: isGroup,
        pushname: (c.contact && (c.contact.pushname || c.contact.__x_pushname)) || '',
        shortName: (c.contact && (c.contact.shortName || c.contact.__x_shortName)) || '',
        profilePicUrl: getFiberProfilePic(c)
      });
    }
    return out;
  }

  // Busca o modelo do chat no fiber store por JID
  function findChatModelByJid(jid) {
    var store = _fiberStoreCache || findFiberStore();
    if (!store || !Array.isArray(store.chats)) return null;
    for (var i = 0; i < store.chats.length; i++) {
      var c = store.chats[i];
      if (!c || !c.id) continue;
      try {
        var cjid = c.id._serialized || (typeof c.id === 'string' ? c.id : (c.id.toString && c.id.toString()));
        if (cjid === jid) return { chat: c, store: store };
      } catch (e) {}
    }
    return null;
  }

  // Tenta abrir um chat por JID usando varios metodos do WA Web.
  // Returns { ok, via, tried, availableKeys } pra diagnostico.
  function openChatByJid(jid) {
    var match = findChatModelByJid(jid);
    if (!match) return { ok: false, reason: 'chat-not-found' };
    var target = match.chat;
    var store = match.store;
    var tried = [];

    // Enumera funcoes ANTES de tentar nada, pra poder retornar no diagnostico
    var storeFns = [];
    try { storeFns = Object.keys(store).filter(function(k){return typeof store[k]==='function';}); } catch(e) {}
    var chatFns = [];
    try { chatFns = Object.keys(target).filter(function(k){return typeof target[k]==='function';}); } catch(e) {}

    console.log('[EZAP-OPEN] Tentando abrir chat:', jid);
    console.log('[EZAP-OPEN] storeFns disponiveis (' + storeFns.length + '):', storeFns);
    console.log('[EZAP-OPEN] chatFns disponiveis (' + chatFns.length + '):', chatFns);

    // Strategy 1: metodos no proprio chat model (lista expandida)
    var chatMethods = ['open', 'activate', 'select', 'click', 'onClick', 'openChat', 'setActive', 'focus'];
    for (var i = 0; i < chatMethods.length; i++) {
      var m = chatMethods[i];
      try {
        if (typeof target[m] === 'function') {
          target[m]();
          return { ok: true, via: 'chat.' + m + '()' };
        }
      } catch (e) { tried.push('chat.' + m + ':' + (e && e.message)); }
    }

    // Strategy 2: metodos no store (lista expandida)
    var storeMethods = [
      'openChat', 'onChatClick', 'onChatPressed', 'handleChatClick', 'selectChat',
      'onChatOpen', 'onOpenChat', 'chatSelect', 'onSelectChat', 'setActiveChat',
      'onClick', 'onPress', 'onChatSelect', 'onItemClick', 'onItemPress'
    ];
    for (var j = 0; j < storeMethods.length; j++) {
      var sm = storeMethods[j];
      try {
        if (typeof store[sm] === 'function') {
          // Tenta com chat como argumento
          try { store[sm](target); return { ok: true, via: 'store.' + sm + '(chat)' }; }
          catch (e1) {
            // Tenta com { chat } como argumento
            try { store[sm]({ chat: target, id: target.id, jid: jid }); return { ok: true, via: 'store.' + sm + '({chat})' }; }
            catch (e2) {
              // Tenta com jid como argumento
              try { store[sm](jid); return { ok: true, via: 'store.' + sm + '(jid)' }; }
              catch (e3) { tried.push('store.' + sm + ': all args failed'); }
            }
          }
        }
      } catch (e) { tried.push('store.' + sm + ':' + (e && e.message)); }
    }

    // Strategy 3: escanea props do store por qualquer function com nome matching
    try {
      for (var k = 0; k < storeFns.length; k++) {
        var key = storeFns[k];
        if (/chat|open|select|activate|press|click|navigate|goto/i.test(key)) {
          try {
            store[key](target);
            return { ok: true, via: 'store.' + key + '(chat)' };
          } catch (e) {
            try { store[key](jid); return { ok: true, via: 'store.' + key + '(jid)' }; }
            catch (e2) { tried.push('store.' + key + ': failed'); }
          }
        }
      }
    } catch (e) {}

    // Strategy 4: procura metodo no chat model com nome relacionado
    try {
      for (var kk = 0; kk < chatFns.length; kk++) {
        var ck = chatFns[kk];
        if (/open|activate|select|focus|goto|navigate/i.test(ck)) {
          try {
            target[ck]();
            return { ok: true, via: 'chat.' + ck + '()' };
          } catch (e) { tried.push('chat.' + ck + ': failed'); }
        }
      }
    } catch (e) {}

    // Strategy 5: procura uma action/dispatch no store (Redux-like)
    try {
      if (typeof store.dispatch === 'function') {
        var actions = [
          { type: 'OPEN_CHAT', payload: { jid: jid } },
          { type: 'chat/open', payload: target },
          { type: 'SELECT_CHAT', chatId: jid }
        ];
        for (var a = 0; a < actions.length; a++) {
          try { store.dispatch(actions[a]); return { ok: true, via: 'store.dispatch(' + actions[a].type + ')' }; }
          catch (e) { tried.push('dispatch ' + actions[a].type + ': failed'); }
        }
      }
    } catch (e) {}

    // Diagnostico: retorna keys disponiveis pro caso de nada funcionar
    return {
      ok: false,
      reason: 'no-method-worked',
      tried: tried,
      storeFns: storeFns,
      chatFns: chatFns.slice(0, 60),
      hasDispatch: typeof store.dispatch === 'function',
      chatIdSerialized: (target.id && target.id._serialized) || null
    };
  }

  // ===== RPC via postMessage =====
  window.addEventListener('message', function(event) {
    if (!event.data || event.source !== window) return;
    var d = event.data;
    if (d.type === '_ezap_get_chats_req') {
      // Estrategia primaria: React fiber (zero dep webpack)
      var chats = getAllChatsFromFiber();
      var via = 'fiber';
      if (!chats || !chats.length) {
        // Fallback: webpack store (so funciona se _ezapWebpackRequire capturado)
        chats = getAllChats();
        via = 'webpack';
      }
      window.postMessage({
        type: '_ezap_get_chats_res',
        id: d.id,
        ok: !!(chats && chats.length),
        chats: chats || [],
        ready: !!(chats && chats.length) || window._ezapStoreReady,
        via: via
      }, '*');
    } else if (d.type === '_ezap_open_chat_req') {
      var result;
      try { result = openChatByJid(d.jid); }
      catch (e) { result = { ok: false, reason: 'exception', error: e && e.message }; }
      window.postMessage({
        type: '_ezap_open_chat_res',
        id: d.id,
        result: result
      }, '*');
    } else if (d.type === '_ezap_store_ready_req') {
      // Fiber store nao precisa de "ready handshake" — ou tem, ou nao tem.
      var fiberOk = false;
      try { var s = _fiberStoreCache || findFiberStore(); fiberOk = !!(s && s.chats && s.chats.length); } catch(e) {}
      window.postMessage({
        type: '_ezap_store_ready_res',
        id: d.id,
        ready: fiberOk || window._ezapStoreReady
      }, '*');
    }
  });

  // Debug helper exposto no console: window._ezapDebugStore()
  window._ezapDebugStore = function() {
    var fiberChats = null;
    try { fiberChats = getAllChatsFromFiber(); } catch(e) {}
    var fiberInfo = fiberChats ? {
      count: fiberChats.length,
      sample: fiberChats.slice(0, 3),
      withName: fiberChats.filter(function(x){return x.name;}).length,
      withoutName: fiberChats.filter(function(x){return !x.name;}).length
    } : null;
    var allKeys = Object.keys(window).filter(function(k){return k.indexOf('webpackChunk')===0;});
    // Inclui nomes conhecidos mesmo se nao enumerable
    ['webpackChunkwhatsapp_web_client','webpackChunkbuild','webpackChunk_N_E_'].forEach(function(n){
      if (allKeys.indexOf(n) < 0) { try { if (window[n]) allKeys.push(n); } catch(e){} }
    });
    var perKey = {};
    allKeys.forEach(function(k){
      try {
        var v = window[k];
        perKey[k] = {
          present: v !== undefined && v !== null,
          isArray: Array.isArray(v),
          len: v && typeof v.length === 'number' ? v.length : null,
          pushNative: v && v.push ? String(v.push).indexOf('[native code]')>=0 : null,
          parasitePushed: !!_parasitePushed[k]
        };
      } catch(e) { perKey[k] = 'err:'+e.message; }
    });
    var chunk = findWebpackChunk();
    return {
      fiber: fiberInfo,
      ready: window._ezapStoreReady,
      tries: _initTries,
      lastWebpackKey: _lastWebpackKey,
      allWebpackKeys: allKeys,
      perKey: perKey,
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

  console.log('[EZAP-STORE] Bridge started (v8 React fiber primary, webpack fallback). Call window._ezapDebugStore() for state.');
})();
