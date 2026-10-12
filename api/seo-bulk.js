// Bulk SEO transport. Only call after products.write authorization.
// Shopify accepts JSONL staged via stagedUploadsCreate, then bulkOperationRunMutation.
export async function startSeoBulk({ gql, rows }) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10000) throw new Error("Expected 1-10000 SEO rows");
  const ids = new Set();
  const lines = rows.map((row) => {
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(row.id) || ids.has(row.id)) throw new Error("Invalid or duplicate product ID");
    ids.add(row.id);
    if (typeof row.seoTitle !== "string" || typeof row.seoDescription !== "string" || !row.seoTitle.trim() || !row.seoDescription.trim() || row.seoTitle.length > 255 || row.seoDescription.length > 320) throw new Error("Invalid SEO metadata");
    return JSON.stringify({ product: { id: row.id, seo: { title: row.seoTitle.trim(), description: row.seoDescription.trim() } } });
  });
  const jsonl = lines.join("\n") + "\n";
  const bytes = Buffer.byteLength(jsonl);
  if (bytes > 18 * 1024 * 1024) throw new Error("Bulk payload exceeds 18 MB; use server-side generation or split upload");
  const staged = await gql(`mutation($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}}userErrors{field message}}}`, {
    input: [{ filename: "skinpara-product-seo.jsonl", mimeType: "text/jsonl", resource: "BULK_MUTATION_VARIABLES", httpMethod: "POST", fileSize: String(bytes) }]
  });
  const result = staged.stagedUploadsCreate;
  if (result.userErrors?.length || !result.stagedTargets?.[0]) throw new Error("Staging failed: " + JSON.stringify(result.userErrors));
  const target = result.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "skinpara-product-seo.jsonl");
  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) throw new Error("Staged upload failed: HTTP " + upload.status);
  const key = target.parameters.find((p) => p.name === "key")?.value;
  if (!key) throw new Error("Missing staged upload key");
  const mutation = "mutation UpdateSeo($product:ProductUpdateInput!){productUpdate(product:$product){product{id}userErrors{field message}}}";
  const bulk = await gql(`mutation($mutation:String!,$path:String!){bulkOperationRunMutation(mutation:$mutation,stagedUploadPath:$path){bulkOperation{id status type}userErrors{field message}}}`, { mutation, path: key });
  const outcome = bulk.bulkOperationRunMutation;
  if (outcome.userErrors?.length || !outcome.bulkOperation) throw new Error("Bulk start failed: " + JSON.stringify(outcome.userErrors));
  return { mode: "BULK_STARTED", submitted: rows.length, bulkOperation: outcome.bulkOperation };
}
