export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  addDoc,
  writeBatch,
} from "firebase/firestore";
import { NextResponse } from "next/server";

async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const snap = await getDocs(query(paymentsRef, where("companyCode", "==", companyCode)));
  let totalCredit = 0;
  let totalAllocated = 0;
  snap.forEach((d) => {
    const p = d.data();
    if (p.deleted) return;
    totalCredit += Number(p.amount || 0);
    totalAllocated += Number(p.allocated || 0);
  });
  return totalCredit - totalAllocated;
}

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

export async function POST(req) {
  try {
    const { orderNumber } = await req.json();
    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    console.log(`💳 Attempting to allocate credit to order ${orderNumber}`);

    // 🧾 Fetch order
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);
    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const order = orderSnap.data();
    const companyCode = order?.companyCode;
    if (!companyCode) {
      return NextResponse.json({ error: "Order missing companyCode" }, { status: 400 });
    }

    const orderTotal = Number(order?.order_details?.total || 0);
    if (orderTotal <= 0) {
      return NextResponse.json({ message: "Order has no outstanding amount" });
    }

    // 🚦 Check invoice (if exists)
    const invoicesSnap = await getDocs(
      query(collection(db, "invoices"), where("orderNumber", "==", orderNumber))
    );
    const invoiceDoc = invoicesSnap.docs[0];
    const invoiceData = invoiceDoc ? invoiceDoc.data() : null;

    // 💰 Fetch available payments
    const paymentsRef = collection(db, "payments");
    const paymentsSnap = await getDocs(query(paymentsRef, where("companyCode", "==", companyCode)));

    let remaining = orderTotal;
    const batch = writeBatch(db);
    const fromPayments = [];

    paymentsSnap.forEach((pDoc) => {
      if (remaining <= 0) return;
      const p = pDoc.data();
      if (p.deleted) return;
      const unallocated = Number(p.unallocated || 0);
      if (unallocated > 0) {
        const allocateAmt = Math.min(remaining, unallocated);
        fromPayments.push({ paymentId: pDoc.id, amount: allocateAmt });

        batch.update(pDoc.ref, {
          allocated: (p.allocated || 0) + allocateAmt,
          unallocated: unallocated - allocateAmt,
          creditAllocations: [
            ...(p.creditAllocations || []),
            {
              orderNumber,
              amount: allocateAmt,
              date: new Date().toISOString(),
            },
          ],
        });
        remaining -= allocateAmt;
      }
    });

    if (fromPayments.length === 0) {
      return NextResponse.json({
        error: "No available credit to allocate.",
      });
    }

    if (remaining > 0) {
      console.log(`⚠️ Partial allocation applied: R${orderTotal - remaining} / R${orderTotal}`);
    }

    // ✅ Mark as paid if fully allocated
    const fullySettled = remaining <= 0;
    const now = new Date().toISOString();

    if (invoiceDoc) {
      batch.update(invoiceDoc.ref, {
        payment_status: fullySettled ? "Paid" : "Partially Paid",
        date_settled: now,
      });
    }

    batch.update(orderRef, {
      payment_status: fullySettled ? "Paid" : "Partially Paid",
      date_settled: now,
      allocationFixed: true, // flag to indicate manual allocation done
    });

    await batch.commit();

    // 🔍 Log action
    await logAccountingAction({
      action: "MANUAL_CREDIT_ALLOCATION",
      companyCode,
      orderNumber,
      amountApplied: orderTotal - remaining,
      performedBy: "system/manual",
      fullySettled,
      fromPayments,
    });

    const newCredit = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: fullySettled
        ? `Credit successfully allocated to order ${orderNumber}`
        : `Partial credit allocated to order ${orderNumber}`,
      allocated: orderTotal - remaining,
      remainingBalance: remaining,
      fromPayments,
      availableCredit: newCredit,
    });
  } catch (err) {
    console.error("❌ Credit allocation failed:", err.message);
    return NextResponse.json(
      { error: err.message || "Credit allocation failed" },
      { status: 500 }
    );
  }
}
