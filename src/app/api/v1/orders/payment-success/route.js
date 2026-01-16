export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────────────── HELPERS ───────────────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status });

const now = () => new Date().toISOString();

/* ───────────────── ENDPOINT ───────────────── */

export async function POST(req) {
  try {
    const { orderId, payment } = await req.json();

    if (!orderId) {
      return err(400, "Missing Order ID", "orderId is required.");
    }

    if (!payment || payment.provider !== "peach") {
      return err(
        400,
        "Invalid Provider",
        "payment.provider must be 'peach'."
      );
    }

    if (!payment.peachTransactionId) {
      return err(
        400,
        "Missing Transaction ID",
        "payment.peachTransactionId is required."
      );
    }

    const chargeType = payment.chargeType || "card";

    if (chargeType !== "card" && chargeType !== "token") {
      return err(
        400,
        "Invalid Charge Type",
        "payment.chargeType must be 'card' or 'token'."
      );
    }

    if (chargeType === "card" && !payment.threeDSecureId) {
      return err(
        400,
        "Missing 3DS ID",
        "payment.threeDSecureId is required for chargeType 'card'."
      );
    }

    if (!payment.currency || typeof payment.amount_incl !== "number") {
      return err(
        400,
        "Missing Amount",
        "payment.amount_incl (number) and payment.currency are required."
      );
    }

    /* ───── Load Order ───── */

    const ref = doc(db, "orders_v2", orderId);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      return err(404, "Order Not Found", "Invalid orderId.");
    }

    const order = snap.data();

    /* ───── Idempotency Guard ───── */

    const existingAttempts = Array.isArray(order?.payment?.attempts)
      ? order.payment.attempts
      : [];

    const alreadyProcessed = existingAttempts.some(
      a => a?.peachTransactionId === payment.peachTransactionId
    );

    if (alreadyProcessed) {
      return ok({
        orderId,
        status: "already_processed"
      });
    }

    /* ───── Validate order currency & amount ───── */

    const requiredAmount = Number(order?.payment?.required_amount_incl || 0);
    const paidAmount = Number(payment.amount_incl || 0);

    if (paidAmount !== requiredAmount) {
      return err(
        400,
        "Payment Mismatch",
        "Paid amount does not match order required_amount_incl.",
        {
          required_amount_incl: requiredAmount,
          paid_amount_incl: paidAmount
        }
      );
    }

    if (payment.currency !== order?.payment?.currency) {
      return err(
        400,
        "Currency Mismatch",
        "Paid currency does not match order currency.",
        {
          required_currency: order?.payment?.currency,
          paid_currency: payment.currency
        }
      );
    }

    /* ───── Build Attempt (CIT + MIT) ───── */

    const attempt = {
      provider: "peach",
      method: payment.method || "card",
      chargeType,

      threeDSecureId: payment.threeDSecureId || null,

      merchantTransactionId: payment.merchantTransactionId || null,
      peachTransactionId: payment.peachTransactionId,

      token:
        chargeType === "token"
          ? {
              registrationId: payment.token?.registrationId || null,
              cardId: payment.token?.cardId || null
            }
          : null,

      status: "charged",
      createdAt: now()
    };

    const nextAttempts = [...existingAttempts, attempt];

    /* ───── Determine editability changes ─────
       LOCKED RULE:
       - personal orders: editable always false + lock immediately
       - business orders: do NOT change editable here (invoice creation locks them)
    ───────────────────────────────────────── */

    const isPersonal = order?.order?.type === "personal";

    const updatePayload = {
      "payment.method": payment.method || "card",
      "payment.status": "paid",
      "payment.paid_amount_incl": paidAmount,
      "payment.attempts": nextAttempts,

      "order.status.payment": "paid",
      "order.status.order": "confirmed",

      timestamps: {
        ...(order.timestamps || {}),
        updatedAt: now()
      }
    };

    if (isPersonal) {
      updatePayload["order.editable"] = false;
      updatePayload["order.editable_reason"] =
        "Order is locked because payment was completed.";
      updatePayload.timestamps.lockedAt = now();
    }

    await updateDoc(ref, updatePayload);

    return ok({
      orderId,
      orderType: order?.order?.type || null,
      paymentStatus: "paid",
      orderStatus: "confirmed",
      editable: isPersonal ? false : order?.order?.editable ?? null
    });

  } catch (e) {
    return err(500, "Server Error", e.message);
  }
}
