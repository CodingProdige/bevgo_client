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

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const r2 = v => Number((Number(v) || 0).toFixed(2));

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

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orderNumber, paymentIds } = body || {};

    if (!orderNumber) {
      return err(400, "Missing Input", "orderNumber is required.");
    }

    if (!Array.isArray(paymentIds) || paymentIds.length === 0) {
      return err(400, "Missing Input", "paymentIds must be a non-empty array.");
    }

    const resolvedOrderId = await resolveOrderId(orderNumber);
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const orderRef = doc(db, "orders_v2", resolvedOrderId);
    const orderSnap = await getDoc(orderRef);
    if (!orderSnap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const order = orderSnap.data();
    const required = Number(order?.payment?.required_amount_incl || 0);
    const paid = Number(order?.payment?.paid_amount_incl || 0);
    const customerId = order?.order?.customerId || null;

    let remainingDue = r2(required - paid);
    let allocatedTotal = 0;

    const paymentSummaries = [];

    for (const paymentId of paymentIds) {
      const payRef = doc(db, "payments_v2", paymentId);
      const paySnap = await getDoc(payRef);

      if (!paySnap.exists()) {
        paymentSummaries.push({
          paymentId,
          usable_amount_incl: 0,
          status: "not_found"
        });
        continue;
      }

      const payment = paySnap.data();
      if (customerId && payment?.customer?.customerId !== customerId) {
        paymentSummaries.push({
          paymentId,
          usable_amount_incl: 0,
          status: "customer_mismatch"
        });
        continue;
      }

      const paymentRemaining = Number(payment?.payment?.remaining_amount_incl || 0);
      const usable = r2(Math.max(0, Math.min(paymentRemaining, remainingDue)));

      allocatedTotal = r2(allocatedTotal + usable);
      remainingDue = r2(remainingDue - usable);

      paymentSummaries.push({
        paymentId,
        usable_amount_incl: usable,
        remaining_amount_incl: paymentRemaining,
        status: paymentRemaining > 0 ? "ok" : "no_funds"
      });
    }

    return ok({
      orderNumber,
      required_amount_incl: r2(required),
      already_paid_incl: r2(paid),
      selected_payments_total_incl: allocatedTotal,
      remaining_due_incl: remainingDue,
      additional_needed_incl: remainingDue > 0 ? remainingDue : 0,
      max_additional_allocatable_incl: remainingDue > 0 ? remainingDue : 0,
      can_cover: remainingDue <= 0,
      payments: paymentSummaries
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Allocation Preview Failed",
      e?.message ?? "Unexpected error previewing allocation."
    );
  }
}
