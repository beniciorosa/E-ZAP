// GET /api/v1/abas/:id/contacts — List contacts in aba
// POST /api/v1/abas/:id/contacts — Add contact to aba
// DELETE /api/v1/abas/:id/contacts?jid=xxx — Remove contact from aba
const { authenticate, logUsage, cors, hasScope } = require('../../../_lib/auth');
const { supaRest } = require('../../../_lib/supabase');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const start = Date.now();
  const { id, jid } = req.query;

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  if (user.error === 'rate_limit') return res.status(429).json({ error: 'Rate limit exceeded' });

  // Verify aba belongs to user
  const { data: abaCheck } = await supaRest(`abas?id=eq.${id}&user_id=eq.${user.user_id}&select=id`);
  if (!abaCheck || abaCheck.length === 0) return res.status(404).json({ error: 'Aba not found' });

  try {
    if (req.method === 'GET') {
      if (!hasScope(user, 'read')) return res.status(403).json({ error: 'Scope "read" required' });
      const { data } = await supaRest(
        `aba_contacts?aba_id=eq.${id}&select=id,contact_name,contact_jid,created_at&order=created_at.asc`
      );
      await logUsage(user.api_key_id, user.user_id, `/v1/abas/${id}/contacts`, 'GET', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ contacts: data });
    }

    if (req.method === 'POST') {
      if (!hasScope(user, 'write')) return res.status(403).json({ error: 'Scope "write" required' });
      const { contact_name, contact_jid } = req.body || {};
      if (!contact_name && !contact_jid) return res.status(400).json({ error: 'Field "contact_name" or "contact_jid" is required' });
      const { data } = await supaRest('aba_contacts', 'POST', {
        aba_id: id,
        contact_name: contact_name || null,
        contact_jid: contact_jid || null
      });
      await logUsage(user.api_key_id, user.user_id, `/v1/abas/${id}/contacts`, 'POST', 201, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(201).json({ contact: Array.isArray(data) ? data[0] : data });
    }

    if (req.method === 'DELETE') {
      if (!hasScope(user, 'write')) return res.status(403).json({ error: 'Scope "write" required' });
      if (!jid) return res.status(400).json({ error: 'Query param "jid" is required' });
      const filter = jid.includes('@') ? `contact_jid=eq.${jid}` : `contact_name=eq.${encodeURIComponent(jid)}`;
      await supaRest(`aba_contacts?aba_id=eq.${id}&${filter}`, 'DELETE');
      await logUsage(user.api_key_id, user.user_id, `/v1/abas/${id}/contacts`, 'DELETE', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
