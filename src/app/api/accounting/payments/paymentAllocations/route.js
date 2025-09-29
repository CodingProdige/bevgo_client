import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

/**
 * GET - Fetch allocations for a paymentId
 * Example: /api/accounting/payments/paymentAllocations?paymentId=123
 */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const paymentId = searchParams.get("paymentId");

    if (!paymentId) {
      return NextResponse.json(
        { error: "paymentId is required" },
        { status: 400 }
      );
    }

    const allocRef = collection(db, "allocations");
    const allocSnap = await getDocs(allocRef);

    const appliedTo = [];

    for (const allocDoc of allocSnap.docs) {
      const alloc = allocDoc.data();

      // Find this payment inside the fromPayments array
      const matchedPayment = (alloc.fromPayments || []).find(
        (fp) => fp.paymentId === paymentId
      );
      if (!matchedPayment) continue;

      // 🔎 Fetch invoice metadata
      let invoiceDate = null;
      let invoicePDFURL = null;
      let invoiceTotal = null;
      if (alloc.invoiceId) {
        const invoiceRef = doc(db, "invoices", alloc.invoiceId);
        const invoiceSnap = await getDoc(invoiceRef);
        if (invoiceSnap.exists()) {
          const inv = invoiceSnap.data();
          invoiceDate = inv.invoiceDate || null;
          invoicePDFURL = inv.invoicePDFURL || null;
          invoiceTotal = inv.finalTotals?.finalTotal || null;
        }
      }

      appliedTo.push({
        invoiceId: alloc.invoiceId,
        companyCode: alloc.companyCode,
        amount: matchedPayment.amount,
        date: alloc.date,
        status: alloc.status,
        createdBy: alloc.createdBy,
        allocationId: allocDoc.id,
        invoiceDate,
        invoicePDFURL,
        invoiceTotal, // ✅ optional enrichment
      });
    }

    return NextResponse.json({
      message: "Allocations retrieved successfully",
      appliedTo,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to fetch allocations" },
      { status: 500 }
    );
  }
}
