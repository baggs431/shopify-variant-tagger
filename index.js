import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";

const app = express();
const SHOPIFY_STORE        = process.env.SHOPIFY_STORE        || "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN      = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const BASE_URL             = process.env.BASE_URL            || "http://localhost:3000";
const SHOPIFY_API_VERSION  = process.env.SHOPIFY_API_VERSION || "2025-01";
const delay                = (ms) => new Promise((res) => setTimeout(res, ms));

// 🧠 Temporarily stores recently processed variant IDs
const recentlyTagged = new Set();

// ─── 1) AUTO-REGISTER WEBHOOK ─────────────────────────────────────────────────
async function registerWebhook() {
  try {
    const resp = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_API_TOKEN,
        },
        body: JSON.stringify({
          webhook: {
            topic: "products/update",
            address: `${BASE_URL}/webhook`,
            format: "json",
          },
        }),
      }
    );
    const data = await resp.json();
    if (resp.ok) {
      console.log("✅ Webhook registered:", data.webhook.id);
    } else {
      // “address has already been taken” is fine
      console.log("⚠️ Webhook register response:", data.errors || data);
    }
  } catch (err) {
    console.error("❌ Webhook registration error:", err.message);
  }
}

// ─── 2) WEBHOOK ROUTER (RAW BODY + HMAC) ──────────────────────────────────────
const webhookRouter = express.Router();

webhookRouter.post(
  "/",
  bodyParser.raw({ type: "application/json", limit: "5mb" }),
  async (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const digest = crypto
      .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(req.body)
      .digest("base64");

    if (digest !== hmacHeader) {
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
  }
);

app.use("/webhook", webhookRouter);

// ─── 3) JSON BODY PARSER FOR EVERYTHING ELSE ──────────────────────────────────
app.use(express.json({ limit: "5mb" }));

// ─── 4) VARIANT-TAGGING LOGIC ─────────────────────────────────────────────────
function encodeShopifyVariantId(id) {
  return Buffer.from(`gid://shopify/ProductVariant/${id}`).toString("base64");
}

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
      setTimeout(() => recentlyTagged.delete(variantId), 30000);

      const encodedId = encodeShopifyVariantId(variantId);
      const query = `{
        productVariant(id: "${encodedId}") {
          id title createdAt price compareAtPrice
          product { createdAt }
          espressoMeta: metafields(namespace: "espresso", first: 10) {
            edges { node { key value } }
          }
          customMeta: metafields(namespace: "custom", first: 10) {
            edges { node { key value } }
          }
        }
      }`;

      const response = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_API_TOKEN,
          },
          body: JSON.stringify({ query }),
        }
      );

      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        console.error(`❌ Parse failed for ${variantId}`, text);
        continue;
      }
      if (result.errors) {
        console.warn(`⚠️ GraphQL errors for ${variantId}`, result.errors);
        continue;
      }

      const v = result.data.productVariant;
      if (!v) {
        console.warn(`⚠️ Variant missing for ${variantId}`);
        continue;
      }

      const createdAt     = new Date(v.createdAt);
      const productCreated = new Date(v.product.createdAt);
      const price         = parseFloat(v.price);
      const compareAt     = parseFloat(v.compareAtPrice || "0");

      const espressoMeta = {};
      const customMeta   = {};
      v.espressoMeta.edges.forEach((e) => espressoMeta[e.node.key] = e.node.value);
      v.customMeta.edges.forEach((e)   => customMeta[e.node.key]   = e.node.value);

      const isBestSeller = espressoMeta.best_selling_30_days === "true";
      const currentTag   = (customMeta.tag || "").trim().toLowerCase();

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
      newTag = newTag.toLowerCase();

      console.log(`📋 ${variantId} — current: "${currentTag}", new: "${newTag}"`);
      if (newTag === currentTag || (newTag === "none" && !currentTag)) {
        console.log(`✅ No change for ${variantId}`);
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

      await fetch(
        `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_API_TOKEN,
          },
          body: JSON.stringify({ query: mutation }),
        }
      );

      console.log(`🏷️ Tagged ${variantId} as "${newTag}"`);
      await delay(1000);
    } catch (err) {
      console.error(`❌ Error on ${variantId}:`, err.message);
    }
  }

  res.json({ status: "done", processed: variant_ids.length });
});

// ─── 5) OPTIONAL DEBUG ROUTE ─────────────────────────────────────────────────
app.get("/debug-variant/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const encoded = Buffer.from(`gid://shopify/ProductVariant/${id}`).toString("base64");

    const query = `{
      productVariant(id: "${encoded}") {
        id title createdAt price compareAtPrice
        product { title createdAt }
        espressoMeta: metafields(namespace: "espresso", first: 10) {
          edges { node { key value } }
        }
        customMeta: metafields(namespace: "custom", first: 10) {
          edges { node { key value } }
        }
      }
    }`;

    const resp = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_API_TOKEN,
        },
        body: JSON.stringify({ query }),
      }
    );
    const text = await resp.text();
    let result;
    try { result = JSON.parse(text); } catch { return res.status(500).json({ error: text }); }
    res.json({ success: true, id, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 6) START SERVER + REGISTER WEBHOOK ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  registerWebhook();
});
