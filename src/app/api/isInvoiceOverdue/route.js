import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const invoiceId = url.searchParams.get("id");

    if (!invoiceId) {
      return NextResponse.json({ error: "Missing invoice ID" }, { status: 400 });
    }

    const snap = await getDoc(doc(db, "invoices", invoiceId));
    if (!snap.exists()) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const data = snap.data();
    const status = data.payment_status;
    const method = data.paymentMethod;
    const dueDate = new Date(data.dueDate);
    const today = new Date();

    let result = "Ignored";

    if (status === "Paid") {
      // ✅ Always trust Paid in Firestore
      result = "Paid";
    } else if (status === "Pending") {
      // ✅ Only calculate overdue logic for Pending
      if (method === "EFT") {
        result = dueDate < today ? "Overdue" : "Pending";
      } else {
        // For Cash, Card, Payfast, Yoco: trust Firestore Pending until settled manually
        result = "Pending";
      }
    }

    return NextResponse.json({ status: result });
  } catch (err) {
    console.error("❌ Error checking invoice status:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
