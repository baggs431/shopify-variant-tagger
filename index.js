import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";

const app = express();

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Increase payload limit for general routes
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Webhook: Product update (captures variant changes)
app.post("/webhook/product-update", bodyParser.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const rawBody = req.body.toString("utf8");

    const computedHmac = crypto
      .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody, "utf8")
      .digest("base64");

    if (computedHmac !== hmacHeader) {
      console.warn("⚠️ Webhook HMAC validation failed");
      return res.status(401).send("Unauthorized");
    }

    const payload = JSON.parse(rawBody);
    const variantIds = payload.variants.map(v => v.admin_graphql_api_id);

    console.log("🔔 Webhook triggered for product update:", payload.id);
    console.log("📦 Variant IDs:", variantIds);

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

// Webhook registration (on startup)
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
