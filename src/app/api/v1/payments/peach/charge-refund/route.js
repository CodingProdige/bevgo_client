export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

const now = () => new Date().toISOString();

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return {
    number: n,
    formatted: n.toFixed(2)
  };
}

/* ───────── ENV ───────── */

const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;
const ENTITY_ID = process.env.PEACH_S2S_ENTITY_ID;
const HOST = "oppwa.com";

/* ───────── PEACH REQUEST ───────── */

function peachRequest(path, form) {
  const body = querystring.stringify(form);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        port: 443,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(raw));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function resolveOrderRef({ orderId, orderNumber, merchantTransactionId }) {
  if (orderId) {
    return doc(db, "orders_v2", orderId);
  }

  const field = orderNumber
    ? "order.orderNumber"
    : "order.merchantTransactionId";
  const value = orderNumber || merchantTransactionId;

  const snap = await getDocs(
    query(collection(db, "orders_v2"), where(field, "==", value))
  );

  if (snap.empty) {
    return null;
  }

  if (snap.size > 1) {
    throw new Error("multiple_orders");
  }

  return snap.docs[0].ref;
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const {
      orderId,
      orderNumber,
      merchantTransactionId,
      paymentId,
      amount,
      currency,
      message
    } = await req.json();

    if (!paymentId) {
      return err(400, "Missing Payment ID", "paymentId is required.");
    }

    if (!orderId && !orderNumber && !merchantTransactionId) {
      return err(
        400,
        "Missing Order Reference",
        "orderId, orderNumber, or merchantTransactionId is required."
      );
    }

    if (!ACCESS_TOKEN || !ENTITY_ID) {
      return err(500, "Config Error", "PEACH credentials are not configured.");
    }

    const ref = await resolveOrderRef({
      orderId,
      orderNumber,
      merchantTransactionId
    });

    if (!ref) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const snap = await getDoc(ref);

    if (!snap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const order = snap.data();
    const existingAttempts = Array.isArray(order?.payment?.attempts)
      ? order.payment.attempts
      : [];

    const alreadyRefunded = existingAttempts.some(
      a => a?.type === "refund" && a?.originalPaymentId === paymentId
    );

    if (alreadyRefunded) {
      return ok({
        orderId: snap.id,
        status: "already_refunded"
      });
    }

    const paidAmount = Number(order?.payment?.paid_amount_incl || 0);
    const existingRefunded = Number(order?.payment?.refunded_amount_incl || 0);
    const refundAmountInput = amount ?? paidAmount;
    const refundAmountNormalized = normalizeAmount(refundAmountInput);
    const refundCurrency = currency || order?.payment?.currency;
    const refundMessage = String(message || "").trim();

    if (!refundAmountNormalized) {
      return err(400, "Invalid Amount", "Refund amount must be a number.");
    }

    const refundAmount = refundAmountNormalized.number;

    if (!refundCurrency) {
      return err(
        400,
        "Missing Currency",
        "currency is required or must exist on the order."
      );
    }

    if (!refundAmount || refundAmount <= 0) {
      return err(
        400,
        "Invalid Amount",
        "Refund amount must be greater than zero."
      );
    }

    if (refundAmount > paidAmount) {
      return err(
        409,
        "Invalid Refund Amount",
        "Refund amount cannot exceed paid amount."
      );
    }

    const peachPayload = {
      entityId: ENTITY_ID,
      amount: refundAmountNormalized.formatted,
      currency: refundCurrency,
      paymentType: "RF"
    };

    const refundRes = await peachRequest(`/v1/payments/${paymentId}`, peachPayload);

    if (!refundRes?.result?.code?.startsWith("000.")) {
      return err(
        402,
        "Refund Failed",
        refundRes?.result?.description || "Refund could not be completed.",
        { gateway: refundRes }
      );
    }

    const attempt = {
      type: "refund",
      provider: "peach",
      originalPaymentId: paymentId,
      peachTransactionId: refundRes.id,
      amount_incl: refundAmount,
      currency: refundCurrency,
      status: "refunded",
      createdAt: now(),
      ...(refundMessage ? { message: refundMessage } : {})
    };

    const remainingPaid = Math.max(
      0,
      Number((paidAmount - refundAmount).toFixed(2))
    );
    const isFullyRefunded = remainingPaid === 0;
    const nextRefundedTotal = Number(
      (existingRefunded + refundAmount).toFixed(2)
    );

    const updatePayload = {
      "payment.status": isFullyRefunded ? "refunded" : "partial_refund",
      "payment.paid_amount_incl": remainingPaid,
      "payment.refunded_amount_incl": nextRefundedTotal,
      "payment.refunded_currency": refundCurrency,
      "payment.refunded_at": now(),
      "payment.refund_count": (order?.payment?.refund_count || 0) + 1,
      "payment.attempts": [...existingAttempts, attempt],
      "order.status.payment": isFullyRefunded ? "refunded" : "partial_refund",
      "timestamps.updatedAt": now()
    };

    if (refundMessage) {
      updatePayload["order.refund_message"] = refundMessage;
      updatePayload["order.refund_message_at"] = now();
    }

    if (isFullyRefunded) {
      updatePayload["order.status.order"] = "cancelled";
      updatePayload["order.editable"] = false;
      updatePayload["order.editable_reason"] =
        "Order is locked because it was fully refunded.";
      updatePayload["timestamps.lockedAt"] = order?.timestamps?.lockedAt || now();
    }

    await updateDoc(ref, updatePayload);

    return ok({
      orderId: snap.id,
      refundId: refundRes.id,
      paymentId,
      status: isFullyRefunded ? "refunded" : "partial_refund",
      remainingPaid
    });
  } catch (e) {
    if (e?.message === "multiple_orders") {
      return err(
        409,
        "Multiple Orders Found",
        "Multiple orders match this reference."
      );
    }

    return err(500, "Refund Error", e?.message || "Unexpected error.");
  }
}
