import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RETRIES = 3;
const PROCESS_INTERVAL_MS = 5000;
const BATCH_SIZE = 10;

// In-memory async queue for variant IDs
let variantQueue = [];

const processVariants = async (variant_ids) => {
  const now = new Date();
  const msIn45Days = 45 * 24 * 60 * 60 * 1000;

  for (const variantId of variant_ids) {
    try {
      const query = `{
        productVariant(id: \"${variantId}\") {
          id
          createdAt
          price
          compareAtPrice
          product {
            createdAt
          }
          metafields(namespace: \"espresso\", first: 10) {
            edges {
              node {
                key
                value
              }
            }
          }
          metafield(namespace: \"custom\", key: \"tag\") {
            value
          }
        }
      }`;

      const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_API_TOKEN,
        },
        body: JSON.stringify({ query }),
      });

      const result = await response.json();
      const variant = result.data.productVariant;
      if (!variant) {
        console.warn(`⚠️ Variant ${variantId} not found`);
        continue;
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
      const currentTag = variant.metafield?.value || "";

      let tag = "None";
      if (createdAt > productCreated && now - createdAt < msIn45Days) {
        tag = "New";
      } else if (compareAt > 0 && compareAt > price) {
        tag = "Offer";
      } else if (isBestSeller) {
        tag = "Hot";
      }

      if (tag === currentTag) {
        console.log(`⚠️ Tag for ${variant.id} already \"${tag}\" – skipping`);
        continue;
      }

      const mutation = `
        mutation {
          metafieldsSet(metafields: [{
            ownerId: \"${variant.id}\",
            namespace: \"custom\",
            key: \"tag\",
            type: \"single_line_text_field\",
            value: \"${tag}\"
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

      let attempt = 0;
      while (attempt < MAX_RETRIES) {
        try {
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
          break;
        } catch (err) {
          attempt++;
          console.warn(`⚠️ Retry tagging ${variant.id} (attempt ${attempt}): ${err.message}`);
          await delay(1000);
        }
      }

      await delay(1000);
    } catch (err) {
      console.error(`❌ Error tagging variant ${variantId}:`, err.stack || err.message);
    }
  }
};

// New async-friendly endpoint
app.post("/enqueue-tag-variants", async (req, res) => {
  const variant_ids = req.body.variant_ids || [];
  if (!Array.isArray(variant_ids)) {
    return res.status(400).json({ error: "Expected array of variant_ids" });
  }

  variantQueue.push(...variant_ids);
  console.log(`🧾 Enqueued ${variant_ids.length} variants. Queue now has ${variantQueue.length}.`);
  res.status(200).json({ status: "queued", count: variant_ids.length });
});

// Background async processor
setInterval(async () => {
  if (variantQueue.length === 0) return;

  const batch = variantQueue.splice(0, BATCH_SIZE);
  console.log(`🔄 Processing ${batch.length} variants...`);
  await processVariants(batch);
}, PROCESS_INTERVAL_MS);

app.listen(3000, () => {
  console.log("🔥 Async variant tagger ready at http://localhost:3000");
});
