// app/api/deleteOrder/route.js
import { db } from "@/lib/firebaseConfig";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where
} from "firebase/firestore";
import { NextResponse } from "next/server";

const UPDATE_STOCK_API_URL = "https://bevgo-pricelist.vercel.app/updateProductStock";
const USE_CREDIT_API_URL = "https://bevgo-client.vercel.app/api/accounting/payments/useCredit";

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
    const { orderNumber, only, companyCode } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    // Determine which collections to delete from
    let collections = ["orders", "invoices", "deliveryNotes"];
    if (only === "invoice") {
      collections = ["invoices"];
    } else if (only === "deliveryNote") {
      collections = ["deliveryNotes"];
    }

    const deleted = [];
    let orderItems = [];

    for (const collectionName of collections) {
      const docRef = doc(db, collectionName, orderNumber);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        // Capture items before deletion (only if it's the "orders" collection)
        if (collectionName === "orders") {
          const orderData = docSnap.data();
          orderItems = orderData?.order_details?.items || [];
        }

        await deleteDoc(docRef);
        deleted.push(collectionName);
        console.log(`🗑️ Deleted ${collectionName}/${orderNumber}`);
      }
    }

    // 🗑️ Delete any linked rentals_v2
    const rentalsSnap = await getDocs(
      query(
        collection(db, "rentals_v2"),
        where("orderNumber", "==", orderNumber)
      )
    );
    for (const rental of rentalsSnap.docs) {
      await deleteDoc(rental.ref);
      console.log(`🗑️ Deleted rentals_v2/${rental.id}`);
    }

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: `No matching documents found for orderNumber ${orderNumber}.` },
        { status: 404 }
      );
    }

    // 🔧 Restore stock if we had items
    if (orderItems.length > 0) {
      try {
        const stockUpdateRes = await fetch(UPDATE_STOCK_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: orderItems.map(item => ({
              unique_code: item.unique_code,
              quantity: -Math.abs(item.quantity), // negative = put back
            })),
          }),
        });

        if (!stockUpdateRes.ok) {
          const errorText = await stockUpdateRes.text();
          console.error("⚠️ Stock restore failed:", stockUpdateRes.status, errorText);
          await sendSlackAlert(
            `⚠️ Stock restore failed for deleted order #${orderNumber}\nStatus: ${stockUpdateRes.status}\nError: ${errorText}`
          );
        } else {
          const stockUpdateData = await stockUpdateRes.json();
          console.log("📦 Stock restored:", stockUpdateData);
        }
      } catch (err) {
        console.error("⚠️ Failed to call stock restore API:", err.message);
        await sendSlackAlert(
          `⚠️ Stock restore API call failed for order #${orderNumber}\nError: ${err.message}`
        );
      }
    }

    // ♻️ Reverse credit allocations for this order
    try {
      const reverseRes = await fetch(
        `${USE_CREDIT_API_URL}?companyCode=${companyCode}&orderNumber=${orderNumber}`,
        { method: "DELETE" }
      );

      if (reverseRes.ok) {
        const reversedData = await reverseRes.json();
        console.log("♻️ Credit reversed:", reversedData);
      } else {
        const errorText = await reverseRes.text();
        console.error("⚠️ Credit reversal failed:", reverseRes.status, errorText);
        await sendSlackAlert(
          `⚠️ Credit reversal failed for order #${orderNumber}\nStatus: ${reverseRes.status}\nError: ${errorText}`
        );
      }
    } catch (err) {
      console.error("⚠️ Failed to call useCredit DELETE API:", err.message);
      await sendSlackAlert(
        `⚠️ useCredit DELETE API call failed for order #${orderNumber}\nError: ${err.message}`
      );
    }

    return NextResponse.json(
      { message: `Deleted from: ${deleted.join(", ")}`, deleted },
      { status: 200 }
    );

  } catch (error) {
    console.error("❌ Failed to delete documents:", error);
    return NextResponse.json(
      { error: "Failed to delete documents", details: error.message },
      { status: 500 }
    );
  }
}
