// GET /api/v1/abas — List user's abas
// POST /api/v1/abas — Create new aba
const { authenticate, logUsage, cors, hasScope } = require('../../_lib/auth');
const { supaRest } = require('../../_lib/supabase');

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
      const { data, status } = await supaRest(
        `abas?user_id=eq.${user.user_id}&select=id,name,color,created_at&order=created_at.asc`
      );
      await logUsage(user.api_key_id, user.user_id, '/v1/abas', 'GET', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ abas: data });
    }

    if (req.method === 'POST') {
      if (!hasScope(user, 'write')) return res.status(403).json({ error: 'Scope "write" required' });
      const { name, color } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Field "name" is required' });
      const { data, status } = await supaRest('abas', 'POST', {
        user_id: user.user_id,
        name,
        color: color || '#25d366'
      });
      await logUsage(user.api_key_id, user.user_id, '/v1/abas', 'POST', 201, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(201).json({ aba: Array.isArray(data) ? data[0] : data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
