// GET /api/v1/usage — Get API usage stats
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
    // Get usage logs for this API key (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: logs } = await supaRest(
      `api_usage_logs?api_key_id=eq.${user.api_key_id}&created_at=gte.${thirtyDaysAgo}&select=endpoint,method,status_code,response_ms,created_at&order=created_at.desc&limit=500`
    );

    // Aggregate stats
    const total = logs ? logs.length : 0;
    const byEndpoint = {};
    let totalMs = 0;
    if (logs) {
      logs.forEach(l => {
        const key = `${l.method} ${l.endpoint}`;
        byEndpoint[key] = (byEndpoint[key] || 0) + 1;
        totalMs += l.response_ms || 0;
      });
    }

    await logUsage(user.api_key_id, user.user_id, '/v1/usage', 'GET', 200, Date.now() - start, req.headers['x-forwarded-for']);
    return res.status(200).json({
      period: '30d',
      total_requests: total,
      avg_response_ms: total > 0 ? Math.round(totalMs / total) : 0,
      by_endpoint: byEndpoint,
      rate_limit_per_min: user.rate_limit,
      recent: (logs || []).slice(0, 20)
    });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
