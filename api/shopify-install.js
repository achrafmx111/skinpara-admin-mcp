import crypto from "crypto";

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SCOPES = "read_products,write_products,read_themes,write_themes";
const REDIRECT_URI = "https://skinpara-admin-mcp.vercel.app/api/shopify/callback";

export default async function handler(req,res){
  const shop = (SHOP || "").includes(".") ? SHOP : (SHOP + ".myshopify.com");
  if (!SHOP || !CLIENT_ID) return res.status(500).send("Shopify OAuth environment is not configured.");
  const state = crypto.randomBytes(24).toString("hex");
  res.setHeader("Set-Cookie", `shopify_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("state", state);
  return res.redirect(302,u.toString());
}