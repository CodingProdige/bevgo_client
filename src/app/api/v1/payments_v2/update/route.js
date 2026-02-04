export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const now = () => new Date().toISOString();
const r2 = v => Number((Number(v) || 0).toFixed(2));

function computeStatus(amountIncl, allocatedIncl) {
  if (allocatedIncl <= 0) return "unallocated";
  if (allocatedIncl >= amountIncl) return "allocated";
  return "partially_allocated";
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      paymentId,
      payment = {},
      proof = null
    } = body || {};

    if (!paymentId) {
      return err(400, "Missing Input", "paymentId is required.");
    }

    const ref = doc(db, "payments_v2", paymentId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Payment Not Found", "Payment could not be located.");
    }

    const existing = snap.data();
    const allocations = Array.isArray(existing?.allocations)
      ? existing.allocations
      : [];
    const allocatedIncl = allocations.reduce(
      (sum, a) => sum + Number(a?.amount_incl || 0),
      0
    );

    const nextAmountIncl = payment?.amount_incl != null
      ? Number(payment.amount_incl)
      : Number(existing?.payment?.amount_incl || 0);

    if (!Number.isFinite(nextAmountIncl) || nextAmountIncl <= 0) {
      return err(400, "Invalid Amount", "payment.amount_incl must be > 0.");
    }

    if (allocatedIncl > nextAmountIncl) {
      return err(
        400,
        "Invalid Amount",
        "payment.amount_incl cannot be less than allocated amount."
      );
    }

    const remaining = r2(nextAmountIncl - allocatedIncl);
    const nextStatus = computeStatus(nextAmountIncl, allocatedIncl);

    const updatePayload = {
      "payment.amount_incl": r2(nextAmountIncl),
      "payment.remaining_amount_incl": remaining,
      "payment.status": nextStatus,
      "timestamps.updatedAt": now()
    };

    if (payment?.method) updatePayload["payment.method"] = payment.method;
    if (payment?.currency) updatePayload["payment.currency"] = payment.currency;
    if (payment?.reference !== undefined)
      updatePayload["payment.reference"] = payment.reference || null;
    if (payment?.note !== undefined)
      updatePayload["payment.note"] = payment.note || null;

    if (proof !== undefined) {
      updatePayload.proof = proof && typeof proof === "object"
        ? {
            type: proof.type || null,
            url: proof.url || null
          }
        : null;
    }

    await updateDoc(ref, updatePayload);

    return ok({
      paymentId,
      updated: true
    });
  } catch (e) {
    return err(
      500,
      "Update Payment Failed",
      e?.message || "Unexpected error updating payment."
    );
  }
}
