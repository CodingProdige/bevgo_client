export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, s = 200) =>
  NextResponse.json({ ok: true, data }, { status: s });

const err = (s, title, message) =>
  NextResponse.json({ ok: false, title, message }, { status: s });

/* ───────── ENDPOINT ───────── */

export async function GET() {
  try {
    const snap = await getDocs(collection(db, "orders_v2"));

    const orders = snap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data() // 🔥 FULL RAW DOCUMENT
    }));

    return ok({
      total: orders.length,
      orders
    });

  } catch (e) {
    return err(
      500,
      "Fetch Failed",
      e?.message || "Unexpected error fetching orders_v2"
    );
  }
}
