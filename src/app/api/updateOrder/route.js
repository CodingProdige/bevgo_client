import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { doc, updateDoc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const UPDATE_STOCK_API_URL = "https://bevgo-pricelist.vercel.app/updateProductStock";

// 🔧 Helper: Send Slack alert
async function sendSlackAlert(message) {
  try {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    console.error("⚠️ Failed to send Slack alert:", err.message);
  }
}

export async function POST(req) {
  try {
    const { orderNumber, field, fieldData } = await req.json();

    // ✅ Validate required parameters
    if (!orderNumber || !field || fieldData === undefined) {
      return NextResponse.json({ error: "Missing orderNumber, field, or fieldData" }, { status: 400 });
    }

    // ✅ Reference the order document in Firestore
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    // ✅ Check if order exists
    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // ✅ Update the specified field
    await updateDoc(orderRef, {
      [field]: fieldData
    });

    console.log(`✅ Updated order ${orderNumber}: ${field} = ${fieldData}`);

    // 🔧 If cancelling the order, restore stock
    if (field === "order_canceled" && fieldData === true) {
      const orderData = orderSnap.data();
      const items = orderData?.order_details?.items || [];

      if (items.length > 0) {
        try {
          const stockUpdateRes = await fetch(UPDATE_STOCK_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: items.map(item => ({
                unique_code: item.unique_code,
                quantity: -Math.abs(item.quantity), // negative = put back
              })),
            }),
          });

          if (!stockUpdateRes.ok) {
            const errorText = await stockUpdateRes.text();
            console.error("⚠️ Stock restore failed:", stockUpdateRes.status, errorText);
            await sendSlackAlert(
              `⚠️ Stock restore failed for cancelled order #${orderNumber}\nStatus: ${stockUpdateRes.status}\nError: ${errorText}`
            );
          } else {
            const stockUpdateData = await stockUpdateRes.json();
            console.log("📦 Stock restored:", stockUpdateData);
          }
        } catch (err) {
          console.error("⚠️ Failed to call stock restore API:", err.message);
          await sendSlackAlert(
            `⚠️ Stock restore API call failed for cancelled order #${orderNumber}\nError: ${err.message}`
          );
        }
      }
    }

    return NextResponse.json(
      { 
        message: `Order ${orderNumber} updated successfully`, 
        updatedField: field, 
        newValue: fieldData 
      }, 
      { status: 200 }
    );

  } catch (error) {
    console.error("❌ Error updating order:", error);
    return NextResponse.json({ error: "Something went wrong", details: error.message }, { status: 500 });
  }
}
