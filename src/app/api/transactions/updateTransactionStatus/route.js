// app/api/initTransaction/updateStatus/route.js
// Allowed statuses (editable): "Pending" | "Paid" | "Failed" | "Cancelled"
export const runtime = "nodejs";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { NextResponse } from "next/server";

// Adjust the set below if you want more statuses (e.g., "Expired", "Reversed")
const ALLOWED_STATUSES = new Set(["Pending", "Paid", "Failed", "Cancelled"]);

export async function POST(req) {
  try {
    const { transactionNumber, paymentStatus } = await req.json();

    if (!transactionNumber) {
      return NextResponse.json({ error: "Missing transactionNumber" }, { status: 400 });
    }
    if (!paymentStatus || !ALLOWED_STATUSES.has(paymentStatus)) {
      return NextResponse.json(
        { error: `Invalid paymentStatus. Allowed: ${Array.from(ALLOWED_STATUSES).join(", ")}` },
        { status: 400 }
      );
    }

    const txRef = doc(db, "initTransactions", String(transactionNumber));
    const snap = await getDoc(txRef);

    if (!snap.exists()) {
      return NextResponse.json(
        { error: `Transaction ${transactionNumber} not found` },
        { status: 404 }
      );
    }

    await updateDoc(txRef, {
      paymentStatus,
      updatedAt: serverTimestamp(),
    });

    // Optionally re-read to return fresh data
    const updatedSnap = await getDoc(txRef);
    return NextResponse.json(
      {
        message: "Payment status updated",
        transaction: { id: updatedSnap.id, ...updatedSnap.data() },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("updateStatus error:", error);
    return NextResponse.json({ error: error.message || "Unknown error" }, { status: 500 });
  }
}
