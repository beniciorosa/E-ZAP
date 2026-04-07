// Supabase REST helper for Vercel serverless functions
const SUPA_URL = 'https://xsqpqdjffjqxdcmoytfc.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcXBxZGpmZmpxeGRjbW95dGZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzUxMjIwMywiZXhwIjoyMDc5MDg4MjAzfQ.QmSMnUA2x5AkhN_je20lcAb889-DnSyT-8w3dSQhsWM';

const headers = {
  'apikey': SUPA_KEY,
  'Authorization': `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function supaRest(path, method = 'GET', body = null) {
  const opts = { method, headers: { ...headers } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  // For DELETE/PATCH that shouldn't return body
  if (method === 'DELETE') opts.headers['Prefer'] = 'return=representation';
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

async function supaRpc(fn, args = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args)
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return text; }
}

module.exports = { supaRest, supaRpc, SUPA_URL, SUPA_KEY };
