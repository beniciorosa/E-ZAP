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
      GroupMetadata: !!found.GroupMetadata, Wid: !!found.Wid,
      ProfilePicThumb: !!found.ProfilePicThumb
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
    var found = { Chat: null, Contact: null, GroupMetadata: null, Wid: null, ProfilePicThumb: null };
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
        // ProfilePicThumb: store que tem find() e retorna thumb com eurl
        if (!found.ProfilePicThumb && typeof obj.find === 'function' && typeof obj.getModelsArray === 'function') {
          try {
            var pModels = obj.getModelsArray();
            if (pModels && pModels.length > 0) {
              var pm = pModels[0];
              // ProfilePicThumb model tem: tag, eurl, img, stale, id
              if (pm && ('tag' in pm || 'stale' in pm) && (pm.eurl || pm.__x_eurl || pm.img || pm.__x_img)) {
                found.ProfilePicThumb = obj;
                console.log('[EZAP-STORE] Found ProfilePicThumb store with', pModels.length, 'entries');
              }
            }
          } catch(e) {}
        }
      }
    }
    window._ezapDebug = window._ezapDebug || {};
    window._ezapDebug.lastScan = { scanned: scanned, errors: errors, found: {
      Chat: !!found.Chat, Contact: !!found.Contact, GroupMetadata: !!found.GroupMetadata, Wid: !!found.Wid, ProfilePicThumb: !!found.ProfilePicThumb
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
        chat && chat.__x_profilePicThumbObj,
        chat && chat.contact && chat.contact.profilePicThumbObj,
        chat && chat.contact && chat.contact.__x_profilePicThumbObj
      ];
      for (var i = 0; i < candidates.length; i++) {
        var p = candidates[i];
        if (!p) continue;
        var url = p.eurl || p.__x_eurl || p.img || p.__x_img ||
                  p.imgFull || p.__x_imgFull || p.eurl_1x || p.url;
        if (url && typeof url === 'string') return url;
      }
      // Tenta direto em fields do chat
      var directUrl = (chat && (chat.eurl || chat.__x_eurl ||
                     (chat.contact && (chat.contact.eurl || chat.contact.__x_eurl)))) || '';
      if (directUrl && typeof directUrl === 'string') return directUrl;
    } catch (e) {}
    return '';
  }

  // ===== PROFILE PIC ON DEMAND =====
  // Busca foto de perfil para um JID usando multiplas estrategias:
  // 1. ProfilePicThumb Store (webpack) — find() retorna thumb com eurl fresca
  // 2. Fiber store — profilePicThumb.img (base64 local, nunca expira)
  // 3. Fiber store — profilePicThumb.eurl (pode estar expirada)

  function _extractThumbUrl(thumb) {
    if (!thumb) return '';
    // Prioriza eurl (URL de alta qualidade)
    var url = thumb.eurl || thumb.__x_eurl || thumb.imgFull || thumb.__x_imgFull || thumb.eurl_1x || thumb.url;
    if (url && typeof url === 'string' && url.indexOf('http') === 0) return url;
    // Fallback: img base64 (thumbnail pequena, mas sempre disponivel)
    var img = thumb.img || thumb.__x_img;
    if (img && typeof img === 'string') return img;
    return '';
  }

  function _getThumbFromChat(chat) {
    if (!chat) return null;
    var candidates = [
      chat.contact && chat.contact.profilePicThumb,
      chat.contact && chat.contact.__x_profilePicThumb,
      chat.profilePicThumbObj,
      chat.__x_profilePicThumbObj,
      chat.contact && chat.contact.profilePicThumbObj,
      chat.contact && chat.contact.__x_profilePicThumbObj
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i]) return candidates[i];
    }
    return null;
  }

  // Debug: inspeciona profundamente um chat pra achar onde a foto esta
  var _picDebugDone = false;
  function _deepInspectChat(chat, jid) {
    if (_picDebugDone) return;
    _picDebugDone = true;
    try {
      var contact = chat.contact || chat.__x_contact;
      var info = {
        jid: jid,
        hasContact: !!contact,
        chatKeys: Object.keys(chat).filter(function(k) { return /pic|thumb|img|photo|avatar|url/i.test(k); }),
        contactKeys: contact ? Object.keys(contact).filter(function(k) { return /pic|thumb|img|photo|avatar|url/i.test(k); }) : [],
        allContactKeys: contact ? Object.keys(contact).slice(0, 40) : []
      };
      // Inspeciona profilePicThumb diretamente
      var thumb = contact && (contact.profilePicThumb || contact.__x_profilePicThumb);
      if (thumb) {
        info.thumbKeys = Object.keys(thumb);
        info.thumbProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(thumb) || {}).slice(0, 20);
        info.thumbEurl = thumb.eurl || thumb.__x_eurl || null;
        info.thumbImg = thumb.img ? (typeof thumb.img + ':' + String(thumb.img).slice(0, 30)) : null;
        info.thumbTag = thumb.tag || thumb.__x_tag || null;
      } else {
        info.noThumb = true;
        // Busca qualquer campo que possa ser uma URL de foto
        if (contact) {
          Object.keys(contact).forEach(function(k) {
            var v = contact[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && v !== contact) {
              var vk = Object.keys(v);
              if (vk.some(function(kk) { return /eurl|img|tag/.test(kk); })) {
                info['contact.' + k] = vk.slice(0, 10);
              }
            }
          });
        }
      }
      console.log('[EZAP-PIC] Deep inspect chat:', JSON.stringify(info, null, 2));
    } catch(e) {
      console.log('[EZAP-PIC] Deep inspect error:', e && e.message);
    }
  }

  function fetchProfilePicOnDemand(jid) {
    return new Promise(function(resolve) {
      try {
        // Primeiro refresh do fiber store pra ter dados frescos
        findFiberStore();

        var match = findChatModelByJid(jid);
        if (!match) { resolve(''); return; }

        var chat = match.chat;
        _deepInspectChat(chat, jid);

        // === ESTRATEGIA 1: ProfilePicThumb Store (webpack) ===
        var ppStore = window._ezapStore && window._ezapStore.ProfilePicThumb;
        var widHelper = window._ezapStore && window._ezapStore.Wid;
        if (ppStore && typeof ppStore.find === 'function') {
          try {
            var widObj = null;
            if (widHelper && typeof widHelper.createWid === 'function') {
              widObj = widHelper.createWid(jid);
            }
            var findResult = ppStore.find(widObj || jid);
            if (findResult && typeof findResult.then === 'function') {
              findResult.then(function(thumb) {
                var url = _extractThumbUrl(thumb);
                resolve(url || getFiberProfilePic(chat) || '');
              }).catch(function() {
                resolve(getFiberProfilePic(chat) || '');
              });
              return;
            }
            if (findResult) {
              var url = _extractThumbUrl(findResult);
              if (url) { resolve(url); return; }
            }
          } catch(e) {}
        }

        // === ESTRATEGIA 2: Thumb do fiber store (todos os campos possiveis) ===
        var contact = chat.contact || chat.__x_contact;
        if (contact) {
          // Tenta TODOS os campos do contact que possam ter URL/base64
          var allKeys = Object.keys(contact);
          for (var ki = 0; ki < allKeys.length; ki++) {
            var k = allKeys[ki];
            if (!/pic|thumb|img|photo|avatar/i.test(k)) continue;
            var val = contact[k];
            if (!val) continue;
            if (typeof val === 'string') {
              if (val.indexOf('data:') === 0 || val.indexOf('http') === 0) {
                resolve(val); return;
              }
            }
            if (typeof val === 'object') {
              var url = _extractThumbUrl(val);
              if (url) { resolve(url); return; }
            }
          }
        }

        // === ESTRATEGIA 3: getFiberProfilePic original ===
        var freshUrl = getFiberProfilePic(chat);
        resolve(freshUrl || '');
      } catch (e) {
        resolve('');
      }
    });
  }

  // Batch: busca fotos de varios JIDs de uma vez
  function fetchProfilePicsBatch(jids) {
    var promises = jids.map(function(jid) {
      return fetchProfilePicOnDemand(jid).then(function(url) {
        return { jid: jid, url: url };
      });
    });
    return Promise.all(promises);
  }

  function getFiberChatName(chat) {
    try {
      // Prioridade: formattedTitle/title() refletem o nome ATUAL do grupo
      // (atualizado em tempo real). chat.name pode ficar stale apos rename.
      if (chat.formattedTitle) return String(chat.formattedTitle);
      if (chat.__x_formattedTitle) return String(chat.__x_formattedTitle);
      if (typeof chat.title === 'function') { var t = chat.title(); if (t) return String(t); }
      else if (typeof chat.title === 'string' && chat.title) return chat.title;
      if (typeof chat.name === 'string' && chat.name) return chat.name;
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
    // SEMPRE re-scana fiber store (cache pode ficar stale apos React re-render,
    // ex: grupo renomeado, contato mudou pushname). Custo minimo (~1-3ms).
    var store = findFiberStore();
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
      var lastTs = 0;
      try {
        lastTs = Number(c.t || c.__x_t || (c.lastReceivedKey && c.lastReceivedKey.t) || 0) || 0;
      } catch (e) {}
      var unread = 0;
      try { unread = Number(c.unreadCount || c.__x_unreadCount || 0) || 0; } catch (e) {}
      // Extrai preview da ultima mensagem (body + fromMe)
      var lastMsgText = '';
      var lastMsgFromMe = false;
      try {
        var msgs = c.msgs || c.__x_msgs;
        var lastMsg = null;
        if (msgs) {
          if (typeof msgs.last === 'function') lastMsg = msgs.last();
          else if (msgs._models && msgs._models.length) lastMsg = msgs._models[msgs._models.length - 1];
          else if (Array.isArray(msgs) && msgs.length) lastMsg = msgs[msgs.length - 1];
        }
        if (lastMsg) {
          lastMsgFromMe = !!(lastMsg.id && lastMsg.id.fromMe) || !!lastMsg.__x_isSentByMe;
          // Prefere caption (legenda) sobre body pra midia (body pode ser base64 thumbnail)
          var body = lastMsg.caption || lastMsg.__x_caption || '';
          if (!body) {
            var rawBody = lastMsg.body || lastMsg.__x_body || '';
            // Filtra base64 e dados binarios (thumbnails de video/imagem)
            if (rawBody && rawBody.length < 200 && !/^\/9j\/|^data:|^[A-Za-z0-9+\/]{50,}/.test(rawBody)) {
              body = rawBody;
            }
          }
          if (!body) {
            // Tipos nao-texto: mostra label com duracao quando disponivel
            var type = lastMsg.type || lastMsg.__x_type || '';
            var duration = Number(lastMsg.duration || lastMsg.__x_duration || 0);
            var durStr = duration > 0 ? ' ' + Math.floor(duration / 60) + ':' + ('0' + (duration % 60)).slice(-2) : '';
            if (type === 'image') body = '📷 Foto';
            else if (type === 'video') body = '🎥 Video' + durStr;
            else if (type === 'audio' || type === 'ptt') body = '🎤' + durStr;
            else if (type === 'document') body = '📄 Documento';
            else if (type === 'sticker') body = '🖼️ Sticker';
            else if (type === 'location') body = '📍 Localizacao';
            else if (type === 'vcard' || type === 'multi_vcard') body = '👤 Contato';
          }
          lastMsgText = String(body || '').slice(0, 80);
        }
      } catch (e) {}
      // Resolve sender name pra grupos (exibe quem mandou a ultima msg)
      var lastMsgSender = '';
      try {
        if (lastMsg && isGroup && !lastMsgFromMe) {
          var participant = lastMsg.author || lastMsg.__x_author ||
            (lastMsg.id && (lastMsg.id.participant || lastMsg.id._serialized)) || '';
          if (participant) {
            // Tenta achar nome do contato que mandou
            var pJid = typeof participant === 'string' ? participant :
              (participant._serialized || participant.toString && participant.toString() || '');
            // Busca nome do sender: senderObj, notifyName, pushname
            var senderContact = lastMsg.senderObj || lastMsg.__x_senderObj;
            if (senderContact) {
              lastMsgSender = senderContact.pushname || senderContact.__x_pushname ||
                senderContact.name || senderContact.__x_name ||
                senderContact.shortName || senderContact.__x_shortName ||
                senderContact.formattedName || senderContact.verifiedName || '';
            }
            // Fallback: notifyName (pushname do sender na hora do envio)
            if (!lastMsgSender) {
              lastMsgSender = lastMsg.notifyName || lastMsg.__x_notifyName || '';
            }
            // Sem nome resolvido? Nao mostra numero cru (pode ser ID interno do WA).
            // Preview vai mostrar so a mensagem sem prefixo de sender.
          }
        }
      } catch (e) {}
      // Pin e archive nativos do WA
      var pinTs = 0;
      try { pinTs = Number(c.pin || c.__x_pin || 0) || 0; } catch(e) {}
      var isArchived = !!(c.archive || c.__x_archive);
      var isMuted = !!(c.mute && (c.mute.expiration === -1 || c.mute.expiration > Date.now() / 1000)) ||
                    !!(c.__x_mute && (c.__x_mute.expiration === -1 || c.__x_mute.expiration > Date.now() / 1000));

      out.push({
        jid: jid,
        name: String(name || '').trim(),
        isGroup: isGroup,
        pushname: (c.contact && (c.contact.pushname || c.contact.__x_pushname)) || '',
        shortName: (c.contact && (c.contact.shortName || c.contact.__x_shortName)) || '',
        profilePicUrl: getFiberProfilePic(c),
        lastTs: lastTs,
        unread: unread,
        lastMsgText: lastMsgText,
        lastMsgFromMe: lastMsgFromMe,
        lastMsgSender: lastMsgSender,
        pinTs: pinTs,
        isArchived: isArchived,
        isMuted: isMuted
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

    // ===== PRIORIDADE: onItemClick com varios arg shapes =====
    // Em WA atual, onItemClick e o handler da lista. Signature provavel:
    // (chat, event) ou (event, chat) ou ({item, event}). Testa tudo.
    if (typeof store.onItemClick === 'function') {
      var fakeEvent = {
        type: 'click', button: 0, bubbles: true,
        preventDefault: function() {}, stopPropagation: function() {},
        stopImmediatePropagation: function() {},
        currentTarget: null, target: null, nativeEvent: null
      };
      var shapes = [
        ['chat,event', function(){ return store.onItemClick(target, fakeEvent); }],
        ['event,chat', function(){ return store.onItemClick(fakeEvent, target); }],
        ['{item,event}', function(){ return store.onItemClick({ item: target, event: fakeEvent, chat: target }); }],
        ['chat-only', function(){ return store.onItemClick(target); }],
        ['event-only-with-currentTarget', function(){
          var ev = Object.assign({}, fakeEvent, { currentTarget: { dataset: { id: jid } } });
          return store.onItemClick(ev);
        }]
      ];
      console.log('[EZAP-OPEN] onItemClick.toString():', String(store.onItemClick).slice(0, 200));
      for (var si = 0; si < shapes.length; si++) {
        try {
          shapes[si][1]();
          return { ok: true, via: 'store.onItemClick[' + shapes[si][0] + ']' };
        } catch (e) {
          tried.push('onItemClick[' + shapes[si][0] + ']: ' + (e && e.message));
        }
      }
    }

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
    // onItemClick ja foi tentado com prioridade acima.
    var storeMethods = [
      'openChat', 'onChatClick', 'onChatPressed', 'handleChatClick', 'selectChat',
      'onChatOpen', 'onOpenChat', 'chatSelect', 'onSelectChat', 'setActiveChat',
      'onClick', 'onPress', 'onChatSelect', 'onItemPress'
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
    // Skip: metodos que nao sao pra abrir chat (multiSelect = entrar em modo
    // selecao, focus search = focar a busca, etc).
    var skipKeys = /multiselect|focussearch|focusfilters|focus|startselect|selectmode/i;
    try {
      for (var k = 0; k < storeFns.length; k++) {
        var key = storeFns[k];
        if (skipKeys.test(key)) continue;
        if (/chat|open|activate|press|click|navigate|goto/i.test(key)) {
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

  // ===== WEBPACK ACTION MODULE SCANNER =====
  // Escaneia todos os modulos webpack uma unica vez pra achar funcoes de acao
  // (mute, pin, archive, markUnread, etc.) que o WA expoe internamente.
  var _wpActionFns = {};
  var _wpActionScanned = false;

  function _scanWebpackActions() {
    if (_wpActionScanned) return;
    _wpActionScanned = true;
    var req = window._ezapWebpackRequire;
    if (!req) { console.log('[EZAP-ACTION] No webpack require for action scan'); return; }
    var modSource = req.m || req.c || {};
    var keys = Object.keys(modSource);
    console.log('[EZAP-ACTION] Scanning', keys.length, 'webpack modules for action functions...');

    var patterns = {
      mute:        /^(sendMute|muteChat|setMuteChat|toggleMute|sendMuteChat|muteAction)$/i,
      unmute:      /^(sendUnmute|unmuteChat|setUnmuteChat|sendUnmuteChat|unmuteAction)$/i,
      pin:         /^(sendPin|pinChat|setPinState|togglePinChat|sendPinChat|pinAction|setPinChat)$/i,
      unpin:       /^(sendUnpin|unpinChat|unsetPinState|sendUnpinChat|unpinAction)$/i,
      markUnread:  /^(sendMarkUnread|markUnread|markAsUnread|markChatUnread|sendUnread|setUnread)$/i,
      markRead:    /^(sendMarkRead|markRead|markAsRead|markChatRead|sendSeen|sendRead)$/i,
      archive:     /^(sendArchive|archiveChat|setArchive|sendArchiveChat|archiveAction)$/i,
      unarchive:   /^(sendUnarchive|unarchiveChat|unsetArchive|sendUnarchiveChat)$/i,
      clear:       /^(sendClear|clearChat|clearMessages|sendClearChat|clearAction)$/i
    };

    var totalPatterns = Object.keys(patterns).length;
    var foundCount = 0;

    for (var i = 0; i < keys.length; i++) {
      if (foundCount >= totalPatterns) break;
      var mod;
      try { mod = req(keys[i]); } catch(e) { continue; }
      if (!mod || typeof mod !== 'object') continue;
      var targets = [mod];
      if (mod.default && typeof mod.default === 'object') targets.push(mod.default);
      for (var t = 0; t < targets.length; t++) {
        var target = targets[t];
        if (!target || typeof target !== 'object' || Array.isArray(target)) continue;
        var modKeys;
        try { modKeys = Object.keys(target); } catch(e) { continue; }
        if (modKeys.length > 200) continue;
        for (var k = 0; k < modKeys.length; k++) {
          var fname = modKeys[k];
          if (typeof target[fname] !== 'function') continue;
          for (var pname in patterns) {
            if (!_wpActionFns[pname] && patterns[pname].test(fname)) {
              _wpActionFns[pname] = { module: target, fnName: fname };
              foundCount++;
              console.log('[EZAP-ACTION] Found webpack fn:', pname, '->', fname);
            }
          }
        }
      }
    }
    console.log('[EZAP-ACTION] Webpack scan done. Found', foundCount, '/', totalPatterns, ':',
      Object.keys(_wpActionFns).join(', ') || '(none)');
  }

  // Busca modelo de chat na colecao webpack Chat (pode ter metodos que o fiber nao tem)
  function _getWebpackChatModel(jid) {
    var chatStore = window._ezapStore && window._ezapStore.Chat;
    if (!chatStore) return null;
    // Tenta .get() com WID object
    if (typeof chatStore.get === 'function') {
      try {
        var wid = window._ezapStore.Wid && window._ezapStore.Wid.createWid
          ? window._ezapStore.Wid.createWid(jid) : jid;
        var model = chatStore.get(wid);
        if (model) return model;
      } catch(e) {}
      try { var m2 = chatStore.get(jid); if (m2) return m2; } catch(e) {}
    }
    // Fallback: scan array
    try {
      var models = chatStore.getModelsArray();
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        if (!m || !m.id) continue;
        try {
          var mid = m.id._serialized || (m.id.toString && m.id.toString()) || '';
          if (mid === jid) return m;
        } catch(e) {}
      }
    } catch(e) {}
    return null;
  }

  // ===== CHAT ACTIONS =====
  // Executa acoes no chat via multiplas estrategias:
  // 1. Webpack action modules (funcoes internas do WA encontradas via scan)
  // 2. Metodos no modelo webpack Chat (colecao Chat.get(jid))
  // 3. Metodos no modelo fiber (React memoizedProps)
  // 4. Store handler functions (memoizedProps com pattern matching)
  // 5. Property fallbacks (setar propriedade direta no modelo)
  function executeChatAction(jid, action) {
    var match = findChatModelByJid(jid);
    if (!match) return { ok: false, reason: 'chat-not-found' };
    var fiberChat = match.chat;
    var store = match.store;
    var tried = [];

    // Busca modelo webpack (pode ter metodos diferentes do fiber)
    var wpChat = _getWebpackChatModel(jid);
    // Garante scan de action modules
    _scanWebpackActions();

    if (action !== 'getInfo') {
      console.log('[EZAP-ACTION]', action, jid.slice(0, 15) + '...',
        'wpChat:', !!wpChat, 'fiberChat:', !!fiberChat,
        'wpActions:', Object.keys(_wpActionFns).join(',') || 'none');
    }

    // Helper: tenta chamar metodos em um objeto
    function tryMethod(obj, names, args, prefix) {
      prefix = prefix || '';
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if (typeof obj[name] === 'function') {
          try {
            var result = obj[name].apply(obj, args || []);
            tried.push(prefix + name + ': ok');
            return { ok: true, via: prefix + name, result: result };
          } catch(e) {
            tried.push(prefix + name + ': ' + (e && e.message));
          }
        }
      }
      return null;
    }

    // Helper: tenta funcao webpack action com varias assinaturas de args
    function tryWpAction(actionKey, argShapes) {
      var entry = _wpActionFns[actionKey];
      if (!entry) return null;
      var fn = entry.module[entry.fnName];
      if (typeof fn !== 'function') return null;
      for (var a = 0; a < argShapes.length; a++) {
        try {
          var result = fn.apply(entry.module, argShapes[a]);
          tried.push('wp.' + entry.fnName + '[' + a + ']: ok');
          return { ok: true, via: 'webpack.' + entry.fnName, result: result };
        } catch(e) {
          tried.push('wp.' + entry.fnName + '[' + a + ']: ' + (e && e.message));
        }
      }
      return null;
    }

    // Helper: tenta funcoes no store (memoizedProps) que matchem um pattern
    function tryStorePattern(pattern, argShapes) {
      var storeFns;
      try { storeFns = Object.keys(store).filter(function(k){return typeof store[k]==='function';}); } catch(e) { return null; }
      for (var i = 0; i < storeFns.length; i++) {
        var fn = storeFns[i];
        if (!pattern.test(fn)) continue;
        for (var a = 0; a < argShapes.length; a++) {
          try {
            var result = store[fn].apply(store, argShapes[a]);
            tried.push('store.' + fn + '[' + a + ']: ok');
            return { ok: true, via: 'store.' + fn, result: result };
          } catch(e) {
            tried.push('store.' + fn + '[' + a + ']: ' + (e && e.message));
          }
        }
      }
      return null;
    }

    // Pra diagnostico: lista funcoes do chat
    var chatFns = [];
    try { chatFns = Object.keys(fiberChat).filter(function(k){return typeof fiberChat[k]==='function';}); } catch(e) {}
    var wpChatFns = [];
    if (wpChat) { try { wpChatFns = Object.keys(wpChat).filter(function(k){return typeof wpChat[k]==='function';}); } catch(e) {} }

    // Escolhe o chat principal pra operacoes (prefere webpack)
    var chat = wpChat || fiberChat;

    var r;
    switch (action) {
      case 'archive':
        r = tryWpAction('archive', [[chat, true], [chat], [jid, true]]);
        if (!r) r = tryMethod(chat, ['archive', 'setArchive', '__x_setArchive', 'sendArchive', 'toggleArchive'], [true], 'chat.');
        if (!r && wpChat && wpChat !== fiberChat) r = tryMethod(fiberChat, ['archive', 'setArchive', 'sendArchive'], [true], 'fiber.');
        if (!r) r = tryStorePattern(/archive/i, [[chat, true], [chat], [jid]]);
        if (!r) {
          try {
            chat.archive = true; chat.__x_archive = true;
            if (fiberChat !== chat) { fiberChat.archive = true; fiberChat.__x_archive = true; }
            r = { ok: true, via: 'prop' }; tried.push('prop: ok');
          } catch(e) { tried.push('prop: ' + e.message); }
        }
        break;

      case 'unarchive':
        r = tryWpAction('unarchive', [[chat, false], [chat], [jid, false]]);
        if (!r) r = tryMethod(chat, ['unarchive', 'setArchive', '__x_setArchive'], [false], 'chat.');
        if (!r && wpChat && wpChat !== fiberChat) r = tryMethod(fiberChat, ['unarchive', 'setArchive'], [false], 'fiber.');
        if (!r) r = tryStorePattern(/archive/i, [[chat, false], [chat]]);
        if (!r) {
          try {
            chat.archive = false; chat.__x_archive = false;
            if (fiberChat !== chat) { fiberChat.archive = false; fiberChat.__x_archive = false; }
            r = { ok: true, via: 'prop' };
          } catch(e) {}
        }
        break;

      case 'mute':
        var muteExp = -1;
        r = tryWpAction('mute', [
          [chat, muteExp], [chat, { expiration: muteExp }], [chat],
          [jid, muteExp], [jid, { expiration: muteExp }]
        ]);
        if (!r && wpChat) {
          r = tryMethod(wpChat, ['mute', 'setMute', 'sendMute', 'toggleMute', '__x_setMute', '__x_sendMute'], [{ expiration: muteExp }], 'wp.') ||
              tryMethod(wpChat, ['mute', 'sendMute', 'toggleMute'], [muteExp], 'wp.');
        }
        if (!r) {
          r = tryMethod(fiberChat, ['mute', 'setMute', 'sendMute', 'toggleMute', '__x_setMute', '__x_sendMute'], [{ expiration: muteExp }], 'fiber.') ||
              tryMethod(fiberChat, ['mute', 'sendMute', 'toggleMute'], [muteExp], 'fiber.');
        }
        if (!r) r = tryStorePattern(/mute|silent/i, [[chat, muteExp], [chat, { expiration: muteExp }], [chat], [jid]]);
        // Sem property fallback - nao sincroniza com servidor WA
        // Retorna needs-ui pra slice.js abrir o chat como fallback
        if (!r) r = { ok: false, reason: 'needs-ui', action: 'mute' };
        break;

      case 'unmute':
        r = tryWpAction('unmute', [[chat, 0], [chat, { expiration: 0 }], [chat]]);
        if (!r && wpChat) {
          r = tryMethod(wpChat, ['unmute', 'setMute', 'sendUnmute', '__x_setMute'], [{ expiration: 0 }], 'wp.') ||
              tryMethod(wpChat, ['unmute', 'sendUnmute'], [], 'wp.');
        }
        if (!r) {
          r = tryMethod(fiberChat, ['unmute', 'setMute', 'sendUnmute', '__x_setMute'], [{ expiration: 0 }], 'fiber.') ||
              tryMethod(fiberChat, ['unmute', 'sendUnmute'], [], 'fiber.');
        }
        if (!r) r = tryStorePattern(/unmute|mute/i, [[chat, 0], [chat, { expiration: 0 }], [chat]]);
        if (!r) r = { ok: false, reason: 'needs-ui', action: 'unmute' };
        break;

      case 'markUnread':
        r = tryWpAction('markUnread', [[chat], [chat, true], [jid], [jid, true]]);
        if (!r && wpChat) {
          r = tryMethod(wpChat, ['markUnread', 'sendUnread', 'setUnread', '__x_setUnread', '__x_sendUnread', 'sendMarkUnread'], [], 'wp.') ||
              tryMethod(wpChat, ['markUnread', 'sendUnread', 'changeUnreadStatus', 'setUnreadCount'], [true], 'wp.');
        }
        if (!r) {
          r = tryMethod(fiberChat, ['markUnread', 'sendUnread', 'setUnread', '__x_setUnread', '__x_sendUnread', 'sendMarkUnread'], [], 'fiber.') ||
              tryMethod(fiberChat, ['changeUnreadStatus', 'setUnreadCount'], [true], 'fiber.');
        }
        if (!r) r = tryStorePattern(/unread|markUnread/i, [[chat], [chat, true], [jid]]);
        if (!r) r = { ok: false, reason: 'needs-ui', action: 'markUnread' };
        break;

      case 'markRead':
        r = tryWpAction('markRead', [[chat], [chat, false], [jid]]);
        if (!r && wpChat) {
          r = tryMethod(wpChat, ['markRead', 'sendRead', 'sendSeen', '__x_sendSeen'], [], 'wp.') ||
              tryMethod(wpChat, ['changeUnreadStatus', 'setUnreadCount'], [false], 'wp.');
        }
        if (!r) {
          r = tryMethod(fiberChat, ['markRead', 'sendRead', 'sendSeen', '__x_sendSeen'], [], 'fiber.') ||
              tryMethod(fiberChat, ['changeUnreadStatus', 'setUnreadCount'], [false], 'fiber.');
        }
        if (!r) r = tryStorePattern(/read|seen/i, [[chat], [jid]]);
        if (!r) r = { ok: false, reason: 'needs-ui', action: 'markRead' };
        break;

      case 'pin':
        var pinTs = Math.floor(Date.now() / 1000);
        r = tryWpAction('pin', [[chat, true], [chat, pinTs], [chat], [jid, true]]);
        if (!r && wpChat) {
          r = tryMethod(wpChat, ['pin', 'setPin', 'sendPin', 'togglePin', '__x_setPin'], [true], 'wp.') ||
              tryMethod(wpChat, ['pin', 'setPin', 'sendPin'], [pinTs], 'wp.');
        }
        if (!r) {
          r = tryMethod(fiberChat, ['pin', 'setPin', 'sendPin', 'togglePin', '__x_setPin'], [true], 'fiber.') ||
              tryMethod(fiberChat, ['pin', 'setPin', 'sendPin'], [pinTs], 'fiber.');
        }
        if (!r) r = tryStorePattern(/pin/i, [[chat, true], [chat, pinTs], [chat], [jid]]);
        if (!r) r = { ok: false, reason: 'needs-ui', action: 'pin' };
        break;

      case 'unpin':
        r = tryWpAction('unpin', [[chat, false], [chat, 0], [chat], [jid, false]]);
        if (!r && wpChat) {
          r = tryMethod(wpChat, ['unpin', 'setPin', '__x_setPin'], [false], 'wp.') ||
              tryMethod(wpChat, ['unpin', 'setPin'], [0], 'wp.');
        }
        if (!r) {
          r = tryMethod(fiberChat, ['unpin', 'setPin', '__x_setPin'], [false], 'fiber.') ||
              tryMethod(fiberChat, ['unpin', 'setPin'], [0], 'fiber.');
        }
        if (!r) r = tryStorePattern(/unpin|pin/i, [[chat, false], [chat, 0], [chat]]);
        if (!r) r = { ok: false, reason: 'needs-ui', action: 'unpin' };
        break;

      case 'delete':
        r = tryWpAction('clear', [[chat], [jid]]);
        if (!r && wpChat) r = tryMethod(wpChat, ['delete', 'sendDelete', 'clearMessages', 'clear'], [], 'wp.');
        if (!r) r = tryMethod(fiberChat, ['delete', 'sendDelete', 'clearMessages', 'clear'], [], 'fiber.');
        if (!r) r = tryStorePattern(/clear|delete/i, [[chat], [jid]]);
        if (!r) r = { ok: false, reason: 'needs-ui', action: 'delete' };
        break;

      case 'getInfo':
        var isGroup = jid.indexOf('@g.us') >= 0;
        var isMuted = !!(chat.mute && (chat.mute.expiration === -1 || chat.mute.expiration > Date.now() / 1000)) ||
                      !!(chat.__x_mute && (chat.__x_mute.expiration === -1 || chat.__x_mute.expiration > Date.now() / 1000)) ||
                      !!chat.isMuted || !!chat.__x_isMuted;
        var isArchived = !!chat.archive || !!chat.__x_archive;
        var isPinned = !!chat.pin || !!chat.__x_pin;
        return {
          ok: true,
          info: {
            isGroup: isGroup,
            isMuted: isMuted,
            isArchived: isArchived,
            isPinned: isPinned,
            unreadCount: chat.unreadCount || chat.__x_unreadCount || 0
          }
        };

      default:
        return { ok: false, reason: 'unknown-action' };
    }

    if (!r) {
      console.log('[EZAP-ACTION] FAILED', action, '- tried:', tried.join(' | '));
      console.log('[EZAP-ACTION] chatFns:', chatFns.slice(0, 40).join(','));
      if (wpChatFns.length) console.log('[EZAP-ACTION] wpChatFns:', wpChatFns.slice(0, 40).join(','));
    }
    return r || { ok: false, reason: 'no-method-worked', tried: tried, chatFns: chatFns.slice(0, 40), wpChatFns: wpChatFns.slice(0, 40), wpActionFns: Object.keys(_wpActionFns) };
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
    } else if (d.type === '_ezap_chat_action_req') {
      var actionResult;
      try { actionResult = executeChatAction(d.jid, d.action); }
      catch (e) { actionResult = { ok: false, reason: 'exception', error: e && e.message }; }
      console.log('[EZAP-ACTION]', d.action, d.jid, actionResult);
      window.postMessage({
        type: '_ezap_chat_action_res',
        id: d.id,
        result: actionResult
      }, '*');
    } else if (d.type === '_ezap_get_profile_pics_req') {
      // Batch fetch profile pics on demand
      var jids = d.jids || [];
      var ppStore = window._ezapStore && window._ezapStore.ProfilePicThumb;
      console.log('[EZAP-PIC] Batch request for', jids.length, 'JIDs. ProfilePicThumb store:', !!ppStore);
      if (!jids.length) {
        window.postMessage({ type: '_ezap_get_profile_pics_res', id: d.id, results: [] }, '*');
      } else {
        fetchProfilePicsBatch(jids).then(function(results) {
          var withUrl = results.filter(function(r) { return !!r.url; }).length;
          console.log('[EZAP-PIC] Batch done:', withUrl + '/' + results.length, 'with URL');
          window.postMessage({ type: '_ezap_get_profile_pics_res', id: d.id, results: results }, '*');
        }).catch(function(err) {
          console.log('[EZAP-PIC] Batch error:', err && err.message);
          window.postMessage({ type: '_ezap_get_profile_pics_res', id: d.id, results: [] }, '*');
        });
      }
    } else if (d.type === '_ezap_get_msgs_req') {
      // Return recent messages from all chats for capture
      console.log('[EZAP-CAPTURE-BRIDGE] Received msgs request, id:', d.id);
      // DEBUG: inspect msgs structure of first chat
      try {
        var debugChats = getAllChatsFromFiber();
        if (!debugChats) { try { if (window._ezapStore && window._ezapStore.Chat) debugChats = window._ezapStore.Chat.getModelsArray(); } catch(e){} }
        if (debugChats && debugChats.length) {
          for (var dci = 0; dci < Math.min(debugChats.length, 3); dci++) {
            var dc = debugChats[dci];
            var dMsgs = dc.msgs || dc.__x_msgs;
            var dcJid = dc.id ? (dc.id._serialized || '') : '';
            console.log('[EZAP-CAPTURE-BRIDGE] Chat[' + dci + '] jid=' + dcJid.substring(0,15) + '.. msgs type=' + typeof dMsgs,
              'isArray=' + Array.isArray(dMsgs),
              'keys=' + (dMsgs ? Object.keys(dMsgs).slice(0,12).join(',') : 'null'),
              'has _models=' + !!(dMsgs && dMsgs._models),
              'has last=' + !!(dMsgs && typeof dMsgs.last === 'function'),
              'has getModelsArray=' + !!(dMsgs && typeof dMsgs.getModelsArray === 'function'),
              'has length=' + !!(dMsgs && dMsgs.length !== undefined),
              'length=' + (dMsgs ? (dMsgs.length || (dMsgs._models ? dMsgs._models.length : '?')) : 0)
            );
            // Try all access patterns
            if (dMsgs) {
              var testArr = null;
              if (typeof dMsgs.last === 'function') { try { var lm = dMsgs.last(); console.log('[EZAP-CAPTURE-BRIDGE] .last() =', lm ? (lm.type || lm.__x_type || 'obj') : 'null'); } catch(e) { console.log('[EZAP-CAPTURE-BRIDGE] .last() err:', e.message); } }
              if (typeof dMsgs.getModelsArray === 'function') { try { testArr = dMsgs.getModelsArray(); console.log('[EZAP-CAPTURE-BRIDGE] .getModelsArray() len=', testArr ? testArr.length : 0); } catch(e) { console.log('[EZAP-CAPTURE-BRIDGE] .getModelsArray() err:', e.message); } }
              if (dMsgs._models) { console.log('[EZAP-CAPTURE-BRIDGE] ._models len=', dMsgs._models.length); }
              // Check for forEach / toArray / values
              if (typeof dMsgs.forEach === 'function') console.log('[EZAP-CAPTURE-BRIDGE] has .forEach');
              if (typeof dMsgs.toArray === 'function') { try { testArr = dMsgs.toArray(); console.log('[EZAP-CAPTURE-BRIDGE] .toArray() len=', testArr.length); } catch(e){} }
              if (typeof dMsgs.getAll === 'function') { try { testArr = dMsgs.getAll(); console.log('[EZAP-CAPTURE-BRIDGE] .getAll() len=', testArr.length); } catch(e){} }
              if (typeof dMsgs.values === 'function') { try { testArr = Array.from(dMsgs.values()); console.log('[EZAP-CAPTURE-BRIDGE] .values() len=', testArr.length); } catch(e){} }
              if (typeof dMsgs[Symbol.iterator] === 'function') console.log('[EZAP-CAPTURE-BRIDGE] is iterable');
            }
          }
        }
      } catch(e) { console.log('[EZAP-CAPTURE-BRIDGE] debug err:', e.message); }
      var sinceTs = d.sinceTs || {};  // { chatJid: lastTimestamp } map
      var maxPerChat = d.maxPerChat || 30;
      var initialMax = d.initialMax || 50;
      var msgChats = getAllChatsFromFiber();
      if (!msgChats || !msgChats.length) {
        try {
          if (window._ezapStore && window._ezapStore.Chat) {
            msgChats = window._ezapStore.Chat.getModelsArray();
          }
        } catch(e) {}
      }
      var allMsgEvents = [];
      if (msgChats && msgChats.length) {
        for (var mci = 0; mci < msgChats.length; mci++) {
          var mc = msgChats[mci];
          if (!mc || !mc.id) continue;
          var mcJid = '';
          try {
            mcJid = mc.id._serialized || (typeof mc.id === 'string' ? mc.id : (mc.id.toString ? mc.id.toString() : ''));
          } catch(e) { continue; }
          if (!mcJid || mcJid === 'status@broadcast' || mcJid.indexOf('@lid') >= 0) continue;
          var mcMsgs = mc.msgs || mc.__x_msgs;
          var mcArr = [];
          if (mcMsgs) {
            if (mcMsgs._models && Array.isArray(mcMsgs._models)) mcArr = mcMsgs._models;
            else if (Array.isArray(mcMsgs)) mcArr = mcMsgs;
            else if (typeof mcMsgs.getModelsArray === 'function') { try { mcArr = mcMsgs.getModelsArray() || []; } catch(e){} }
          }
          if (!mcArr.length) continue;
          var mcIsGroup = mcJid.indexOf('@g.us') >= 0;
          var mcName = getFiberChatName(mc) || getChatName(mc);
          var mcLastTs = sinceTs[mcJid] || 0;
          var mcMax = mcLastTs ? maxPerChat : initialMax;
          var mcStart = Math.max(0, mcArr.length - mcMax);
          for (var mmi = mcStart; mmi < mcArr.length; mmi++) {
            var mm = mcArr[mmi];
            if (!mm) continue;
            var mmWid = '';
            try {
              mmWid = mm.id ? (mm.id._serialized || (mm.id.toString ? mm.id.toString() : '')) : '';
            } catch(e) { continue; }
            if (!mmWid) continue;
            var mmTs = Number(mm.t || mm.__x_t || (mm.id && mm.id.t) || 0);
            if (!mmTs) continue;
            if (mcLastTs && mmTs <= mcLastTs) continue;
            var mmType = String(mm.type || mm.__x_type || 'other').toLowerCase();
            if (mmType === 'e2e_notification' || mmType === 'notification_template' ||
                mmType === 'gp2' || mmType === 'protocol' || mmType === 'ciphertext' ||
                mmType === 'notification' || mmType === 'call_log') continue;
            var mmBody = mm.caption || mm.__x_caption || '';
            if (!mmBody) {
              var rawB = mm.body || mm.__x_body || '';
              if (rawB && rawB.length < 5000 && !/^\/9j\/|^data:|^[A-Za-z0-9+\/]{100,}/.test(rawB)) mmBody = rawB;
            }
            var mmSent = !!(mm.id && mm.id.fromMe) || !!(mm.__x_isSentByMe);
            var mmSender = '';
            try {
              var sObj = mm.senderObj || mm.__x_senderObj;
              if (sObj) mmSender = sObj.pushname || sObj.name || sObj.shortName || sObj.formattedName || '';
              if (!mmSender) mmSender = mm.notifyName || mm.__x_notifyName || '';
            } catch(e) {}
            var mmParticipant = '';
            if (mcIsGroup) {
              var mmAuth = mm.author || mm.__x_author;
              if (mmAuth) {
                mmParticipant = typeof mmAuth === 'string' ? mmAuth.split('@')[0] :
                  (mmAuth._serialized ? mmAuth._serialized.split('@')[0] : '');
              } else if (mm.id && mm.id.participant) {
                var mmP = mm.id.participant;
                mmParticipant = typeof mmP === 'string' ? mmP.split('@')[0] :
                  (mmP._serialized ? mmP._serialized.split('@')[0] : '');
              }
            }
            var mmDuration = Number(mm.duration || mm.__x_duration || 0);
            var mmMime = mm.mimetype || mm.__x_mimetype || null;
            // Normalize type
            var typeMap = {chat:'text',text:'text',ptt:'audio',audio:'audio',image:'image',video:'video',document:'document',sticker:'sticker',vcard:'contact',multi_vcard:'contact',location:'location',liveLocation:'location'};
            var normType = typeMap[mmType] || 'other';
            allMsgEvents.push({
              wid: mmWid,
              chatJid: mcJid,
              chatName: mcName,
              isGroup: mcIsGroup,
              direction: mmSent ? 'sent' : 'received',
              messageType: normType,
              body: mmBody ? String(mmBody).substring(0, 4000) : '',
              caption: (mm.caption || mm.__x_caption) ? String(mm.caption || mm.__x_caption).substring(0, 1000) : '',
              senderName: mmSender,
              groupParticipant: mmParticipant,
              duration: mmDuration > 0 ? Math.round(mmDuration) : 0,
              mediaMime: mmMime,
              timestamp: mmTs,
              clientPhone: mcJid.split('@')[0].replace(/[^0-9]/g, ''),
              charCount: mmBody ? mmBody.length : 0
            });
          }
        }
      }
      console.log('[EZAP-CAPTURE-BRIDGE] Responding with', allMsgEvents.length, 'events from', (msgChats ? msgChats.length : 0), 'chats');
      window.postMessage({
        type: '_ezap_get_msgs_res',
        id: d.id,
        ok: allMsgEvents.length > 0,
        events: allMsgEvents,
        chatCount: msgChats ? msgChats.length : 0
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
