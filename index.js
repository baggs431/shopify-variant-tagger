import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";

const app = express();
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// 🧠 Temporarily stores recently processed variant IDs
const recentlyTagged = new Set();

app.use("/webhook", bodyParser.raw({ type: "application/json", limit: "5mb" }));

function verifyHmac(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("base64");

  return digest === hmacHeader;
}

function encodeShopifyVariantId(id) {
  return Buffer.from(`gid://shopify/ProductVariant/${id}`).toString("base64");
}

app.post("/webhook", async (req, res) => {
  if (!verifyHmac(req)) {
    console.warn("❌ Webhook HMAC validation failed");
    return res.status(401).send("Unauthorized");
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch (error) {
    console.error("❌ Payload parsing failed", error);
    return res.status(400).send("Invalid payload");
  }

  const variantIds = (payload.variants || []).map((v) => v.id.toString());
  console.log("📦 Webhook received, sending to /tag-variants:", variantIds);

  await fetch(`${BASE_URL}/tag-variants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant_ids: variantIds }),
  });

  res.status(200).send("OK");
});

app.use(express.json({ limit: "5mb" }));

app.post("/tag-variants", async (req, res) => {
  const { variant_ids } = req.body;
  const now = new Date();
  const msIn45Days = 45 * 24 * 60 * 60 * 1000;

  for (const variantId of variant_ids) {
    try {
      if (recentlyTagged.has(variantId)) {
        console.log(`⏳ Skipping ${variantId} – recently tagged`);
        continue;
      }

      recentlyTagged.add(variantId);
      setTimeout(() => recentlyTagged.delete(variantId), 30000); // 30s cooldown

      const encodedId = encodeShopifyVariantId(variantId);

      const query = `{
        productVariant(id: "${encodedId}") {
          id
          title
          createdAt
          price
          compareAtPrice
          product { createdAt }
          espressoMeta: metafields(namespace: "espresso", first: 10) {
            edges { node { key value } }
          }
          customMeta: metafields(namespace: "custom", first: 10) {
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

      const text = await response.text();
      let result;

      try {
        result = JSON.parse(text);
      } catch (err) {
        console.error(`❌ Failed to parse response for ${variantId}:`, err.message);
        console.error("Raw response:", text);
        continue;
      }

      if (result.errors) {
        console.warn(`⚠️ Shopify returned GraphQL errors for ${variantId}:`, result.errors);
        continue;
      }

      const variant = result?.data?.productVariant;
      if (!variant) {
        console.warn(`⚠️ Variant not found in response for ${variantId}`);
        continue;
      }

      const createdAt = new Date(variant.createdAt);
      const productCreated = new Date(variant.product.createdAt);
      const price = parseFloat(variant.price);
      const compareAt = parseFloat(variant.compareAtPrice || "0");

      const espressoMeta = {};
      const customMeta = {};
      variant.espressoMeta.edges.forEach((edge) => {
        espressoMeta[edge.node.key] = edge.node.value;
      });
      variant.customMeta.edges.forEach((edge) => {
        customMeta[edge.node.key] = edge.node.value;
      });

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

      // 🔐 Prevent loops: skip if value is unchanged or empty
      console.log(`📋 Variant ${variantId} — current tag: "${currentTag}", new tag: "${newTag}"`);
      if (newTag === currentTag) {
        console.log(`✅ ${variantId} already tagged as "${newTag}" – skipping write`);
        continue;
      }

      if (newTag === "None" && !currentTag) {
        console.log(`✅ ${variantId} has no tag and doesn't need one – skipping write`);
        continue;
      }

      const mutation = `
        mutation {
          metafieldsSet(metafields: [{
            ownerId: "${encodedId}",
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

// Optional debug route stays here
app.get("/debug-variant/:id", async (req, res) => {
  try {
    const variantId = req.params.id;
    const encodedId = Buffer.from(`gid://shopify/ProductVariant/${variantId}`).toString("base64");

    const query = `{
      productVariant(id: "${encodedId}") {
        id
        title
        createdAt
        price
        compareAtPrice
        product { title createdAt }
        espressoMeta: metafields(namespace: "espresso", first: 10) {
          edges { node { key value } }
        }
        customMeta: metafields(namespace: "custom", first: 10) {
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

    const text = await response.text();
    let result;

    try {
      result = JSON.parse(text);
    } catch {
      return res.status(500).json({
        error: "Invalid JSON response from Shopify",
        raw: text,
      });
    }

    res.json({ success: true, variantId, result });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Variant tagging server running on port ${PORT}`);
});
