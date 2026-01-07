export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m) =>
  NextResponse.json({ ok: false, title: t, message: m }, { status: s });

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return err(400, "Missing 3DS ID", "id is required");
    }

    const ref = doc(db, "payment_3ds_attempts", id);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      return err(404, "Not Found", "3DS attempt does not exist");
    }

    const data = snap.data();

    return ok({
      threeDSecureId: id,
      orderId: data.orderId,
      orderNumber: data.orderNumber || null,
      frictionless: !!data.frictionless,
      status: data.status || "initiated",
      redirect: data.redirect || null,
      redirectPreconditions: data.redirectPreconditions || null,
      methodRedirect: data.methodRedirect || null,
      challengeRedirect: data.challengeRedirect || null,
      channel: data.channel || null,
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || null,
      amount: data.amount || null,
      currency: data.currency || null,
      merchantTransactionId: data.merchantTransactionId || null,
      userId: data.userId || null
    });
  } catch (e) {
    return err(500, "Server Error", e.message);
  }
}
