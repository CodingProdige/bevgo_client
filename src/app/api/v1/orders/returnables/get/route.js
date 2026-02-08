export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

async function resolveOrderId(orderNumber) {
  if (!orderNumber) return null;

  const matchSnap = await getDocs(
    query(
      collection(db, "orders_v2"),
      where("order.orderNumber", "==", orderNumber)
    )
  );

  if (matchSnap.size > 1) {
    throw {
      code: 409,
      title: "Multiple Orders Found",
      message: "Multiple orders match this orderNumber."
    };
  }

  if (matchSnap.empty) return null;
  return matchSnap.docs[0].id;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orderId: rawOrderId, orderNumber: rawOrderNumber } = body || {};

    const orderId = rawOrderId ? String(rawOrderId).trim() : null;
    const orderNumber = rawOrderNumber ? String(rawOrderNumber).trim() : null;

    if (!orderId && !orderNumber) {
      return err(400, "Missing Input", "orderId or orderNumber is required.");
    }

    const resolvedOrderId = orderId || (await resolveOrderId(orderNumber));
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const ref = doc(db, "orders_v2", resolvedOrderId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const order = snap.data();
    const returnsModule = order?.returns || null;
    const fallbackReturnables = Array.isArray(order?.credit_notes?.returnables)
      ? order.credit_notes.returnables
      : [];

    return ok({
      orderId: resolvedOrderId,
      orderNumber: order?.order?.orderNumber || null,
      returnables: returnsModule?.returnables || fallbackReturnables,
      totals: returnsModule?.totals || { excl: 0, vat: 0, incl: 0 },
      collected_returns_incl: returnsModule?.collected_returns_incl || 0
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Fetch Returnables Failed",
      e?.message ?? "Unexpected error fetching returnables."
    );
  }
}
