import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const SHOPIFY_STORE = "uk-escentual.myshopify.com";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;

app.post("/tag-variants", async (req, res) => {
  console.log("🔔 Request received:", JSON.stringify(req.body, null, 2));
  const { product, variants } = req.body;

  const now = new Date();
  const msIn45Days = 45 * 24 * 60 * 60 * 1000;

  for (const variant of variants) {
    const createdAt = new Date(variant.created_at);
    const price = parseFloat(variant.price);
    const compareAt = parseFloat(variant.compare_at_price);
    const dailySold = parseInt(
      variant.metafields?.espresso?.daily_sold_quantity || "0",
      10
    );
    const productCreated = new Date(product.created_at);

    let tag = "";

    const isNew =
      createdAt > productCreated &&
      now - createdAt < msIn45Days;

    const isOffer = compareAt > price;

    const isHot = variant.metafields?.espresso?.best_selling_30_days === "true";

    if (isNew) {
      tag = "New";
    } else if (isOffer) {
      tag = "Offer";
    } else if (isHot) {
      tag = "Hot";
    } else {
      tag = ""; // Clear tag if none apply
    }

    console.log(`➡️ Updating variant ${variant.id} with tag: "${tag || '[cleared]'}"`);

    const mutation = `
      mutation {
        metafieldsSet(metafields: [{
          ownerId: "${variant.id}",
          namespace: "custom",
          key: "tag",
          type: "single_line_text_field",
          value: "${tag}"
        }]) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    console.log("📦 Sending Shopify mutation...");
    console.log(mutation);

    try {
      const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_API_TOKEN,
        },
        body: JSON.stringify({ query: mutation }),
      });

      const result = await response.json();
      console.log("🛠 Shopify response:", JSON.stringify(result, null, 2));

      if (result.errors) {
        console.error("❌ Top-level GraphQL errors:", result.errors);
      }

      const userErrors = result.data?.metafieldsSet?.userErrors || [];
      if (userErrors.length > 0) {
        console.warn("⚠️ User Errors:", userErrors);
      }

    } catch (err) {
      console.error(`❌ Failed to update variant ${variant.id}:`, err.message);
    }
  }

  res.json({ status: "done" });
});

app.listen(3000, () => {
  console.log("🔥 Variant tagger running at http://localhost:3000");
});