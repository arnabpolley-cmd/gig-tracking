export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const order = req.body;
  const gigToken = process.env.GIG_ACCESS_TOKEN;
  const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;
  const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
  const shopDomain = 's6bcd1-ar.myshopify.com';

  try {
    const countryMap = { "NG": "Nigeria" };

    // --- STEP 1: SENDER GEOLOCATION (Shopify Admin Location) ---
    const locRes = await fetch(`https://${shopDomain}/admin/api/2026-01/locations.json`, {
      headers: { "X-Shopify-Access-Token": adminToken }
    });
    const locData = await locRes.json();
    const primaryLoc = locData.locations?.find(l => l.active) || locData.locations?.[0];

    if (!primaryLoc) throw new Error("No Shopify locations found.");

    const cleanSAddress1 = primaryLoc.address1?.replace(/^,\s*|\s*,\s*$/g, '').replace(/,\s*,\s*/g, ', ');
    const sAddrStr = [cleanSAddress1, primaryLoc.address2, primaryLoc.city, primaryLoc.province, primaryLoc.zip, primaryLoc.country_name]
      .filter(p => p && p.trim() !== "").join(", ");

    const sGeoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(sAddrStr)}&key=${googleApiKey}`);
    const sGeoData = await sGeoRes.json();
    const senderFound = sGeoData.results && sGeoData.results.length > 0;

    // --- STEP 2: RECEIVER GEOLOCATION (Customer Address) ---
    const dest = order.shipping_address;
    const rCountry = countryMap[dest.country_code] || dest.country;
    const rAddrStr = [dest.address1, dest.address2, dest.city, dest.province, dest.zip, rCountry]
      .filter(p => p && p.trim() !== "").join(", ");

    const rGeoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(rAddrStr)}&key=${googleApiKey}`);
    const rGeoData = await rGeoRes.json();
    const receiverFound = rGeoData.results && rGeoData.results.length > 0;

    // Validation Check
    if (!senderFound || !receiverFound) {
      console.error(`Geocoding failed. Sender:${senderFound}, Receiver:${receiverFound}`);
      return res.status(400).json({ error: "Could not verify addresses via Google Maps." });
    }

    const sCoords = sGeoData.results[0].geometry.location;
    const rCoords = rGeoData.results[0].geometry.location;

    // --- STEP 3: PREPARE FULFILLMENT ORDER ---
    const foRes = await fetch(`https://${shopDomain}/admin/api/2026-01/orders/${order.id}/fulfillment_orders.json`, {
      headers: { "X-Shopify-Access-Token": adminToken }
    });
    const { fulfillment_orders } = await foRes.json();
    const primaryFO = fulfillment_orders[0];

    // --- STEP 4: LOOP ITEMS & CAPTURE PRE-SHIPMENT ---
    const fulfillmentResults = [];

    for (const item of order.line_items) {
      console.log(`Creating GIG Waybill for: ${item.name}`);

      const gigRes = await fetch("https://dev-thirdpartynode.theagilitysystems.com/capture/preshipment", {
        method: "POST",
        headers: { "access-token": gigToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          "VehicleType": 1,
          "SenderName": primaryLoc.name || "Main Warehouse",
          "SenderPhoneNumber": primaryLoc.phone || "08012345678",
          "SenderEmail": "warehouse@yourstore.com",
          "SenderLocation": { "Latitude": sCoords.lat, "Longitude": sCoords.lng },
          "ReceiverName": `${dest.first_name} ${dest.last_name}`,
          "ReceiverPhoneNumber": dest.phone || order.phone || "08000000000",
          "ReceiverEmail": order.email,
          "ReceiverLocation": { "Latitude": rCoords.lat, "Longitude": rCoords.lng },
          "ShipmentItems": [{
            "ItemName": item.name,
            "Quantity": item.quantity,
            "Weight": (item.grams / 1000) || 0.5,
            "Value": parseFloat(item.price),
            "Description": item.title || item.name
          }]
        })
      });

      const gigData = await gigRes.json();
      const trackingNumber = gigData.data?.WaybillNumber;

      if (trackingNumber) {
        // --- STEP 5: PUSH TRACKING TO SHOPIFY ---
        await fetch(`https://${shopDomain}/admin/api/2026-01/fulfillments.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": adminToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            fulfillment: {
              line_items_by_fulfillment_order: [{
                fulfillment_order_id: primaryFO.id,
                fulfillment_order_line_items: [{
                  id: primaryFO.line_items.find(li => li.line_item_id === item.id).id,
                  quantity: item.quantity
                }]
              }],
              tracking_info: {
                number: trackingNumber,
                url: `https://giglogistics.com/track/mobileShipment?waybillNumber=${trackingNumber}`,
                company: "GIG Logistics"
              }
            }
          })
        });
        fulfillmentResults.push({ item: item.name, waybill: trackingNumber });
      }
    }

    return res.status(200).json({ success: true, fulfillments: fulfillmentResults });

  } catch (error) {
    console.error("Fulfillment Process Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}