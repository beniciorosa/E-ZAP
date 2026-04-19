// ===== Google OAuth2 flow for DHIEGO.AI =====
// Temporary routes to authorize Google Calendar + Gmail access for specific
// @grupoescalada.com.br accounts. After getting refresh_tokens, these routes
// can be removed (the bot uses the stored tokens directly).
//
// Flow:
//   1. GET /api/google/auth?email=dhiego@grupoescalada.com.br
//      → Redirects to Google consent screen
//   2. Google redirects back to GET /api/google/callback?code=...&state=...
//      → Exchanges code for tokens, stores refresh_token in app_settings
//   3. Bot uses refresh_token to get access_token on every API call

const express = require("express");
const router = express.Router();
const { supaRest } = require("../services/supabase");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

async function getOAuthCreds() {
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

// Step 1: Start OAuth flow
// GET /api/google/auth?email=dhiego@grupoescalada.com.br
router.get("/auth", async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: "?email= required" });

    const { clientId } = await getOAuthCreds();
    if (!clientId) return res.status(500).json({ error: "google_oauth_client_id not configured" });

    // Force localhost redirect — Google OAuth rejects bare HTTP on public IPs.
    // The SSH tunnel (or local dev) makes localhost:3100 reach the server.
    const redirectUri = "http://localhost:3100/api/google/callback";
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      login_hint: email,
      state: email,
    });

    const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();
    console.log("[GOOGLE-OAUTH] Redirecting to consent for:", email);
    res.redirect(authUrl);
  } catch (e) {
    console.error("[GOOGLE-OAUTH] auth error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Step 2: Callback — exchange code for tokens
// GET /api/google/callback?code=...&state=email
router.get("/callback", async (req, res) => {
  try {
    const { code, state: email, error } = req.query;
    if (error) return res.status(400).json({ error: "OAuth denied: " + error });
    if (!code) return res.status(400).json({ error: "No code received" });

    const { clientId, clientSecret } = await getOAuthCreds();
    const redirectUri = "http://localhost:3100/api/google/callback";

    // Exchange code for tokens
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenResp.json();
    if (tokens.error) {
      console.error("[GOOGLE-OAUTH] token exchange failed:", tokens);
      return res.status(400).json({ error: tokens.error, description: tokens.error_description });
    }

    console.log("[GOOGLE-OAUTH] Got tokens for:", email);
    console.log("[GOOGLE-OAUTH] Has refresh_token:", !!tokens.refresh_token);

    // Store refresh_token keyed by email
    const safeKey = "google_refresh_token_" + (email || "unknown").replace(/[^a-zA-Z0-9@._-]/g, "_");
    if (tokens.refresh_token) {
      await supaRest(
        "/rest/v1/app_settings?on_conflict=key",
        "POST",
        { key: safeKey, value: tokens.refresh_token },
        "resolution=merge-duplicates,return=minimal"
      );
      console.log("[GOOGLE-OAUTH] Saved refresh_token as:", safeKey);
    }

    // Also store access_token (short-lived, but useful for immediate test)
    if (tokens.access_token) {
      await supaRest(
        "/rest/v1/app_settings?on_conflict=key",
        "POST",
        { key: safeKey.replace("refresh", "access"), value: tokens.access_token },
        "resolution=merge-duplicates,return=minimal"
      );
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>✅ Google OAuth OK</h1>
        <p>Conta autorizada: <strong>${email || "unknown"}</strong></p>
        <p>refresh_token salvo como: <code>${safeKey}</code></p>
        <p>Pode fechar esta janela.</p>
      </body></html>
    `);
  } catch (e) {
    console.error("[GOOGLE-OAUTH] callback error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper: List which Google accounts have refresh_tokens stored
router.get("/status", async (req, res) => {
  try {
    const rows = await supaRest(
      '/rest/v1/app_settings?key=like.google_refresh_token_*&select=key'
    );
    const accounts = (rows || []).map(r => r.key.replace("google_refresh_token_", ""));
    res.json({ ok: true, authorizedAccounts: accounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
