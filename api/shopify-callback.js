import crypto from "crypto";

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(v => v.trim().split("=")).filter(x => x.length === 2));
}
function safeShop(v) {
  return typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(v);
}
function validHmac(q) {
  const { hmac, ...rest } = q;
  if (!hmac || !CLIENT_SECRET) return false;
  const msg = Object.keys(rest).sort().map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`).join("&");
  const digest = crypto.createHmac("sha256", CLIENT_SECRET).update(msg).digest("hex");
  const a = Buffer.from(digest, "utf8"), b = Buffer.from(String(hmac), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  const { shop, code, state } = req.query || {};
  const cookies = parseCookies(req);
  if (!safeShop(shop) || !code || !state || state !== cookies.shopify_oauth_state || !validHmac(req.query)) {
    return res.status(400).send("Invalid Shopify OAuth callback.");
  }

  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
  });
  const raw = await r.text();
  if (!r.ok) return res.status(502).send("Shopify token exchange failed (HTTP " + r.status + ").");
  let j;
  try { j = JSON.parse(raw); } catch { return res.status(502).send("Shopify token exchange returned an invalid response."); }
  if (!j.access_token) return res.status(502).send("Shopify did not return an access token.");

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return res.status(500).send("Secure token storage is not configured.");
  const save = await fetch(SUPABASE_URL + "/rest/v1/shopify_oauth_tokens?on_conflict=shop", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SECRET_KEY,
      "Authorization": "Bearer " + SUPABASE_SECRET_KEY,
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({ shop, access_token: j.access_token, scopes: j.scope || null, updated_at: new Date().toISOString() })
  });
  if (!save.ok) return res.status(502).send("Shopify authorization succeeded, but secure token storage failed (HTTP " + save.status + ").");

  res.setHeader("Set-Cookie", "shopify_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return res.status(200).send("Shopify authorization succeeded and the access token was stored securely. You can close this page.");
}
