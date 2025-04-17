import { db } from "@/lib/firebaseConfig";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  startAt,
  endAt,
  doc,
  getDoc,
} from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode, orderNumber, dateRange, paymentStatus, isAdmin } = await req.json();

    // ✅ Fetch invoice by orderNumber if provided
    if (orderNumber) {
      const invoiceRef = doc(db, "invoices", orderNumber);
      const invoiceSnap = await getDoc(invoiceRef);

      if (!invoiceSnap.exists()) {
        return NextResponse.json(
          { message: `No invoice found with order number ${orderNumber}` },
          { status: 404 }
        );
      }

      console.log(`✅ Fetched invoice for order number: ${orderNumber}`);
      return NextResponse.json(
        { message: "Invoice retrieved successfully", invoices: [invoiceSnap.data()] },
        { status: 200 }
      );
    }

    // ✅ Build base query
    let invoicesRef = collection(db, "invoices");
    let q;

    if (isAdmin === true) {
      q = query(invoicesRef);
      console.log("🔐 Admin access: Fetching all invoices.");
    } else if (companyCode) {
      q = query(invoicesRef, where("customer.companyCode", "==", companyCode));
    } else {
      // No companyCode or isAdmin — return empty array with 200
      return NextResponse.json(
        { message: "No parameters provided, returning empty result.", invoices: [] },
        { status: 200 }
      );
    }

    // ✅ Apply optional filters
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

    // ✅ Execute query
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return NextResponse.json({ message: "No invoices found", invoices: [] }, { status: 200 });
    }

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
