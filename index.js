import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: '5mb' }));

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function verifyHmac(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest("base64");

  return digest === hmacHeader;
}

app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const rawBody = req.body;

  if (!verifyHmac(rawBody, hmacHeader)) {
    console.warn("⚠️ Webhook HMAC validation failed");
    return res.status(401).send("HMAC validation failed");
  }

  const body = JSON.parse(rawBody.toString("utf8"));
  const productId = body.id;
  const variants = body.variants || [];

  const variantIds = variants.map((v) => v.admin_graphql_api_id);

  console.log("📦 Product ID:", productId);
  console.log("🕵️ Product Updated At:", body.updated_at);
  console.log("🔍 Variant Changes:", variants);
  console.log("🚀 Forwarding to tag-variants:", variantIds);

  fetch("http://localhost:3000/tag-variants", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ variant_ids: variantIds }),
  })
    .then((res) => res.json())
    .then((result) => console.log("✅ Tagging result from webhook:", result))
    .catch((err) => console.error("❌ Error forwarding to tag-variants:", err));

  res.status(200).send("Webhook received");
});

app.post("/tag-variants", async (req, res) => {
  const { variant_ids } = req.body;
  console.log("📨 Tagging requested for:", variant_ids);

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
          metafields(namespace: "custom", first: 10) {
            edges { node { key value } }
          }
          metafields(namespace: "espresso", first: 10) {
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

      if (!result || !result.data || !result.data.productVariant) {
        console.warn("❗ No productVariant in response:", JSON.stringify(result, null, 2));
        continue;
      }

      const variant = result.data.productVariant;
      const createdAt = new Date(variant.createdAt);
      const productCreated = new Date(variant.product.createdAt);
      const price = parseFloat(variant.price);
      const compareAt = parseFloat(variant.compareAtPrice || "0");

      const espressoMeta = {};
      const customMeta = {};

      for (const edge of variant.metafields) {
        if (edge.namespace === "espresso") {
          edge.edges.forEach((e) => (espressoMeta[e.node.key] = e.node.value));
        }
        if (edge.namespace === "custom") {
          edge.edges.forEach((e) => (customMeta[e.node.key] = e.node.value));
        }
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
        console.log(`✅ Skipped: ${variantId} already tagged as "${newTag}"`);
        continue;
      }

      console.log(`🎯 Updating tag for ${variantId} → "${newTag}"`);

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

      await delay(1000);
    } catch (err) {
      console.error(`❌ Error tagging ${variantId}:`, err.message);
    }
  }

  res.json({ status: "done" });
});

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
});
