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
  deleteDoc,
  addDoc,
} from "firebase/firestore";
import { NextResponse } from "next/server";

// 🧮 Utility: calculate available credit (ignores deleted payments)
async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const q = query(paymentsRef, where("companyCode", "==", companyCode));
  const snap = await getDocs(q);

  let totalCredit = 0;
  let totalAllocated = 0;

  snap.forEach((doc) => {
    const p = doc.data();
    if (p.deleted) return; // 🚫 skip deleted
    totalCredit += Number(p.amount || 0);
    totalAllocated += Number(p.allocated || 0);
  });

  return {
    totalCredit,
    totalAllocated,
    availableCredit: totalCredit - totalAllocated,
  };
}

// 🧾 Utility: log accounting actions
async function logAccountingAction(action) {
  try {
    await addDoc(collection(db, "accountingLogs"), {
      ...action,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("⚠️ Failed to log accounting action:", err.message);
  }
}


/**
 * 🧾 REVERSE INVOICE ENDPOINT
 * -------------------------------------------------------------------
 * This endpoint fully reverses an invoice settlement:
 * - Restores credit back to linked payment documents
 * - Deletes all allocation documents for the invoice (hard delete)
 * - Resets invoice and order payment statuses
 * - Logs the reversal to accountingLogs
 *
 * -------------------------------------------------------------------
 * 🧩 SUPPORTED PAYLOADS
 *
 * 1️⃣ Basic reversal:
 *    → Reverses all allocations and marks invoice/order as Pending.
 *    {
 *      "orderNumber": "35584744"
 *    }
 *
 * 2️⃣ Custom reason:
 *    → Include a reason + user identifier for audit trail.
 *    {
 *      "orderNumber": "35584744",
 *      "reason": "Duplicate allocation detected during audit",
 *      "reversedBy": "Dillon"
 *    }
 *
 * 3️⃣ Bad debt write-off:
 *    → Restores allocations but flags invoice as Bad Debt.
 *    {
 *      "orderNumber": "35584744",
 *      "reason": "Customer non-payment — written off",
 *      "status": "Bad Debt",
 *      "reversedBy": "AccountsDept"
 *    }
 *
 * -------------------------------------------------------------------
 * 🧾 Example Successful Response:
 * {
 *   "message": "Invoice 35584744 reversed successfully",
 *   "orderNumber": "35584744",
 *   "amountRestored": 299,
 *   "newStatus": "Pending",
 *   "allocationsDeleted": 2,
 *   "creditSummary": {
 *     "totalCredit": 3000,
 *     "totalAllocated": 2100,
 *     "availableCredit": 900
 *   }
 * }
 *
 * -------------------------------------------------------------------
 * ✅ Safe to rerun `/settleInvoice` afterwards — 
 * all allocations for this invoice are fully removed and payments restored.
 */

export async function POST(req) {
  try {
    const {
      orderNumber,
      reason = "Reversal",
      status = "Pending", // could also be "Bad Debt"
      reversedBy = "system",
    } = await req.json();

    if (!orderNumber) {
      return NextResponse.json(
        { error: "Missing orderNumber" },
        { status: 400 }
      );
    }

    // 🧾 Fetch allocations for this invoice
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

    // 🧩 Reverse allocations one by one
    for (const allocDoc of allocSnap.docs) {
      const allocation = allocDoc.data();

      // Defensive: skip already reversed or corrupted entries
      if (allocation.status === "Reversed" || !allocation.fromPayments) continue;

      companyCode = allocation.companyCode;
      totalRestored += allocation.amount || 0;

      // Reverse every linked payment allocation
      for (const fp of allocation.fromPayments) {
        const paymentRef = doc(db, "payments", fp.paymentId);
        const paymentSnap = await getDoc(paymentRef);

        if (!paymentSnap.exists()) continue;

        const payment = paymentSnap.data();
        if (payment.deleted) continue; // skip soft-deleted

        const newAllocated = Math.max(0, (payment.allocated || 0) - fp.amount);
        const newUnallocated = (payment.unallocated || 0) + fp.amount;

        batch.update(paymentRef, {
          allocated: newAllocated,
          unallocated: newUnallocated,
        });
      }

      // 💥 Hard delete the allocation doc (after credit restoration)
      batch.delete(allocDoc.ref);
    }

    // 🧾 Update invoice + order status safely
    const invoiceRef = doc(db, "invoices", orderNumber);
    const orderRef = doc(db, "orders", orderNumber);

    // Invoice should always exist
    batch.update(invoiceRef, {
      payment_status: status,
      date_settled: null,
    });

    // Only update order if it exists (skip for rentals)
    const orderSnap = await getDoc(orderRef);
    if (orderSnap.exists()) {
      batch.update(orderRef, {
        payment_status: status,
        date_settled: null,
      });
    }

    // ✅ Commit all changes atomically
    await batch.commit();

    // 🪵 Log reversal event
    await logAccountingAction({
      action: "REVERSE_INVOICE",
      companyCode,
      orderNumber,
      amount: totalRestored,
      performedBy: reversedBy,
      details: { reason, status, allocationsDeleted: allocSnap.size },
    });

    // ♻️ Recalculate credit availability
    const updatedCredit = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: `Invoice ${orderNumber} reversed successfully`,
      orderNumber,
      amountRestored: totalRestored,
      newStatus: status,
      allocationsDeleted: allocSnap.size,
      creditSummary: updatedCredit,
    });
  } catch (err) {
    console.error("❌ Reverse invoice failed:", err);
    return NextResponse.json(
      { error: err.message || "Failed to reverse invoice payment" },
      { status: 500 }
    );
  }
}
