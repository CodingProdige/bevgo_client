// app/api/initTransaction/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, runTransaction, serverTimestamp } from "firebase/firestore";
import { NextResponse } from "next/server";

/* -------------------- existing POST (create) stays here -------------------- */
/* ... your POST implementation from before ... */

/* -------------------- NEW: GET /api/initTransaction?transactionNumber=XXXXXXXX -------------------- */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const transactionNumber = searchParams.get("transactionNumber");

    if (!transactionNumber) {
      return NextResponse.json({ error: "Missing transactionNumber" }, { status: 400 });
    }

    const ref = doc(db, "initTransactions", String(transactionNumber));
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      return NextResponse.json(
        { error: `Transaction ${transactionNumber} not found` },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { id: snap.id, ...snap.data() },
      { status: 200 }
    );
  } catch (error) {
    console.error("get initTransaction error:", error);
    return NextResponse.json({ error: error.message || "Unknown error" }, { status: 500 });
  }
}
