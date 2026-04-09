// ===== E-ZAP Admin Overlay =====
// Permite admins visualizarem conversas de outros usuarios diretamente no WhatsApp Web.
// Feature gate: "admin_overlay" (habilitavel/desabilitavel no painel admin)
// Somente leitura — nao envia mensagens.
(function() {
  "use strict";

  // ===== STATE =====
  var _users = null;          // cached user list
  var _selectedUserId = null;
  var _selectedUserName = "";
  var _conversations = [];    // grouped conversations
  var _viewingChat = null;    // { chatJid, chatName } when viewing messages
  var _sidebarCreated = false;
  var _immersiveActive = false; // immersive (full WhatsApp) mode

  // ===== HELPERS =====
  function supa(path, method, body, prefer) {
    return window.ezapSupaRest ? window.ezapSupaRest(path, method, body, prefer) : Promise.resolve(null);
  }

  function isAdmin() {
    return window.__wcrmAuth && window.__wcrmAuth.userRole === "admin";
  }

  function esc(str) {
    if (!str) return "";
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function timeAgo(dateStr) {
    var now = new Date();
    var dt = new Date(dateStr);
    var diffMs = now - dt;
    var diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "agora";
    if (diffMin < 60) return diffMin + " min";
    var diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + "h";
    var diffD = Math.floor(diffH / 24);
    if (diffD < 7) return diffD + "d";
    return String(dt.getDate()).padStart(2, "0") + "/" + String(dt.getMonth() + 1).padStart(2, "0");
  }

  function getInitials(name) {
    if (!name) return "?";
    return name.split(" ").map(function(w) { return w[0]; }).slice(0, 2).join("").toUpperCase();
  }

  // Generate consistent color from string
  function avatarColor(str) {
    var colors = ["#00a884","#4d96ff","#8b5cf6","#ff6b6b","#ffa94d","#51cf66","#339af0","#845ef7","#e64980","#20c997"];
    var hash = 0;
    for (var i = 0; i < (str || "").length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  // ===== CREATE BUTTON =====
  function createAdminButton() {
    if (document.getElementById("admin-overlay-toggle")) return;
    var btn = document.createElement("button");
    btn.id = "admin-overlay-toggle";
    btn.className = "escalada-crm ezap-float-btn";
    btn.setAttribute("data-tooltip", "Supervisão");
    btn.title = "Supervisão - Visualizar conversas de usuários";
    btn.addEventListener("click", toggleAdminSidebar);
    if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "admin_overlay");
    else { btn.textContent = "SPV"; btn.style.background = "#ff922b"; btn.style.color = "#fff"; }
    var container = document.getElementById("ezap-float-container");
    if (container) container.appendChild(btn);
    else document.body.appendChild(btn);
  }

  // ===== TOGGLE =====
  function toggleAdminSidebar() {
    if (!_sidebarCreated) {
      createAdminSidebar();
    }
    if (window.ezapSidebar) {
      ezapSidebar.toggle("admin_overlay");
      return;
    }
    // Fallback
    var sb = document.getElementById("admin-overlay-sidebar");
    if (sb) {
      if (sb.classList.contains("open")) sb.classList.remove("open");
      else { sb.classList.add("open"); loadUsers(); }
    }
  }

  // ===== CREATE SIDEBAR =====
  function createAdminSidebar() {
    if (document.getElementById("admin-overlay-sidebar")) return;
    _sidebarCreated = true;

    var sidebar = document.createElement("div");
    sidebar.id = "admin-overlay-sidebar";
    sidebar.className = "escalada-crm ezap-sidebar";

    // Header
    var header = document.createElement("div");
    header.className = "ezap-header";
    header.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:#ff922b;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff">S</div>' +
        '<h3 class="ezap-header-title">Supervisão</h3>' +
      '</div>';
    var closeBtn = document.createElement("button");
    closeBtn.className = "ezap-header-close";
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", toggleAdminSidebar);
    header.appendChild(closeBtn);
    sidebar.appendChild(header);

    // User selector
    var selectorDiv = document.createElement("div");
    selectorDiv.id = "admin-overlay-selector";
    selectorDiv.style.cssText = "padding:var(--ezap-space-3) var(--ezap-space-4);border-bottom:1px solid var(--ezap-border);background:var(--ezap-bg-elevated)";
    selectorDiv.innerHTML =
      '<label class="ezap-section-title" style="display:block;margin-bottom:6px">Selecionar usuário</label>' +
      '<select id="admin-overlay-user-select" class="ezap-input">' +
        '<option value="">Carregando usuários...</option>' +
      '</select>' +
      '<div id="admin-overlay-stats" style="font-size:var(--ezap-text-sm);color:var(--ezap-text-secondary);margin-top:6px"></div>' +
      '<button id="ao-immersive-btn" class="ezap-btn ezap-btn--orange ezap-btn--full ezap-btn--sm" style="margin-top:8px;opacity:0.5" disabled>' +
        '&#128065; Modo Imersivo' +
      '</button>';
    sidebar.appendChild(selectorDiv);

    // Content area (conversations list or chat viewer)
    var contentDiv = document.createElement("div");
    contentDiv.id = "admin-overlay-content";
    contentDiv.className = "ezap-content";
    contentDiv.style.cssText = "display:flex;flex-direction:column;padding:0";
    sidebar.appendChild(contentDiv);

    // Footer
    var footer = document.createElement("div");
    footer.style.cssText = "padding:var(--ezap-space-2) var(--ezap-space-4);border-top:1px solid var(--ezap-border);text-align:center;font-size:var(--ezap-text-xs);color:var(--ezap-text-secondary);background:var(--ezap-bg-elevated);flex-shrink:0";
    footer.textContent = "Visualização somente leitura";
    sidebar.appendChild(footer);

    document.body.appendChild(sidebar);

    // Register with sidebar manager
    if (window.ezapSidebar) {
      window.ezapSidebar.register("admin_overlay", {
        show: function() {
          var sb = document.getElementById("admin-overlay-sidebar");
          if (sb) sb.classList.add("open");
        },
        hide: function() {
          var sb = document.getElementById("admin-overlay-sidebar");
          if (sb) sb.classList.remove("open");
        },
        onOpen: function() { loadUsers(); },
        shrinkApp: true,
        closesOthers: true,
      });
    }

    // Bind immersive button (always present in sidebar)
    var immBtn = document.getElementById("ao-immersive-btn");
    if (immBtn) immBtn.addEventListener("click", function() {
      if (_selectedUserId) enterImmersiveMode();
    });

    // Bind user select
    var sel = document.getElementById("admin-overlay-user-select");
    if (sel) sel.addEventListener("change", function() {
      _selectedUserId = this.value;
      _selectedUserName = this.options[this.selectedIndex] ? this.options[this.selectedIndex].text : "";
      _viewingChat = null;
      if (_selectedUserId) loadConversations(_selectedUserId);
      else renderEmpty();
      // Enable/disable immersive button based on selection
      _updateImmersiveBtn();
    });
  }

  /** Enable/disable the immersive button based on whether a user is selected */
  function _updateImmersiveBtn() {
    var btn = document.getElementById("ao-immersive-btn");
    if (!btn) return;
    btn.disabled = !_selectedUserId;
    btn.style.opacity = _selectedUserId ? "1" : "";
  }

  // ===== LOAD USERS =====
  function loadUsers() {
    if (_users) {
      populateUserSelect();
      return;
    }
    supa("/rest/v1/users?select=id,name,phone&active=eq.true&order=name.asc").then(function(users) {
      if (!Array.isArray(users)) return;
      _users = users;
      populateUserSelect();
    });
  }

  function populateUserSelect() {
    var sel = document.getElementById("admin-overlay-user-select");
    if (!sel || !_users) return;
    var currentUserId = window.__wcrmAuth ? window.__wcrmAuth.userId : null;
    var html = '<option value="">-- Selecione um usuário --</option>';
    html += '<option value="__all__">Todos os usuários</option>';
    _users.forEach(function(u) {
      // Don't show current admin user
      if (u.id === currentUserId) return;
      var label = u.name || u.phone || "Sem nome";
      html += '<option value="' + u.id + '">' + esc(label) + '</option>';
    });
    sel.innerHTML = html;

    // Restore previous selection if any
    if (_selectedUserId) {
      sel.value = _selectedUserId;
      loadConversations(_selectedUserId);
    }
  }

  // ===== LOAD CONVERSATIONS =====
  function loadConversations(userId) {
    var content = document.getElementById("admin-overlay-content");
    if (!content) return;
    content.innerHTML =
      '<div class="ezap-loading" style="padding:40px">' +
        '<div style="font-size:24px;margin-bottom:8px">&#9203;</div>Carregando conversas...' +
      '</div>';

    // Fetch recent messages, group by chat
    var query = "/rest/v1/message_events?";
    if (userId !== "__all__") query += "user_id=eq." + userId + "&";
    query += "select=chat_jid,chat_name,is_group,direction,message_type,body,timestamp" +
      "&order=timestamp.desc&limit=1500";

    supa(query).then(function(msgs) {
      if (!Array.isArray(msgs) || !msgs.length) {
        content.innerHTML =
          '<div class="ezap-empty" style="padding:40px">' +
            '<div style="font-size:24px;margin-bottom:8px">&#128172;</div>Nenhuma conversa encontrada' +
          '</div>';
        updateStats(0, 0);
        return;
      }

      // Group by chat_jid
      var chatMap = {};
      var totalMsgs = msgs.length;
      var todayStr = new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"
      msgs.forEach(function(m) {
        if (!m.chat_jid) return;
        if (!chatMap[m.chat_jid]) {
          chatMap[m.chat_jid] = {
            chatJid: m.chat_jid,
            chatName: m.chat_name || m.chat_jid,
            isGroup: m.is_group || false,
            lastMsg: m,
            count: 0,
            todayReceived: 0,
          };
        }
        chatMap[m.chat_jid].count++;
        // Count received messages from today
        if (m.direction === "received" && m.timestamp && m.timestamp.substring(0, 10) === todayStr) {
          chatMap[m.chat_jid].todayReceived++;
        }
      });

      _conversations = Object.values(chatMap).sort(function(a, b) {
        return new Date(b.lastMsg.timestamp) - new Date(a.lastMsg.timestamp);
      });

      updateStats(_conversations.length, totalMsgs);
      renderConversationList();
    });
  }

  function updateStats(chats, msgs) {
    var el = document.getElementById("admin-overlay-stats");
    if (!el) return;
    if (chats === 0 && msgs === 0) { el.innerHTML = ""; return; }
    el.innerHTML = chats + " conversas | " + msgs + " mensagens recentes";
    // Enable immersive button now that data is loaded
    _updateImmersiveBtn();
  }

  // ===== RENDER CONVERSATION LIST =====
  function renderConversationList() {
    var content = document.getElementById("admin-overlay-content");
    if (!content) return;
    _viewingChat = null;

    if (!_conversations.length) {
      content.innerHTML =
        '<div class="ezap-empty" style="padding:40px">Nenhuma conversa</div>';
      return;
    }

    var html = '';
    _conversations.forEach(function(c) {
      var initials = getInitials(c.chatName);
      var color = avatarColor(c.chatJid);
      var lastBody = c.lastMsg.body || "";
      if (!lastBody && c.lastMsg.message_type && c.lastMsg.message_type !== "chat") {
        var t = c.lastMsg.message_type;
        if (t === "ptt" || t === "audio") lastBody = "🎤 Audio";
        else if (t === "image") lastBody = "📷 Imagem";
        else if (t === "video") lastBody = "🎥 Video";
        else if (t === "document") lastBody = "📄 Documento";
        else if (t === "sticker") lastBody = "🏷 Sticker";
        else lastBody = "📎 " + t;
      }
      if (lastBody.length > 45) lastBody = lastBody.substring(0, 45) + "...";
      var dirIcon = c.lastMsg.direction === "sent" ? "&#10003; " : "";
      var time = timeAgo(c.lastMsg.timestamp);
      var groupBadge = c.isGroup ? '<span style="font-size:9px;background:#2a3942;color:#8696a0;padding:1px 5px;border-radius:3px;margin-left:4px">Grupo</span>' : '';

      html +=
        '<div class="ao-chat-item" data-jid="' + esc(c.chatJid) + '" data-name="' + esc(c.chatName) + '">' +
          '<div class="ao-chat-avatar" style="background:' + color + '">' + esc(initials) + '</div>' +
          '<div class="ao-chat-info">' +
            '<div class="ao-chat-top">' +
              '<span class="ao-chat-name">' + esc(c.chatName) + groupBadge + '</span>' +
              '<span class="ao-chat-time">' + time + '</span>' +
            '</div>' +
            '<div class="ao-chat-preview">' + dirIcon + esc(lastBody) + '</div>' +
          '</div>' +
          '<div class="ao-chat-count">' + c.count + '</div>' +
        '</div>';
    });

    content.innerHTML = html;

    // Bind click events
    content.querySelectorAll(".ao-chat-item").forEach(function(el) {
      el.addEventListener("click", function() {
        var jid = this.getAttribute("data-jid");
        var name = this.getAttribute("data-name");
        openChatView(jid, name);
      });
    });
  }

  // ===== OPEN CHAT VIEW =====
  function openChatView(chatJid, chatName) {
    _viewingChat = { chatJid: chatJid, chatName: chatName };
    var content = document.getElementById("admin-overlay-content");
    if (!content) return;

    // Show loading with back button
    content.innerHTML =
      '<div class="ao-chat-header">' +
        '<button class="ao-back-btn" id="ao-back-btn">&#8592;</button>' +
        '<div class="ao-chat-avatar-sm" style="background:' + avatarColor(chatJid) + '">' + esc(getInitials(chatName)) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(chatName) + '</div>' +
          '<div id="ao-chat-meta" style="font-size:11px;color:#8696a0">Carregando...</div>' +
        '</div>' +
      '</div>' +
      '<div id="ao-chat-messages" style="flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:4px">' +
        '<div style="text-align:center;padding:40px;color:#8696a0">&#9203; Carregando mensagens...</div>' +
      '</div>';

    // Bind back button
    document.getElementById("ao-back-btn").addEventListener("click", function() {
      renderConversationList();
    });

    // Fetch messages
    var query = "/rest/v1/message_events?";
    if (_selectedUserId !== "__all__") query += "user_id=eq." + _selectedUserId + "&";
    query += "chat_jid=eq." + encodeURIComponent(chatJid) +
      "&select=message_wid,direction,message_type,body,caption,sender_name,group_participant,timestamp,transcript,duration_seconds,is_group" +
      "&order=timestamp.asc&limit=500";

    supa(query).then(function(msgs) {
      if (!Array.isArray(msgs) || !msgs.length) {
        document.getElementById("ao-chat-messages").innerHTML =
          '<div style="text-align:center;padding:40px;color:#8696a0">Nenhuma mensagem encontrada</div>';
        return;
      }
      renderMessages(msgs);
    });
  }

  // ===== RENDER MESSAGES =====
  function renderMessages(msgs) {
    var container = document.getElementById("ao-chat-messages");
    if (!container) return;

    // Update meta
    var meta = document.getElementById("ao-chat-meta");
    if (meta) meta.textContent = msgs.length + " mensagens";

    var html = '';
    var lastDate = '';

    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var dt = new Date(m.timestamp);
      var dateStr = String(dt.getDate()).padStart(2, "0") + "/" + String(dt.getMonth() + 1).padStart(2, "0") + "/" + dt.getFullYear();
      var timeStr = String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");

      // Date divider
      if (dateStr !== lastDate) {
        html += '<div class="ao-date-divider"><span>' + dateStr + '</span></div>';
        lastDate = dateStr;
      }

      var dir = m.direction === "sent" ? "sent" : "received";
      html += '<div class="ao-msg ' + dir + '">';

      // Sender name for groups
      if (m.is_group && m.direction === "received") {
        var senderLabel = m.sender_name || m.group_participant || "";
        if (senderLabel) {
          if (/^\d+$/.test(senderLabel) && senderLabel.length >= 10) {
            senderLabel = "+" + senderLabel.substring(0, 2) + " " + senderLabel.substring(2, 4) + " " + senderLabel.substring(4);
          }
          html += '<div class="ao-msg-sender" style="color:' + avatarColor(senderLabel) + '">' + esc(senderLabel) + '</div>';
        }
      }

      // Message type badge
      if (m.message_type && m.message_type !== "chat" && m.message_type !== "text") {
        var typeLabel = m.message_type;
        if (typeLabel === "ptt" || typeLabel === "audio") {
          var dur = m.duration_seconds ? Math.round(m.duration_seconds) : 0;
          var durMin = Math.floor(dur / 60);
          var durSec = dur % 60;
          typeLabel = "🎤 Audio " + durMin + ":" + String(durSec).padStart(2, "0");
        } else if (typeLabel === "image") { typeLabel = "📷 Imagem"; }
        else if (typeLabel === "video") { typeLabel = "🎥 Video"; }
        else if (typeLabel === "document") { typeLabel = "📄 Documento"; }
        else if (typeLabel === "sticker") { typeLabel = "🏷 Sticker"; }
        else if (typeLabel === "vcard") { typeLabel = "👤 Contato"; }
        else if (typeLabel === "location") { typeLabel = "📍 Localização"; }
        html += '<div class="ao-msg-badge">' + typeLabel + '</div>';
      }

      // Body text
      var text = m.body || m.caption || "";
      if (text) {
        html += '<div>' + esc(text) + '</div>';
      } else if (!m.body && !m.caption && m.message_type !== "chat" && m.message_type !== "text") {
        // Media without text — badge is enough
      } else {
        html += '<div style="font-style:italic;opacity:0.5">(sem texto)</div>';
      }

      // Transcript
      if (m.transcript) {
        html += '<div class="ao-msg-transcript">📝 ' + esc(m.transcript) + '</div>';
      }

      html += '<div class="ao-msg-time">' + timeStr + '</div>';
      html += '</div>';
    }

    container.innerHTML = html;
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  // ===== RENDER EMPTY STATE =====
  function renderEmpty() {
    var content = document.getElementById("admin-overlay-content");
    if (!content) return;
    content.innerHTML =
      '<div class="ezap-empty" style="padding:60px 20px">' +
        '<div style="font-size:48px;margin-bottom:16px;opacity:0.3">&#128101;</div>' +
        '<div style="font-size:var(--ezap-text-md);font-weight:var(--ezap-font-semibold);margin-bottom:6px">Supervisão de conversas</div>' +
        '<div style="font-size:var(--ezap-text-sm);line-height:1.5">Selecione um usuário acima para visualizar suas conversas em tempo real.</div>' +
      '</div>';
  }

  // =============================================
  // ===== IMMERSIVE MODE (Full WhatsApp View) =====
  // =============================================

  function enterImmersiveMode() {
    if (_immersiveActive) return;
    if (!_selectedUserId || !_conversations.length) return;
    _immersiveActive = true;

    // Close the sidebar
    if (window.ezapSidebar) ezapSidebar.close("admin_overlay");

    // Measure pane-side position before adding banner
    var pane = document.getElementById("pane-side");
    var paneRect = pane ? pane.getBoundingClientRect() : { left: 0, top: 0, width: 400, height: window.innerHeight };
    var BANNER_H = 36;

    // Create top banner
    var banner = document.createElement("div");
    banner.id = "ao-imm-banner";
    Object.assign(banner.style, {
      position: "fixed", top: "0", left: "0", width: "100%", height: BANNER_H + "px",
      background: "linear-gradient(90deg, #ff922b, #e8590c)", color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: "13px", fontWeight: "600", zIndex: "200001",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    });
    banner.innerHTML =
      '<span>&#128065; Supervisão: <strong>' + esc(_selectedUserName) + '</strong> &mdash; Somente leitura</span>' +
      '<button id="ao-imm-exit" style="position:absolute;right:16px;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:#fff;padding:4px 16px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Sair</button>';
    document.body.appendChild(banner);
    document.getElementById("ao-imm-exit").addEventListener("click", exitImmersiveMode);

    // Push WhatsApp down to make room for banner
    var appEl = document.getElementById("app");
    if (appEl) {
      appEl.style.marginTop = BANNER_H + "px";
      appEl.style.height = "calc(100vh - " + BANNER_H + "px)";
    }

    // Recalculate positions after margin push
    var paneLeft = pane ? pane.getBoundingClientRect().left : 0;
    var paneWidth = paneRect.width;
    var rightLeft = paneLeft + paneWidth;
    var topOffset = BANNER_H;

    // ===== LEFT PANEL: fixed overlay covering #pane-side =====
    var leftOverlay = document.createElement("div");
    leftOverlay.id = "ao-imm-left";
    Object.assign(leftOverlay.style, {
      position: "fixed",
      top: topOffset + "px",
      left: paneLeft + "px",
      width: paneWidth + "px",
      height: "calc(100vh - " + topOffset + "px)",
      background: "#111b21",
      zIndex: "200000",
      display: "flex",
      flexDirection: "column",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      color: "#e9edef",
      fontSize: "14px",
    });

    // Build user options for immersive dropdown
    var immUserOpts = '<option value="__all__">Todos os usuários</option>';
    var currentUserId = window.__wcrmAuth ? window.__wcrmAuth.userId : null;
    if (_users) {
      _users.forEach(function(u) {
        if (u.id === currentUserId) return;
        var label = u.name || u.phone || "Sem nome";
        var sel = (u.id === _selectedUserId) ? " selected" : "";
        immUserOpts += '<option value="' + u.id + '"' + sel + '>' + esc(label) + '</option>';
      });
    }
    // Select __all__ if that's the current selection
    if (_selectedUserId === "__all__") {
      immUserOpts = immUserOpts.replace('value="__all__"', 'value="__all__" selected');
    }

    leftOverlay.innerHTML =
      '<div style="display:flex;align-items:center;padding:12px 16px;background:#202c33;min-height:56px;gap:12px">' +
        '<div style="width:40px;height:40px;min-width:40px;border-radius:50%;background:#ff922b;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#fff">' + esc(getInitials(_selectedUserName)) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<select id="ao-imm-user-select" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid #3b4a54;background:#2a3942;color:#e9edef;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;outline:none">' +
            immUserOpts +
          '</select>' +
          '<div id="ao-imm-conv-count" style="font-size:11px;color:#8696a0;margin-top:2px">' + _conversations.length + ' conversas</div>' +
        '</div>' +
      '</div>' +
      '<div style="padding:6px 12px;background:#111b21">' +
        '<div style="display:flex;align-items:center;background:#202c33;border-radius:8px;padding:6px 12px;gap:8px">' +
          '<span style="color:#8696a0;font-size:14px">&#128269;</span>' +
          '<input id="ao-imm-search-input" type="text" placeholder="Pesquisar conversa..." style="background:none;border:none;color:#e9edef;font-size:13px;outline:none;width:100%;font-family:inherit">' +
        '</div>' +
      '</div>' +
      '<div id="ao-imm-chatlist" style="flex:1;overflow-y:auto"></div>';

    document.body.appendChild(leftOverlay);

    // Render chat list
    renderImmersiveChatList(_conversations);

    // Search filter
    document.getElementById("ao-imm-search-input").addEventListener("input", function() {
      var q = this.value.toLowerCase().trim();
      var filtered = q ? _conversations.filter(function(c) {
        return (c.chatName || "").toLowerCase().indexOf(q) >= 0;
      }) : _conversations;
      renderImmersiveChatList(filtered);
    });

    // Bind immersive user selector — switch user without leaving immersive mode
    document.getElementById("ao-imm-user-select").addEventListener("change", function() {
      var newUserId = this.value;
      var newUserName = this.options[this.selectedIndex] ? this.options[this.selectedIndex].text : "";
      _selectedUserId = newUserId;
      _selectedUserName = newUserName;
      // Update avatar
      var avatar = document.querySelector("#ao-imm-left div[style*='border-radius:50']");
      // Update banner
      var bannerSpan = document.querySelector("#ao-imm-banner span");
      if (bannerSpan) bannerSpan.innerHTML = '&#128065; Supervisão: <strong>' + esc(_selectedUserName) + '</strong> &mdash; Somente leitura';
      // Clear search
      var searchInput = document.getElementById("ao-imm-search-input");
      if (searchInput) searchInput.value = "";
      // Reset right panel
      var rightOv = document.getElementById("ao-imm-right");
      if (rightOv) rightOv.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8696a0;flex-direction:column;gap:12px">' +
          '<div style="font-size:64px;opacity:0.2">&#128172;</div>' +
          '<div style="font-size:16px;font-weight:500">Selecione uma conversa</div>' +
          '<div style="font-size:13px;opacity:0.7">Clique em uma conversa ao lado para visualizar</div>' +
        '</div>';
      // Show loading in chat list
      var chatlist = document.getElementById("ao-imm-chatlist");
      if (chatlist) chatlist.innerHTML = '<div style="text-align:center;padding:40px;color:#8696a0">Carregando conversas...</div>';
      // Fetch new user's conversations
      if (!newUserId) return;
      var query = "/rest/v1/message_events?";
      if (newUserId !== "__all__") query += "user_id=eq." + newUserId + "&";
      query += "select=chat_jid,chat_name,is_group,direction,message_type,body,timestamp&order=timestamp.desc&limit=1500";
      supa(query).then(function(msgs) {
        if (!Array.isArray(msgs) || !msgs.length) {
          if (chatlist) chatlist.innerHTML = '<div style="text-align:center;padding:40px;color:#8696a0">Nenhuma conversa encontrada</div>';
          var countEl = document.getElementById("ao-imm-conv-count");
          if (countEl) countEl.textContent = "0 conversas";
          _conversations = [];
          return;
        }
        var chatMap = {};
        var todayStr = new Date().toISOString().split("T")[0];
        msgs.forEach(function(m) {
          if (!m.chat_jid) return;
          if (!chatMap[m.chat_jid]) {
            chatMap[m.chat_jid] = { chatJid: m.chat_jid, chatName: m.chat_name || m.chat_jid, isGroup: m.is_group || false, lastMsg: m, count: 0, todayReceived: 0 };
          }
          chatMap[m.chat_jid].count++;
          if (m.direction === "received" && m.timestamp && m.timestamp.substring(0, 10) === todayStr) {
            chatMap[m.chat_jid].todayReceived++;
          }
        });
        _conversations = Object.values(chatMap).sort(function(a, b) {
          return new Date(b.lastMsg.timestamp) - new Date(a.lastMsg.timestamp);
        });
        var countEl = document.getElementById("ao-imm-conv-count");
        if (countEl) countEl.textContent = _conversations.length + " conversas";
        renderImmersiveChatList(_conversations);
      });
    });

    // ===== RIGHT PANEL: fixed overlay covering #main area =====
    var rightOverlay = document.createElement("div");
    rightOverlay.id = "ao-imm-right";
    Object.assign(rightOverlay.style, {
      position: "fixed",
      top: topOffset + "px",
      left: rightLeft + "px",
      width: "calc(100vw - " + rightLeft + "px)",
      height: "calc(100vh - " + topOffset + "px)",
      background: "#0b141a",
      zIndex: "200000",
      display: "flex",
      flexDirection: "column",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      color: "#e9edef",
      fontSize: "14px",
    });
    rightOverlay.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8696a0;flex-direction:column;gap:12px">' +
        '<div style="font-size:64px;opacity:0.2">&#128172;</div>' +
        '<div style="font-size:16px;font-weight:500">Selecione uma conversa</div>' +
        '<div style="font-size:13px;opacity:0.7">Clique em uma conversa ao lado para visualizar</div>' +
      '</div>';
    document.body.appendChild(rightOverlay);

    // ESC key to exit
    document.addEventListener("keydown", _immEscHandler);
    console.log("[EZAP] Admin Overlay: Immersive mode entered for", _selectedUserName);
  }

  function _immEscHandler(e) {
    if (e.key === "Escape" && _immersiveActive) exitImmersiveMode();
  }

  function exitImmersiveMode() {
    if (!_immersiveActive) return;
    _immersiveActive = false;

    // Remove overlays
    var banner = document.getElementById("ao-imm-banner");
    if (banner) banner.remove();
    var leftOv = document.getElementById("ao-imm-left");
    if (leftOv) leftOv.remove();
    var rightOv = document.getElementById("ao-imm-right");
    if (rightOv) rightOv.remove();

    // Restore app margin and height
    var appEl = document.getElementById("app");
    if (appEl) { appEl.style.marginTop = ""; appEl.style.height = ""; }

    document.removeEventListener("keydown", _immEscHandler);
    console.log("[EZAP] Admin Overlay: Immersive mode exited");
  }

  // ===== IMMERSIVE: Render Chat List =====
  function renderImmersiveChatList(conversations) {
    var container = document.getElementById("ao-imm-chatlist");
    if (!container) return;

    var html = '';
    conversations.forEach(function(c) {
      var initials = getInitials(c.chatName);
      var color = avatarColor(c.chatJid);
      var lastBody = c.lastMsg.body || "";
      if (!lastBody && c.lastMsg.message_type && c.lastMsg.message_type !== "chat") {
        var t = c.lastMsg.message_type;
        if (t === "ptt" || t === "audio") lastBody = "\uD83C\uDFA4 Audio";
        else if (t === "image") lastBody = "\uD83D\uDCF7 Imagem";
        else if (t === "video") lastBody = "\uD83C\uDFA5 Video";
        else if (t === "document") lastBody = "\uD83D\uDCC4 Documento";
        else if (t === "sticker") lastBody = "\uD83C\uDFF7 Sticker";
        else lastBody = "\uD83D\uDCCE " + t;
      }
      if (lastBody.length > 55) lastBody = lastBody.substring(0, 55) + "...";
      var time = timeAgo(c.lastMsg.timestamp);
      var todayCount = c.todayReceived || 0;

      html +=
        '<div class="ao-imm-row" data-jid="' + esc(c.chatJid) + '" data-name="' + esc(c.chatName) + '">' +
          '<div style="width:49px;height:49px;min-width:49px;border-radius:50%;background:' + color + ';display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:600;color:#fff">' + esc(initials) + '</div>' +
          '<div style="flex:1;min-width:0;padding-left:14px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">' +
              '<span style="font-size:16px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;color:#e9edef">' + esc(c.chatName) + '</span>' +
              '<span style="font-size:12px;color:' + (todayCount > 0 ? '#00a884' : '#8696a0') + ';flex-shrink:0;margin-left:8px">' + time + '</span>' +
            '</div>' +
            '<div style="font-size:13px;color:#8696a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center">' +
              '<span>' + esc(lastBody) + '</span>' +
              (todayCount > 0 ? '<span style="margin-left:auto;min-width:20px;height:20px;border-radius:50%;background:#00a884;color:#111b21;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 5px;flex-shrink:0">' + todayCount + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
    });

    container.innerHTML = html;

    // Bind click
    container.querySelectorAll(".ao-imm-row").forEach(function(el) {
      el.addEventListener("click", function() {
        // Highlight active
        container.querySelectorAll(".ao-imm-row").forEach(function(r) { r.style.background = ""; });
        this.style.background = "#2a3942";
        var jid = this.getAttribute("data-jid");
        var name = this.getAttribute("data-name");
        openImmersiveChat(jid, name);
      });
    });
  }

  // ===== IMMERSIVE: Open Chat =====
  function openImmersiveChat(chatJid, chatName) {
    var rightOv = document.getElementById("ao-imm-right");
    if (!rightOv) return;

    // Show header + loading
    rightOv.innerHTML =
      '<div style="display:flex;align-items:center;padding:10px 16px;background:#202c33;min-height:56px;gap:12px;border-bottom:1px solid #2a3942">' +
        '<div style="width:40px;height:40px;min-width:40px;border-radius:50%;background:' + avatarColor(chatJid) + ';display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff">' + esc(getInitials(chatName)) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:500;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(chatName) + '</div>' +
          '<div id="ao-imm-msg-meta" style="font-size:12px;color:#8696a0">Carregando mensagens...</div>' +
        '</div>' +
      '</div>' +
      '<div id="ao-imm-messages" style="flex:1;overflow-y:auto;padding:20px 60px;display:flex;flex-direction:column;gap:3px;background-image:url(data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiBmaWxsPSIjMGIxNDFhIi8+PC9zdmc+)">' +
        '<div style="text-align:center;padding:60px;color:#8696a0">Carregando...</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;padding:12px 60px;background:#202c33;border-top:1px solid #2a3942;color:#8696a0;font-size:13px;gap:8px">' +
        '<span style="opacity:0.5">&#128274;</span> Visualização somente leitura' +
      '</div>';

    // Fetch messages
    var query = "/rest/v1/message_events?";
    if (_selectedUserId !== "__all__") query += "user_id=eq." + _selectedUserId + "&";
    query += "chat_jid=eq." + encodeURIComponent(chatJid) +
      "&select=message_wid,direction,message_type,body,caption,sender_name,group_participant,timestamp,transcript,duration_seconds,is_group" +
      "&order=timestamp.asc&limit=500";

    supa(query).then(function(msgs) {
      var msgContainer = document.getElementById("ao-imm-messages");
      var meta = document.getElementById("ao-imm-msg-meta");
      if (!msgContainer) return;

      if (!Array.isArray(msgs) || !msgs.length) {
        msgContainer.innerHTML = '<div style="text-align:center;padding:60px;color:#8696a0">Nenhuma mensagem encontrada</div>';
        if (meta) meta.textContent = "Sem mensagens";
        return;
      }

      if (meta) meta.textContent = msgs.length + " mensagens";
      renderImmersiveMessages(msgContainer, msgs);
    });
  }

  // ===== IMMERSIVE: Render Messages =====
  function renderImmersiveMessages(container, msgs) {
    var html = '';
    var lastDate = '';

    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var dt = new Date(m.timestamp);
      var dateStr = String(dt.getDate()).padStart(2, "0") + "/" + String(dt.getMonth() + 1).padStart(2, "0") + "/" + dt.getFullYear();
      var timeStr = String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");

      // Date divider
      if (dateStr !== lastDate) {
        html += '<div style="text-align:center;padding:12px 0">' +
          '<span style="background:#1a2530;color:#8696a0;font-size:12px;padding:5px 16px;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,0.2)">' + dateStr + '</span></div>';
        lastDate = dateStr;
      }

      var isSent = m.direction === "sent";
      var bubbleBg = isSent ? "#005c4b" : "#202c33";
      var align = isSent ? "flex-end" : "flex-start";
      var tailRadius = isSent ? "border-bottom-right-radius:3px" : "border-bottom-left-radius:3px";

      html += '<div style="display:flex;justify-content:' + align + '">' +
        '<div style="max-width:65%;padding:6px 8px 4px 9px;border-radius:8px;' + tailRadius + ';background:' + bubbleBg + ';box-shadow:0 1px 1px rgba(0,0,0,0.13);font-size:14px;line-height:1.5;word-wrap:break-word">';

      // Sender name for groups
      if (m.is_group && !isSent) {
        var senderLabel = m.sender_name || m.group_participant || "";
        if (senderLabel) {
          if (/^\d+$/.test(senderLabel) && senderLabel.length >= 10) {
            senderLabel = "+" + senderLabel.substring(0, 2) + " " + senderLabel.substring(2, 4) + " " + senderLabel.substring(4);
          }
          html += '<div style="font-size:12.5px;font-weight:600;color:' + avatarColor(senderLabel) + ';margin-bottom:2px">' + esc(senderLabel) + '</div>';
        }
      }

      // Message type badge
      if (m.message_type && m.message_type !== "chat" && m.message_type !== "text") {
        var typeLabel = m.message_type;
        if (typeLabel === "ptt" || typeLabel === "audio") {
          var dur = m.duration_seconds ? Math.round(m.duration_seconds) : 0;
          var durMin = Math.floor(dur / 60);
          var durSec = dur % 60;
          typeLabel = "🎤 Audio " + durMin + ":" + String(durSec).padStart(2, "0");
        } else if (typeLabel === "image") { typeLabel = "📷 Imagem"; }
        else if (typeLabel === "video") { typeLabel = "🎥 Video"; }
        else if (typeLabel === "document") { typeLabel = "📄 Documento"; }
        else if (typeLabel === "sticker") { typeLabel = "🏷 Sticker"; }
        else if (typeLabel === "vcard") { typeLabel = "👤 Contato"; }
        else if (typeLabel === "location") { typeLabel = "📍 Localização"; }
        html += '<div style="display:inline-block;font-size:12px;padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.06);color:#8696a0;margin-bottom:3px">' + typeLabel + '</div>';
      }

      // Body text
      var text = m.body || m.caption || "";
      if (text) {
        html += '<span style="color:#e9edef">' + esc(text) + '</span>';
      } else if (!m.body && !m.caption && m.message_type !== "chat" && m.message_type !== "text") {
        // Media — badge is enough
      } else {
        html += '<span style="font-style:italic;opacity:0.4">(sem texto)</span>';
      }

      // Transcript
      if (m.transcript) {
        html += '<div style="font-style:italic;font-size:12px;color:#8696a0;border-left:2px solid #00a884;padding-left:8px;margin-top:4px">📝 ' + esc(m.transcript) + '</div>';
      }

      // Time + checkmarks
      var checks = isSent ? ' <span style="color:rgba(255,255,255,0.35)">&#10003;&#10003;</span>' : '';
      html += '<div style="display:flex;justify-content:flex-end;align-items:center;gap:4px;margin-top:2px">' +
        '<span style="font-size:11px;color:rgba(255,255,255,0.45)">' + timeStr + '</span>' + checks + '</div>';

      html += '</div></div>';
    }

    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
  }

  // ===== INIT =====
  function initAdminOverlay() {
    console.log("[EZAP] Admin Overlay: Initializing...");
    createAdminButton();
    console.log("[EZAP] Admin Overlay: Ready!");
  }

  // Start after authentication
  document.addEventListener("wcrm-auth-ready", function() {
    if (window.__ezapHasFeature && window.__ezapHasFeature("admin_overlay")) {
      setTimeout(initAdminOverlay, 1500);
    } else {
      console.log("[EZAP] Admin Overlay: Feature not enabled");
    }
  });
  // Fallback if auth already loaded
  if (window.__wcrmAuth && window.__ezapHasFeature && window.__ezapHasFeature("admin_overlay")) {
    setTimeout(initAdminOverlay, 3000);
  }

})();
