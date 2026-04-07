// GET /api/v1/me — Get authenticated user info
const { authenticate, logUsage, cors } = require('../_lib/auth');
const { supaRest } = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const start = Date.now();

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  if (user.error === 'rate_limit') return res.status(429).json({ error: 'Rate limit exceeded' });

  try {
    const { data } = await supaRest(
      `users?id=eq.${user.user_id}&select=id,name,email,phone,role,features,created_at,last_active`
    );
    if (!data || data.length === 0) return res.status(404).json({ error: 'User not found' });

    const u = data[0];
    await logUsage(user.api_key_id, user.user_id, '/v1/me', 'GET', 200, Date.now() - start, req.headers['x-forwarded-for']);
    return res.status(200).json({
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        features: u.features || [],
        created_at: u.created_at,
        last_active: u.last_active
      },
      api: {
        scopes: user.scopes,
        rate_limit_per_min: user.rate_limit
      }
    });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
