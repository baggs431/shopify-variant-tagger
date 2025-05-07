import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Middleware for normal JSON (for /tag-variants)
app.use(express.json({ limit: "5mb" }));

// Middleware to grab raw body for /webhook route
app.use(
  "/webhook",
  bodyParser.raw({ type: "application/json", limit: "5mb" })
);

function verifyHmac(rawBody, hmacHeader) {
  const hmac = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hmacHeader));
}

app.post("/webhook", async (req, res) => {
  const rawBody = req.body;
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  if (!verifyHmac(rawBody, hmacHeader)) {
    console.warn("⚠️ Webhook HMAC validation failed");
    return res.status(401).send("HMAC validation failed");
  }

  const payload = JSON.parse(rawBody.toString("utf8"));
  console.log("✅ Webhook payload received:", JSON.stringify(payload, null, 2));

  // Example: extract variant IDs
  const variantIds = payload.variants?.map((v) => v.admin_graphql_api_id).filter(Boolean) || [];

  if (variantIds.length === 0) {
    console.log("ℹ️ No variants to tag in webhook payload.");
    return res.sendStatus(200);
  }

  // Forward to tag-variants endpoint
  try {
    const response = await fetch(`http://localhost:${PORT}/tag-variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant_ids: variantIds }),
    });

    const result = await response.json();
    console.log("🎯 Tagging result:", result);
  } catch (err) {
    console.error("❌ Failed to forward to tag-variants:", err.message);
  }

  res.sendStatus(200);
});

// Dummy /tag-variants for demo (replace with your real logic)
app.post("/tag-variants", async (req, res) => {
  const { variant_ids } = req.body;
  console.log("📦 Tagging requested for:", variant_ids);

  // You would fetch details and run tagging logic here...

  res.json({ status: "done", processed: variant_ids.length });
});

app.listen(PORT, () => {
  console.log(`🔥 Variant tagger running at http://localhost:${PORT}`);
});
