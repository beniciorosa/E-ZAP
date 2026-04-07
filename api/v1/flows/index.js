// GET /api/v1/flows — List user's flows
// POST /api/v1/flows — Create new flow
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
      const { data } = await supaRest(
        `flows?user_id=eq.${user.user_id}&select=id,name,description,status,trigger_type,run_count,success_count,failure_count,created_at,updated_at,last_run_at&order=created_at.desc`
      );
      await logUsage(user.api_key_id, user.user_id, '/v1/flows', 'GET', 200, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(200).json({ flows: data });
    }

    if (req.method === 'POST') {
      if (!hasScope(user, 'flows')) return res.status(403).json({ error: 'Scope "flows" required' });
      const { name, description, trigger_type, trigger_config, nodes, edges } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Field "name" is required' });
      const { data } = await supaRest('flows', 'POST', {
        user_id: user.user_id,
        name,
        description: description || '',
        status: 'draft',
        trigger_type: trigger_type || 'manual',
        trigger_config: trigger_config || {},
        nodes: nodes || [],
        edges: edges || []
      });
      await logUsage(user.api_key_id, user.user_id, '/v1/flows', 'POST', 201, Date.now() - start, req.headers['x-forwarded-for']);
      return res.status(201).json({ flow: Array.isArray(data) ? data[0] : data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
