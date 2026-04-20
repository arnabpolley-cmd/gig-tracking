export default async function handler(req, res) {
  // 1. Verify Method (Usually a POST from Shopify Webhooks)
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const order = req.body;
  const gigToken = process.env.GIG_ACCESS_TOKEN;
  const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;
  const shopDomain = 's6bcd1-ar.myshopify.com';

  try {
    console.log(`Processing tracking for Order: ${order.name}`);

    // --- STEP 1: PREPARE DATA FOR GIG SHIPMENT CREATION ---
    // Note: GIG's 'Create Shipment' endpoint is usually different from the 'Price' endpoint
    const gigShipmentPayload = {
      "SenderName": "Oshodi Warehouse",
      "SenderAddress": "Your Warehouse Address", // Ideally fetched from locations like your rate code
      "ReceiverName": `${order.shipping_address.first_name} ${order.shipping_address.last_name}`,
      "ReceiverAddress": `${order.shipping_address.address1}, ${order.shipping_address.city}`,
      "ReceiverPhoneNumber": order.shipping_address.phone || order.phone,
      "ReceiverEmail": order.email,
      "VehicleType": 1,
      "ShipmentItems": order.line_items.map(item => ({
        "ItemName": item.name,
        "Quantity": item.quantity,
        "Weight": (item.grams / 1000) || 0.5,
        "Value": item.price
      }))
    };

    // --- STEP 2: CALL GIG LOGISTICS TO CREATE SHIPMENT ---
    const gigRes = await fetch("https://dev-thirdpartynode.theagilitysystems.com/shipment/v3/create", {
      method: "POST",
      headers: { 
        "access-token": gigToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(gigShipmentPayload)
    });

    const gigData = await gigRes.json();
    const trackingNumber = gigData.data?.WaybillNumber;

    if (!trackingNumber) {
      throw new Error("GIG Logistics did not return a tracking number.");
    }

    // --- STEP 3: ASSIGN TRACKING TO SHOPIFY ---
    // First, we need the Fulfillment Order ID (Shopify API 2023+ requirement)
    const fulfillmentOrderRes = await fetch(
      `https://${shopDomain}/admin/api/2026-01/orders/${order.id}/fulfillment_orders.json`,
      { headers: { "X-Shopify-Access-Token": adminToken } }
    );
    const foData = await fulfillmentOrderRes.json();
    const fulfillmentOrderId = foData.fulfillment_orders[0].id;

    // Create the fulfillment
    const fulfillRes = await fetch(
      `https://${shopDomain}/admin/api/2026-01/fulfillments.json`,
      {
        method: "POST",
        headers: { 
          "X-Shopify-Access-Token": adminToken,
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          fulfillment: {
            line_items_by_fulfillment_order: [
              {
                fulfillment_order_id: fulfillmentOrderId,
                fulfillment_order_line_items: [] // Leaving empty fulfills all items
              }
            ],
            tracking_info: {
              number: trackingNumber,
              url: `https://giglogistics.com/track-shipment/?waybill=${trackingNumber}`,
              company: "GIG Logistics"
            },
            notify_customer: true
          }
        })
      }
    );

    const fulfillStatus = await fulfillRes.json();
    
    return res.status(200).json({ 
      success: true, 
      tracking: trackingNumber,
      shopify_status: fulfillRes.status 
    });

  } catch (error) {
    console.error("Fulfillment Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}