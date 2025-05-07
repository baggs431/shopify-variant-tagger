import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: '5mb' }));

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// HMAC verification
const verifyHmac = (req, res, buf) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const generatedHmac = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(buf, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(generatedHmac, "utf8"),
    Buffer.from(hmacHeader, "utf8")
  );
};

// Webhook endpoint
app.post("/webhook", express.raw({ type: 'application/json', limit: '5mb' }), async (req, res) => {
  const hmacValid = verifyHmac(req, res, req.body);

  if (!hmacValid) {
    console.warn("⚠️ Webhook HMAC validation failed");
    return res.status(401).send("HMAC validation failed");
  }

  const payload = JSON.parse(req.body.toString("utf8"));
  console.log("✅ Webhook payload parsed:", payload.id);

  const variantIds = payload.variants?.map(v => v.admin_graphql_api_id).filter(Boolean) || [];

  if (variantIds.length === 0) {
    console.log("⚠️ No variant IDs found in webhook payload");
    return res.status(200).json({ status: "no_variants" });
  }

  // Call tagging logic
  const response = await fetch("http://localhost:3000/tag-variants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant_ids: variantIds }),
  });

  const result = await response.json();
  console.log("📨 Tagging result:", result);

  res.status(200).json({ status: "ok" });
});

// Variant tagging endpoint (your existing logic here)
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
          metafields(namespace: "custom", first: 10) { edges { node { key value } } }
          metafields(namespace: "espresso", first: 10) { edges { node { key value } } }
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
        console.warn("❗ Variant not found:", variantId);
        continue;
      }

      const createdAt = new Date(variant.createdAt);
      const productCreated = new Date(variant.product.createdAt);
      const price = parseFloat(variant.price);
      const compareAt = parseFloat(variant.compareAtPrice || "0");

      const espressoMeta = {};
      const customMeta = {};

      for (const edge of variant.metafields.espresso?.edges || []) {
        espressoMeta[edge.node.key] = edge.node.value;
      }
      for (const edge of variant.metafields.custom?.edges || []) {
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
