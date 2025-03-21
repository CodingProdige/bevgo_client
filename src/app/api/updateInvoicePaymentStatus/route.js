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

    console.log(`📌 Updating invoice for Order Number: ${orderNumber}`);

    // Reference the invoice document in Firestore
    const invoiceRef = doc(db, "invoices", orderNumber);

    // Update the payment status
    await updateDoc(invoiceRef, { payment_status: paymentStatus });

    console.log("✅ Invoice payment status updated successfully.");

    return NextResponse.json(
      { message: "Invoice payment status updated successfully" },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Failed to update invoice:", error.message);
    return NextResponse.json(
      { error: "Failed to update invoice", details: error.message },
      { status: 500 }
    );
  }
}
