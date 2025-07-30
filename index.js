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

// 🧠 Helper: query Shopify Admin API
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

// ─── AUTO-RECONCILE WEBHOOK ─────────────────────────────────────────────────────
// Ensures exactly one products/update → ${BASE_URL}/webhook exists.
async function reconcileWebhook() {
  try {
    // 1) List existing
    const listRes = await shopifyRequest("/webhooks.json?limit=250");
    const listData = await listRes.json();
    const existing = (listData.webhooks || []).filter(
      (w) =>
        w.topic === "products/update" &&
        w.address === `${BASE_URL}/webhook`
    );

    // 2) Delete any duplicates beyond one
    if (existing.length > 1) {
      for (let i = 1; i < existing.length; i++) {
        await shopifyRequest(`/webhooks/${existing[i].id}.json`, {
          method: "DELETE",
        });
        console.log(`🗑️ Deleted duplicate webhook #${existing[i].id}`);
      }
    }

    // 3) Create if none exist
    if (existing.length === 0) {
      const createRes = await shopifyRequest("/webhooks.json", {
        method: "POST",
        body: JSON.stringify({
          webhook: {
            topic: "products/update",
            address: `${BASE_URL}/webhook`,
            format: "json",
          },
        }),
      });
      const createData = await createRes.json();
      if (createRes.ok) {
        console.log("✅ Webhook created:", createData.webhook.id);
      } else {
        console.warn("⚠️ Failed to create webhook:", createData.errors || createData);
      }
    } else {
      console.log("✅ Webhook already registered:", existing[0].id);
    }
  } catch (err) {
    console.error("❌ Webhook reconcile error:", err.message);
  }
}

// ─── WEBHOOK HANDLER (RAW + HMAC) ───────────────────────────────────────────────
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
    } catch (err) {
      console.error("❌ Payload parsing failed", err);
      return res.status(400).send("Invalid payload");
    }

    const variantIds = (payload.variants || []).map((v) => v.id.toString());
    console.log("📦 Webhook received:", variantIds);

    await fetch(`${BASE_URL}/tag-variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant_ids: variantIds }),
    });

    res.status(200).send("OK");
  }
);
app.use("/webhook", webhookRouter);
app.use(express.json({ limit: "5mb" })); // everything else

// ─── VARIANT-TAGGING LOGIC (UNCHANGED) ─────────────────────────────────────────
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
      if (recentlyTagged.has(id)) {
        console.log(`⏳ Skipping ${id} – cooldown`);
        continue;
      }
      recentlyTagged.add(id);
      setTimeout(() => recentlyTagged.delete(id), 30_000);

      const gid = encodeShopifyVariantId(id);
      const q = `{
        productVariant(id:"${gid}") {
          createdAt price compareAtPrice product{createdAt}
          espressoMeta:metafields(namespace:"espresso",first:10){edges{node{key value}}}
          customMeta:metafields(namespace:"custom",first:10){edges{node{key value}}}
        }
      }`;
      const resp = await shopifyRequest("/graphql.json", {
        method: "POST",
        body: JSON.stringify({ query: q }),
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { console.error("❌ Bad JSON", text); continue; }
      if (data.errors) { console.warn("⚠️ GQL errors", data.errors); continue; }
      const v = data.data.productVariant;
      if (!v) { console.warn("⚠️ No variant", id); continue; }

      const createdAt = new Date(v.createdAt).getTime();
      const prodCreated = new Date(v.product.createdAt).getTime();
      const price = parseFloat(v.price);
      const cmp   = parseFloat(v.compareAtPrice||"0");
      const esm   = Object.fromEntries(v.espressoMeta.edges.map(e=>[e.node.key,e.node.value]));
      const csm   = Object.fromEntries(v.customMeta.edges.map(e=>[e.node.key,e.node.value]));

      const isBest = esm.best_selling_30_days==="true";
      const curTag = (csm.tag||"").trim().toLowerCase();

      let newTag = "none";
      if (createdAt>prodCreated && now-createdAt<ms45d) newTag="new";
      else if (cmp>price) newTag="offer";
      else if (isBest) newTag="hot";

      if (newTag===curTag || (newTag==="none" && !curTag)) {
        console.log(`✅ ${id} no change (${curTag})`);
        continue;
      }

      const m = `
        mutation {
          metafieldsSet(metafields:[{
            ownerId:"${gid}",
            namespace:"custom",key:"tag",
            type:"single_line_text_field",value:"${newTag}"
          }]) { userErrors{field message} }
        }`;
      await shopifyRequest("/graphql.json", {
        method: "POST",
        body: JSON.stringify({ query: m }),
      });
      console.log(`🏷️ Tagged ${id} as "${newTag}"`);
      await delay(1000);

    } catch (err) {
      console.error(`❌ Error on ${id}:`, err.message);
    }
  }

  res.json({ status:"done", processed:variant_ids.length });
});

// ─── DEBUG ROUTE (optional) ───────────────────────────────────────────────────
app.get("/debug-variant/:id", async (req, res) => {
  const id = req.params.id;
  const gid = encodeShopifyVariantId(id);
  const q = `{
    productVariant(id:"${gid}") {
      title createdAt price compareAtPrice
      espressoMeta:metafields(namespace:"espresso",first:10){edges{node{key value}}}
      customMeta:metafields(namespace:"custom",first:10){edges{node{key value}}}
    }
  }`;
  const resp = await shopifyRequest("/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: q }),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { return res.status(500).send(text); }
  res.json({ success:true, id, data });
});

// ─── START + RECONCILE ─────────────────────────────────────────────────────────
const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
  reconcileWebhook();
});
