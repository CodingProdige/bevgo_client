export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  doc,
  getDocs,
  query,
  where,
  getDoc,
  writeBatch,
  updateDoc
} from "firebase/firestore";
import { NextResponse } from "next/server";

// Utility: calculate available credit
async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const q = query(paymentsRef, where("companyCode", "==", companyCode));
  const snap = await getDocs(q);

  let totalCredit = 0;
  let totalAllocated = 0;

  snap.forEach((doc) => {
    const p = doc.data();
    totalCredit += Number(p.amount || 0);
    totalAllocated += Number(p.allocated || 0);
  });

  return {
    totalCredit,
    totalAllocated,
    availableCredit: totalCredit - totalAllocated
  };
}

export async function POST(req) {
  try {
    const { orderNumber, reason = "Reversal", status = "Pending", reversedBy = "system" } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    // Fetch allocations for this invoice
    const allocSnap = await getDocs(
      query(collection(db, "allocations"), where("invoiceId", "==", orderNumber))
    );

    if (allocSnap.empty) {
      return NextResponse.json(
        { error: `No allocations found for invoice ${orderNumber}` },
        { status: 404 }
      );
    }

    const batch = writeBatch(db);
    let companyCode = null;
    let totalRestored = 0;

    for (const allocDoc of allocSnap.docs) {
      const allocation = allocDoc.data();
      companyCode = allocation.companyCode;
      totalRestored += allocation.amount;

      // Roll back each fromPayment
      for (const fp of allocation.fromPayments) {
        const paymentRef = doc(db, "payments", fp.paymentId);
        const paymentSnap = await getDoc(paymentRef);

        if (paymentSnap.exists()) {
          const payment = paymentSnap.data();
          batch.update(paymentRef, {
            allocated: (payment.allocated || 0) - fp.amount,
            unallocated: (payment.unallocated || 0) + fp.amount
          });
        }
      }

      // Mark allocation as reversed (soft delete)
      batch.update(allocDoc.ref, {
        status: "Reversed",
        reversedAt: new Date().toISOString(),
        reversedBy,
        reversalReason: reason
      });
    }

    // Revert invoice + order status
    const invoiceRef = doc(db, "invoices", orderNumber);
    const orderRef = doc(db, "orders", orderNumber);

    batch.update(invoiceRef, {
      payment_status: status, // "Pending" or "Bad Debt"
      date_settled: null
    });

    batch.update(orderRef, {
      payment_status: status,
      date_settled: null
    });

    await batch.commit();

    const updatedCredit = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: `Invoice ${orderNumber} reversed successfully`,
      orderNumber,
      amountRestored: totalRestored,
      newStatus: status,
      creditSummary: updatedCredit
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to reverse invoice payment" },
      { status: 500 }
    );
  }
}
