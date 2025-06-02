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
    let constraints = [];

    // 🔐 Admin with companyCode = filter by companyCode
    if (isAdmin && companyCode) {
      constraints.push(where("customer.companyCode", "==", companyCode));
      console.log(`🔐 Admin access: Filtering by companyCode: ${companyCode}`);
    }

    // 👤 Non-admin with companyCode = filter by companyCode
    else if (!isAdmin && companyCode) {
      constraints.push(where("customer.companyCode", "==", companyCode));
    }

    // 🔐 Admin with no companyCode = fetch all invoices (no constraints)
    else if (isAdmin && !companyCode) {
      console.log("🔐 Admin access: Fetching all invoices.");
    }

    // ❌ No valid criteria = return empty
    else {
      return NextResponse.json(
        { message: "No parameters provided, returning empty result.", invoices: [] },
        { status: 200 }
      );
    }

    // ✅ Apply date range if both from & to provided
    if (dateRange?.from && dateRange?.to) {
      const fromDate = new Date(dateRange.from).toISOString();
      const toDate = new Date(dateRange.to).toISOString();
      constraints.push(orderBy("invoiceDate"));
      constraints.push(startAt(fromDate));
      constraints.push(endAt(toDate));
      console.log(`📅 Filtered by date range: ${fromDate} to ${toDate}`);
    }

    // ❌ Avoid Firestore filter if Overdue
    if (paymentStatus && paymentStatus !== "Overdue") {
      constraints.push(where("payment_status", "==", paymentStatus));
      console.log(`🔍 Firestore filter: payment_status == ${paymentStatus}`);
    }

    // ✅ Execute query
    const q = constraints.length > 0 ? query(invoicesRef, ...constraints) : invoicesRef;
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return NextResponse.json({ message: "No invoices found", invoices: [] }, { status: 200 });
    }

    // ✅ Map results
    let invoices = snapshot.docs.map((doc) => doc.data());

    // ✅ Apply Overdue logic
    if (paymentStatus === "Overdue") {
      const now = new Date();
      let cutoffDate = now;

      if (dateRange?.to) {
        const parsedTo = new Date(dateRange.to);
        if (!isNaN(parsedTo)) {
          cutoffDate = parsedTo;
        }
      }

      invoices = invoices.filter((invoice) => {
        const status = (invoice.payment_status || "").toLowerCase();

        let due = null;

        if (typeof invoice.dueDate === "string") {
          const parts = invoice.dueDate.split("/");
          if (parts.length === 3) {
            const [m, d, y] = parts.map(Number);
            due = new Date(y, m - 1, d);
          } else {
            due = new Date(Date.parse(invoice.dueDate));
          }
        } else {
          due = new Date(invoice.dueDate);
        }

        const isValid = due instanceof Date && !isNaN(due);
        const isOverdue = isValid && due < cutoffDate && status !== "paid" && status !== "pending";

        // 🐞 Debug logs
        console.log(
          `📆 Due: ${isValid ? due.toISOString() : "Invalid"}, Status: ${status}, Overdue: ${isOverdue}`
        );

        return isOverdue;
      });

      console.log(`⚠️ Filtered overdue invoices before ${cutoffDate.toISOString()}, excluding Paid and Pending`);
    }

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
