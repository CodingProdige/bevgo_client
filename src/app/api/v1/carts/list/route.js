export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";

import { collection, getDocs } from "firebase/firestore";

/* HELPERS */
const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

export async function POST(req) {
  try {
    const body = await req.json();
    const { minItems, olderThanHours, userId } = body || {};

    const cartsRef = collection(db, "carts_active");
    const snap = await getDocs(cartsRef);

    const now = Date.now();
    const hrsMs = 60 * 60 * 1000;

    let carts = [];

    snap.forEach(docSnap => {
      const data = docSnap.data();

      // optional: filter by userId
      if (userId && data.cart?.user_id !== userId) return;

      // optional: filter by minItems
      const count = data.items?.length || 0;
      if (minItems && count < minItems) return;

      // optional: filter by age
      const updated = new Date(data.timestamps?.updatedAt || data.timestamps?.createdAt).getTime();
      const ageHours = (now - updated) / hrsMs;

      if (olderThanHours && ageHours < olderThanHours) return;

      carts.push({
        cart_id: data.cart?.cart_id,
        user_id: data.cart?.user_id,
        item_count: count,
        updatedAt: data.timestamps?.updatedAt,
        createdAt: data.timestamps?.createdAt,
        age_hours: Math.round(ageHours * 10) / 10
      });
    });

    return ok({
      data: {
        total: carts.length,
        carts
      }
    });

  } catch (e) {
    console.error(e);
    return err(500, "List Carts Failed", "An unexpected error occurred.", {
      error: e.toString()
    });
  }
}
