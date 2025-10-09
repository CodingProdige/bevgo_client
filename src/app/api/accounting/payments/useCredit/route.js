// app/api/payments/useCredit/route.js
import { db } from "@/lib/firebaseConfig";
import {
  collection,
  query,
  where,
  getDocs,
  orderBy,
  updateDoc,
  doc,
} from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode, orderNumber, creditApplied } = await req.json();

    if (!companyCode || !orderNumber || !creditApplied || creditApplied <= 0) {
      return NextResponse.json(
        { error: "Missing or invalid companyCode, orderNumber, or creditApplied" },
        { status: 400 }
      );
    }

    console.log(`💳 Applying credit of R${creditApplied} for order ${orderNumber}`);

    const paymentsRef = collection(db, "payments");
    const q = query(
      paymentsRef,
      where("companyCode", "==", companyCode),
      where("deleted", "==", false),
      orderBy("paymentDate", "asc")
    );
    const snap = await getDocs(q);

    let remainingCredit = creditApplied;
    const updates = [];

    for (const docSnap of snap.docs) {
      if (remainingCredit <= 0) break;

      const payment = docSnap.data();
      const paymentRef = doc(db, "payments", docSnap.id);

      let unallocated = Number(payment.unallocated || 0);
      if (unallocated <= 0) continue;

      const applyAmount = Math.min(unallocated, remainingCredit);

      await updateDoc(paymentRef, {
        unallocated: unallocated - applyAmount,
        allocated: Number(payment.allocated || 0) + applyAmount,
        creditAllocations: [
          ...(payment.creditAllocations || []),
          {
            orderNumber,
            amount: applyAmount,
            date: new Date().toISOString(),
          },
        ],
      });

      updates.push({
        paymentId: docSnap.id,
        paymentNumber: payment.paymentNumber,
        applied: applyAmount,
      });

      remainingCredit -= applyAmount;
    }

    const appliedTotal = creditApplied - remainingCredit;

    return NextResponse.json({
      message: `Credit applied successfully`,
      orderNumber,
      requested: creditApplied,
      applied: appliedTotal,
      unused: remainingCredit,
      updates,
    });
  } catch (err) {
    console.error("❌ Failed to apply credit:", err.message);
    return NextResponse.json(
      { error: "Failed to apply credit", details: err.message },
      { status: 500 }
    );
  }
}

// ✅ DELETE - reverse applied credit for a specific order
export async function DELETE(req) {
  try {
    const { searchParams } = new URL(req.url);
    const companyCode = searchParams.get("companyCode");
    const orderNumber = searchParams.get("orderNumber");

    if (!companyCode || !orderNumber) {
      return NextResponse.json(
        { error: "Missing companyCode or orderNumber" },
        { status: 400 }
      );
    }

    console.log(`♻️ Reversing credit for order ${orderNumber}`);

    const paymentsRef = collection(db, "payments");
    const q = query(paymentsRef, where("companyCode", "==", companyCode));
    const snap = await getDocs(q);

    let reversedTotal = 0;
    const updates = [];

    for (const docSnap of snap.docs) {
      const payment = docSnap.data();
      const paymentRef = doc(db, "payments", docSnap.id);

      const creditAllocations = payment.creditAllocations || [];
      const matching = creditAllocations.find(ca => ca.orderNumber === orderNumber);
      if (!matching) continue;

      // remove this allocation
      const updatedAllocations = creditAllocations.filter(ca => ca.orderNumber !== orderNumber);

      await updateDoc(paymentRef, {
        unallocated: Number(payment.unallocated || 0) + matching.amount,
        allocated: Math.max(0, Number(payment.allocated || 0) - matching.amount),
        creditAllocations: updatedAllocations,
      });

      reversedTotal += matching.amount;
      updates.push({
        paymentId: docSnap.id,
        paymentNumber: payment.paymentNumber,
        reversed: matching.amount,
      });
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { message: `No credit allocations found for order ${orderNumber}`, reversed: 0 },
        { status: 200 }
      );
    }

    return NextResponse.json({
      message: `Credit reversed successfully`,
      orderNumber,
      reversed: reversedTotal,
      updates,
    });
  } catch (err) {
    console.error("❌ Failed to reverse credit:", err.message);
    return NextResponse.json(
      { error: "Failed to reverse credit", details: err.message },
      { status: 500 }
    );
  }
}
