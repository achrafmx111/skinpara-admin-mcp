import crypto from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP;
const VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const PROXY_SECRET = process.env.SHOPIFY_APP_CLIENT_SECRET;

function signed(query) {
  const { signature, ...params } = query;
  if (typeof signature !== "string" || !PROXY_SECRET) return false;
  const message = Object.keys(params).sort().map(k => {
    const value = Array.isArray(params[k]) ? params[k].join(",") : params[k];
    return k + "=" + value;
  }).join("");
  const expected = crypto.createHmac("sha256", PROXY_SECRET).update(message).digest("hex");
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
async function token() {
  if (!SHOP || !SUPABASE_URL || !SUPABASE_KEY) throw Error("Missing server configuration");
  const host = SHOP.includes(".") ? SHOP : SHOP + ".myshopify.com";
  const r = await fetch(SUPABASE_URL + "/rest/v1/shopify_oauth_tokens?shop=eq." + encodeURIComponent(host) + "&select=access_token&limit=1", {
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
  });
  if (!r.ok) throw Error("Token lookup failed");
  const rows = await r.json();
  if (!rows?.[0]?.access_token) throw Error("No Shopify token");
  return rows[0].access_token;
}
async function graphql(query, variables) {
  const host = SHOP.includes(".") ? SHOP : SHOP + ".myshopify.com";
  const r = await fetch("https://" + host + "/admin/api/" + VERSION + "/graphql.json", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await token() },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (!r.ok || json.errors) throw Error("Shopify request failed");
  return json.data;
}
const text = (s, max) => typeof s === "string" ? s.trim().slice(0, max) : "";
const money = cents => (cents / 100).toFixed(2);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Shopify app proxy is mandatory: no unauthenticated public Admin API access.
  if (!signed(req.query || {})) return res.status(401).json({ error: "Invalid app proxy signature" });
  const timestamp = Number(req.query.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return res.status(401).json({ error: "Expired request" });
  if (req.query.shop !== (SHOP?.includes(".") ? SHOP : SHOP + ".myshopify.com")) return res.status(401).json({ error: "Shop mismatch" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const name = text(body?.name, 120);
    const phone = text(body?.phone, 32);
    const address = text(body?.address, 300);
    const city = text(body?.city, 100);
    const items = body?.items;
    if (name.length < 2 || !/^\\+?[0-9\\s-]{9,18}$/.test(phone) || address.length < 8 || city.length < 2 || !Array.isArray(items) || !items.length || items.length > 20) return res.status(400).json({ error: "Invalid order details" });
    const quantities = new Map();
    for (const item of items) {
      const id = item?.variantId;
      const qty = item?.quantity;
      if (typeof id !== "string" || !/^gid:\/\/shopify\/ProductVariant\/\\d+$/.test(id) || !Number.isInteger(qty) || qty < 1 || qty > 20) return res.status(400).json({ error: "Invalid item" });
      quantities.set(id, (quantities.get(id) || 0) + qty);
    }
    if (quantities.size > 20 || [...quantities.values()].some(n => n > 20)) return res.status(400).json({ error: "Invalid quantity" });
    const ids = [...quantities.keys()];
    const data = await graphql(`query($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id price availableForSale inventoryQuantity inventoryPolicy product{status}}}}`, { ids });
    if (data.nodes.length !== ids.length || data.nodes.some(v => !v || !v.availableForSale || v.product.status !== "ACTIVE")) return res.status(409).json({ error: "Unavailable product" });
    let subtotal = 0;
    for (const v of data.nodes) {
      const qty = quantities.get(v.id);
      if (v.inventoryPolicy === "DENY" && v.inventoryQuantity !== null && v.inventoryQuantity < qty) return res.status(409).json({ error: "Insufficient inventory" });
      subtotal += Math.round(Number(v.price) * 100) * qty;
    }
    const kenitra = /^(k[eé]nitra|القنيطرة)$/iu.test(city);
    const shipping = kenitra || subtotal >= 60000 ? 0 : 3000;
    const lines = ids.map(id => ({ variantId: id, quantity: quantities.get(id) }));
    if (shipping) lines.push({ title: "Livraison Maroc", originalUnitPrice: "30.00", quantity: 1, taxable: false });
    const created = await graphql(`mutation($input:DraftOrderInput!){draftOrderCreate(input:$input){draftOrder{id name status totalPrice}userErrors{field message}}}`, { input: {
      lineItems: lines,
      shippingAddress: { firstName: name, address1: address, city, countryCode: "MA", phone },
      billingAddress: { firstName: name, address1: address, city, countryCode: "MA", phone },
      phone,
      tags: ["SkinPara-COD", "COD-Pending-Confirmation"],
      note: "Cash on delivery. Shipping calculated server-side. Pending staff confirmation."
    } });
    const errors = created.draftOrderCreate.userErrors;
    if (errors?.length || !created.draftOrderCreate.draftOrder) throw Error("Draft order creation failed");
    return res.status(201).json({ success: true, orderReference: created.draftOrderCreate.draftOrder.name, subtotal: money(subtotal), shipping: money(shipping), currency: "MAD", status: "PENDING_CONFIRMATION" });
  } catch (err) {
    return res.status(500).json({ error: "Order could not be created" });
  }
}
