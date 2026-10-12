import crypto from "node:crypto";
const U=process.env.SUPABASE_URL,K=process.env.SUPABASE_SECRET_KEY,BASE="https://skinpara-admin-mcp.vercel.app";
const ALLOWED_SCOPES=new Set(["products.read","products.write"]);
const esc=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const requestedScopes=value=>{
  const requested=String(value||"products.read products.write").split(/\s+/).filter(Boolean);
  if(requested.some(scope=>!ALLOWED_SCOPES.has(scope)))return null;
  const scopes=[...new Set(requested)];
  if(scopes.includes("products.write")&&!scopes.includes("products.read"))scopes.unshift("products.read");
  return scopes;
};
async function client(id){
  const r=await fetch(U+"/rest/v1/mcp_oauth_clients?client_id=eq."+encodeURIComponent(id)+"&select=client_id,redirect_uris&limit=1",{headers:{apikey:K,Authorization:"Bearer "+K}});
  const a=await r.json();
  return a?.[0];
}
export default async function handler(req,res){
  const q=req.query||{};
  const scopes=requestedScopes(q.scope);
  if(q.response_type!=="code"||!q.client_id||!q.redirect_uri||!q.code_challenge||q.code_challenge_method!=="S256"||!scopes)return res.status(400).send("Invalid OAuth request");
  const c=await client(q.client_id);
  if(!c||!c.redirect_uris.includes(q.redirect_uri))return res.status(400).send("Invalid client or redirect URI");
  if(q.resource&&q.resource!==BASE+"/api/mcp")return res.status(400).send("Invalid resource");
  if(req.method==="GET"){
    const write=scopes.includes("products.write");
    const access=write?"read access plus SEO-only product metadata updates":"read-only product access";
    const tools=write
      ? "<code>get_product</code>, <code>search_products</code>, <code>search_taxonomy_categories</code>, <code>preview_product_update</code>, and <code>bulk_update_product_seo</code>."
      : "<code>get_product</code>, <code>search_products</code>, <code>search_taxonomy_categories</code>, and <code>preview_product_update</code>.";
    res.setHeader("Content-Type","text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html><meta name=viewport content="width=device-width"><title>Authorize SkinPara</title><style>body{font:16px system-ui;max-width:620px;margin:70px auto;padding:24px}button{padding:12px 18px}code{background:#eee;padding:2px 5px}</style><h1>SkinPara Shopify Admin</h1><p>ChatGPT is requesting <b>${access}</b>.</p><p>Allowed tools: ${tools}</p><p>The write scope can change only SEO titles and meta descriptions through the bulk SEO tool. It cannot change prices, inventory, images, variants, status, collections, publication, or themes. Legacy API-key sessions never receive write access.</p><form method=post><input type=hidden name=payload value="${esc(Buffer.from(JSON.stringify({...q,scope:scopes.join(" ")})).toString("base64url"))}"><button type=submit>Authorize SkinPara access</button></form>`);
  }
  let p={};
  try{p=JSON.parse(Buffer.from(req.body?.payload||"","base64url").toString())}catch{return res.status(400).send("Invalid request");}
  const approvedScopes=requestedScopes(p.scope);
  const cc=await client(p.client_id);
  if(!approvedScopes||!cc||!cc.redirect_uris.includes(p.redirect_uri)||p.resource&&p.resource!==BASE+"/api/mcp")return res.status(400).send("Invalid client");
  const code=crypto.randomBytes(32).toString("base64url");
  const r=await fetch(U+"/rest/v1/mcp_oauth_codes",{method:"POST",headers:{apikey:K,Authorization:"Bearer "+K,"Content-Type":"application/json",Prefer:"return=minimal"},body:JSON.stringify({code,client_id:p.client_id,redirect_uri:p.redirect_uri,code_challenge:p.code_challenge,resource:BASE+"/api/mcp",scope:approvedScopes.join(" "),expires_at:new Date(Date.now()+5*60e3).toISOString()})});
  if(!r.ok)return res.status(500).send("Authorization failed");
  const url=new URL(p.redirect_uri);
  url.searchParams.set("code",code);
  if(p.state)url.searchParams.set("state",p.state);
  return res.redirect(302,url.toString());
}
