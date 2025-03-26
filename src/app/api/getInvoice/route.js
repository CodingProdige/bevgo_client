import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where, orderBy, startAt, endAt } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode, orderNumber, dateRange, paymentStatus } = await req.json();

    if (!companyCode) {
      return NextResponse.json(
        { error: "Missing companyCode parameter" },
        { status: 400 }
      );
    }

    console.log(`📌 Fetching invoices for company code: ${companyCode}`);

    // Initialize query with the required companyCode filter
    let invoicesRef = collection(db, "invoices");
    let q = query(invoicesRef, where("companyCode", "==", companyCode));

    // Apply optional filters
    if (orderNumber) {
      q = query(q, where("orderNumber", "==", orderNumber));
      console.log(`🔍 Filtered by order number: ${orderNumber}`);
    }

    if (paymentStatus) {
      q = query(q, where("payment_status", "==", paymentStatus));
      console.log(`🔍 Filtered by payment status: ${paymentStatus}`);
    }

    if (dateRange && dateRange.from && dateRange.to) {
      const fromDate = new Date(dateRange.from).toISOString();
      const toDate = new Date(dateRange.to).toISOString();
      q = query(q, orderBy("invoiceDate"), startAt(fromDate), endAt(toDate));
      console.log(`📅 Filtered by date range: ${fromDate} to ${toDate}`);
    }

    // Execute the query
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return NextResponse.json({ message: "No invoices found", invoices: [] }, { status: 200 });
    }

    // Construct the response with entire invoice document
    const invoices = snapshot.docs.map((doc) => doc.data());

    console.log(`✅ Fetched ${invoices.length} invoices successfully.`);

    return NextResponse.json(
      { message: "Invoices retrieved successfully", invoices },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Failed to retrieve invoices:", error.message);
    return NextResponse.json(
      { error: "Failed to retrieve invoices", details: error.message },
      { status: 500 }
    );
  }
}
