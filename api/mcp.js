import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";
const MCP_KEY = process.env.MCP_API_KEY;

async function gql(query, variables={}) {
  if (!SHOP || !TOKEN) throw new Error("Shopify environment variables are not configured");
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method:"POST",
    headers:{"Content-Type":"application/json","X-Shopify-Access-Token":TOKEN},
    body:JSON.stringify({query,variables})
  });
  const j=await r.json();
  if(!r.ok || j.errors) throw new Error(JSON.stringify(j.errors || j));
  return j.data;
}
const out=(x)=>({content:[{type:"text",text:JSON.stringify(x,null,2)}]});

function makeServer(){
 const s=new McpServer({name:"skinpara-admin-mcp",version:"1.0.1"});

 s.tool("get_product","Read one Shopify product by GID",{id:z.string()},async({id})=>out(await gql(`query($id:ID!){product(id:$id){id title handle descriptionHtml productType tags category{id name fullName} seo{title description} status vendor}}`,{id})));

 s.tool("search_products","Search products using Shopify query syntax",{query:z.string(),first:z.number().int().min(1).max(50).default(20)},async({query,first})=>out(await gql(`query($q:String!,$n:Int!){products(first:$n,query:$q){nodes{id title handle status vendor productType tags category{id name fullName} seo{title description}}}}`,{q:query,n:first})));

 s.tool("update_product","Update safe product SEO/catalog fields. Omitted fields stay unchanged",{
   id:z.string(),title:z.string().optional(),descriptionHtml:z.string().optional(),productType:z.string().optional(),
   tags:z.array(z.string()).optional(),categoryId:z.string().optional(),seoTitle:z.string().optional(),seoDescription:z.string().optional()
 },async(a)=>{
   const product={id:a.id};
   for(const k of ["title","descriptionHtml","productType","tags"]) if(a[k]!==undefined) product[k]=a[k];
   if(a.categoryId!==undefined) product.category=a.categoryId;
   if(a.seoTitle!==undefined || a.seoDescription!==undefined) product.seo={...(a.seoTitle!==undefined?{title:a.seoTitle}:{}),...(a.seoDescription!==undefined?{description:a.seoDescription}:{})};
   const d=await gql(`mutation($product:ProductUpdateInput!){productUpdate(product:$product){product{id title handle productType tags category{id name fullName} seo{title description}} userErrors{field message}}}`,{product});
   return out(d.productUpdate);
 });

 s.tool("taxonomy_categories","Search Shopify taxonomy categories",{search:z.string(),first:z.number().int().min(1).max(50).default(20)},async({search,first})=>out(await gql(`query($s:String!,$n:Int!){taxonomy{categories(first:$n,search:$s){nodes{id name fullName isLeaf isRoot}}}}`,{s:search,n:first})));

 return s;
}

export default async function handler(req,res){
 if(req.method!=="POST"){res.statusCode=200;res.setHeader("content-type","application/json");return res.end(JSON.stringify({ok:true,name:"skinpara-admin-mcp"}));}
 if(MCP_KEY && req.headers.authorization!==`Bearer ${MCP_KEY}`){res.statusCode=401;return res.end("Unauthorized");}
 const server=makeServer();
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
 await server.connect(transport);
 await transport.handleRequest(req,res,req.body);
}
