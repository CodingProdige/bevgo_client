import { db } from "@/lib/firebaseConfig";
import { doc, updateDoc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { orderNumber, totalCashReceived } = await req.json();

    if (!orderNumber || totalCashReceived === undefined) {
      return NextResponse.json({ error: "Missing orderNumber or totalCashReceived" }, { status: 400 });
    }

    console.log(`📌 Updating total_cash_received for Order Number: ${orderNumber}`);

    // Fetch the order document from Firestore
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Update the total_cash_received field in the order document
    await updateDoc(orderRef, {
      total_cash_received: parseFloat(totalCashReceived),
    });

    console.log(`✅ Order document updated successfully for Order Number: ${orderNumber}`);

    // Fetch the invoice document from Firestore
    const invoiceRef = doc(db, "invoices", orderNumber);
    const invoiceSnap = await getDoc(invoiceRef);

    if (!invoiceSnap.exists()) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    // Update the total_cash_received field in the invoice document
    await updateDoc(invoiceRef, {
      total_cash_received: parseFloat(totalCashReceived),
    });

    console.log(`✅ Invoice document updated successfully for Order Number: ${orderNumber}`);

    return NextResponse.json({ message: "Documents updated successfully" }, { status: 200 });
  } catch (error) {
    console.error("❌ Failed to update documents:", error.message);
    return NextResponse.json({ error: "Failed to update documents", details: error.message }, { status: 500 });
  }
}
