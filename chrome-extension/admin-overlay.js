// ===== E-ZAP Admin Overlay =====
// Permite admins visualizarem conversas de outros usuarios diretamente no WhatsApp Web.
// Feature gate: "admin_overlay" (habilitavel/desabilitavel no painel admin)
// Somente leitura — nao envia mensagens.
(function() {
  "use strict";

  // ===== STATE =====
  var _users = null;          // cached user list
  var _selectedUserId = null;
  var _conversations = [];    // grouped conversations
  var _viewingChat = null;    // { chatJid, chatName } when viewing messages
  var _sidebarCreated = false;

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
    var colors = ["#25d366","#4d96ff","#cc5de8","#ff6b6b","#ffa94d","#51cf66","#339af0","#845ef7","#e64980","#20c997"];
    var hash = 0;
    for (var i = 0; i < (str || "").length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  // ===== CREATE BUTTON =====
  function createAdminButton() {
    if (document.getElementById("admin-overlay-toggle")) return;
    var btn = document.createElement("button");
    btn.id = "admin-overlay-toggle";
    btn.title = "Supervisao - Visualizar conversas de usuarios";
    btn.addEventListener("click", toggleAdminSidebar);
    Object.assign(btn.style, {
      width: "50px",
      height: "50px",
      borderRadius: "50%",
      border: "none",
      fontWeight: "bold",
      cursor: "pointer",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    if (window.__ezapApplyButtonStyle) window.__ezapApplyButtonStyle(btn, "admin_overlay");
    else { btn.textContent = "SPV"; btn.style.background = "#ff922b"; btn.style.color = "#fff"; btn.style.fontSize = "10px"; }
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
    if (sb) sb.style.display = sb.style.display === "flex" ? "none" : "flex";
  }

  // ===== CREATE SIDEBAR =====
  function createAdminSidebar() {
    if (document.getElementById("admin-overlay-sidebar")) return;
    _sidebarCreated = true;

    var sidebar = document.createElement("div");
    sidebar.id = "admin-overlay-sidebar";
    Object.assign(sidebar.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: "320px",
      height: "100vh",
      background: "#111b21",
      borderLeft: "1px solid #2a3942",
      zIndex: "100000",
      flexDirection: "column",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      color: "#e9edef",
      fontSize: "13px",
      overflow: "hidden",
      display: "none",
    });

    // Header
    var header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 16px", background: "#202c33", borderBottom: "1px solid #2a3942", minHeight: "48px",
    });
    header.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:#ff922b;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff">S</div>' +
        '<h3 style="margin:0;font-size:15px;font-weight:600;color:#e9edef">Supervisao</h3>' +
      '</div>';
    var closeBtn = document.createElement("button");
    Object.assign(closeBtn.style, { background: "none", border: "none", color: "#8696a0", fontSize: "20px", cursor: "pointer", padding: "4px 8px", borderRadius: "4px" });
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", toggleAdminSidebar);
    header.appendChild(closeBtn);
    sidebar.appendChild(header);

    // User selector
    var selectorDiv = document.createElement("div");
    selectorDiv.id = "admin-overlay-selector";
    Object.assign(selectorDiv.style, {
      padding: "12px 16px", borderBottom: "1px solid #2a3942", background: "#1a2530",
    });
    selectorDiv.innerHTML =
      '<label style="font-size:11px;color:#8696a0;font-weight:600;display:block;margin-bottom:6px">Selecionar usuario</label>' +
      '<select id="admin-overlay-user-select" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #3b4a54;background:#2a3942;color:#e9edef;font-size:13px;font-family:inherit;cursor:pointer;outline:none">' +
        '<option value="">Carregando usuarios...</option>' +
      '</select>' +
      '<div id="admin-overlay-stats" style="font-size:11px;color:#8696a0;margin-top:6px"></div>';
    sidebar.appendChild(selectorDiv);

    // Content area (conversations list or chat viewer)
    var contentDiv = document.createElement("div");
    contentDiv.id = "admin-overlay-content";
    Object.assign(contentDiv.style, { flex: "1", overflowY: "auto", display: "flex", flexDirection: "column" });
    sidebar.appendChild(contentDiv);

    // Footer
    var footer = document.createElement("div");
    Object.assign(footer.style, {
      padding: "8px 16px", borderTop: "1px solid #2a3942", textAlign: "center",
      fontSize: "10px", color: "#8696a0", background: "#1a2530",
    });
    footer.textContent = "Visualizacao somente leitura";
    sidebar.appendChild(footer);

    document.body.appendChild(sidebar);

    // Register with sidebar manager
    if (window.ezapSidebar) {
      window.ezapSidebar.register("admin_overlay", {
        show: function() {
          var sb = document.getElementById("admin-overlay-sidebar");
          if (sb) sb.style.display = "flex";
        },
        hide: function() {
          var sb = document.getElementById("admin-overlay-sidebar");
          if (sb) sb.style.display = "none";
        },
        onOpen: function() { loadUsers(); },
        shrinkApp: true,
        closesOthers: true,
      });
    }

    // Bind user select
    var sel = document.getElementById("admin-overlay-user-select");
    if (sel) sel.addEventListener("change", function() {
      _selectedUserId = this.value;
      _viewingChat = null;
      if (_selectedUserId) loadConversations(_selectedUserId);
      else renderEmpty();
    });
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
    var html = '<option value="">-- Selecione um usuario --</option>';
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
      '<div style="text-align:center;padding:40px;color:#8696a0">' +
        '<div style="font-size:24px;margin-bottom:8px">&#9203;</div>Carregando conversas...' +
      '</div>';

    // Fetch recent messages, group by chat
    var query = "/rest/v1/message_events?user_id=eq." + userId +
      "&select=chat_jid,chat_name,is_group,direction,message_type,body,timestamp" +
      "&order=timestamp.desc&limit=1500";

    supa(query).then(function(msgs) {
      if (!Array.isArray(msgs) || !msgs.length) {
        content.innerHTML =
          '<div style="text-align:center;padding:40px;color:#8696a0">' +
            '<div style="font-size:24px;margin-bottom:8px">&#128172;</div>Nenhuma conversa encontrada' +
          '</div>';
        updateStats(0, 0);
        return;
      }

      // Group by chat_jid
      var chatMap = {};
      var totalMsgs = msgs.length;
      msgs.forEach(function(m) {
        if (!m.chat_jid) return;
        if (!chatMap[m.chat_jid]) {
          chatMap[m.chat_jid] = {
            chatJid: m.chat_jid,
            chatName: m.chat_name || m.chat_jid,
            isGroup: m.is_group || false,
            lastMsg: m,
            count: 0,
          };
        }
        chatMap[m.chat_jid].count++;
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
    if (chats === 0 && msgs === 0) { el.textContent = ""; return; }
    el.textContent = chats + " conversas | " + msgs + " mensagens recentes";
  }

  // ===== RENDER CONVERSATION LIST =====
  function renderConversationList() {
    var content = document.getElementById("admin-overlay-content");
    if (!content) return;
    _viewingChat = null;

    if (!_conversations.length) {
      content.innerHTML =
        '<div style="text-align:center;padding:40px;color:#8696a0">Nenhuma conversa</div>';
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
    var query = "/rest/v1/message_events?user_id=eq." + _selectedUserId +
      "&chat_jid=eq." + encodeURIComponent(chatJid) +
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
        else if (typeLabel === "location") { typeLabel = "📍 Localizacao"; }
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
      '<div style="text-align:center;padding:60px 20px;color:#8696a0">' +
        '<div style="font-size:48px;margin-bottom:16px;opacity:0.3">&#128101;</div>' +
        '<div style="font-size:14px;font-weight:600;margin-bottom:6px">Supervisao de conversas</div>' +
        '<div style="font-size:12px;line-height:1.5">Selecione um usuario acima para visualizar suas conversas em tempo real.</div>' +
      '</div>';
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
