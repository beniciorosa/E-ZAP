// ============================================================
// FLOW ENGINE - Executa fluxos de automacao no WhatsApp Web
// ============================================================
// MVP: executa fluxo manual no chat atualmente aberto.
// Fase futura: scheduler iterando multiplos chats.

(function() {
  "use strict";

  // ===== State =====
  var activeFlows = [];
  var lastFlowsSync = 0;
  var FLOWS_SYNC_INTERVAL_MS = 60000; // 1 min

  // ===== Listener for "Testar agora" trigger from admin =====
  // Messages come via chrome.runtime (from background.js, triggered by admin sending
  // a test command or by local keyboard shortcut / menu)
  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function(req, sender, sendResponse) {
      if (!req || req.action !== "flow_execute_manual") return false;
      executeFlowManually(req.flowId).then(function(result) {
        sendResponse({ ok: true, result: result });
      }).catch(function(err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      });
      return true; // async
    });
  }

  // ===== Sync active flows from Supabase =====
  function syncFlows() {
    var uid = (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
    if (!uid) return Promise.resolve([]);
    return sendBg({
      action: "supabase_rest",
      path: "/rest/v1/flows?user_id=eq." + uid + "&status=eq.active&select=*",
      method: "GET"
    }).then(function(rows) {
      if (Array.isArray(rows)) {
        activeFlows = rows;
        lastFlowsSync = Date.now();
      }
      return activeFlows;
    }).catch(function() { return activeFlows; });
  }

  // ===== Polling para botao "Testar agora" do admin =====
  var POLL_INTERVAL_MS = 8000;
  var pollRunning = false;
  var pollTimer = null;

  function pollTestRequests() {
    if (pollRunning) return;
    var uid = (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
    if (!uid) return;
    pollRunning = true;
    // Buscar flows com test_requested_at preenchido e ainda nao processado
    sendBg({
      action: "supabase_rest",
      path: "/rest/v1/flows?user_id=eq." + uid + "&test_requested_at=not.is.null&select=id,name,test_requested_at,test_processed_at",
      method: "GET"
    }).then(function(rows) {
      if (!Array.isArray(rows) || rows.length === 0) { pollRunning = false; return; }
      // filtrar os que ainda nao foram processados (processed_at null OU processed_at < requested_at)
      var pending = rows.filter(function(r) {
        if (!r.test_processed_at) return true;
        return new Date(r.test_processed_at).getTime() < new Date(r.test_requested_at).getTime();
      });
      if (pending.length === 0) { pollRunning = false; return; }
      // executar sequencialmente
      var idx = 0;
      function next() {
        if (idx >= pending.length) { pollRunning = false; return; }
        var flow = pending[idx++];
        console.log("[FlowEngine] Teste disparado do admin:", flow.name);
        executeFlowManually(flow.id).catch(function(err) {
          console.warn("[FlowEngine] Erro no teste:", err);
        }).then(function() {
          // marcar como processado
          return sendBg({
            action: "supabase_rest",
            path: "/rest/v1/flows?id=eq." + flow.id,
            method: "PATCH",
            body: { test_processed_at: new Date().toISOString() }
          });
        }).then(next, next);
      }
      next();
    }).catch(function() { pollRunning = false; });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollTestRequests, POLL_INTERVAL_MS);
    // Primeira verificacao rapida depois de 3s
    setTimeout(pollTestRequests, 3000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Inicia polling assim que auth estiver disponivel
  function waitForAuthAndStart() {
    var attempts = 0;
    var iv = setInterval(function() {
      attempts++;
      if (window.__wcrmAuth && window.__wcrmAuth.userId) {
        clearInterval(iv);
        startPolling();
      } else if (attempts > 60) {
        clearInterval(iv);
      }
    }, 2000);
  }
  waitForAuthAndStart();

  // Expose for external triggering
  window.__ezapFlowEngine = {
    syncFlows: syncFlows,
    executeFlowManually: executeFlowManually,
    getActiveFlows: function() { return activeFlows; },
    startPolling: startPolling,
    stopPolling: stopPolling,
    pollNow: pollTestRequests
  };

  // ===== Execute flow manually on currently open chat =====
  function executeFlowManually(flowId) {
    var startedAt = new Date().toISOString();
    var logSteps = [];
    var flow = null;

    // Step 1: load flow
    return loadFlowById(flowId).then(function(f) {
      if (!f) throw new Error("Fluxo nao encontrado");
      flow = f;
      logSteps.push({ t: Date.now(), type: "start", msg: "Iniciando fluxo: " + f.name });

      // Step 1.5: abrir chat do escopo (se aplicavel)
      return ensureTargetChatOpen(flow, logSteps);
    }).then(function() {
      // Step 2: get current chat context
      return getCurrentChatContext();
    }).then(function(chat) {
      if (!chat || !chat.name) throw new Error("Nenhum chat aberto no WhatsApp");
      logSteps.push({ t: Date.now(), type: "context", msg: "Chat: " + chat.name });

      // Step 3: resolve variables
      return resolveVariables(chat).then(function(vars) {
        logSteps.push({ t: Date.now(), type: "vars", msg: "Variaveis carregadas", vars: summarizeVars(vars) });
        return { chat: chat, vars: vars };
      });
    }).then(function(ctx) {
      // Step 4: walk the graph
      return walkFlow(flow, ctx, logSteps);
    }).then(function(walkResult) {
      // Step 5: log run
      return logFlowRun(flow, "success", logSteps, startedAt, null).then(function() {
        return walkResult;
      });
    }).catch(function(err) {
      logSteps.push({ t: Date.now(), type: "error", msg: String(err && err.message || err) });
      return logFlowRun(flow, "failure", logSteps, startedAt, String(err && err.message || err)).then(function() {
        throw err;
      });
    });
  }

  function loadFlowById(flowId) {
    return sendBg({
      action: "supabase_rest",
      path: "/rest/v1/flows?id=eq." + flowId + "&select=*",
      method: "GET"
    }).then(function(rows) {
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    });
  }

  // ===== Abre o chat alvo baseado no scope_config do fluxo =====
  function ensureTargetChatOpen(flow, logSteps) {
    var scope = flow && flow.scope_config;
    if (!scope || !scope.type || scope.type === "all") {
      // Sem escopo especifico -> usa o chat atualmente aberto
      return Promise.resolve();
    }
    var targetName = (scope.value || "").trim();
    if (!targetName) return Promise.resolve();

    // Se o chat ja esta aberto e bate com o escopo, nao abre de novo
    var currentOpen = extractChatNameFromDOM();
    var matches = false;
    if (currentOpen) {
      var cn = currentOpen.toLowerCase();
      var tn = targetName.toLowerCase();
      // "chat_name" e label "Nome contem" no admin -> substring match
      if (scope.type === "chat_name" && cn.indexOf(tn) >= 0) matches = true;
    }
    if (matches) {
      logSteps.push({ t: Date.now(), type: "scope", msg: "Chat alvo ja aberto: " + currentOpen });
      return Promise.resolve();
    }

    logSteps.push({ t: Date.now(), type: "scope", msg: "Abrindo chat: " + targetName });
    return openChatByName(targetName).then(function(opened) {
      logSteps.push({ t: Date.now(), type: "scope", msg: "Chat aberto: " + opened });
    });
  }

  // ===== Abre um chat usando a busca lateral do WhatsApp Web =====
  function openChatByName(name) {
    return new Promise(function(resolve, reject) {
      // 1. Encontra o campo de pesquisa da sidebar
      var searchBox = document.querySelector('#side div[contenteditable="true"][role="textbox"]')
                   || document.querySelector('div[contenteditable="true"][role="textbox"]');
      if (!searchBox) {
        reject(new Error("Campo de pesquisa do WhatsApp nao encontrado"));
        return;
      }

      // 2. Foca e limpa
      searchBox.focus();
      try { document.execCommand('selectAll', false, null); } catch(e) {}
      try { document.execCommand('delete', false, null); } catch(e) {}

      // 3. Cola o nome via clipboard event
      var clipData = new DataTransfer();
      clipData.setData('text/plain', name);
      var pasteEvent = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: clipData
      });
      searchBox.dispatchEvent(pasteEvent);

      // 4. Aguarda o resultado aparecer e clica no primeiro item
      var attempts = 0;
      var check = setInterval(function() {
        attempts++;
        var firstItem = document.querySelector('#pane-side div[role="listitem"]')
                     || document.querySelector('[aria-label="Lista de conversas"] div[role="listitem"]')
                     || document.querySelector('[data-testid="cell-frame-container"]');
        // Tambem checa se o nome no listitem bate com o alvo
        if (firstItem) {
          var titleEl = firstItem.querySelector('span[dir="auto"][title]') || firstItem.querySelector('span[dir="auto"]');
          var itemName = titleEl ? (titleEl.getAttribute("title") || titleEl.textContent || "") : "";
          // clica no primeiro resultado
          var clickTarget = firstItem.querySelector('div[role="row"]') || firstItem;
          clickTarget.click();
          // Aguarda o header do chat carregar
          setTimeout(function() {
            clearInterval(check);
            // Limpa a pesquisa para nao ficar com filtro
            try {
              var back = document.querySelector('button[aria-label="Cancelar busca"]')
                      || document.querySelector('button[aria-label="Voltar"]');
              if (back) back.click();
            } catch(e) {}
            resolve(itemName || name);
          }, 700);
          return;
        }
        if (attempts > 15) {
          clearInterval(check);
          reject(new Error("Contato nao encontrado na busca: " + name));
        }
      }, 300);
    });
  }

  // ===== Get current chat context from DOM =====
  function getCurrentChatContext() {
    // Reuse content.js script-scope globals (shared across content scripts in same world)
    var name = "";
    var phone = "";
    try { name = (typeof currentName !== "undefined" && currentName) ? currentName : ""; } catch(e) {}
    try { phone = (typeof currentPhone !== "undefined" && currentPhone) ? currentPhone : ""; } catch(e) {}
    if (!name) name = extractChatNameFromDOM();
    if (!phone) phone = extractPhoneFromDOM(name);
    var isGroup = detectGroup();
    return Promise.resolve({
      name: name || "",
      phone: phone || "",
      is_group: !!isGroup
    });
  }

  function extractChatNameFromDOM() {
    // WhatsApp Web chat header selector
    var header = document.querySelector('#main header');
    if (!header) return "";
    var titleSpan = header.querySelector('span[dir="auto"][title]');
    if (titleSpan) return titleSpan.getAttribute("title") || titleSpan.textContent || "";
    var anySpan = header.querySelector('span[dir="auto"]');
    return anySpan ? (anySpan.textContent || "") : "";
  }

  function extractPhoneFromDOM(name) {
    // Phone usually in subtitle or metadata
    if (name && /^\+?\d[\d\s\-\(\)]+$/.test(name)) return name.replace(/\D/g, "");
    return "";
  }

  function detectGroup() {
    var header = document.querySelector('#main header');
    if (!header) return false;
    // Groups have participants list subtitle with comma-separated names
    var subtitle = header.querySelector('span[title]');
    if (!subtitle) return false;
    var txt = subtitle.textContent || "";
    return txt.indexOf(",") !== -1 && txt.length > 20; // heuristic
  }

  // ===== Resolve variables =====
  function resolveVariables(chat) {
    var vars = {
      contact: {
        name: chat.name,
        phone: chat.phone,
        is_group: chat.is_group,
        is_pinned: false,
        has_label: false,
        in_tab: false,
        days_since_last_message: 0,
        total_messages: 0
      },
      meeting: { exists: false },
      deal: { exists: false },
      ticket: { exists: false },
      now: buildNowVars()
    };

    // Populate labels from storage
    var labelPromise = new Promise(function(resolve) {
      if (!chrome || !chrome.storage) return resolve();
      chrome.storage.local.get("wcrm_labels", function(data) {
        var labelsData = (data && data.wcrm_labels) || {};
        var key = normalizePhone(chat.phone);
        if (key && labelsData[key] && labelsData[key].labels && labelsData[key].labels.length > 0) {
          vars.contact.has_label = true;
          vars.contact._labels = labelsData[key].labels.map(function(l) { return l.name; });
        }
        resolve();
      });
    });

    // Populate abas from storage
    var abasPromise = new Promise(function(resolve) {
      if (!chrome || !chrome.storage) return resolve();
      chrome.storage.local.get("wcrm_abas", function(data) {
        var abasData = (data && data.wcrm_abas) || {};
        var key = normalizePhone(chat.phone);
        if (key) {
          Object.keys(abasData).forEach(function(abaName) {
            var aba = abasData[abaName];
            if (aba && aba.contacts && aba.contacts.indexOf(key) >= 0) {
              vars.contact.in_tab = true;
              vars.contact._tabs = vars.contact._tabs || [];
              vars.contact._tabs.push(abaName);
            }
          });
        }
        resolve();
      });
    });

    // HubSpot: meeting/deal/ticket data
    var hubspotPromise = loadHubspotContext(chat).then(function(hs) {
      if (hs.meeting) vars.meeting = hs.meeting;
      if (hs.deal) vars.deal = hs.deal;
      if (hs.ticket) vars.ticket = hs.ticket;
    }).catch(function() { /* hubspot may be unavailable */ });

    return Promise.all([labelPromise, abasPromise, hubspotPromise]).then(function() {
      return vars;
    });
  }

  function buildNowVars() {
    var d = new Date();
    var h = d.getHours();
    return {
      hour: h,
      day_of_week: d.getDay(),
      day: d.getDate(),
      is_business_hours: h >= 9 && h < 18
    };
  }

  function normalizePhone(phone) {
    if (!phone) return "";
    var digits = String(phone).replace(/\D/g, "");
    if (digits.startsWith("55") && digits.length > 11) digits = digits.substring(2);
    return digits;
  }

  function loadHubspotContext(chat) {
    // Query contact + meetings + tickets + deals from HubSpot via background
    var searchPhone = chat.phone || "";
    if (!searchPhone && chat.name) {
      // Groups might not have phone; skip HubSpot
      return Promise.resolve({});
    }
    return sendBg({
      action: "hubspot_search_contact",
      phone: searchPhone,
      chatName: chat.name
    }).then(function(contactRes) {
      if (!contactRes || contactRes.error || !contactRes.results || contactRes.results.length === 0) return {};
      var contact = contactRes.results[0];
      var contactId = contact.id;
      // Get tickets (includes next meeting logic)
      return sendBg({ action: "hubspot_get_tickets", contactId: contactId }).then(function(ticketRes) {
        var result = {};
        var tickets = (ticketRes && ticketRes.results) || [];
        if (tickets.length > 0) {
          var t = tickets[0];
          var p = t.properties || {};
          result.ticket = {
            exists: true,
            subject: p.subject || "",
            stage: p._stageName || p.hs_pipeline_stage || "",
            pipeline: p._pipelineName || "",
            priority: p.hs_ticket_priority || "",
            days_since_created: daysBetween(p.createdate, new Date()),
            calls_restantes: parseInt(p.nm__calls_restantes || "0", 10) || 0,
            calls_total: parseInt(p.nm__total_de_calls_adquiridas__starter__pro__business_ || "0", 10) || 0,
            modelo_mentoria: p.modelo_de_mentoria || "",
            data_inicio_blocos: p.data_de_inicio_dos_blocos || "",
            data_termino_1o_bloco: p.data_de_termino_do_1o_bloco || "",
            data_termino_2o_bloco: p.data_de_termino_do_2o_bloco || ""
          };
          // Fetch meetings for this ticket
          return sendBg({
            action: "hubspot_get_meetings",
            ticketId: t.id,
            contactId: contactId
          }).then(function(meetRes) {
            var meetings = (meetRes && meetRes.results) || [];
            if (meetings.length > 0) {
              // Find next future and last past
              var now = new Date();
              var future = [];
              var past = [];
              meetings.forEach(function(m) {
                var st = new Date(m.properties && m.properties.hs_meeting_start_time);
                if (!isNaN(st.getTime())) {
                  if (st > now) future.push({ date: st, raw: m });
                  else past.push({ date: st, raw: m });
                }
              });
              future.sort(function(a, b) { return a.date - b.date; });
              past.sort(function(a, b) { return b.date - a.date; });
              var next = future[0];
              var last = past[0];
              result.meeting = {
                exists: future.length > 0,
                next_date: next ? next.date.toISOString() : "",
                days_until: next ? Math.ceil((next.date - now) / (1000 * 60 * 60 * 24)) : -1,
                days_since: last ? Math.floor((now - last.date) / (1000 * 60 * 60 * 24)) : -1,
                total_count: past.length,
                last_outcome: last && last.raw.properties ? (last.raw.properties.hs_meeting_outcome || "") : ""
              };
            } else {
              result.meeting = { exists: false, days_until: -1, days_since: -1, total_count: 0 };
            }
            return result;
          });
        }
        return result;
      });
    }).catch(function() { return {}; });
  }

  function daysBetween(isoStr, ref) {
    if (!isoStr) return 0;
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return 0;
    return Math.floor((ref - d) / (1000 * 60 * 60 * 24));
  }

  // ===== Walk flow graph =====
  function walkFlow(flow, ctx, logSteps) {
    var nodes = flow.nodes || [];
    var edges = flow.edges || [];
    var startNode = nodes.find(function(n) { return n.type === "start"; });
    if (!startNode) throw new Error("Fluxo sem node Start");

    var visited = {};
    var maxSteps = 50; // safety
    var steps = 0;

    function next(nodeId, outputHandle) {
      var edge = edges.find(function(e) {
        return e.source === nodeId && (e.sourceHandle || 0) === (outputHandle || 0);
      });
      return edge ? edge.target : null;
    }

    function findNode(id) {
      return nodes.find(function(n) { return n.id === id; });
    }

    function run(nodeId) {
      if (!nodeId) return Promise.resolve({ done: true, reason: "Fim do fluxo" });
      if (++steps > maxSteps) throw new Error("Loop detectado ou fluxo muito longo (>50 steps)");
      if (visited[nodeId]) throw new Error("Ciclo detectado em " + nodeId);
      visited[nodeId] = true;

      var node = findNode(nodeId);
      if (!node) throw new Error("Node nao encontrado: " + nodeId);

      logSteps.push({ t: Date.now(), type: "node", nodeId: nodeId, nodeType: node.type });

      return executeNode(node, ctx).then(function(nodeResult) {
        var nextId = next(nodeId, nodeResult && nodeResult.output || 0);
        return run(nextId);
      });
    }

    return run(next(startNode.id, 0)).then(function(r) {
      logSteps.push({ t: Date.now(), type: "end", msg: "Fluxo concluido" });
      return r;
    });
  }

  // ===== Execute individual node =====
  function executeNode(node, ctx) {
    var data = node.data || {};
    switch (node.type) {
      case "start":
        return Promise.resolve({ output: 0 });
      case "end":
        return Promise.resolve({ done: true });
      case "ifelse":
        return Promise.resolve({ output: evalCondition(data, ctx.vars) ? 0 : 1 });
      case "wait":
        var ms = computeWaitMs(data);
        return new Promise(function(resolve) { setTimeout(function() { resolve({ output: 0 }); }, Math.min(ms, 60000)); });
      case "send_message":
        return executeSendMessage(data, ctx);
      case "add_label":
        return executeAddLabel(data, ctx);
      case "add_to_tab":
        return executeAddToTab(data, ctx);
      case "hubspot_next_meeting":
        // Already loaded in vars; node is informational in MVP
        return Promise.resolve({ output: 0 });
      default:
        return Promise.resolve({ output: 0 });
    }
  }

  function computeWaitMs(data) {
    var amt = parseInt(data.amount || 1, 10) || 1;
    var unit = data.unit || "hours";
    if (unit === "minutes") return amt * 60 * 1000;
    if (unit === "hours") return amt * 60 * 60 * 1000;
    if (unit === "days") return amt * 24 * 60 * 60 * 1000;
    return amt * 60 * 60 * 1000;
  }

  // ===== Evaluate If/Else condition =====
  function evalCondition(data, vars) {
    var fieldValue = getVarByPath(vars, data.field || "");
    var targetValue = data.value;
    var op = data.op || "eq";

    // Boolean normalization
    if (typeof fieldValue === "boolean" || targetValue === "true" || targetValue === "false") {
      var bField = !!fieldValue;
      var bTarget = targetValue === "true" || targetValue === true;
      if (op === "eq") return bField === bTarget;
      if (op === "neq") return bField !== bTarget;
      return false;
    }

    // Number comparison if target looks numeric
    if (!isNaN(parseFloat(targetValue)) && isFinite(targetValue)) {
      var nField = parseFloat(fieldValue);
      var nTarget = parseFloat(targetValue);
      if (isNaN(nField)) return false;
      if (op === "eq") return nField === nTarget;
      if (op === "neq") return nField !== nTarget;
      if (op === "gt") return nField > nTarget;
      if (op === "gte") return nField >= nTarget;
      if (op === "lt") return nField < nTarget;
      if (op === "lte") return nField <= nTarget;
    }

    // String comparison
    var sField = String(fieldValue || "").toLowerCase().trim();
    var sTarget = String(targetValue || "").toLowerCase().trim();
    if (op === "eq") return sField === sTarget;
    if (op === "neq") return sField !== sTarget;
    if (op === "contains") return sField.indexOf(sTarget) >= 0;
    return false;
  }

  function getVarByPath(vars, path) {
    if (!path) return undefined;
    var parts = path.split(".");
    var cur = vars;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // ===== Template replacement {{var.path}} =====
  function replaceTemplates(text, vars) {
    if (!text) return "";
    return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, function(match, path) {
      var v = getVarByPath(vars, path);
      return v == null ? match : String(v);
    });
  }

  // ===== Action: send message =====
  function executeSendMessage(data, ctx) {
    var text = replaceTemplates(data.text || "", ctx.vars);
    if (!text.trim()) return Promise.resolve({ output: 0, skipped: true });
    // Use existing typeInWhatsApp from msg.js if available (shared content-script scope)
    var typeFn = null;
    try { if (typeof typeInWhatsApp === "function") typeFn = typeInWhatsApp; } catch(e) {}
    if (typeFn) {
      return Promise.resolve(typeFn(text)).then(function() { return { output: 0 }; });
    }
    // Fallback: paste + enter
    return typeInWhatsAppFallback(text).then(function() { return { output: 0 }; });
  }

  function typeInWhatsAppFallback(text) {
    return new Promise(function(resolve, reject) {
      var input = document.querySelector('#main div[contenteditable="true"][role="textbox"]');
      if (!input) return reject(new Error("Campo de mensagem nao encontrado"));
      input.focus();
      var clipData = new DataTransfer();
      clipData.setData("text/plain", text);
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipData }));
      setTimeout(function() {
        var sendBtn = document.querySelector('button[aria-label="Enviar"]') ||
                      document.querySelector('button[data-tab="11"]') ||
                      document.querySelector('[data-icon="send"]');
        if (sendBtn) sendBtn.click();
        else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
        setTimeout(resolve, 300);
      }, 400);
    });
  }

  // ===== Action: add label =====
  function executeAddLabel(data, ctx) {
    var labelName = replaceTemplates(data.labelName || "", ctx.vars);
    if (!labelName || !ctx.chat.phone) return Promise.resolve({ output: 0, skipped: true });
    var uid = (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
    if (!uid) return Promise.resolve({ output: 0, skipped: true });
    return sendBg({
      action: "supabase_rest",
      path: "/rest/v1/labels",
      method: "POST",
      body: {
        user_id: uid,
        contact_phone: normalizePhone(ctx.chat.phone),
        contact_name: ctx.chat.name || "",
        text: labelName,
        color: "#25d366"
      },
      prefer: "return=minimal"
    }).then(function() { return { output: 0 }; });
  }

  // ===== Action: add to tab =====
  function executeAddToTab(data, ctx) {
    var tabName = replaceTemplates(data.tabName || "", ctx.vars);
    if (!tabName || !ctx.chat.phone) return Promise.resolve({ output: 0, skipped: true });
    return new Promise(function(resolve) {
      chrome.storage.local.get("wcrm_abas", function(d) {
        var abas = (d && d.wcrm_abas) || {};
        if (!abas[tabName]) abas[tabName] = { contacts: [], color: "#25d366" };
        var key = normalizePhone(ctx.chat.phone);
        if (abas[tabName].contacts.indexOf(key) === -1) abas[tabName].contacts.push(key);
        chrome.storage.local.set({ wcrm_abas: abas }, function() {
          resolve({ output: 0 });
        });
      });
    });
  }

  // ===== Log flow run to Supabase =====
  function logFlowRun(flow, status, steps, startedAt, errorMsg) {
    if (!flow) return Promise.resolve();
    var uid = (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
    if (!uid) return Promise.resolve();
    return sendBg({
      action: "supabase_rest",
      path: "/rest/v1/flow_runs",
      method: "POST",
      body: {
        flow_id: flow.id,
        user_id: uid,
        status: status,
        steps: steps,
        error_message: errorMsg,
        started_at: startedAt,
        finished_at: new Date().toISOString()
      },
      prefer: "return=minimal"
    }).then(function() {
      // Update flow run counters
      var patchBody = { last_run_at: new Date().toISOString(), run_count: (flow.run_count || 0) + 1 };
      if (status === "success") patchBody.success_count = (flow.success_count || 0) + 1;
      else patchBody.failure_count = (flow.failure_count || 0) + 1;
      return sendBg({
        action: "supabase_rest",
        path: "/rest/v1/flows?id=eq." + flow.id,
        method: "PATCH",
        body: patchBody,
        prefer: "return=minimal"
      });
    });
  }

  function summarizeVars(vars) {
    return {
      contact_name: vars.contact.name,
      is_group: vars.contact.is_group,
      has_label: vars.contact.has_label,
      meeting_exists: vars.meeting.exists,
      meeting_days_until: vars.meeting.days_until,
      ticket_exists: vars.ticket.exists
    };
  }

  // ===== Helper: sendBg (mimics content.js sendBgMessage) =====
  function sendBg(msg) {
    return new Promise(function(resolve) {
      var done = false;
      var timer = setTimeout(function() {
        if (!done) { done = true; resolve({ error: "Timeout" }); }
      }, 20000);
      try {
        chrome.runtime.sendMessage(msg, function(res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(res || { error: "Sem resposta" });
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve({ error: e.message }); }
      }
    });
  }

  console.log("[EZAP Flow Engine] ready");
})();
