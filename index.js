import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;

// Delay helper to throttle requests
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch variant and product data by ID
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

// Primary tagging route
app.post("/tag-variants", async (req, res) => {
  const variantIds = req.body.variant_ids || [];
  const now = new Date();
  const msIn45Days = 45 * 24 * 60 * 60 * 1000;

  for (const variantId of variantIds) {
    try {
      const variant = await getVariantAndProduct(variantId);
      if (!variant) {
        console.warn(`⚠️ Variant not found: ${variantId}`);
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
      const currentTag = espressoMeta.tag || "";

      // Tagging logic
      let tag = "";
      if (createdAt > productCreated && now - createdAt < msIn45Days) {
        tag = "New";
      } else if (compareAt > price) {
        tag = "Offer";
      } else if (isBestSeller) {
        tag = "Hot";
      }

      // Skip if already correct
      if (tag === currentTag) {
        console.log(`⚠️ Tag for ${variant.id} already "${tag}" – skipping`);
        continue;
      }

      // If no valid tag, set to "none"
      if (!tag) {
        tag = "none";
      }

      console.log(`➡️ Setting tag for ${variant.id} to "${tag}"`);

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

      await delay(500); // Throttle between updates

    } catch (err) {
      console.error(`❌ Error tagging variant ${variantId}:`, err.message);
    }
  }

  res.json({ status: "done", processed: variantIds.length });
});

// Triggerable batching endpoint
app.post("/enqueue-tag-variants", async (req, res) => {
  console.log("🛎️ Enqueue route hit");

  // Example test variant IDs (replace with live data or logic)
  const variantIds = [
    "gid://shopify/ProductVariant/1234567890",
    "gid://shopify/ProductVariant/0987654321"
  ];

  // Internally call the tagging route
  const response = await fetch("http://localhost:3000/tag-variants", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ variant_ids: variantIds })
  });

  const result = await response.json();
  console.log("✅ Tagging result from enqueue:", result);

  res.json({ status: "queued", result });
});

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
});
