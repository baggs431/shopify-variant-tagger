import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getVariantAndProduct = async (variantId) => {
  const query = `
    {
      productVariant(id: "${variantId}") {
        id
        createdAt
        price
        compareAtPrice
        product {
          createdAt
          status
        }
        metafields(namespace: "espresso", first: 10) {
          edges {
            node {
              key
              value
            }
          }
        }
      }
    }
  `;

  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  const result = await response.json();
  return result.data.productVariant;
};

const tagVariant = async (variantId, now, msIn45Days) => {
  try {
    const variant = await getVariantAndProduct(variantId);
    if (!variant) return console.warn(`⚠️ Variant not found: ${variantId}`);

    if (variant.product.status !== "ACTIVE") {
      console.log(`⏭ Skipping inactive product for variant ${variant.id}`);
      return;
    }

    const createdAt = new Date(variant.createdAt);
    const productCreated = new Date(variant.product.createdAt);
    const price = parseFloat(variant.price);
    const compareAt = parseFloat(variant.compareAtPrice || "0");

    const espressoMeta = {};
    for (const edge of variant.metafields.edges) {
      espressoMeta[edge.node.key] = edge.node.value;
    }

    const isBestSeller = espressoMeta.best_selling_30_days === "true";
    const currentTag = espressoMeta.tag || "";

    let tag = "";
    if (createdAt > productCreated && now - createdAt < msIn45Days) tag = "New";
    else if (compareAt > price) tag = "Offer";
    else if (isBestSeller) tag = "Hot";

    if (tag === currentTag) {
      console.log(`⚠️ Tag for ${variant.id} already "${tag}" – skipping`);
      return;
    }

    if (!tag) tag = "none";

    const mutation = `
      mutation {
        metafieldsSet(metafields: [{
          ownerId: "${variant.id}",
          namespace: "custom",
          key: "tag",
          type: "single_line_text_field",
          value: "${tag}"
        }, {
          ownerId: "${variant.id}",
          namespace: "custom",
          key: "tag_last_updated",
          type: "single_line_text_field",
          value: "${now.toISOString()}"
        }]) {
          metafields {
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query: mutation }),
    });

    const data = await res.json();
    console.log(`✅ Tagged ${variant.id} as ${tag}`);
    await delay(500);
  } catch (err) {
    console.error(`❌ Failed to tag ${variantId}:`, err.message);
  }
};

const fetchAllVariantIds = async () => {
  let hasNextPage = true;
  let cursor = null;
  const variantIds = [];

  while (hasNextPage) {
    const query = `{
      productVariants(first: 100${cursor ? `, after: \"${cursor}\"` : ""}) {
        edges {
          cursor
          node {
            id
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }`;

    const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();
    const edges = data.data.productVariants.edges;
    edges.forEach(edge => variantIds.push(edge.node.id));
    console.log(`📦 Collected ${variantIds.length} variants so far`);

    hasNextPage = data.data.productVariants.pageInfo.hasNextPage;
    if (hasNextPage) cursor = edges[edges.length - 1].cursor;

    await delay(1000);
  }

  return variantIds;
};

app.post("/full-sync-variants", async (req, res) => {
  console.log("🚀 Starting full variant sync...");
  const variantIds = await fetchAllVariantIds();
  const now = new Date();
  const msIn45Days = 45 * 24 * 60 * 60 * 1000;

  for (const id of variantIds) {
    await tagVariant(id, now, msIn45Days);
  }

  res.json({ status: "complete", total: variantIds.length });
});

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
});
