// ===== DHIEGO.AI — Google OAuth2 token manager =====
// Handles refresh_token → access_token exchange for Google APIs (Calendar, Gmail).
// Refresh tokens are stored in app_settings keyed by email (e.g.
// google_refresh_token_dhiego@grupoescalada.com.br). Access tokens are cached
// in-memory for ~50 minutes (Google's default lifetime is 60min).

const { supaRest } = require("../../supabase");

const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min, Google tokens last 60min

// In-process cache: email → { accessToken, expiresAt }
const _accessCache = new Map();

async function getOAuthClientCreds() {
  const rows = await supaRest(
    '/rest/v1/app_settings?key=in.("google_oauth_client_id","google_oauth_client_secret")&select=key,value'
  );
  const bag = {};
  for (const r of (rows || [])) bag[r.key] = r.value;
  return {
    clientId: bag.google_oauth_client_id || "",
    clientSecret: bag.google_oauth_client_secret || "",
  };
}

async function getRefreshToken(email) {
  const key = "google_refresh_token_" + email;
  const rows = await supaRest(
    "/rest/v1/app_settings?key=eq." + encodeURIComponent(key) + "&select=value&limit=1"
  );
  return rows && rows[0] && rows[0].value || null;
}

async function listAuthorizedEmails() {
  const rows = await supaRest(
    '/rest/v1/app_settings?key=like.google_refresh_token_*&select=key'
  );
  return (rows || []).map(r => r.key.replace("google_refresh_token_", ""));
}

// Exchange refresh_token for a fresh access_token (or return cached).
async function getAccessToken(email) {
  if (!email) throw new Error("email é obrigatório");

  // Check cache
  const cached = _accessCache.get(email);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const refreshToken = await getRefreshToken(email);
  if (!refreshToken) {
    throw new Error("Conta " + email + " não está autorizada. Peça ao Dhiego para rodar o fluxo OAuth.");
  }

  const { clientId, clientSecret } = await getOAuthClientCreds();
  if (!clientId || !clientSecret) {
    throw new Error("google_oauth_client_id/secret não configurados em app_settings");
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    console.error("[GOOGLE-AUTH] refresh failed for", email, data);
    throw new Error("Falha ao renovar token Google: " + (data.error_description || data.error || "unknown"));
  }

  _accessCache.set(email, {
    accessToken: data.access_token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  console.log("[GOOGLE-AUTH] refreshed access_token for", email);
  return data.access_token;
}

function clearAccessCache(email) {
  if (email) _accessCache.delete(email);
  else _accessCache.clear();
}

module.exports = {
  getAccessToken,
  listAuthorizedEmails,
  clearAccessCache,
};
