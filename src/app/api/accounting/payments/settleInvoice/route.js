export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
  addDoc,
  writeBatch,
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
    availableCredit: totalCredit - totalAllocated,
  };
}

export async function POST(req) {
  try {
    const { companyCode, orderNumber } = await req.json();

    if (!companyCode || !orderNumber) {
      return NextResponse.json(
        { error: "Missing companyCode or orderNumber" },
        { status: 400 }
      );
    }

    // Fetch invoice
    const invoiceRef = doc(db, "invoices", orderNumber);
    const invoiceSnap = await getDocs(query(collection(db, "invoices"), where("orderNumber", "==", orderNumber)));
    if (invoiceSnap.empty) {
      return NextResponse.json(
        { error: `Invoice ${orderNumber} not found` },
        { status: 404 }
      );
    }
    const invoiceDoc = invoiceSnap.docs[0];
    const invoice = invoiceDoc.data();
    const invoiceTotal = Number(invoice.finalTotals?.finalTotal || 0);

    // Check credit
    const creditSummary = await getAvailableCredit(companyCode);
    if (creditSummary.availableCredit < invoiceTotal) {
      return NextResponse.json(
        { error: "Insufficient credit to settle this invoice", creditSummary },
        { status: 400 }
      );
    }

    // Fetch unallocated payments (FIFO)
    const paymentsRef = collection(db, "payments");
    const paymentsSnap = await getDocs(
      query(paymentsRef, where("companyCode", "==", companyCode))
    );

    let remaining = invoiceTotal;
    const batch = writeBatch(db);
    const fromPayments = [];

    paymentsSnap.forEach((pDoc) => {
      if (remaining <= 0) return;
      const p = pDoc.data();
      const unallocated = Number(p.unallocated || 0);

      if (unallocated > 0) {
        const allocateAmt = Math.min(remaining, unallocated);
        fromPayments.push({ paymentId: pDoc.id, amount: allocateAmt });

        batch.update(pDoc.ref, {
          allocated: (p.allocated || 0) + allocateAmt,
          unallocated: unallocated - allocateAmt,
        });

        remaining -= allocateAmt;
      }
    });

    if (remaining > 0) {
      return NextResponse.json(
        { error: "Allocation failed — not enough unallocated payments" },
        { status: 400 }
      );
    }

    // Create allocation doc
    const allocationRef = await addDoc(collection(db, "allocations"), {
      companyCode,
      invoiceId: orderNumber,
      amount: invoiceTotal,
      fromPayments,
      date: new Date().toISOString(),
      createdBy: "system",
    });

    // Update invoice + order
    const now = new Date().toISOString();
    batch.update(invoiceRef, {
      payment_status: "Paid",
      date_settled: now,
    });
    batch.update(doc(db, "orders", orderNumber), {
      payment_status: "Paid",
      date_settled: now,
    });

    // Commit all changes
    await batch.commit();

    // Return success
    const updatedCredit = await getAvailableCredit(companyCode);
    return NextResponse.json({
      message: `Invoice ${orderNumber} settled successfully`,
      allocationId: allocationRef.id,
      fromPayments,
      creditSummary: updatedCredit,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to settle invoice" },
      { status: 500 }
    );
  }
}
