// GET /api/v1/pins — List pinned contacts
// POST /api/v1/pins — Pin a contact
// DELETE /api/v1/pins?jid=xxx — Unpin a contact
const { authenticate, logUsage, cors, hasScope } = require('../_lib/auth');
const { supaRest } = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const start = Date.now();

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  if (user.error === 'rate_limit') return res.status(429).json({ error: 'Rate limit exceeded' });

  try {
    if (req.method === 'GET') {
      if (!hasScope(user, 'read')) return res.status(403).json({ error: 'Scope "read" required' });
      const { data } = await supaRest(
        `pinned_contacts?user_id=eq.${user.user_id}&select=id,contact_name,contact_jid,created_at&order=created_at.asc`
      );
      await logUsage(user.api_key_id, user.user_id, '/v1/pins', 'GET', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ pins: data });
    }

    if (req.method === 'POST') {
      if (!hasScope(user, 'write')) return res.status(403).json({ error: 'Scope "write" required' });
      const { contact_name, contact_jid } = req.body || {};
      if (!contact_name && !contact_jid) return res.status(400).json({ error: 'Field "contact_name" or "contact_jid" is required' });
      const { data } = await supaRest('pinned_contacts', 'POST', {
        user_id: user.user_id,
        contact_name: contact_name || null,
        contact_jid: contact_jid || null
      });
      await logUsage(user.api_key_id, user.user_id, '/v1/pins', 'POST', 201, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(201).json({ pin: Array.isArray(data) ? data[0] : data });
    }

    if (req.method === 'DELETE') {
      if (!hasScope(user, 'write')) return res.status(403).json({ error: 'Scope "write" required' });
      const { jid } = req.query;
      if (!jid) return res.status(400).json({ error: 'Query param "jid" is required' });
      const filter = jid.includes('@') ? `contact_jid=eq.${jid}` : `contact_name=eq.${encodeURIComponent(jid)}`;
      await supaRest(`pinned_contacts?user_id=eq.${user.user_id}&${filter}`, 'DELETE');
      await logUsage(user.api_key_id, user.user_id, '/v1/pins', 'DELETE', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
