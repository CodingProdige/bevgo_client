export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
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
const isMeaningfulString = value =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.trim().toLowerCase() !== "null" &&
  value.trim().toLowerCase() !== "undefined";

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
    (Number(totals?.final_incl || 0) - collectedReturnsIncl).toFixed(2)
  );
  return Number(
    totals?.final_payable_incl ??
      derivedFinalPayable ??
      order?.payment?.required_amount_incl ??
      0
  );
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const payload = body && typeof body === "object" ? body : {};
    const { orderNumber, paymentIds } = payload;
    const normalizedOrderNumber = isMeaningfulString(orderNumber)
      ? orderNumber.trim()
      : "";
    const normalizedPaymentIds = (Array.isArray(paymentIds) ? paymentIds : [])
      .map(id => (typeof id === "string" ? id.trim() : String(id || "").trim()))
      .filter(isMeaningfulString);
    const uniquePaymentIds = [...new Set(normalizedPaymentIds)];

    if (!normalizedOrderNumber) {
      return err(400, "Missing Input", "orderNumber is required.");
    }

    if (uniquePaymentIds.length === 0) {
      return err(400, "Missing Input", "paymentIds must be a non-empty array.");
    }

    const resolvedOrderId = await resolveOrderId(normalizedOrderNumber);
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const orderRef = doc(db, "orders_v2", resolvedOrderId);
    const orderSnap = await getDoc(orderRef);
    if (!orderSnap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const result = await runTransaction(db, async tx => {
      const txOrderSnap = await tx.get(orderRef);
      if (!txOrderSnap.exists()) {
        throw {
          code: 404,
          title: "Order Not Found",
          message: "Order could not be located."
        };
      }

      const order = txOrderSnap.data();
      const orderStatus = order?.order?.status?.order || null;
      const orderPaymentStatus = order?.payment?.status || order?.order?.status?.payment || null;
      if (orderStatus === "cancelled") {
        throw {
          code: 409,
          title: "Invalid Order State",
          message: "Cannot allocate payments to a cancelled order."
        };
      }
      if (orderPaymentStatus === "refunded" || orderPaymentStatus === "partial_refund") {
        throw {
          code: 409,
          title: "Invalid Order State",
          message: "Cannot allocate payments to a refunded order."
        };
      }

      const required = getOrderRequiredIncl(order);
      const paid = Number(order?.payment?.paid_amount_incl || 0);
      let remainingDue = r2(required - paid);

      if (remainingDue <= 0) {
        return {
          orderNumber: normalizedOrderNumber,
          status: "already_paid",
          allocated_total_incl: 0,
          remaining_due_incl: 0,
          payment_status: computeOrderPaymentStatus(required, paid),
          allocations: []
        };
      }

      const customerId =
        order?.meta?.orderedFor ||
        order?.order?.customerId ||
        null;
      const orderCurrency = String(order?.payment?.currency || "ZAR").trim();
      const manualPayments = Array.isArray(order?.payment?.manual_payments)
        ? [...order.payment.manual_payments]
        : [];

      const allocationResults = [];
      let allocatedTotal = 0;
      const transactionTime = now();

      for (const paymentId of uniquePaymentIds) {
        if (remainingDue <= 0) break;
        const payRef = doc(db, "payments_v2", paymentId);
        const paySnap = await tx.get(payRef);

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

        const paymentCurrency = String(payment?.payment?.currency || "ZAR").trim();
        if (paymentCurrency !== orderCurrency) {
          allocationResults.push({
            paymentId,
            allocated_incl: 0,
            remaining_amount_incl: Number(payment?.payment?.remaining_amount_incl || 0),
            status: "currency_mismatch"
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
          orderNumber: normalizedOrderNumber,
          amount_incl: allocate,
          allocatedAt: transactionTime
        };

        tx.update(payRef, {
          "payment.remaining_amount_incl": nextRemaining,
          "payment.status": nextStatus,
          "allocations": [...(payment?.allocations || []), allocationEntry],
          "timestamps.updatedAt": transactionTime
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

      tx.update(orderRef, {
        "payment.paid_amount_incl": nextPaid,
        "payment.status": paymentStatus,
        "order.status.payment": paymentStatus,
        "payment.manual_payments": manualPayments,
        "timestamps.updatedAt": transactionTime
      });

      return {
        orderNumber: normalizedOrderNumber,
        allocated_total_incl: allocatedTotal,
        remaining_due_incl: r2(required - nextPaid),
        payment_status: paymentStatus,
        allocations: allocationResults
      };
    });

    return ok(result);
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Allocation Failed",
      e?.message ?? "Unexpected error allocating payments."
    );
  }
}
