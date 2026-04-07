// GET /api/v1/contacts/:jid/notes — List notes for a contact
// POST /api/v1/contacts/:jid/notes — Add note to contact
const { authenticate, logUsage, cors, hasScope } = require('../../../_lib/auth');
const { supaRest } = require('../../../_lib/supabase');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const start = Date.now();
  const { jid } = req.query;

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  if (user.error === 'rate_limit') return res.status(429).json({ error: 'Rate limit exceeded' });

  // Notes are stored in "observations" table, keyed by contact_phone (digits only)
  const phone = jid.replace(/@.*$/, '').replace(/\D/g, '');

  try {
    if (req.method === 'GET') {
      if (!hasScope(user, 'read')) return res.status(403).json({ error: 'Scope "read" required' });
      const { data } = await supaRest(
        `observations?user_id=eq.${user.user_id}&contact_phone=eq.${phone}&select=id,contact_phone,contact_name,content,created_at,updated_at&order=created_at.desc`
      );
      await logUsage(user.api_key_id, user.user_id, `/v1/contacts/${jid}/notes`, 'GET', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ notes: data });
    }

    if (req.method === 'POST') {
      if (!hasScope(user, 'write')) return res.status(403).json({ error: 'Scope "write" required' });
      const { content, contact_name } = req.body || {};
      if (!content) return res.status(400).json({ error: 'Field "content" is required' });
      const { data } = await supaRest('observations', 'POST', {
        user_id: user.user_id,
        contact_phone: phone,
        contact_name: contact_name || jid,
        content
      });
      await logUsage(user.api_key_id, user.user_id, `/v1/contacts/${jid}/notes`, 'POST', 201, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(201).json({ note: Array.isArray(data) ? data[0] : data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
