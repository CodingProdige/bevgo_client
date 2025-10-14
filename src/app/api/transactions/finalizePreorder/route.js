// app/api/transactions/finalizePreorder/route.js
export const runtime = "nodejs";

import { db } from "@/lib/firebaseConfig";
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { NextResponse } from "next/server";

/**
 * POST /api/transactions/finalizePreorder
 * Body: { transactionNumber: string, orderNumber: string }
 *
 * Steps:
 *  1) Validate & load initTransactions/<transactionNumber>
 *  2) Require transaction.paymentStatus === "Paid" (409 otherwise)
 *  3) Attach orderNumber to the transaction (idempotent)
 *  4) Link captured payments (payments.transactionNumber == tn) to the order (idempotent)
 *  5) Mark orders/<orderNumber> as prePaid: true (idempotent)
 */
export async function POST(req) {
  try {
    const { transactionNumber, orderNumber } =
      (await req.json().catch(() => ({}))) || {};

    if (!transactionNumber || !orderNumber) {
      return NextResponse.json(
        { error: "Missing transactionNumber or orderNumber" },
        { status: 400 }
      );
    }

    // 1) Load transaction
    const txRef = doc(db, "initTransactions", String(transactionNumber));
    const txSnap = await getDoc(txRef);
    if (!txSnap.exists()) {
      return NextResponse.json(
        { error: `Transaction ${transactionNumber} not found` },
        { status: 404 }
      );
    }

    const txData = txSnap.data();
    const status = txData?.paymentStatus || "Pending";

    // 2) Ensure payment completed
    if (status !== "Paid") {
      return NextResponse.json(
        { error: `Transaction not paid (status=${status})` },
        { status: 409 }
      );
    }

    // 3) Attach orderNumber to transaction (idempotent)
    let transactionUpdated = false;
    if (!txData.orderNumber || txData.orderNumber !== orderNumber) {
      await updateDoc(txRef, {
        orderNumber,
        attachedAt: serverTimestamp(),
      });
      transactionUpdated = true;
    }

    // 4) Link any captured payments by transactionNumber to this order
    const paymentsQ = query(
      collection(db, "payments"),
      where("transactionNumber", "==", String(transactionNumber))
    );
    const paySnap = await getDocs(paymentsQ);

    let paymentsUpdated = 0;
    if (!paySnap.empty) {
      const batch = writeBatch(db);
      paySnap.docs.forEach((pdoc) => {
        const pdata = pdoc.data();
        // Only update if missing or different (idempotent)
        if (pdata.orderNumber !== orderNumber) {
          const pref = doc(db, "payments", pdoc.id);
          batch.update(pref, {
            orderNumber,
            orderLinkedAt: serverTimestamp(),
          });
          paymentsUpdated++;
        }
      });
      if (paymentsUpdated > 0) {
        await batch.commit();
      }
    }

    // 5) Mark order as prepaid (idempotent protection)
    let orderSetPrepaid = false;
    const orderRef = doc(db, "orders", String(orderNumber));
    const orderSnap = await getDoc(orderRef);
    if (orderSnap.exists()) {
      const odata = orderSnap.data();
      if (!odata?.prePaid) {
        await updateDoc(orderRef, { prePaid: true, prePaidAt: serverTimestamp() });
        orderSetPrepaid = true;
      }
    } else {
      // If the order doesn't exist yet, you can choose to 404 or just surface a warning.
      // Returning 200 with a hint keeps this endpoint usable immediately after you create the order.
      return NextResponse.json(
        {
          message:
            "Transaction linked; no order document found to mark as prepaid.",
          transaction: { id: txSnap.id, ...txData, orderNumber },
          paymentsUpdated,
          orderFound: false,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        message: "Pre-order finalized",
        transactionUpdated,
        paymentsUpdated,
        orderPrePaid: orderSetPrepaid, // false if it was already true
        transactionNumber,
        orderNumber,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("finalizePreorder error:", error);
    return NextResponse.json(
      { error: error.message || "Unknown error" },
      { status: 500 }
    );
  }
}
