import { db } from "@/lib/firebaseConfig";
import { doc, updateDoc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const UPDATE_STOCK_API_URL = "https://bevgo-pricelist.vercel.app/updateProductStock";
const USE_CREDIT_API_URL = "https://bevgo-client.vercel.app/api/accounting/payments/useCredit";

// 🔧 Helper: Slack alert
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
    const { orderNumber, data } = await req.json();

    if (!orderNumber || !data || typeof data !== "object") {
      return NextResponse.json(
        { error: "Missing or invalid parameters" },
        { status: 400 }
      );
    }

    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);
    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const orderData = orderSnap.data();

    // ✅ Update the order fields
    await updateDoc(orderRef, data);
    console.log(`✅ Updated order ${orderNumber} with data:`, data);

    // 🧾 Trigger cancellation cleanup ONLY if order_status === "Canceled"
    const isCanceled =
      data.order_status &&
      typeof data.order_status === "string" &&
      data.order_status.trim().toLowerCase() === "canceled";

    if (isCanceled) {
      console.log(`🚫 Order ${orderNumber} marked as CANCELED — performing cleanup.`);

      const companyCode = orderData.companyCode;
      const orderItems =
        orderData?.order_details?.items ||
        orderData?.order_details?.cartDetails ||
        [];

      // ♻️ Reverse any credit allocations
      if (companyCode) {
        try {
          const reverseRes = await fetch(
            `${USE_CREDIT_API_URL}?companyCode=${companyCode}&orderNumber=${orderNumber}`,
            { method: "DELETE" }
          );

          if (reverseRes.ok) {
            const reversedData = await reverseRes.json();
            console.log("♻️ Credit reversed successfully:", reversedData);
          } else {
            const errorText = await reverseRes.text();
            console.error("⚠️ Credit reversal failed:", reverseRes.status, errorText);
            await sendSlackAlert(
              `⚠️ Credit reversal failed for canceled order #${orderNumber}\nStatus: ${reverseRes.status}\nError: ${errorText}`
            );
          }
        } catch (err) {
          console.error("⚠️ Failed to call useCredit DELETE API:", err.message);
          await sendSlackAlert(
            `⚠️ useCredit DELETE API call failed for order #${orderNumber}\nError: ${err.message}`
          );
        }
      }

      // 📦 Restore stock for all items
      if (orderItems.length > 0) {
        try {
          const stockUpdateRes = await fetch(UPDATE_STOCK_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: orderItems.map((item) => ({
                unique_code: item.unique_code,
                quantity: -Math.abs(item.quantity), // negative = return stock
              })),
            }),
          });

          if (!stockUpdateRes.ok) {
            const errorText = await stockUpdateRes.text();
            console.error("⚠️ Stock restore failed:", stockUpdateRes.status, errorText);
            await sendSlackAlert(
              `⚠️ Stock restore failed for canceled order #${orderNumber}\nStatus: ${stockUpdateRes.status}\nError: ${errorText}`
            );
          } else {
            const stockUpdateData = await stockUpdateRes.json();
            console.log("📦 Stock restored successfully:", stockUpdateData);
          }
        } catch (err) {
          console.error("⚠️ Failed to call stock restore API:", err.message);
          await sendSlackAlert(
            `⚠️ Stock restore API call failed for canceled order #${orderNumber}\nError: ${err.message}`
          );
        }
      }
    }

    return NextResponse.json(
      {
        message: `Order ${orderNumber} updated successfully${
          isCanceled ? " and cancellation cleanup completed." : "."
        }`,
        updatedFields: data,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Error updating order:", error);
    return NextResponse.json(
      { error: "Something went wrong", details: error.message },
      { status: 500 }
    );
  }
}
