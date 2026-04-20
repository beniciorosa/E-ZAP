// ===== Supabase REST client for WhatsApp Server =====
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// ===== Concurrency gate =====
// PostgREST / Kong have finite worker slots. When 18 sessions reconnect at
// once, baileys streams thousands of history-sync inserts in parallel and
// saturates the upstream, triggering 503/504 cascades that also break admin
// login (which shares the same gateway). This semaphore caps in-flight
// requests from this process so we degrade gracefully instead of DDoSing
// the gateway.
const SUPA_MAX_CONCURRENCY = parseInt(process.env.SUPA_MAX_CONCURRENCY || "6", 10);
let _inFlight = 0;
const _waitQueue = [];

function _acquire() {
  return new Promise(resolve => {
    if (_inFlight < SUPA_MAX_CONCURRENCY) {
      _inFlight++;
      resolve();
    } else {
      _waitQueue.push(resolve);
    }
  });
}

function _release() {
  const next = _waitQueue.shift();
  if (next) {
    next();
  } else {
    _inFlight = Math.max(0, _inFlight - 1);
  }
}

async function supaRest(path, method = "GET", body = null, prefer = null) {
  const headers = {
    "apikey": SUPA_KEY,
    "Authorization": "Bearer " + SUPA_KEY,
    "Content-Type": "application/json",
  };
  if (prefer) headers["Prefer"] = prefer;

  const opts = { method, headers };
  if (body && method !== "GET") opts.body = JSON.stringify(body);

  await _acquire();
  try {
    const resp = await fetch(SUPA_URL + path, opts);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error("Supabase " + resp.status + ": " + err);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  } finally {
    _release();
  }
}

async function supaRpc(fn, args = {}) {
  return supaRest("/rest/v1/rpc/" + fn, "POST", args);
}

// Count rows matching a PostgREST filter without fetching the data.
// Uses HEAD + Prefer: count=exact and parses the Content-Range response header.
// Example: supaCount("/rest/v1/wa_photo_queue?session_id=eq.X&status=eq.failed")
async function supaCount(path) {
  const headers = {
    "apikey": SUPA_KEY,
    "Authorization": "Bearer " + SUPA_KEY,
    "Prefer": "count=exact",
    "Range-Unit": "items",
    "Range": "0-0",
  };
  const resp = await fetch(SUPA_URL + path, { method: "HEAD", headers });
  if (!resp.ok && resp.status !== 206) {
    return 0;
  }
  const cr = resp.headers.get("content-range") || "";
  const m = cr.match(/\/(\d+|\*)$/);
  if (!m || m[1] === "*") return 0;
  return parseInt(m[1], 10) || 0;
}

// ============================================================================
// JID expansion helpers (port from admin.html _expandPhonesToJids)
// ============================================================================

// Para números BR, expande variações com e sem o "9 extra" depois do DDD
// (cadastros antigos não têm o 9 que foi adicionado depois de 2012)
// Ex: 5584994712772 → [5584994712772, 558494712772]
//     558494712772  → [558494712772, 5584994712772]
function expandBrazilPhoneVariations(phone) {
  const variations = [phone];
  const s = String(phone).replace(/\D/g, "");
  if (s.length < 10) return variations;
  if (s.indexOf("55") === 0) {
    if (s.length === 13 && s.charAt(4) === "9") {
      const without9 = s.substring(0, 4) + s.substring(5);
      if (variations.indexOf(without9) < 0) variations.push(without9);
    }
    if (s.length === 12) {
      const with9 = s.substring(0, 4) + "9" + s.substring(4);
      if (variations.indexOf(with9) < 0) variations.push(with9);
    }
  }
  return variations;
}

// Expande lista de phones em todos os JIDs relacionados:
//   - Chats individuais (@s.whatsapp.net + @lid via wa_contacts)
//   - Grupos onde o phone/JID é membro (via group_members)
// Retorna array deduplicado de JIDs.
async function expandPhonesToJids(phones, opts) {
  opts = opts || {};
  if (!phones || phones.length === 0) {
    return opts.groupByPhone ? { jids: [], phoneMap: {} } : [];
  }

  // Resolve phone-by-phone pra montar mapa {phone: [jids]} sem perder a origem
  const phoneMap = {};
  const allJidsSet = new Set();

  for (const phone of phones) {
    const variations = expandBrazilPhoneVariations(phone);
    const jidsForThisPhone = new Set();

    // Step 1: wa_contacts WHERE phone IN [variations]
    const phoneListIn = variations.map(p => `"${p}"`).join(",");
    const contactRows = await supaRest(
      `/rest/v1/wa_contacts?phone=in.(${phoneListIn})&select=contact_jid,linked_jid`
    ).catch(() => []);

    for (const r of (contactRows || [])) {
      if (r.contact_jid) jidsForThisPhone.add(r.contact_jid);
      if (r.linked_jid) jidsForThisPhone.add(r.linked_jid);
    }

    // JIDs sintéticos como fallback
    for (const v of variations) jidsForThisPhone.add(`${v}@s.whatsapp.net`);

    // Step 2: group_members WHERE member_phone IN [keys]
    const memberKeys = new Set(variations);
    for (const jid of jidsForThisPhone) {
      const key = jid.replace(/@.*$/, "");
      if (key) memberKeys.add(key);
    }
    if (memberKeys.size > 0) {
      const memberListIn = Array.from(memberKeys).map(p => `"${p}"`).join(",");
      const memberRows = await supaRest(
        `/rest/v1/group_members?member_phone=in.(${memberListIn})&select=group_jid`
      ).catch(() => []);
      for (const m of (memberRows || [])) {
        if (m.group_jid) jidsForThisPhone.add(m.group_jid);
      }
    }

    const jidsArr = Array.from(jidsForThisPhone);
    phoneMap[phone] = jidsArr;
    for (const j of jidsArr) allJidsSet.add(j);
  }

  const allJids = Array.from(allJidsSet);
  return opts.groupByPhone ? { jids: allJids, phoneMap } : allJids;
}

// ============================================================================
// CALLS widget helpers — classify & name-fetch
// ============================================================================

// Classifica JID pelo sufixo
function classifyJid(jid) {
  if (!jid) return null;
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@lid")) return "lid";
  return "dm";
}

// Escolhe o JID preferido de uma lista — prioridade group > dm > lid
// Retorna { jid, type } ou null
function pickPrimaryJid(jidsArr) {
  if (!jidsArr || jidsArr.length === 0) return null;
  const groups = jidsArr.filter(j => j && j.endsWith("@g.us"));
  const dms = jidsArr.filter(j => j && j.endsWith("@s.whatsapp.net"));
  const lids = jidsArr.filter(j => j && j.endsWith("@lid"));
  const ordered = groups.concat(dms).concat(lids);
  if (ordered.length === 0) return null;
  const jid = ordered[0];
  return { jid, type: classifyJid(jid) };
}

// Busca nomes dos chats em batch. Tenta wa_chats.chat_name primeiro;
// fallback wa_contacts.name/push_name (DMs) ou group_members.group_name (grupos).
// Retorna { jid: name }.
async function fetchChatNamesBatch(jids) {
  if (!jids || jids.length === 0) return {};
  const unique = Array.from(new Set(jids.filter(Boolean)));
  const result = {};
  const CHUNK = 50;

  // Step 1: wa_chats.chat_name (fonte principal)
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const listIn = chunk.map(j => `"${j}"`).join(",");
    const rows = await supaRest(
      `/rest/v1/wa_chats?chat_jid=in.(${listIn})&select=chat_jid,chat_name`
    ).catch(() => []);
    for (const r of rows || []) {
      if (r.chat_jid && r.chat_name && !result[r.chat_jid]) {
        result[r.chat_jid] = r.chat_name;
      }
    }
  }

  // Step 2: pra quem ficou sem nome, separa por tipo
  const missing = unique.filter(j => !result[j]);
  if (missing.length === 0) return result;

  const missingGroups = missing.filter(j => j.endsWith("@g.us"));
  const missingDMs = missing.filter(j => !j.endsWith("@g.us"));

  // Groups -> group_members.group_name
  for (let i = 0; i < missingGroups.length; i += CHUNK) {
    const chunk = missingGroups.slice(i, i + CHUNK);
    const listIn = chunk.map(j => `"${j}"`).join(",");
    const rows = await supaRest(
      `/rest/v1/group_members?group_jid=in.(${listIn})&select=group_jid,group_name&limit=${chunk.length * 5}`
    ).catch(() => []);
    for (const r of rows || []) {
      if (r.group_jid && r.group_name && !result[r.group_jid]) {
        result[r.group_jid] = r.group_name;
      }
    }
  }

  // DMs -> wa_contacts.name / push_name
  for (let i = 0; i < missingDMs.length; i += CHUNK) {
    const chunk = missingDMs.slice(i, i + CHUNK);
    const listIn = chunk.map(j => `"${j}"`).join(",");
    const rows = await supaRest(
      `/rest/v1/wa_contacts?contact_jid=in.(${listIn})&select=contact_jid,name,push_name`
    ).catch(() => []);
    for (const r of rows || []) {
      if (r.contact_jid && !result[r.contact_jid]) {
        const n = r.name || r.push_name;
        if (n) result[r.contact_jid] = n;
      }
    }
  }

  return result;
}

module.exports = {
  supaRest, supaRpc, supaCount,
  expandPhonesToJids, expandBrazilPhoneVariations,
  classifyJid, pickPrimaryJid, fetchChatNamesBatch,
};
