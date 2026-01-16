export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, doc, getDoc, getDocs, query, updateDoc, where } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const now = () => new Date().toISOString();

const allowedOrderStatuses = [
  "draft",
  "confirmed",
  "processing",
  "dispatched",
  "completed",
  "cancelled"
];

const defaultOrderReasons = {
  draft: "Order set to draft.",
  confirmed: "Order confirmed.",
  processing: "Order is being processed.",
  dispatched: "Order dispatched.",
  completed: "Order completed.",
  cancelled: "Order cancelled."
};

async function resolveOrderId(orderId, orderNumber) {
  if (orderId) return orderId;
  if (!orderNumber) return null;

  const matchSnap = await getDocs(
    query(
      collection(db, "orders_v2"),
      where("order.orderNumber", "==", orderNumber)
    )
  );

  if (matchSnap.size > 1) {
    throw { code: 409, title: "Multiple Orders Found", message: "Multiple orders match this orderNumber." };
  }

  if (matchSnap.empty) return null;
  return matchSnap.docs[0].id;
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const orderNumber = body?.orderNumber || null;
    const status = String(body?.status || "").trim().toLowerCase();
    const reason = String(body?.reason || "").trim();
    const defaultReason = defaultOrderReasons[status] || "Order status updated.";

    if (!orderNumber) {
      return err(400, "Missing Input", "orderNumber is required.");
    }

    if (!allowedOrderStatuses.includes(status)) {
      return err(
        400,
        "Invalid Status",
        `status must be one of: ${allowedOrderStatuses.join(", ")}`
      );
    }

    const resolvedOrderId = await resolveOrderId(null, orderNumber);
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const ref = doc(db, "orders_v2", resolvedOrderId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const order = snap.data();
    const updatePayload = {
      "order.status.order": status,
      "timestamps.updatedAt": now()
    };

    if (status === "completed" || status === "cancelled") {
      updatePayload["order.editable"] = false;
      updatePayload["order.editable_reason"] = reason || defaultReason;
      updatePayload["timestamps.lockedAt"] = order?.timestamps?.lockedAt || now();
    }

    await updateDoc(ref, updatePayload);

    return ok({
      orderId: resolvedOrderId,
      orderNumber: order?.order?.orderNumber || null,
      status
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Update Failed",
      e?.message ?? "Unexpected error updating order status."
    );
  }
}
