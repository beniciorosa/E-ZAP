// API Key authentication middleware
const crypto = require('crypto');
const { supaRpc, supaRest } = require('./supabase');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Rate limit: in-memory store (resets per cold start, good enough for now)
const rateLimitStore = {};

function checkRateLimit(keyId, limit) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  if (!rateLimitStore[keyId]) rateLimitStore[keyId] = [];
  // Remove old entries
  rateLimitStore[keyId] = rateLimitStore[keyId].filter(t => now - t < windowMs);
  if (rateLimitStore[keyId].length >= limit) return false;
  rateLimitStore[keyId].push(now);
  return true;
}

async function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const key = authHeader.slice(7).trim();
  if (!key || !key.startsWith('ezap_')) return null;

  const keyHash = hashKey(key);
  const result = await supaRpc('validate_api_key', { p_key_hash: keyHash });
  if (!result || !Array.isArray(result) || result.length === 0) return null;

  const user = result[0];

  // Rate limit check
  if (!checkRateLimit(user.api_key_id, user.rate_limit)) {
    return { error: 'rate_limit', user };
  }

  return user;
}

async function logUsage(apiKeyId, userId, endpoint, method, statusCode, responseMs, ip) {
  try {
    await supaRest('api_usage_logs', 'POST', {
      api_key_id: apiKeyId,
      user_id: userId,
      endpoint,
      method,
      status_code: statusCode,
      response_ms: responseMs,
      ip_address: ip || null
    });
  } catch (e) { /* non-critical */ }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function hasScope(user, scope) {
  if (!user || !user.scopes) return false;
  return user.scopes.includes(scope) || user.scopes.includes('admin');
}

module.exports = { authenticate, logUsage, cors, hasScope, hashKey };
