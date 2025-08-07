import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
const SHOPIFY_STORE        = process.env.SHOPIFY_STORE        || "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN      = process.env.ADMIN_API_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const BASE_URL             = process.env.BASE_URL            || "http://localhost:3000";
const SHOPIFY_API_VERSION  = process.env.SHOPIFY_API_VERSION || "2025-01";
const delay                = (ms) => new Promise((res) => setTimeout(res, ms));

// Helper: call Shopify Admin API
async function shopifyRequest(path, opts) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  return fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_API_TOKEN,
    },
    ...opts,
  });
}

// Reconcile the products/update webhook so it never disappears
async function reconcileWebhook() {
  try {
    const res = await shopifyRequest("/webhooks.json?limit=250");
    const data = await res.json();
    // Filter for our exact webhook
    const matches = (data.webhooks || []).filter(
      w => w.topic === "products/update" && w.address === `${BASE_URL}/webhook`
    );

    // Delete duplicates
    if (matches.length > 1) {
      for (let i = 1; i < matches.length; i++) {
        await shopifyRequest(`/webhooks/${matches[i].id}.json`, { method: "DELETE" });
        console.log(`🗑️ Removed duplicate webhook ${matches[i].id}`);
      }
    }

    // Create if missing
    if (matches.length === 0) {
      const create = await shopifyRequest("/webhooks.json", {
        method: "POST",
        body: JSON.stringify({
          webhook: {
            topic: "products/update",
            address: `${BASE_URL}/webhook`,
            format: "json"
          }
        }),
      });
      const cdata = await create.json();
      console.log(create.ok ? `✅ Webhook created ${cdata.webhook.id}` : `⚠️ Failed to create webhook: ${JSON.stringify(cdata.errors)}`);
    } else {
      console.log(`✅ Webhook active: ${matches[0].id}`);
    }
  } catch (err) {
    console.error("❌ reconcileWebhook error:", err.message);
  }
}

// WEBHOOK HANDLER: express.json verify for raw body capture + HMAC validation
app.post(
  "/webhook",
  express.json({
    type: "application/json",
    limit: "5mb",
    verify: (req, res, buf) => { req.rawBody = buf; }
  }),
  async (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    const digest = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest("base64");
    if (digest !== hmacHeader) {
      console.warn("❌ Webhook HMAC validation failed");
      return res.status(401).send("Unauthorized");
    }
    const payload = req.body;
    const variant_ids = (payload.variants || []).map(v => v.id.toString());
    console.log("📦 Webhook payload variants:", variant_ids);
    await fetch(`${BASE_URL}/tag-variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant_ids })
    });
    res.status(200).send("OK");
  }
);

// JSON parser for other routes
app.use(express.json({ limit: "5mb" }));

// Variant-tagging logic with fixed skip condition and debug logging
function encodeShopifyVariantId(id) {
  return Buffer.from(`gid://shopify/ProductVariant/${id}`).toString("base64");
}
const recentlyTagged = new Set();
app.post("/tag-variants", async (req, res) => {
  const { variant_ids } = req.body;
  const now = Date.now();
  const ms45d = 45 * 24 * 60 * 60 * 1000;
  for (const id of variant_ids) {
    try {
      if (recentlyTagged.has(id)) { console.log(`⏳ Skipping ${id}`); continue; }
      recentlyTagged.add(id);
      setTimeout(() => recentlyTagged.delete(id), 30000);
      const gid = encodeShopifyVariantId(id);
      const query = `{ productVariant(id: "${gid}") { createdAt price compareAtPrice product { createdAt } espressoMeta: metafields(namespace: "espresso", first: 10) { edges { node { key value } } } customMeta: metafields(namespace: "custom", first: 10) { edges { node { key value } } } } }`;
      const resp = await shopifyRequest("/graphql.json", { method: "POST", body: JSON.stringify({ query }) });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { console.error("❌ GQL parse error"); continue; }
      if (data.errors) { console.warn("⚠️ GQL errors", data.errors); continue; }
      const v = data.data.productVariant;
      if (!v) { console.warn(`⚠️ No variant ${id}`); continue; }
      const createdAt = new Date(v.createdAt).getTime();
      const prodCreated = new Date(v.product.createdAt).getTime();
      const price = parseFloat(v.price), cmp = parseFloat(v.compareAtPrice || "0");
      const esm = Object.fromEntries(v.espressoMeta.edges.map(e => [e.node.key, e.node.value]));
      const csm = Object.fromEntries(v.customMeta.edges.map(e => [e.node.key, e.node.value]));
      const isBest = esm.best_selling_30_days === "true";
      const curTag = (csm.tag || "").trim().toLowerCase();
      let newTag = "none";
      if (createdAt > prodCreated && now - createdAt < ms45d) newTag = "new";
      else if (cmp > price) newTag = "offer";
      else if (isBest) newTag = "hot";

      // debug logging for comparison
      console.log(`🔍 ${id}: curTag="${curTag}", newTag="${newTag}"`);

      // only skip when the tag really hasn’t changed
      if (newTag === curTag) {
        console.log(`✅ ${id} unchanged`);
        continue;
      }

      const mutation = `mutation { metafieldsSet(metafields: [{ ownerId: "${gid}", namespace: "custom", key: "tag", type: "single_line_text_field", value: "${newTag}" }]) { userErrors { field message } } }`;
      await shopifyRequest("/graphql.json", { method: "POST", body: JSON.stringify({ query: mutation }) });
      console.log(`🏷️ Tagged ${id} as ${newTag}`);
      await delay(1000);
    } catch (err) {
      console.error(`❌ Error on ${id}:`, err.message);
    }
  }
  res.json({ status: "done", processed: variant_ids.length });
});

// Optional debug route
app.get("/debug-variant/:id", async (req, res) => {
  const id = req.params.id;
  const gid = encodeShopifyVariantId(id);
  const query = `{ productVariant(id: "${gid}") { title createdAt price compareAtPrice espressoMeta: metafields(namespace: "espresso", first: 10) { edges { node { key value } } } customMeta: metafields(namespace: "custom", first: 10) { edges { node { key value } } } } }`;
  const resp = await shopifyRequest("/graphql.json", { method: "POST", body: JSON.stringify({ query }) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { return res.status(500).send(text); }
  res.json({ success: true, id, data });
});

// Start server & reconcile webhook
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
  reconcileWebhook();
});
