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
const isMeaningfulString = value => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  return lowered !== "null" && lowered !== "undefined";
};

function getOrderRequiredIncl(order) {
  const totals = order?.totals || {};
  const returnsModule = order?.returns || {};
  const collectedReturnsIncl = Number(
    returnsModule?.collected_returns_incl ??
      returnsModule?.totals?.incl ??
      totals?.collected_returns_incl ??
      0
  );
  const derivedFinalPayable = Number(
    (
      Number(totals?.final_incl || 0) -
      collectedReturnsIncl
    ).toFixed(2)
  );

  return Number(
    totals?.final_payable_incl ??
      derivedFinalPayable ??
      order?.payment?.required_amount_incl ??
      0
  );
}

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
    const payload = body && typeof body === "object" ? body : {};
    const { orderNumber, paymentIds, paymentId } = payload;

    const normalizedOrderNumber = isMeaningfulString(orderNumber)
      ? orderNumber.trim()
      : "";

    const rawPaymentIds = Array.isArray(paymentIds)
      ? paymentIds
      : paymentIds
        ? [paymentIds]
        : paymentId
          ? [paymentId]
          : [];

    const normalizedPaymentIds = rawPaymentIds
      .map(v => (typeof v === "string" ? v.trim() : String(v || "").trim()))
      .filter(isMeaningfulString);

    const hasOrder = Boolean(normalizedOrderNumber);
    const hasPayments = normalizedPaymentIds.length > 0;

    if (!hasOrder && !hasPayments) {
      return err(
        400,
        "Missing Input",
        "Provide at least one of: orderNumber or paymentIds."
      );
    }

    let required = 0;
    let paid = 0;
    let customerId = null;
    let remainingDue = null;

    if (hasOrder) {
      const resolvedOrderId = await resolveOrderId(normalizedOrderNumber);
      if (!resolvedOrderId) {
        return err(404, "Order Not Found", "Order could not be located.");
      }

      const orderRef = doc(db, "orders_v2", resolvedOrderId);
      const orderSnap = await getDoc(orderRef);
      if (!orderSnap.exists()) {
        return err(404, "Order Not Found", "Order could not be located.");
      }

      const order = orderSnap.data();
      required = getOrderRequiredIncl(order);
      paid = Number(order?.payment?.paid_amount_incl || 0);
      customerId =
        order?.meta?.orderedFor ||
        order?.order?.customerId ||
        null;
      remainingDue = r2(required - paid);
    }

    let allocatedTotal = 0;
    let selectedPaymentsTotal = 0;

    const paymentSummaries = [];

    const uniquePaymentIds = hasPayments ? [...new Set(normalizedPaymentIds)] : [];

    for (const paymentId of uniquePaymentIds) {
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
          remaining_amount_incl: Number(payment?.payment?.remaining_amount_incl || 0),
          status: "customer_mismatch"
        });
        continue;
      }

      const paymentRemaining = Number(payment?.payment?.remaining_amount_incl || 0);
      selectedPaymentsTotal = r2(selectedPaymentsTotal + Math.max(paymentRemaining, 0));
      const usable = hasOrder
        ? r2(Math.max(0, Math.min(paymentRemaining, remainingDue)))
        : r2(Math.max(paymentRemaining, 0));

      allocatedTotal = r2(allocatedTotal + usable);
      if (hasOrder) {
        remainingDue = r2(remainingDue - usable);
      }

      paymentSummaries.push({
        paymentId,
        usable_amount_incl: usable,
        remaining_amount_incl: paymentRemaining,
        status: paymentRemaining > 0 ? "ok" : "no_funds"
      });
    }

    return ok({
      orderNumber: hasOrder ? normalizedOrderNumber : null,
      required_amount_incl: hasOrder ? r2(required) : null,
      already_paid_incl: hasOrder ? r2(paid) : null,
      selected_payments_total_incl: selectedPaymentsTotal,
      allocatable_selected_total_incl: allocatedTotal,
      remaining_due_incl: hasOrder ? remainingDue : null,
      additional_needed_incl: hasOrder ? (remainingDue > 0 ? remainingDue : 0) : null,
      max_additional_allocatable_incl: hasOrder ? (remainingDue > 0 ? remainingDue : 0) : null,
      can_cover: hasOrder ? remainingDue <= 0 : null,
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
