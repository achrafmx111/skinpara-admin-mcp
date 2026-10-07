# SkinPara Admin MCP

Private MCP bridge for SkinPara Shopify Admin GraphQL.

## Required Vercel environment variables
- SHOPIFY_SHOP
- SHOPIFY_ADMIN_ACCESS_TOKEN
- SHOPIFY_API_VERSION=2026-10
- MCP_API_KEY

Never commit secrets to GitHub.

## Endpoint
POST /api/mcp

Initial tools: get_product, search_products, update_product, taxonomy_categories.
