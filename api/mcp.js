import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
let tokenCache = { value: null, expiresAt: 0 };
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";
const MCP_KEY = process.env.MCP_API_KEY;

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  if (!SHOP || !SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("Shopify OAuth token storage is not configured");
  const host = SHOP.includes(".") ? SHOP : SHOP + ".myshopify.com";
  const r = await fetch(SUPABASE_URL + "/rest/v1/shopify_oauth_tokens?shop=eq." + encodeURIComponent(host) + "&select=access_token&limit=1", {
    headers: {"apikey":SUPABASE_SECRET_KEY,"Authorization":"Bearer "+SUPABASE_SECRET_KEY}
  });
  if(!r.ok) throw new Error("Secure Shopify token lookup failed: HTTP " + r.status);
  const rows=await r.json();
  if(!rows?.[0]?.access_token) throw new Error("No stored Shopify OAuth token. Authorize the app first.");
  tokenCache={value:rows[0].access_token,expiresAt:Date.now()+5*60*1000};
  return tokenCache.value;
}
