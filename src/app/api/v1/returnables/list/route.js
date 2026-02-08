export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, getDocs } from "firebase/firestore";
import { pricingDb } from "@/lib/firebasePricingConfig";

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

export async function POST() {
  try {
    const snap = await getDocs(collection(pricingDb, "returnables_v2"));
    const returnables = snap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data()
    }));

    return ok({ returnables });
  } catch (e) {
    return err(
      500,
      "Fetch Returnables Failed",
      e?.message || "Unexpected error fetching returnables."
    );
  }
}
