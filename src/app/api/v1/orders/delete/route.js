export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status });

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
    const { orderId, orderNumber, merchantTransactionId, force = false } =
      await req.json();

    if (!orderId && !orderNumber && !merchantTransactionId) {
      return err(
        400,
        "Missing Order Reference",
        "orderId, orderNumber, or merchantTransactionId is required."
      );
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
    const paid = order?.payment?.status === "paid";

    if (paid && !force) {
      return err(
        409,
        "Order Already Paid",
        "Paid orders cannot be deleted without force=true.",
        {
          orderId: snap.id,
          orderNumber: order?.order?.orderNumber || null,
          merchantTransactionId: order?.order?.merchantTransactionId || null
        }
      );
    }

    await deleteDoc(ref);

    return ok({
      orderId: snap.id,
      orderNumber: order?.order?.orderNumber || null,
      merchantTransactionId: order?.order?.merchantTransactionId || null,
      deleted: true
    });
  } catch (e) {
    if (e?.message === "multiple_orders") {
      return err(
        409,
        "Multiple Orders Found",
        "Multiple orders match this reference."
      );
    }

    return err(500, "Delete Failed", e?.message || "Unexpected server error.");
  }
}
