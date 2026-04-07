// POST /api/v1/messages/send — Send a message via WhatsApp (queued)
const { authenticate, logUsage, cors, hasScope } = require('../../_lib/auth');
const { supaRest } = require('../../_lib/supabase');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const start = Date.now();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  if (user.error === 'rate_limit') return res.status(429).json({ error: 'Rate limit exceeded' });
  if (!hasScope(user, 'messages')) return res.status(403).json({ error: 'Scope "messages" required' });

  try {
    const { to, message, jid } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Field "message" is required' });
    if (!to && !jid) return res.status(400).json({ error: 'Field "to" (phone) or "jid" is required' });

    // Normalize phone to JID
    const targetJid = jid || (to.replace(/\D/g, '') + '@c.us');

    // Queue the message in msg_sequences table for the extension to pick up
    const { data } = await supaRest('msg_sequences', 'POST', {
      user_id: user.user_id,
      contact_phone: targetJid.replace(/@.*$/, ''),
      contact_name: req.body.contact_name || targetJid,
      messages: [{ text: message, delay: 0, sent: false }],
      status: 'pending'
    });

    await logUsage(user.api_key_id, user.user_id, '/v1/messages/send', 'POST', 202, Date.now() - start, req.headers['x-forwarded-for']);
    return res.status(202).json({
      message: 'Message queued for delivery',
      to: targetJid,
      sequence: Array.isArray(data) ? data[0] : data
    });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
};
