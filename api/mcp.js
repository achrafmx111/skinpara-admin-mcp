import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";
const MCP_KEY = process.env.MCP_API_KEY;\nimport crypto from "node:crypto";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
let tokenCache = { value: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  if (!SHOP || !SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("Shopify OAuth token storage is not configured");
  const host = SHOP.includes(".") ? SHOP : SHOP + ".myshopify.com";
  const r = await fetch(SUPABASE_URL + "/rest/v1/shopify_oauth_tokens?shop=eq." + encodeURIComponent(host) + "&select=access_token&limit=1", {
    headers: { apikey: SUPABASE_SECRET_KEY, Authorization: "Bearer " + SUPABASE_SECRET_KEY }
  });
  if (!r.ok) throw new Error("Secure Shopify token lookup failed: HTTP " + r.status);
  const rows = await r.json();
  if (!rows?.[0]?.access_token) throw new Error("No stored Shopify OAuth token. Authorize the app first.");
  tokenCache = { value: rows[0].access_token, expiresAt: Date.now() + 5 * 60 * 1000 };
  return tokenCache.value;
}

async function gql(query, variables = {}) {
  const token = await getToken();
  const host = SHOP.includes(".") ? SHOP : SHOP + ".myshopify.com";
  const r = await fetch(`https://${host}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error("Shopify GraphQL failed: " + JSON.stringify(j.errors || j));
  return j.data;
}

function makeServer() {
  const server = new McpServer({ name: "skinpara-admin-mcp", version: "1.0.2" });
  server.tool("get_product", "Read one Shopify product by GID", { id: z.string() }, async ({ id }) => {
    const data = await gql(`query($id:ID!){product(id:$id){id title handle status vendor productType tags seo{title description} category{id name fullName} variants(first:10){nodes{id sku price compareAtPrice}}}}`, { id });
    return { content: [{ type: "text", text: JSON.stringify(data.product, null, 2) }] };
  });
  server.tool("search_products", "Read-only product search", { query: z.string(), first: z.number().int().min(1).max(50).default(10) }, async ({ query, first }) => {
    const data = await gql(`query($q:String!,$n:Int!){products(first:$n,query:$q){nodes{id title handle status vendor productType tags category{id name fullName}}}}`, { q: query, n: first });
    return { content: [{ type: "text", text: JSON.stringify(data.products.nodes, null, 2) }] };
  });
  return server;
}

async function oauthAuthorized(header) {\n  if (!header?.startsWith("Bearer ") || !SUPABASE_URL || !SUPABASE_SECRET_KEY) return false;\n  const raw = header.slice(7);\n  const hash = crypto.createHash("sha256").update(raw).digest("hex");\n  const r = await fetch(SUPABASE_URL + "/rest/v1/mcp_oauth_tokens?token_hash=eq." + hash + "&select=scope,expires_at&limit=1", { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: "Bearer " + SUPABASE_SECRET_KEY } });\n  if (!r.ok) return false; const rows = await r.json(); const t = rows?.[0];\n  return !!t && t.scope?.split(" ").includes("products.read") && new Date(t.expires_at) > new Date();\n}\n\nexport default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, name: "skinpara-admin-mcp" });
  const legacy = !!MCP_KEY && req.headers.authorization === "Bearer " + MCP_KEY;\n  const oauth = legacy ? false : await oauthAuthorized(req.headers.authorization);\n  if (!legacy && !oauth) {\n    res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="https://skinpara-admin-mcp.vercel.app/.well-known/oauth-protected-resource"');\n    return res.status(401).json({ error: "Unauthorized" });\n  }
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
