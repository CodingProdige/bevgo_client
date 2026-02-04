export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

/* ───────── ENDPOINT ───────── */

export async function POST() {
  try {
    const snap = await getDocs(collection(db, "users"));
    const businesses = snap.docs
      .map(doc => ({ uid: doc.id, ...doc.data() }))
      .filter(user => user?.account?.accountType === "business")
      .map(user => ({
        uid: user.uid,
        customerCode: user?.account?.customerCode || null,
        companyName: user?.business?.companyName || user?.account?.companyName || null
      }));

    return ok({ businesses });
  } catch (e) {
    return err(
      500,
      "Fetch Businesses Failed",
      e?.message || "Unexpected error fetching business accounts."
    );
  }
}
