export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc } from "firebase/firestore";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, data: p }, { status: s });

const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const ALLOWED_STATUSES = new Set(["returned", "cancelled"]);

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { rentalId, status } = body || {};

    if (!rentalId || !status) {
      return err(400, "Missing Fields", "rentalId and status are required.");
    }

    if (!ALLOWED_STATUSES.has(status)) {
      return err(
        400,
        "Invalid Status",
        "status must be 'returned' or 'cancelled'."
      );
    }

    const ref = doc(db, "rentals_v2", rentalId);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      return err(404, "Rental Not Found", "No rental found with that id.");
    }

    const timestamp = new Date().toISOString();

    await updateDoc(ref, {
      "billing.status": status,
      "billing.endedAt": timestamp,
      "timestamps.updatedAt": timestamp
    });

    return ok({
      rentalId,
      status,
      updatedAt: timestamp
    });
  } catch (e) {
    return err(
      500,
      "Update Failed",
      e?.message || "Unexpected error."
    );
  }
}
