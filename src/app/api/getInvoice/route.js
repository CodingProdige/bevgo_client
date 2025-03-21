import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET(req) {
  try {
    // Extract orderNumber from the query string
    const { searchParams } = new URL(req.url);
    const orderNumber = searchParams.get("orderNumber");

    if (!orderNumber) {
      return NextResponse.json(
        { error: "Missing orderNumber parameter" },
        { status: 400 }
      );
    }

    console.log(`📌 Fetching invoice for Order Number: ${orderNumber}`);

    // Fetch the invoice document from Firestore
    const invoiceRef = doc(db, "invoices", orderNumber);
    const invoiceSnap = await getDoc(invoiceRef);

    if (!invoiceSnap.exists()) {
      return NextResponse.json(
        { error: "Invoice not found" },
        { status: 404 }
      );
    }

    const invoiceData = invoiceSnap.data();
    console.log("✅ Invoice data retrieved successfully.");

    return NextResponse.json({
      message: "Invoice retrieved successfully",
      invoiceData,
    });
  } catch (error) {
    console.error("❌ Failed to retrieve invoice:", error.message);
    return NextResponse.json(
      { error: "Failed to retrieve invoice", details: error.message },
      { status: 500 }
    );
  }
}
