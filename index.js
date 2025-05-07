import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Webhook handler for product update (e.g. variant added or price changed)
app.post("/webhook/product-update", express.raw({ type: "application/json" }), async (req, res) => {
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
    const productId = payload.id;

    console.log("🔔 Webhook triggered for product update:", productId);

    // Get all variant IDs for the product
    const query = `
      {
        product(id: "gid://shopify/Product/${productId}") {
          variants(first: 100) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    `;

    const variantRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query })
    });

    const variantData = await variantRes.json();
    const variantEdges = variantData.data?.product?.variants?.edges || [];
    const variantIds = variantEdges.map(edge => edge.node.id);

    if (variantIds.length === 0) {
      console.log("⚠️ No variants found for product", productId);
      return res.status(200).send("No variants to process");
    }

    await fetch("http://localhost:3000/tag-variants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant_ids: variantIds })
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(500).send("Error");
  }
});

// Register the webhook for product updates
const registerWebhook = async () => {
  const webhookUrl = "https://shopify-variant-tagger.onrender.com/webhook/product-update";

  const query = `
    mutation {
      webhookSubscriptionCreate(
        topic: PRODUCTS_UPDATE,
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
