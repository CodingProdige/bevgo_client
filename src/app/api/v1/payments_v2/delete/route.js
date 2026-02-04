export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { deleteDoc, doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const now = () => new Date().toISOString();
const r2 = v => Number((Number(v) || 0).toFixed(2));

function computeOrderPaymentStatus(required, paid) {
  if (paid <= 0) return "unpaid";
  if (paid + 0.0001 >= required) return "paid";
  return "partial";
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { paymentId } = body || {};

    if (!paymentId) {
      return err(400, "Missing Input", "paymentId is required.");
    }

    const ref = doc(db, "payments_v2", paymentId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Payment Not Found", "Payment could not be located.");
    }

    const payment = snap.data();
    const allocations = Array.isArray(payment?.allocations)
      ? payment.allocations
      : [];

    for (const allocation of allocations) {
      const orderId = allocation?.orderId || null;
      const amountIncl = Number(allocation?.amount_incl || 0);
      if (!orderId || amountIncl <= 0) continue;

      const orderRef = doc(db, "orders_v2", orderId);
      const orderSnap = await getDoc(orderRef);
      if (!orderSnap.exists()) continue;

      const order = orderSnap.data();
      const required = Number(order?.payment?.required_amount_incl || 0);
      const paid = Number(order?.payment?.paid_amount_incl || 0);
      const nextPaid = r2(Math.max(0, paid - amountIncl));
      const paymentStatus = computeOrderPaymentStatus(required, nextPaid);

      const manualPayments = Array.isArray(order?.payment?.manual_payments)
        ? order.payment.manual_payments
        : [];

      const cleanedManualPayments = manualPayments.filter(entry => {
        if (entry?.paymentId !== paymentId) return true;
        const entryAmount = Number(entry?.amount_incl || 0);
        const entryTime = entry?.allocatedAt || null;
        const allocTime = allocation?.allocatedAt || null;
        if (entryAmount !== amountIncl) return true;
        if (allocTime && entryTime && entryTime !== allocTime) return true;
        return false;
      });

      await updateDoc(orderRef, {
        "payment.paid_amount_incl": nextPaid,
        "payment.status": paymentStatus,
        "order.status.payment": paymentStatus,
        "payment.manual_payments": cleanedManualPayments,
        "timestamps.updatedAt": now()
      });
    }

    await deleteDoc(ref);

    return ok({ paymentId, deleted: true });
  } catch (e) {
    return err(
      500,
      "Delete Payment Failed",
      e?.message || "Unexpected error deleting payment."
    );
  }
}
