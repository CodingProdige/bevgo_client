export const runtime = "nodejs";

import { NextResponse } from "next/server";
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

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const now = () => new Date().toISOString();
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

function computeOrderPaymentStatus(required, paid) {
  if (paid <= 0) return "unpaid";
  if (paid + 0.0001 >= required) return "paid";
  return "partial";
}

function computePaymentStatus(amountIncl, remainingIncl) {
  if (remainingIncl <= 0) return "allocated";
  if (remainingIncl >= amountIncl) return "unallocated";
  return "partially_allocated";
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
    let remainingDue = r2(required - paid);

    if (remainingDue <= 0) {
      return ok({
        orderNumber,
        status: "already_paid",
        remaining_due_incl: 0
      });
    }

    const customerId = order?.order?.customerId || null;
    const manualPayments = Array.isArray(order?.payment?.manual_payments)
      ? order.payment.manual_payments
      : [];

    const paymentUpdates = [];
    const allocationResults = [];
    let allocatedTotal = 0;

    for (const paymentId of paymentIds) {
      if (remainingDue <= 0) break;

      const payRef = doc(db, "payments_v2", paymentId);
      const paySnap = await getDoc(payRef);
      if (!paySnap.exists()) {
        allocationResults.push({
          paymentId,
          allocated_incl: 0,
          remaining_amount_incl: null,
          status: "not_found"
        });
        continue;
      }

      const payment = paySnap.data();
      if (customerId && payment?.customer?.customerId !== customerId) {
        allocationResults.push({
          paymentId,
          allocated_incl: 0,
          remaining_amount_incl: payment?.payment?.remaining_amount_incl ?? null,
          status: "customer_mismatch"
        });
        continue;
      }

      const paymentRemaining = Number(payment?.payment?.remaining_amount_incl || 0);
      if (paymentRemaining <= 0) {
        allocationResults.push({
          paymentId,
          allocated_incl: 0,
          remaining_amount_incl: paymentRemaining,
          status: "no_funds"
        });
        continue;
      }

      const allocate = r2(Math.min(paymentRemaining, remainingDue));
      const nextRemaining = r2(paymentRemaining - allocate);
      const nextStatus = computePaymentStatus(
        Number(payment?.payment?.amount_incl || 0),
        nextRemaining
      );

      const allocationEntry = {
        orderId: resolvedOrderId,
        orderNumber,
        amount_incl: allocate,
        allocatedAt: now()
      };

      paymentUpdates.push({
        ref: payRef,
        update: {
          "payment.remaining_amount_incl": nextRemaining,
          "payment.status": nextStatus,
          "allocations": [...(payment?.allocations || []), allocationEntry],
          "timestamps.updatedAt": now()
        }
      });

      manualPayments.push({
        paymentId,
        amount_incl: allocate,
        method: payment?.payment?.method || null,
        reference: payment?.payment?.reference || null,
        allocatedAt: allocationEntry.allocatedAt
      });

      remainingDue = r2(remainingDue - allocate);
      allocatedTotal = r2(allocatedTotal + allocate);

      allocationResults.push({
        paymentId,
        allocated_incl: allocate,
        remaining_amount_incl: nextRemaining,
        status: nextStatus
      });
    }

    const nextPaid = r2(paid + allocatedTotal);
    const paymentStatus = computeOrderPaymentStatus(required, nextPaid);

    await updateDoc(orderRef, {
      "payment.paid_amount_incl": nextPaid,
      "payment.status": paymentStatus,
      "order.status.payment": paymentStatus,
      "payment.manual_payments": manualPayments,
      "timestamps.updatedAt": now()
    });

    for (const update of paymentUpdates) {
      await updateDoc(update.ref, update.update);
    }

    return ok({
      orderNumber,
      allocated_total_incl: allocatedTotal,
      remaining_due_incl: r2(required - nextPaid),
      payment_status: paymentStatus,
      allocations: allocationResults
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Allocation Failed",
      e?.message ?? "Unexpected error allocating payments."
    );
  }
}
