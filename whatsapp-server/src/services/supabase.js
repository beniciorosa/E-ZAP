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
async function expandPhonesToJids(phones) {
  if (!phones || phones.length === 0) return [];

  // Gera variações com/sem o 9 extra para BR
  const allPhoneVariations = [];
  for (const p of phones) {
    for (const v of expandBrazilPhoneVariations(p)) {
      if (allPhoneVariations.indexOf(v) < 0) allPhoneVariations.push(v);
    }
  }

  // Step 1: busca wa_contacts WHERE phone IN [variações] → coleta JIDs
  const phoneListIn = allPhoneVariations.map(p => `"${p}"`).join(",");
  const contactRows = await supaRest(
    `/rest/v1/wa_contacts?phone=in.(${phoneListIn})&select=contact_jid,linked_jid`
  ).catch(() => []);

  const contactJids = [];
  for (const r of (contactRows || [])) {
    if (r.contact_jid && contactJids.indexOf(r.contact_jid) < 0) contactJids.push(r.contact_jid);
    if (r.linked_jid && contactJids.indexOf(r.linked_jid) < 0) contactJids.push(r.linked_jid);
  }

  // Adiciona JIDs sintéticos (caso wa_contacts não tenha)
  for (const p of allPhoneVariations) {
    const synthetic = `${p}@s.whatsapp.net`;
    if (contactJids.indexOf(synthetic) < 0) contactJids.push(synthetic);
  }

  // Step 2: busca group_members onde member_phone bate (prefixo dos JIDs ou phone)
  const memberKeys = [];
  for (const jid of contactJids) {
    const key = jid.replace(/@.*$/, "");
    if (key && memberKeys.indexOf(key) < 0) memberKeys.push(key);
  }
  for (const p of allPhoneVariations) {
    if (memberKeys.indexOf(p) < 0) memberKeys.push(p);
  }

  const allJids = contactJids.slice();
  if (memberKeys.length > 0) {
    const memberListIn = memberKeys.map(p => `"${p}"`).join(",");
    const memberRows = await supaRest(
      `/rest/v1/group_members?member_phone=in.(${memberListIn})&select=group_jid`
    ).catch(() => []);
    for (const m of (memberRows || [])) {
      if (m.group_jid && allJids.indexOf(m.group_jid) < 0) allJids.push(m.group_jid);
    }
  }

  return allJids;
}

module.exports = { supaRest, supaRpc, supaCount, expandPhonesToJids, expandBrazilPhoneVariations };
