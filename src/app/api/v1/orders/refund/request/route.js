export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const now = () => new Date().toISOString();

async function resolveOrderRef({ orderId, orderNumber, merchantTransactionId }) {
  if (orderId) return doc(db, "orders_v2", orderId);

  const field = orderNumber
    ? "order.orderNumber"
    : "order.merchantTransactionId";
  const value = orderNumber || merchantTransactionId;

  const snap = await getDocs(
    query(collection(db, "orders_v2"), where(field, "==", value))
  );

  if (snap.empty) return null;
  if (snap.size > 1) {
    throw { code: 409, title: "Multiple Orders Found", message: "Multiple orders match this reference." };
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
      message
    } = await req.json();

    if (!orderId && !orderNumber && !merchantTransactionId) {
      return err(
        400,
        "Missing Order Reference",
        "orderId, orderNumber, or merchantTransactionId is required."
      );
    }

    const refundMessage = String(message || "").trim();
    if (!refundMessage) {
      return err(400, "Missing Input", "message is required.");
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
    const paymentStatus =
      order?.payment?.status || order?.order?.status?.payment || null;
    const orderIdResolved = snap.id;

    if (paymentStatus !== "paid" && paymentStatus !== "partial_refund") {
      return err(
        409,
        "Invalid Refund Request",
        "Refunds can only be requested for paid orders."
      );
    }

    if (paymentStatus === "refunded") {
      return err(409, "Already Refunded", "Order has already been refunded.");
    }

    const existingRefundSnap = await getDocs(
      query(collection(db, "refunds_v2"), where("refund.orderId", "==", orderIdResolved))
    );
    const existingRequested = existingRefundSnap.docs.find(
      d => d.data()?.refund?.status === "requested"
    );
    if (existingRequested) {
      return ok({
        refundId: existingRequested.id,
        orderId: orderIdResolved,
        status: "requested",
        alreadyRequested: true
      });
    }

    const refundId = doc(collection(db, "refunds_v2")).id;
    const requestedAt = now();

    const refundDoc = {
      docId: refundId,
      refund: {
        refundId,
        orderId: orderIdResolved,
        orderNumber: order?.order?.orderNumber || null,
        merchantTransactionId: order?.order?.merchantTransactionId || null,
        status: "requested",
        message: refundMessage
      },
      order_snapshot: {
        docId: order.docId || orderIdResolved,
        order: order.order,
        items: order.items,
        totals: order.totals,
        payment: order.payment,
        customer_snapshot: order.customer_snapshot,
        delivery: order.delivery,
        meta: order.meta,
        timestamps: order.timestamps
      },
      timestamps: {
        requestedAt,
        updatedAt: requestedAt
      }
    };

    await setDoc(doc(db, "refunds_v2", refundId), refundDoc);

    return ok({
      refundId,
      orderId: orderIdResolved,
      status: "requested"
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Refund Request Failed",
      e?.message ?? "Unexpected error requesting refund."
    );
  }
}
