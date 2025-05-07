import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";

const app = express();
const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ✅ Webhook BEFORE other body parsers
app.post("/webhook/product-update", bodyParser.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const rawBody = req.body;

    const computedHmac = crypto
      .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("base64");

    if (computedHmac !== hmacHeader) {
      console.warn("⚠️ Webhook HMAC validation failed");
      return res.status(401).send("Unauthorized");
    }

    const payload = JSON.parse(rawBody.toString("utf8"));
    console.log("📦 Product ID:", payload.id);
    console.log("🕵️ Product Updated At:", payload.updated_at);

    if (payload.variants && payload.variants.length > 0) {
      const variantSummary = payload.variants.map((v) => ({
        id: v.id,
        title: v.title,
        price: v.price,
        compare_at_price: v.compare_at_price,
        updated_at: v.updated_at,
      }));
      console.log("🔍 Variant Changes:", JSON.stringify(variantSummary, null, 2));
    }

    const allVariantsUnchanged = payload.variants.every(v => {
      const noChange = !v.price && !v.compare_at_price && !v.title;
      return noChange;
    });

    if (allVariantsUnchanged) {
      console.log("🔕 Skipping — No variant fields changed");
      return res.status(200).send("Ignored");
    }

    const variantIds = payload.variants.map(v => v.admin_graphql_api_id);

    await fetch("http://localhost:3000/tag-variants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant_ids: variantIds }),
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(500).send("Internal server error");
  }
});

// ✅ Use other middleware AFTER webhook
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Webhook registration
const registerWebhook = async () => {
  const query = `
    mutation {
      webhookSubscriptionCreate(
        topic: PRODUCTS_UPDATE,
        webhookSubscription: {
          callbackUrl: "https://shopify-variant-tagger.onrender.com/webhook/product-update",
          format: JSON
        }
      ) {
        webhookSubscription {
          id
        }
        userErrors {
          field
          message
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
  console.dir(result, { depth: null });
};

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
  registerWebhook();
});
