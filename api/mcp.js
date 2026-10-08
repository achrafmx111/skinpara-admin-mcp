import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";
const MCP_KEY = process.env.MCP_API_KEY;
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
  const server = new McpServer({ name: "skinpara-admin-mcp", version: "1.3.0" });

  server.tool("get_product", "Detailed read-only Shopify product lookup by GID. Never modifies Shopify.", { id: z.string() }, async ({ id }) => {
    const data = await gql(`query($id:ID!){product(id:$id){
      id title handle descriptionHtml status vendor productType tags totalInventory
      seo{title description}
      category{id name fullName}
      featuredMedia{alt preview{image{url}}}
      media(first:20){nodes{alt mediaContentType preview{image{url}}}}
      collections(first:20){nodes{id title handle}}
      variants(first:20){nodes{id title sku barcode price compareAtPrice inventoryQuantity taxable}}
    }}`, { id });
    return { content: [{ type: "text", text: JSON.stringify(data.product, null, 2) }] };
  });

  server.tool("preview_product_update", "PREVIEW ONLY. Reads current Shopify product values and shows proposed before/after changes. Never modifies Shopify.", {
    id: z.string(),
    title: z.string().optional(),
    descriptionHtml: z.string().optional(),
    productType: z.string().optional(),
    tags: z.array(z.string()).optional(),
    seoTitle: z.string().optional(),
    seoDescription: z.string().optional(),
    categoryId: z.string().nullable().optional()
  }, async ({ id, title, descriptionHtml, productType, tags, seoTitle, seoDescription, categoryId }) => {
    const data = await gql(`query($id:ID!){product(id:$id){id title descriptionHtml productType tags seo{title description} category{id name fullName}}}`, { id });
    if (!data.product) throw new Error("Product not found");
    const before = data.product;
    const proposed = {};
    if (title !== undefined) proposed.title = title;
    if (descriptionHtml !== undefined) proposed.descriptionHtml = descriptionHtml;
    if (productType !== undefined) proposed.productType = productType;
    if (tags !== undefined) proposed.tags = tags;
    if (seoTitle !== undefined || seoDescription !== undefined) proposed.seo = {
      title: seoTitle !== undefined ? seoTitle : before.seo?.title ?? null,
      description: seoDescription !== undefined ? seoDescription : before.seo?.description ?? null
    };
    if (categoryId !== undefined) proposed.categoryId = categoryId;
    return { content: [{ type: "text", text: JSON.stringify({
      mode: "PREVIEW_ONLY",
      shopify_modified: false,
      productId: id,
      before,
      proposed,
      warning: "No Shopify mutation was executed. Explicit user confirmation is required before any future write tool may be used."
    }, null, 2) }] };
  });

  server.tool("search_taxonomy_categories", "Read-only Shopify taxonomy category search. Never modifies Shopify.", {
    search: z.string(),
    first: z.number().int().min(1).max(50).default(20)
  }, async ({ search, first }) => {
    const data = await gql(`query($search:String!,$first:Int!){taxonomy{categories(first:$first,search:$search){nodes{id name fullName isLeaf isRoot}}}}`, { search, first });
    return { content: [{ type: "text", text: JSON.stringify({ mode: "READ_ONLY", categories: data.taxonomy?.categories?.nodes || [] }, null, 2) }] };
  });

  server.tool("search_products", "Read-only Shopify product search. Never modifies Shopify.", {
    query: z.string(),
    first: z.number().int().min(1).max(50).default(10)
  }, async ({ query, first }) => {
    const data = await gql(`query($q:String!,$n:Int!){products(first:$n,query:$q){nodes{
      id title handle status vendor productType tags totalInventory
      seo{title description}
      category{id name fullName}
      featuredMedia{alt preview{image{url}}}
      variants(first:5){nodes{id sku barcode price compareAtPrice inventoryQuantity}}
    }}}`, { q: query, n: first });
    return { content: [{ type: "text", text: JSON.stringify(data.products.nodes, null, 2) }] };
  });

  return server;
}

async function oauthAuthorized(header) {
  if (!header?.startsWith("Bearer ") || !SUPABASE_URL || !SUPABASE_SECRET_KEY) return false;
  const raw = header.slice(7);
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const r = await fetch(SUPABASE_URL + "/rest/v1/mcp_oauth_tokens?token_hash=eq." + hash + "&select=scope,expires_at&limit=1", {
    headers: { apikey: SUPABASE_SECRET_KEY, Authorization: "Bearer " + SUPABASE_SECRET_KEY }
  });
  if (!r.ok) return false;
  const rows = await r.json();
  const t = rows?.[0];
  return !!t && t.scope?.split(" ").includes("products.read") && new Date(t.expires_at) > new Date();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, name: "skinpara-admin-mcp", version: "1.3.0", mode: "read-only-with-preview-and-taxonomy" });
  const legacy = !!MCP_KEY && req.headers.authorization === "Bearer " + MCP_KEY;
  const oauth = legacy ? false : await oauthAuthorized(req.headers.authorization);
  if (!legacy && !oauth) {
    res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="https://skinpara-admin-mcp.vercel.app/.well-known/oauth-protected-resource"');
    return res.status(401).json({ error: "Unauthorized" });
  }
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
