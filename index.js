// 🔁 Tagging endpoint
app.post("/tag-variants", async (req, res) => {
  const { variant_ids } = req.body;
  console.log("📨 Tagging requested for:", variant_ids);

  const now = new Date();
  const msIn45Days = 45 * 24 * 60 * 60 * 1000;

  for (const variantId of variant_ids) {
    try {
      const query = `{
        productVariant(id: "${variantId}") {
          id
          createdAt
          price
          compareAtPrice
          product { createdAt }
          metafields(namespace: "custom", first: 10) {
            edges { node { key value } }
          }
          metafields(namespace: "espresso", first: 10) {
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

      const result = await response.json();

      // ✅ Debug logging for missing variant
      if (!result || !result.data || !result.data.productVariant) {
        console.warn("❗ No productVariant in response:", JSON.stringify(result, null, 2));
        continue;
      }

      const variant = result.data.productVariant;
      const createdAt = new Date(variant.createdAt);
      const productCreated = new Date(variant.product.createdAt);
      const price = parseFloat(variant.price);
      const compareAt = parseFloat(variant.compareAtPrice || "0");

      const meta = {};
      for (const edge of variant.metafields.edges) {
        meta[edge.node.key] = edge.node.value;
      }
      const espresso = {};
      for (const edge of variant.metafields.namespace === "espresso" ? variant.metafields.edges : []) {
        espresso[edge.node.key] = edge.node.value;
      }

      const isBestSeller = espresso.best_selling_30_days === "true";
      const currentTag = meta.tag || "";

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

      if (newTag === currentTag) {
        console.log(`✅ Skipped: ${variantId} already tagged as "${newTag}"`);
        continue;
      }

      console.log(`🎯 Updating tag for ${variantId} → "${newTag}"`);

      const mutation = `
        mutation {
          metafieldsSet(metafields: [{
            ownerId: "${variantId}",
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

      await delay(1000);
    } catch (err) {
      console.error(`❌ Error tagging ${variantId}:", err.message);
    }
  }

  res.json({ status: "done" });
});
