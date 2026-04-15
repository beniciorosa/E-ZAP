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

module.exports = { supaRest, supaRpc, supaCount };
