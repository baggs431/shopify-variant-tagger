// index.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";

const app = express();
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_STORE = "uk-escentual.myshopify.com";

app.use(express.json({ limit: "5mb" }));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Verify Shopify HMAC
const verifyHmac = (rawBody, hmacHeader) => {
  const generatedHmac = crypto
    .createHmac("sha256", SHOPIFY_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  return generatedHmac === hmacHeader;
};

// Handle Shopify Webhook
app.post("/webhook", bodyParser.raw({ type: "*/*" }), async (req, res) => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const rawBody = req.body;

  if (!verifyHmac(rawBody, hmacHeader)) {
    console.warn("⚠️ Webhook HMAC validation failed");
    return res.status(401).send("Unauthorized");
  }

  const body = JSON.parse(rawBody.toString("utf8"));
  console.log("✅ Webhook payload parsed:", body.id || body.admin_graphql_api_id);

  // Extract variant IDs from the product payload
  const variantIds = body.variants?.map((v) => v.admin_graphql_api_id).filter(Boolean);

  if (!variantIds || variantIds.length === 0) {
    console.log("⚠️ No variants to process");
    return res.status(200).send("No variants");
  }

  console.log("🚀 Forwarding to /tag-variants:", variantIds);

  await fetch("http://localhost:3000/tag-variants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant_ids: variantIds }),
  });

  res.status(200).send("ok");
});

// Tagging endpoint
app.post("/tag-variants", async (req, res) => {
  const { variant_ids } = req.body;
  console.log("📨 Tagging requested for:", variant_ids);

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
          product { createdAt }
          metafields(namespace: \"custom\", first: 10) { edges { node { key value } } }
          metafields(namespace: \"espresso\", first: 10) { edges { node { key value } } }
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
      if (!result?.data?.productVariant) {
        console.warn("❗ No productVariant in response:", result);
        continue;
      }

      const variant = result.data.productVariant;
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

      let newTag = "None";
      if (createdAt > productCreated && now - createdAt < msIn45Days) {
        newTag = "New";
      } else if (compareAt > price) {
        newTag = "Offer";
      } else if (isBestSeller) {
        newTag = "Hot";
      }

      if (newTag === currentTag) {
        console.log(`✅ Skipped: ${variantId} already tagged as \"${newTag}\"`);
        continue;
      }

      const mutation = `
        mutation {
          metafieldsSet(metafields: [{
            ownerId: \"${variantId}\",
            namespace: \"custom\",
            key: \"tag\",
            type: \"single_line_text_field\",
            value: \"${newTag}\"
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
