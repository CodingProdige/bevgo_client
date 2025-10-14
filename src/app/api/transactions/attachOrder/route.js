// app/api/transactions/attachOrder/route.js
export const runtime = "nodejs";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { transactionNumber, orderNumber } = await req.json();

    if (!transactionNumber || !orderNumber) {
      return NextResponse.json({ error: "Missing transactionNumber or orderNumber" }, { status: 400 });
    }

    const txRef = doc(db, "initTransactions", String(transactionNumber));
    const txSnap = await getDoc(txRef);
    if (!txSnap.exists()) {
      return NextResponse.json({ error: `Transaction ${transactionNumber} not found` }, { status: 404 });
    }

    // (Optional) ensure it’s Paid before attaching
    const status = txSnap.data()?.paymentStatus || "Pending";
    if (status !== "Paid") {
      // You can relax this if you want to allow attaching earlier
      return NextResponse.json({ error: `Transaction not paid (status=${status})` }, { status: 409 });
    }

    await updateDoc(txRef, {
      orderNumber,
      attachedAt: serverTimestamp(),
    });

    return NextResponse.json({ message: "Order attached to transaction", transactionNumber, orderNumber }, { status: 200 });
  } catch (err) {
    console.error("attachOrder error:", err);
    return NextResponse.json({ error: err.message || "Unknown error" }, { status: 500 });
  }
}
