export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

async function resolveAccessType(userId) {
  if (!userId) return null;
  const snap = await getDoc(doc(db, "users", userId));
  if (snap.exists()) return snap.data()?.system?.accessType || null;

  const q = query(collection(db, "users"), where("uid", "==", userId));
  const match = await getDocs(q);
  if (match.empty) return null;
  return match.docs[0]?.data()?.system?.accessType || null;
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { customerId } = body || {};

    if (!customerId) {
      return err(400, "Missing Input", "customerId is required.");
    }

    const accessType = await resolveAccessType(customerId);
    const isAdmin = accessType === "admin";

    const snap = await getDocs(collection(db, "orders_v2"));
    const orderNumbers = snap.docs
      .map(doc => ({ docId: doc.id, ...doc.data() }))
      .filter(order =>
        order?.order?.editable === true &&
        order?.order?.orderNumber &&
        (isAdmin || order?.order?.customerId === customerId)
      )
      .map(order => order.order.orderNumber);

    return ok({
      orderNumbers,
      accessType: accessType || "customer"
    });
  } catch (e) {
    return err(
      500,
      "Fetch Editable Orders Failed",
      e?.message || "Unexpected error fetching editable orders."
    );
  }
}
