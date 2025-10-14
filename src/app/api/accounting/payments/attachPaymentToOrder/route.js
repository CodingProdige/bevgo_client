// app/api/payments/attachPaymentToOrder/route.js
export const runtime = "nodejs";

import { db } from "@/lib/firebaseConfig";
import {
  collection, query, where, getDocs, doc, getDoc, updateDoc, serverTimestamp
} from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { transactionNumber, orderNumber } = await req.json();

    if (!transactionNumber || !orderNumber) {
      return NextResponse.json({ error: "Missing transactionNumber or orderNumber" }, { status: 400 });
    }

    // 1) Find payment(s) captured for this transaction (created by the webhook)
    const paymentsQ = query(
      collection(db, "payments"),
      where("transactionNumber", "==", String(transactionNumber))
    );
    const paySnap = await getDocs(paymentsQ);

    if (paySnap.empty) {
      return NextResponse.json(
        { error: `No payment found for transaction ${transactionNumber}` },
        { status: 404 }
      );
    }

    // 2) Attach orderNumber to those payments (usually there’s just one)
    let updatedCount = 0;
    for (const pdoc of paySnap.docs) {
      const pref = doc(db, "payments", pdoc.id);
      const pdata = pdoc.data();
      if (pdata.orderNumber && pdata.orderNumber === orderNumber) {
        continue; // idempotent
      }
      await updateDoc(pref, {
        orderNumber,
        orderLinkedAt: serverTimestamp(),
      });
      updatedCount++;
    }

    // 3) Mark the order as prepaid (like the ORDER path in your webhook)
    const orderRef = doc(db, "orders", String(orderNumber));
    const orderSnap = await getDoc(orderRef);
    if (orderSnap.exists()) {
      await updateDoc(orderRef, { prePaid: true });
    }

    return NextResponse.json(
      {
        message: "Payment(s) attached to order and order marked prepaid",
        transactionNumber,
        orderNumber,
        paymentsUpdated: updatedCount,
        orderPrePaid: orderSnap.exists() ? true : false
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("attachPaymentToOrder error:", err);
    return NextResponse.json({ error: err.message || "Unknown error" }, { status: 500 });
  }
}
