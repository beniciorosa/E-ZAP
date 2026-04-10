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

module.exports = { supaRest, supaRpc };
