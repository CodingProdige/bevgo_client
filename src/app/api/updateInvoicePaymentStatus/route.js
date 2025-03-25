import { db } from "@/lib/firebaseConfig";
import { doc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { orderNumber, paymentStatus } = await req.json();

    if (!orderNumber || !paymentStatus) {
      return NextResponse.json(
        { error: "Missing orderNumber or paymentStatus parameter" },
        { status: 400 }
      );
    }

    console.log(`📌 Updating invoice and order for Order Number: ${orderNumber}`);

    // Get the current date and time
    const dateSettled = new Date().toISOString();

    // Reference the invoice and order documents in Firestore
    const invoiceRef = doc(db, "invoices", orderNumber);
    const orderRef = doc(db, "orders", orderNumber);

    // Update the payment status and date settled on both the invoice and order
    await updateDoc(invoiceRef, { 
      payment_status: paymentStatus,
      date_settled: dateSettled
    });

    await updateDoc(orderRef, { 
      payment_status: paymentStatus,
      date_settled: dateSettled
    });

    console.log("✅ Invoice and order payment status updated successfully with date settled.");

    return NextResponse.json(
      { message: "Invoice and order payment status updated successfully", date_settled: dateSettled },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Failed to update invoice and order:", error.message);
    return NextResponse.json(
      { error: "Failed to update invoice and order", details: error.message },
      { status: 500 }
    );
  }
}
