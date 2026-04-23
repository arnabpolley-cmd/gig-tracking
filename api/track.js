export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const order = req.body;
  const gigToken = process.env.GIG_ACCESS_TOKEN;
  const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;
  const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
  const shopDomain = 's6bcd1-ar.myshopify.com';

  try {
    console.log(`\n--- FULFILLING ORDER: ${order.name} ---`);
    const countryMap = { "NG": "Nigeria" };

    // --- STEP 1: SENDER GEOLOCATION ---
    const locRes = await fetch(`https://${shopDomain}/admin/api/2026-01/locations.json`, {
      headers: { "X-Shopify-Access-Token": adminToken }
    });
    const locData = await locRes.json();
    const primaryLoc = locData.locations?.find(l => l.active) || locData.locations?.[0];

    const cleanSAddress1 = primaryLoc.address1?.replace(/^,\s*|\s*,\s*$/g, '').replace(/,\s*,\s*/g, ', ');
    const sAddrStr = [cleanSAddress1, primaryLoc.address2, primaryLoc.city, primaryLoc.province, primaryLoc.zip, primaryLoc.country_name]
      .filter(p => p && p.trim() !== "").join(", ");

    const sGeoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(sAddrStr)}&key=${googleApiKey}`);
    const sGeoData = await sGeoRes.json();
    const sCoords = sGeoData.results[0].geometry.location;

    // --- STEP 2: RECEIVER GEOLOCATION ---
    const dest = order.shipping_address;
    const rCountry = countryMap[dest.country_code] || dest.country;
    const rAddrStr = [dest.address1, dest.address2, dest.city, dest.province, dest.zip, rCountry]
      .filter(p => p && p.trim() !== "").join(", ");

    const rGeoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(rAddrStr)}&key=${googleApiKey}`);
    const rGeoData = await rGeoRes.json();
    const rCoords = rGeoData.results[0].geometry.location;

    // --- STEP 3: FETCH FULFILLMENT ORDERS ---
    const foRes = await fetch(`https://${shopDomain}/admin/api/2026-01/orders/${order.id}/fulfillment_orders.json`, {
      headers: { "X-Shopify-Access-Token": adminToken }
    });
    const { fulfillment_orders } = await foRes.json();
    const primaryFO = fulfillment_orders[0];

    const fulfillmentResults = [];

    // --- STEP 4: LOOP ITEMS & CAPTURE ---
    for (const item of order.line_items) {
      console.log(`Processing Item: ${item.name}`);

      const gigRes = await fetch("https://dev-thirdpartynode.theagilitysystems.com/capture/preshipment", {
        method: "POST",
        headers: { 
          "access-token": gigToken, 
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          "SenderDetails": {
            "SenderName": primaryLoc.name || "Main Warehouse",
            "SenderPhoneNumber": (primaryLoc.phone || "08012345678").replace(/\s+/g, ''),
            "SenderAddress": sAddrStr,
            "InputtedSenderAddress": sAddrStr,
            "SenderLocality": primaryLoc.city || "Lagos",
            "SenderLocation": { 
              "Latitude": sCoords.lat, 
              "Longitude": sCoords.lng, 
              "FormattedAddress": "", "Name": "", "LGA": "" 
            }
          },
          "ReceiverDetails": {
            "ReceiverStationId": 0,
            "ReceiverName": `${dest.first_name} ${dest.last_name}`,
            "ReceiverPhoneNumber": (dest.phone || order.phone || "08000000000").replace(/\s+/g, ''),
            "ReceiverAddress": rAddrStr,
            "InputtedReceiverAddress": rAddrStr,
            "ReceiverLocation": { 
              "Latitude": rCoords.lat, 
              "Longitude": rCoords.lng, 
              "FormattedAddress": "", "Name": "", "LGA": "" 
            }
          },
          "ShipmentDetails": { 
            "VehicleType": 1, 
            "IsBatchPickUp": 0, 
            "IsFromAgility": 0 
          },
          "ShipmentItems": [{
            "ItemName": item.name,
            "Description": item.title || item.name,
            "ShipmentType": 1,
            "Quantity": item.quantity,
            "Weight": (item.grams / 1000) || 0.5,
            "IsVolumetric": false,
            "Length": 1, "Width": 1, "Height": 1,
            "Value": Math.round(parseFloat(item.price)),
            "SpecialPackageId": 0, "HaulageId": 0
          }]
        })
      });

      const responseJson = await gigRes.json();
      
      // Dig into the nested data object to find the Waybill
      const trackingNumber = responseJson.data?.data?.Waybill || responseJson.data?.Waybill;

      console.log(`>> SUCCESS | Item: ${item.name} | GIG Waybill: ${trackingNumber || "FAILED"}`);

      if (trackingNumber) {
        // --- STEP 5: PUSH TO SHOPIFY ---
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
              },
              notify_customer: true
            }
          })
        });
        fulfillmentResults.push({ item: item.name, waybill: trackingNumber });
      } else {
        console.error(`>> GIG ERROR for ${item.name}:`, JSON.stringify(responseJson));
      }
    }

    return res.status(200).json({ success: true, processed: fulfillmentResults });

  } catch (error) {
    console.error("SYSTEM ERROR:", error.message);
    return res.status(500).json({ error: error.message });
  }
}