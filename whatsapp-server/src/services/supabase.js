// ===== Supabase REST client for WhatsApp Server =====
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supaRest(path, method = "GET", body = null, prefer = null) {
  const headers = {
    "apikey": SUPA_KEY,
    "Authorization": "Bearer " + SUPA_KEY,
    "Content-Type": "application/json",
  };
  if (prefer) headers["Prefer"] = prefer;

  const opts = { method, headers };
  if (body && method !== "GET") opts.body = JSON.stringify(body);

  const resp = await fetch(SUPA_URL + path, opts);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Supabase " + resp.status + ": " + err);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
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
