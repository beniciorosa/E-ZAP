// PATCH /api/v1/notes/:id — Update a note
// DELETE /api/v1/notes/:id — Delete a note
const { authenticate, logUsage, cors, hasScope } = require('../../_lib/auth');
const { supaRest } = require('../../_lib/supabase');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const start = Date.now();
  const { id } = req.query;

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  if (user.error === 'rate_limit') return res.status(429).json({ error: 'Rate limit exceeded' });
  if (!hasScope(user, 'write')) return res.status(403).json({ error: 'Scope "write" required' });

  try {
    if (req.method === 'PATCH') {
      const { content } = req.body || {};
      if (!content) return res.status(400).json({ error: 'Field "content" is required' });
      const { data } = await supaRest(
        `observations?id=eq.${id}&user_id=eq.${user.user_id}`, 'PATCH',
        { content, updated_at: new Date().toISOString() }
      );
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return res.status(404).json({ error: 'Note not found' });
      }
      await logUsage(user.api_key_id, user.user_id, `/v1/notes/${id}`, 'PATCH', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ note: Array.isArray(data) ? data[0] : data });
    }

    if (req.method === 'DELETE') {
      await supaRest(`observations?id=eq.${id}&user_id=eq.${user.user_id}`, 'DELETE');
      await logUsage(user.api_key_id, user.user_id, `/v1/notes/${id}`, 'DELETE', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
