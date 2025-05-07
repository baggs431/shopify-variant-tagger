import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Delay helper to throttle requests
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Webhook handler for new product variants
app.post("/webhook/product-variant-create", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const hmac = req.get("X-Shopify-Hmac-Sha256");
    const body = req.body.toString();

    const digest = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(body, "utf8")
      .digest("base64");

    if (digest !== hmac) {
      console.warn("⚠️ Webhook HMAC validation failed");
      return res.status(401).send("Unauthorized");
    }

    const payload = JSON.parse(body);
    const variantId = payload.id;

    console.log("🔔 Webhook triggered for variant:", variantId);

    await fetch("http://localhost:3000/tag-variants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant_ids: [`gid://shopify/ProductVariant/${variantId}`] })
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(500).send("Error");
  }
});

// Function to register webhook on app start
const registerWebhook = async () => {
  const webhookUrl = "https://shopify-variant-tagger.onrender.com/webhook/product-variant-create";

  const query = `
    mutation {
      webhookSubscriptionCreate(
        topic: PRODUCT_VARIANTS_CREATE,
        webhookSubscription: {
          callbackUrl: "${webhookUrl}",
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
    body: JSON.stringify({ query })
  });

  const result = await response.json();
  console.log("📦 Webhook registration result:", result);
};

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
  registerWebhook();
});
