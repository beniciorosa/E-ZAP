// POST /api/v1/flows/:id/execute — Trigger a flow manually
const { authenticate, logUsage, cors, hasScope } = require('../../../_lib/auth');
const { supaRest } = require('../../../_lib/supabase');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const start = Date.now();
  const { id } = req.query;

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  if (user.error === 'rate_limit') return res.status(429).json({ error: 'Rate limit exceeded' });
  if (!hasScope(user, 'flows')) return res.status(403).json({ error: 'Scope "flows" required' });

  try {
    // Verify flow belongs to user and is active
    const { data: flowData } = await supaRest(
      `flows?id=eq.${id}&user_id=eq.${user.user_id}&select=id,name,status,nodes,edges`
    );
    if (!flowData || flowData.length === 0) return res.status(404).json({ error: 'Flow not found' });

    const flow = flowData[0];
    if (flow.status !== 'active') return res.status(400).json({ error: 'Flow is not active', status: flow.status });

    // Create flow_run record
    const { data: runData } = await supaRest('flow_runs', 'POST', {
      flow_id: id,
      user_id: user.user_id,
      status: 'running',
      trigger_data: req.body || {},
      steps: []
    });

    // Update flow run_count
    await supaRest(`flows?id=eq.${id}`, 'PATCH', {
      run_count: flow.run_count ? flow.run_count + 1 : 1,
      last_run_at: new Date().toISOString()
    });

    await logUsage(user.api_key_id, user.user_id, `/v1/flows/${id}/execute`, 'POST', 202, Date.now() - start, req.headers['x-forwarded-for']);
    return res.status(202).json({
      message: 'Flow execution started',
      run: Array.isArray(runData) ? runData[0] : runData
    });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
