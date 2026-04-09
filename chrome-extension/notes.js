// ===== E-ZAP Message Notes (ISOLATED world) =====
// Allows users to add private annotations on any message.
// Notes are saved to Supabase message_notes table (per user, per message).
// Only the user can see their own notes — invisible to WhatsApp contacts.
(function() {
  "use strict";

  var _noteCache = {};     // wid -> note_text
  var _dbChecked = {};     // wid -> true
  var _busy = {};          // wid -> true

  // ===== DB Operations =====
  function getUserId() {
    return (window.__wcrmAuth && window.__wcrmAuth.userId) || null;
  }

  function isExtValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch(e) { return false; }
  }

  // Batch check DB for notes on visible messages
  function checkDbNotes(wids) {
    if (!wids.length) return Promise.resolve({});
    var toCheck = [];
    for (var i = 0; i < wids.length; i++) {
      if (!_dbChecked[wids[i]]) toCheck.push(wids[i]);
    }
    if (!toCheck.length) return Promise.resolve({});

    return new Promise(function(resolve) {
      var widList = toCheck.map(function(w) { return '"' + w.replace(/"/g, '') + '"'; }).join(',');
      var path = "/rest/v1/message_notes?message_wid=in.(" + widList + ")&user_id=eq." + getUserId() + "&select=message_wid,note_text";
      try {
        chrome.runtime.sendMessage({
          action: "supabase_rest",
          path: path,
          method: "GET"
        }, function(resp) {
          if (chrome.runtime.lastError) { resolve({}); return; }
          var result = {};
          if (Array.isArray(resp)) {
            for (var r = 0; r < resp.length; r++) {
              if (resp[r].note_text) {
                result[resp[r].message_wid] = resp[r].note_text;
                _noteCache[resp[r].message_wid] = resp[r].note_text;
              }
            }
          }
          for (var c = 0; c < toCheck.length; c++) {
            _dbChecked[toCheck[c]] = true;
          }
          resolve(result);
        });
      } catch(e) { resolve({}); }
    });
  }

  // Save note to DB (upsert)
  function saveNote(wid, text, chatJid) {
    return new Promise(function(resolve) {
      var userId = getUserId();
      if (!userId || !isExtValid()) { resolve(false); return; }
      try {
        chrome.runtime.sendMessage({
          action: "supabase_rest",
          path: "/rest/v1/message_notes",
          method: "POST",
          body: {
            user_id: userId,
            message_wid: wid,
            chat_jid: chatJid || null,
            note_text: text,
            updated_at: new Date().toISOString()
          },
          prefer: "resolution=merge-duplicates,return=minimal"
        }, function(resp) {
          if (chrome.runtime.lastError) {
            console.warn("[EZAP-NOTES] Save error:", chrome.runtime.lastError.message);
            resolve(false);
            return;
          }
          _noteCache[wid] = text;
          console.log("[EZAP-NOTES] Note saved:", wid);
          resolve(true);
        });
      } catch(e) { resolve(false); }
    });
  }

  // Delete note from DB
  function deleteNote(wid) {
    return new Promise(function(resolve) {
      var userId = getUserId();
      if (!userId || !isExtValid()) { resolve(false); return; }
      try {
        chrome.runtime.sendMessage({
          action: "supabase_rest",
          path: "/rest/v1/message_notes?message_wid=eq." + encodeURIComponent(wid) + "&user_id=eq." + userId,
          method: "DELETE",
          prefer: "return=minimal"
        }, function(resp) {
          if (chrome.runtime.lastError) { resolve(false); return; }
          delete _noteCache[wid];
          console.log("[EZAP-NOTES] Note deleted:", wid);
          resolve(true);
        });
      } catch(e) { resolve(false); }
    });
  }

  // ===== Get chat JID from current conversation =====
  function getCurrentChatJid() {
    // Try to get from the open conversation header
    var header = document.querySelector('header [data-testid="conversation-info-header"]');
    if (header) {
      var row = header.closest('div[data-id]');
      if (row) return row.getAttribute('data-id');
    }
    // Fallback: check _ezapStore or URL
    return null;
  }

  // ===== Get WID from a message row =====
  function getRowWid(row) {
    // data-id may be on the row itself or on a child/descendant element
    var id = row.getAttribute('data-id');
    if (id && id.indexOf('@') >= 0) return id;
    // Search ALL descendants — some message types (link, image) nest data-id deeper
    var children = row.querySelectorAll('[data-id]');
    for (var i = 0; i < children.length; i++) {
      id = children[i].getAttribute('data-id');
      if (id && id.indexOf('@') >= 0) return id;
    }
    return null;
  }

  // ===== Scan and inject note icons =====
  function scan() {
    // Find all message rows (role="row" in the message list)
    var rows = document.querySelectorAll('div[role="row"]');
    if (!rows.length) return;

    var newRows = [];
    var newWids = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.querySelector('.ezap-note-btn')) continue;
      // Skip audio messages — notes only on text messages
      if (row.querySelector('[data-testid="audio-play"], [data-testid="ptt-play"], [data-testid="audio-seekbar"]')) continue;
      var wid = getRowWid(row);
      if (!wid) continue;
      newRows.push({ row: row, wid: wid });
      newWids.push(wid);
    }

    if (!newRows.length) return;

    checkDbNotes(newWids).then(function(dbResults) {
      for (var j = 0; j < newRows.length; j++) {
        if (newRows[j].row.querySelector('.ezap-note-btn')) continue;
        var wid = newRows[j].wid;
        var hasNote = !!(dbResults[wid] || _noteCache[wid]);
        injectNoteIcon(newRows[j].row, wid, hasNote);
      }
    });
  }

  // Find the visual message bubble inside a row (text messages only)
  function findBubble(row) {
    var copyText = row.querySelector('[class*="copyable-text"]');
    if (copyText) {
      var el = copyText;
      for (var i = 0; i < 10; i++) {
        if (!el.parentElement || el.parentElement === row) break;
        el = el.parentElement;
        try {
          var bg = window.getComputedStyle(el).backgroundColor;
          if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)' && el.offsetWidth > 100) {
            return el;
          }
        } catch(e) {}
      }
    }
    return row.querySelector('[data-testid="msg-container"]') || row;
  }

  function injectNoteIcon(row, wid, hasNote) {
    var btn = document.createElement('div');
    btn.className = 'ezap-note-btn';
    if (hasNote) btn.classList.add('ezap-note-has');
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    btn.title = hasNote ? 'Ver anotação' : 'Adicionar anotação';

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      onNoteClick(row, wid, btn);
    });

    // Find bubble using same strategy as GEIA
    var bubble = findBubble(row);
    bubble.style.position = 'relative';
    bubble.setAttribute('data-ezap-note-bubble', '1');
    row.setAttribute('data-ezap-note-row', '1');

    // If GEIA or transcribe button exists, shift note button further right
    var hasOtherBtn = bubble.querySelector('.geia-suggest-btn') || bubble.querySelector('.ezap-tr-btn');
    if (hasOtherBtn) btn.classList.add('ezap-note-btn-shift');

    bubble.appendChild(btn);

    // If note exists, show it immediately
    if (hasNote) {
      renderNote(row, wid, _noteCache[wid]);
    }
  }

  // ===== Click handler =====
  function onNoteClick(row, wid, btn) {
    // If editor is already open, close it
    var existing = row.querySelector('.ezap-note-editor');
    if (existing) {
      existing.remove();
      return;
    }

    // If note exists and box is visible, toggle it + open editor
    var noteBox = row.querySelector('.ezap-note-box');
    if (noteBox && !noteBox.querySelector('.ezap-note-editor')) {
      openEditor(row, wid, btn, _noteCache[wid] || '');
      return;
    }

    // Open editor (empty or with existing text)
    openEditor(row, wid, btn, _noteCache[wid] || '');
  }

  function openEditor(row, wid, btn, existingText) {
    // Remove any existing editor in this row
    var old = row.querySelector('.ezap-note-editor');
    if (old) old.remove();

    var editor = document.createElement('div');
    editor.className = 'ezap-note-editor';

    var textarea = document.createElement('textarea');
    textarea.className = 'ezap-note-input';
    textarea.placeholder = 'Escreva sua anotação...';
    textarea.value = existingText;
    textarea.rows = 2;
    editor.appendChild(textarea);

    var actions = document.createElement('div');
    actions.className = 'ezap-note-editor-actions';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'ezap-note-save';
    saveBtn.textContent = 'Salvar';
    saveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var text = textarea.value.trim();
      if (!text) return;
      saveBtn.textContent = '...';
      saveBtn.disabled = true;
      var chatJid = getCurrentChatJid();
      saveNote(wid, text, chatJid).then(function(ok) {
        editor.remove();
        if (ok) {
          btn.classList.add('ezap-note-has');
          btn.title = 'Ver anotação';
          renderNote(row, wid, text);
        }
      });
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ezap-note-cancel';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      editor.remove();
    });

    // Salvar first (left), then delete (if exists), then cancel
    actions.appendChild(saveBtn);

    // Delete button (only if note exists)
    if (existingText) {
      var delBtn = document.createElement('button');
      delBtn.className = 'ezap-note-delete';
      delBtn.textContent = 'Excluir';
      delBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        delBtn.textContent = '...';
        deleteNote(wid).then(function(ok) {
          editor.remove();
          if (ok) {
            btn.classList.remove('ezap-note-has');
            btn.title = 'Adicionar anotação';
            var noteBox = row.querySelector('.ezap-note-box');
            if (noteBox) noteBox.remove();
          }
        });
      });
      actions.appendChild(delBtn);
    }

    actions.appendChild(cancelBtn);
    editor.appendChild(actions);

    // Insert editor below the bubble
    var bubble = row.querySelector('[data-ezap-note-bubble]') || findBubble(row);
    bubble.appendChild(editor);

    // Aggressive focus capture — WhatsApp steals focus from normal focus()
    setTimeout(function() {
      textarea.focus();
      // Move cursor to end
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 100);

    // Block ALL key events from reaching WhatsApp
    function stopWa(e) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
    textarea.addEventListener('keydown', stopWa, true);
    textarea.addEventListener('keyup', stopWa, true);
    textarea.addEventListener('keypress', stopWa, true);
    textarea.addEventListener('input', stopWa, true);

    // Handle shortcuts
    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveBtn.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        editor.remove();
      }
    });

    // No blur re-focus — it causes the yellow border to flicker.
    // stopImmediatePropagation on key events is enough to keep input working.
  }

  // ===== Render saved note =====
  function renderNote(row, wid, text) {
    if (!text) return;
    var old = row.querySelector('.ezap-note-box');
    if (old) old.remove();

    var box = document.createElement('div');
    box.className = 'ezap-note-box';
    box.textContent = text;

    // Click on note box to edit
    box.addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = row.querySelector('.ezap-note-btn');
      openEditor(row, wid, btn, _noteCache[wid] || text);
    });

    var bubble = row.querySelector('[data-ezap-note-bubble]') || findBubble(row);
    bubble.appendChild(box);
  }

  // ===== Observer & Init =====
  function start() {
    console.log('[EZAP-NOTES] Starting notes observer');

    var debounceTimer = null;
    var observer = new MutationObserver(function() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scan, 400);
    });

    var app = document.getElementById('app');
    if (app) {
      observer.observe(app, { childList: true, subtree: true });
    }

    // Reset cache when conversation changes
    var lastChat = null;
    setInterval(function() {
      var header = document.querySelector('header span[title]');
      var chatName = header ? header.getAttribute('title') : null;
      if (chatName && chatName !== lastChat) {
        lastChat = chatName;
        _dbChecked = {};  // Re-check notes for new conversation
      }
    }, 2000);

    scan();
    setInterval(scan, 5000);
  }

  function tryStart() {
    if (!getUserId()) return;
    console.log('[EZAP-NOTES] Notes module active for user:', getUserId());
    setTimeout(start, 2000);
  }

  document.addEventListener('wcrm-auth-ready', function() {
    tryStart();
  });

  if (window.__wcrmAuth) setTimeout(tryStart, 3000);
})();
