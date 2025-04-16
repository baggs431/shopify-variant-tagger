import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN; // Better security via Render env vars

// Utility to fetch variant + product data from Shopify
const getVariantAndProduct = async (variantId) => {
  const query = `
    {
      productVariant(id: "${variantId}") {
        id
        createdAt
        price
        compareAtPrice
        product {
          id
          createdAt
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

app.post("/tag-variants", async (req, res) => {
  console.log("🔔 Request received:", JSON.stringify(req.body, null, 2));

  const { variant_ids } = req.body;
  const now = new Date();
  const msIn45Days = 45 * 24 * 60 * 60 * 1000;

  for (const variantId of variant_ids) {
    try {
      const variant = await getVariantAndProduct(variantId);
      if (!variant) {
        console.warn(`❗ Could not fetch variant for ID: ${variantId}`);
        continue;
      }

      const createdAt = new Date(variant.createdAt);
      const price = parseFloat(variant.price);
      const compareAt = parseFloat(variant.compareAtPrice || "0");
      const productCreated = new Date(variant.product.createdAt);

      // Parse espresso metafields
      const espressoMeta = {};
      for (const edge of variant.metafields.edges) {
        espressoMeta[edge.node.key] = edge.node.value;
      }

      const dailySold = parseInt(espressoMeta.daily_sold_quantity || "0", 10);
      const isBestSeller = espressoMeta.best_selling_30_days === "true";

      // Tagging logic
      let tag = "";

      if (createdAt > productCreated && now - createdAt < msIn45Days) {
        tag = "New";
      } else if (compareAt > price) {
        tag = "Offer";
      } else if (isBestSeller) {
        tag = "Hot";
      }

      console.log(`➡️ Tag for variant ${variant.id}: "${tag || '[cleared]'}"`);

      // GraphQL mutation
      const mutation = `
        mutation {
          metafieldsSet(metafields: [{
            ownerId: "${variant.id}",
            namespace: "custom",
            key: "tag",
            type: "single_line_text_field",
            value: "${tag}"
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

      const tagRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_API_TOKEN,
        },
        body: JSON.stringify({ query: mutation }),
      });

      const tagResult = await tagRes.json();
      console.log("🛠 Shopify response:", JSON.stringify(tagResult, null, 2));
    } catch (err) {
      console.error(`❌ Error tagging variant ${variantId}:`, err.message);
    }
  }

  res.json({ status: "done" });
});

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
});