import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";

const app = express();
const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// 🧠 Capture raw body as Buffer
app.use(
  "/webhook",
  bodyParser.raw({ type: "application/json", limit: "5mb" }) // increase size limit
);

// 🧪 HMAC check (now using raw body)
function verifyHmac(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("base64");

  return digest === hmacHeader;
}

app.post("/webhook", async (req, res) => {
  if (!verifyHmac(req)) {
    console.warn("❌ Webhook HMAC validation failed");
    return res.status(401).send("Unauthorized");
  }

  const payload = JSON.parse(req.body.toString("utf8"));
  const variantIds = (payload.variants || []).map(
    (v) => `gid://shopify/ProductVariant/${v.id}`
  );

  console.log("📦 Webhook received. Forwarding to /tag-variants:", variantIds);

  await fetch("http://localhost:3000/tag-variants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant_ids: variantIds }),
  });

  res.status(200).send("OK");
});

// ✨ JSON parser for everything else
app.use(express.json({ limit: "5mb" }));

app.post("/tag-variants", async (req, res) => {
  const { variant_ids } = req.body;
  const now = new Date();
  const msIn45Days = 45 * 24 * 60 * 60 * 1000;

  for (const variantId of variant_ids) {
    try {
      const query = `{
        productVariant(id: "${variantId}") {
          id
          createdAt
          price
          compareAtPrice
          product { createdAt }
          metafields(namespace: "espresso", first: 10) {
            edges { node { key value } }
          }
          metafields(namespace: "custom", first: 10) {
            edges { node { key value } }
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
      const variant = result?.data?.productVariant;
      if (!variant) {
        console.warn(`⚠️ Variant not found: ${variantId}`);
        continue;
      }

      const createdAt = new Date(variant.createdAt);
      const productCreated = new Date(variant.product.createdAt);
      const price = parseFloat(variant.price);
      const compareAt = parseFloat(variant.compareAtPrice || "0");

      const espressoMeta = {};
      const customMeta = {};
      for (const edge of variant.metafields.espresso.edges) {
        espressoMeta[edge.node.key] = edge.node.value;
      }
      for (const edge of variant.metafields.custom.edges) {
        customMeta[edge.node.key] = edge.node.value;
      }

      const isBestSeller = espressoMeta.best_selling_30_days === "true";
      const currentTag = customMeta.tag || "";

      let newTag = "";
      if (createdAt > productCreated && now - createdAt < msIn45Days) {
        newTag = "New";
      } else if (compareAt > price) {
        newTag = "Offer";
      } else if (isBestSeller) {
        newTag = "Hot";
      } else {
        newTag = "None";
      }

      if (newTag === currentTag) {
        console.log(`✅ ${variantId} already tagged as "${newTag}"`);
        continue;
      }

      const mutation = `
        mutation {
          metafieldsSet(metafields: [{
            ownerId: "${variantId}",
            namespace: "custom",
            key: "tag",
            type: "single_line_text_field",
            value: "${newTag}"
          }]) {
            metafields { key value }
            userErrors { field message }
          }
        }`;

      await fetch(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_API_TOKEN,
        },
        body: JSON.stringify({ query: mutation }),
      });

      console.log(`🏷️ Tagged ${variantId} as "${newTag}"`);
      await delay(1000);
    } catch (err) {
      console.error(`❌ Error tagging ${variantId}:`, err.message);
    }
  }

  res.json({ status: "done", processed: variant_ids.length });
});

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
});
