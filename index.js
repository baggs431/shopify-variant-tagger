import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Middleware: Use raw body for webhook, JSON elsewhere
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json({ limit: "5mb" })(req, res, next);
  }
});

// Webhook endpoint from Shopify → forwards to tag-variants
app.post("/webhook", (req, res) => {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const rawBody = req.body;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  if (digest !== hmacHeader) {
    console.warn("⚠️ Webhook HMAC validation failed");
    return res.status(401).send("HMAC validation failed");
  }

  const body = JSON.parse(rawBody.toString("utf8"));
  const updatedVariants = body.variants || [];
  const variantIds = updatedVariants.map(
    (v) => `gid://shopify/ProductVariant/${v.id}`
  );

  console.log("📦 Product webhook triggered → forwarding variants:", variantIds);

  fetch("http://localhost:3000/tag-variants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant_ids: variantIds }),
  });

  res.status(200).send("OK");
});

// Tagging logic
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

      const response = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_API_TOKEN,
          },
          body: JSON.stringify({ query }),
        }
      );

      const result = await response.json();

      if (!result?.data?.productVariant) {
        console.warn(`❌ Missing productVariant for ${variantId}`);
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
        const ns = edge.node?.namespace;
        if (ns === "espresso") espressoMeta[edge.node.key] = edge.node.value;
        if (ns === "custom") customMeta[edge.node.key] = edge.node.value;
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
        console.log(`✅ Skipped ${variantId}: already "${newTag}"`);
        continue;
      }

      console.log(`🔄 Updating tag for ${variantId} → "${newTag}"`);

      const mutation = `mutation {
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

      await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_API_TOKEN,
          },
          body: JSON.stringify({ query: mutation }),
        }
      );

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
