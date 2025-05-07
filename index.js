import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";

const app = express();
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;

// Utility: Pause between requests
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Webhook HMAC verification ---
const verifyHmac = (req, res, buf) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(buf)
    .digest("base64");

  if (digest !== hmacHeader) {
    console.warn("⚠️ Webhook HMAC validation failed");
    return false;
  }
  return true;
};

// Webhook route with raw body parsing
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    if (!verifyHmac(req, res, req.body)) return res.status(401).send("Invalid HMAC");

    const rawBody = req.body.toString("utf8");
    const payload = JSON.parse(rawBody);

    console.log("✅ Webhook verified: Product ID", payload.id);

    // Extract variant IDs if present
    const variantIds = (payload.variants || []).map((v) => `gid://shopify/ProductVariant/${v.id}`);

    if (variantIds.length) {
      const tagResponse = await fetch("http://localhost:3000/tag-variants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant_ids: variantIds }),
      });
      console.log("📦 Tag response status:", tagResponse.status);
    }

    res.status(200).send("OK");
  }
);

// --- Tagging logic ---
app.use(bodyParser.json({ limit: "5mb" }));

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
          metafields(namespace: \"custom\", first: 10) {
            edges { node { key value } }
          }
          metafields(namespace: \"espresso\", first: 10) {
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
        console.warn("❗ Missing productVariant for", variantId);
        continue;
      }

      const variant = result.data.productVariant;
      const createdAt = new Date(variant.createdAt);
      const productCreated = new Date(variant.product.createdAt);
      const price = parseFloat(variant.price);
      const compareAt = parseFloat(variant.compareAtPrice || "0");

      const espressoMeta = {};
      const customMeta = {};

      variant.metafields[0]?.edges.forEach((e) => customMeta[e.node.key] = e.node.value);
      variant.metafields[1]?.edges.forEach((e) => espressoMeta[e.node.key] = e.node.value);

      const isBestSeller = espressoMeta.best_selling_30_days === "true";
      const currentTag = customMeta.tag || "";

      let newTag = "None";
      if (createdAt > productCreated && now - createdAt < msIn45Days) newTag = "New";
      else if (compareAt > price) newTag = "Offer";
      else if (isBestSeller) newTag = "Hot";

      if (newTag === currentTag) {
        console.log(`✅ Skipping ${variantId} — tag already '${newTag}'`);
        continue;
      }

      console.log(`📝 Updating tag for ${variantId} → '${newTag}'`);

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
      console.error(`❌ Failed for ${variantId}:`, err.message);
    }
  }

  res.json({ status: "done" });
});

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
});
