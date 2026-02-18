export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  updateDoc,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, s = 200) =>
  NextResponse.json({ ok: true, data }, { status: s });

const err = (s, title, message) =>
  NextResponse.json({ ok: false, title, message }, { status: s });

const PAGE_SIZE = 50;

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && Object.keys(value).length === 0) return true;
  return false;
}

async function resolveAccessType(userId) {
  if (!userId) return null;
  const snap = await getDoc(doc(db, "users", userId));
  if (snap.exists()) return snap.data()?.system?.accessType || null;

  const q = query(collection(db, "users"), where("uid", "==", userId));
  const match = await getDocs(q);
  if (match.empty) return null;
  return match.docs[0]?.data()?.system?.accessType || null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function canCancelOrder(order) {
  const orderStatus = order?.order?.status?.order || null;
  const paymentStatus =
    order?.payment?.status || order?.order?.status?.payment || null;

  if (
    orderStatus === "processing" ||
    orderStatus === "dispatched" ||
    orderStatus === "completed" ||
    orderStatus === "cancelled"
  )
    return false;
  if (paymentStatus === "refunded" || paymentStatus === "partial_refund")
    return false;

  return true;
}

function buildRefundSummary(order) {
  const payment = order?.payment || {};
  const attempts = Array.isArray(payment.attempts) ? payment.attempts : [];
  const entries = attempts.filter(a =>
    a?.type === "refund" ||
    a?.status === "refunded" ||
    a?.refund === true ||
    a?.refund_status
  ).map(a => ({
    amount_incl: Number(a?.amount_incl || 0),
    status: a?.status || null,
    createdAt: a?.createdAt || null,
    originalPaymentId: a?.originalPaymentId || null,
    provider: a?.provider || null,
    transactionId: a?.peachTransactionId || a?.transactionId || null
  })).sort((a, b) => {
    const aTime = parseDate(a.createdAt)?.getTime() || 0;
    const bTime = parseDate(b.createdAt)?.getTime() || 0;
    return bTime - aTime;
  }).map((entry, index) => ({
    refund_index: index + 1,
    ...entry
  }));

  const totalAmountIncl = entries.reduce(
    (sum, entry) => sum + Number(entry.amount_incl || 0),
    0
  );

  const paymentStatus = payment?.status || order?.order?.status?.payment || null;

  return {
    has_refund: entries.length > 0 || paymentStatus === "refunded",
    status: paymentStatus === "refunded" ? "refunded" : "none",
    total_amount_incl: Number(totalAmountIncl.toFixed(2)),
    entries
  };
}

function normalizeReturns(order) {
  const returnsModule = order?.returns || null;
  if (!returnsModule) {
    return {
      ...order,
      returns: {
        returnables: [],
        totals: { excl: 0, vat: 0, incl: 0 },
        collected_returns_incl: 0
      }
    };
  }
  const returnables = Array.isArray(returnsModule.returnables)
    ? returnsModule.returnables
    : [];
  return {
    ...order,
    returns: {
      ...returnsModule,
      returnables,
      totals: returnsModule.totals || { excl: 0, vat: 0, incl: 0 },
      collected_returns_incl: returnsModule.collected_returns_incl || 0
    }
  };
}

function withFinalPayableTotal(order) {
  const totals = order?.totals || {};
  const returnsModule = order?.returns || {};
  const collectedReturnsIncl = Number(
    returnsModule?.collected_returns_incl ??
      returnsModule?.totals?.incl ??
      totals?.collected_returns_incl ??
      0
  );
  const finalIncl = Number(totals?.final_incl || 0);
  const finalPayableIncl = Number((finalIncl - collectedReturnsIncl).toFixed(2));

  return {
    ...order,
    totals: {
      ...totals,
      final_payable_incl: finalPayableIncl
    }
  };
}

function withIndexedPaymentHistory(order) {
  const payment = order?.payment || {};
  const attempts = Array.isArray(payment?.attempts)
    ? payment.attempts.map((attempt, index) => ({
        payment_attempt_index: index + 1,
        ...attempt
      }))
    : [];
  const manualPayments = Array.isArray(payment?.manual_payments)
    ? payment.manual_payments.map((entry, index) => ({
        manual_payment_index: index + 1,
        ...entry
      }))
    : [];

  return {
    ...order,
    payment: {
      ...payment,
      attempts,
      manual_payments: manualPayments
    }
  };
}

function buildOrderSummary(totals = {}) {
  const pricingAdjustment = Number(
    totals?.pricing_adjustment?.amount_excl ??
      totals?.pricing_adjustment?.amountExcl ??
      0
  );
  const creditApplied = Number(totals?.credit?.applied ?? 0);

  return {
    subtotal_excl: Number(totals?.subtotal_excl || 0),
    delivery_fee_excl: Number(totals?.delivery_fee_excl || 0),
    vat_total: Number(totals?.vat_total || 0),
    pricing_adjustment_excl: pricingAdjustment,
    credit_applied_incl: creditApplied,
    final_incl: Number(totals?.final_incl || 0)
  };
}

function withCancelFlag(order) {
  const normalizedOrder = withIndexedPaymentHistory(
    withFinalPayableTotal(normalizeReturns(order))
  );
  return {
    ...normalizedOrder,
    can_cancel: canCancelOrder(normalizedOrder),
    refund_summary: buildRefundSummary(normalizedOrder),
    order_summary: buildOrderSummary(normalizedOrder?.totals)
  };
}

function matchesFilters(order, filters) {
  if (!filters) return true;

  const orderBlock = order?.order || {};
  const payment = order?.payment || {};
  const delivery = order?.delivery || {};
  const createdAt = parseDate(order?.timestamps?.createdAt);

  const paymentStatus = payment?.status || orderBlock?.status?.payment || null;
  const orderStatus = orderBlock?.status?.order || null;
  const fulfillmentStatus = orderBlock?.status?.fulfillment || null;

  if (filters.orderType && orderBlock.type !== filters.orderType) return false;
  if (filters.customerId && orderBlock.customerId !== filters.customerId)
    return false;
  if (filters.channel && orderBlock.channel !== filters.channel) return false;
  if (filters.paymentStatus && paymentStatus !== filters.paymentStatus)
    return false;
  if (filters.orderStatus && orderStatus !== filters.orderStatus) return false;
  if (filters.fulfillmentStatus && fulfillmentStatus !== filters.fulfillmentStatus)
    return false;
  if (filters.paymentMethod && payment.method !== filters.paymentMethod)
    return false;
  if (
    filters.deliverySpeed &&
    delivery?.speed?.type !== filters.deliverySpeed
  )
    return false;
  if (filters.orderNumber && orderBlock.orderNumber !== filters.orderNumber)
    return false;
  if (
    filters.merchantTransactionId &&
    orderBlock.merchantTransactionId !== filters.merchantTransactionId
  )
    return false;

  if (filters.createdFrom) {
    const from = parseDate(filters.createdFrom);
    if (from && (!createdAt || createdAt < from)) return false;
  }

  if (filters.createdTo) {
    const to = parseDate(filters.createdTo);
    if (to && (!createdAt || createdAt > to)) return false;
  }

  return true;
}

function needsFullCustomerSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return true;
  const hasUid = Boolean(snapshot.uid);
  const hasFullSignals = Boolean(
    snapshot.business ||
      snapshot.deliveryLocations ||
      snapshot.system ||
      snapshot.preferences ||
      snapshot.pricing ||
      snapshot.credit
  );
  return !hasUid || !hasFullSignals;
}

async function ensureFullCustomerSnapshot(orderRef, orderData) {
  const snapshot = orderData?.customer_snapshot || null;
  if (!needsFullCustomerSnapshot(snapshot)) return orderData;

  const customerId =
    snapshot?.uid ||
    snapshot?.customerId ||
    orderData?.order?.customerId ||
    null;

  if (!customerId) return orderData;

  const userSnap = await getDoc(doc(db, "users", customerId));
  if (!userSnap.exists()) return orderData;

  const fullUser = userSnap.data();
  const nextOrder = {
    ...orderData,
    customer_snapshot: fullUser
  };

  await updateDoc(orderRef, {
    customer_snapshot: fullUser,
    "timestamps.updatedAt": new Date().toISOString()
  });

  return nextOrder;
}

function buildOrdersQuery({
  userId,
  allowAll,
  filters,
  sortOrder
}) {
  const clauses = [];

  if (userId && !allowAll) {
    clauses.push(where("meta.orderedFor", "==", userId));
  }

  if (filters?.customerId) {
    clauses.push(where("order.customerId", "==", filters.customerId));
  }

  if (filters?.orderType) {
    clauses.push(where("order.type", "==", filters.orderType));
  }
  if (filters?.channel) {
    clauses.push(where("order.channel", "==", filters.channel));
  }
  if (filters?.paymentStatus) {
    clauses.push(where("order.status.payment", "==", filters.paymentStatus));
  }
  if (filters?.orderStatus) {
    clauses.push(where("order.status.order", "==", filters.orderStatus));
  }
  if (filters?.fulfillmentStatus) {
    clauses.push(where("order.status.fulfillment", "==", filters.fulfillmentStatus));
  }
  if (filters?.paymentMethod) {
    clauses.push(where("payment.method", "==", filters.paymentMethod));
  }
  if (filters?.deliverySpeed) {
    clauses.push(where("delivery.speed.type", "==", filters.deliverySpeed));
  }

  if (filters?.createdFrom) {
    const from = parseDate(filters.createdFrom);
    if (from) clauses.push(where("timestamps.createdAt", ">=", from.toISOString()));
  }
  if (filters?.createdTo) {
    const to = parseDate(filters.createdTo);
    if (to) clauses.push(where("timestamps.createdAt", "<=", to.toISOString()));
  }

  clauses.push(orderBy("timestamps.createdAt", sortOrder === "asc" ? "asc" : "desc"));

  return query(collection(db, "orders_v2"), ...clauses);
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      orderId: rawOrderId,
      orderNumber: rawOrderNumber,
      merchantTransactionId: rawMerchantTransactionId,
      userId: rawUserId,
      returnAll: rawReturnAll,
      filters: rawFilters,
      page: rawPage,
      sortOrder: rawSortOrder
    } = body || {};

    const orderId = isEmpty(rawOrderId) ? null : rawOrderId;
    const orderNumber = isEmpty(rawOrderNumber) ? null : rawOrderNumber;
    const merchantTransactionId = isEmpty(rawMerchantTransactionId)
      ? null
      : rawMerchantTransactionId;
    const userId = isEmpty(rawUserId) ? null : rawUserId;
    const accessType = userId ? await resolveAccessType(userId) : null;
    const isAdminAccess = accessType === "admin";
    const returnAll = rawReturnAll === true || rawReturnAll === "true";
    const allowAll = isAdminAccess && returnAll === true;
    const filters = isEmpty(rawFilters) ? null : rawFilters;
    const paginate = !isEmpty(rawPage);
    const page = paginate ? rawPage : 1;
    const sortOrder = isEmpty(rawSortOrder) ? "desc" : rawSortOrder;

    if (orderId) {
      const ref = doc(db, "orders_v2", orderId);
      const snap = await getDoc(ref);

      if (snap.exists()) {
        return ok({ data: withCancelFlag(snap.data()) });
      }
    }

    if (orderId) {
      const ref = doc(db, "orders_v2", orderId);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        return err(404, "Order Not Found", `No order found with id: ${orderId}`);
      }
      const orderData = await ensureFullCustomerSnapshot(ref, {
        docId: snap.id,
        ...snap.data()
      });
      return ok({ data: withCancelFlag(orderData) });
    }

    if (orderNumber || merchantTransactionId) {
      const field = orderNumber ? "order.orderNumber" : "order.merchantTransactionId";
      const value = orderNumber || merchantTransactionId;
      const ref = query(
        collection(db, "orders_v2"),
        where(field, "==", value),
        limit(1)
      );
      const snap = await getDocs(ref);
      if (snap.empty) {
        return err(
          404,
          "Order Not Found",
          "No order found with the provided reference."
        );
      }
      const docSnap = snap.docs[0];
      const orderData = await ensureFullCustomerSnapshot(docSnap.ref, {
        docId: docSnap.id,
        ...docSnap.data()
      });
      return ok({ data: withCancelFlag(orderData) });
    }

    const baseQuery = buildOrdersQuery({
      userId,
      allowAll,
      filters,
      sortOrder
    });

    const safePage = Number(page) > 0 ? Number(page) : 1;
    const pageSize = paginate ? PAGE_SIZE : null;

    let cursorDoc = null;
    if (paginate && safePage > 1) {
      const cursorSnap = await getDocs(
        query(baseQuery, limit((safePage - 1) * PAGE_SIZE))
      );
      cursorDoc = cursorSnap.docs[cursorSnap.docs.length - 1] || null;
    }

    const dataQuery = paginate
      ? query(
          baseQuery,
          ...(cursorDoc ? [startAfter(cursorDoc)] : []),
          limit(PAGE_SIZE)
        )
      : baseQuery;

    const dataSnap = await getDocs(dataQuery);
    const pageOrders = [];
    for (const docSnap of dataSnap.docs) {
      const hydrated = await ensureFullCustomerSnapshot(docSnap.ref, {
        docId: docSnap.id,
        ...docSnap.data()
      });
      pageOrders.push(withCancelFlag(hydrated));
    }

    const fullSnap = await getDocs(baseQuery);
    const filtered = fullSnap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data()
    })).map(withCancelFlag);

    const total = filtered.length;
    const totalPages = total > 0 ? (paginate ? Math.ceil(total / PAGE_SIZE) : 1) : 0;
    const start = paginate ? (safePage - 1) * PAGE_SIZE : 0;
    const pageOrdersWithIndex = pageOrders.map((order, i) => ({
      ...order,
      order_index: start + i + 1
    }));

    const pages = totalPages > 0
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : [];

    const windowStart = Math.max(1, safePage - 3);
    const windowEnd = Math.min(totalPages, safePage + 3);
    const pageWindow = totalPages > 0
      ? Array.from({ length: windowEnd - windowStart + 1 }, (_, i) => windowStart + i)
      : [];
    const moreBefore = Math.max(0, windowStart - 1);
    const moreAfter = Math.max(0, totalPages - windowEnd);

    const totals = filtered.reduce(
      (acc, o) => {
        const orderBlock = o?.order || {};
        const payment = o?.payment || {};
        const delivery = o?.delivery || {};
        const customerSnapshot = o?.customer_snapshot || {};

        const paymentStatus = payment?.status || orderBlock?.status?.payment || "unknown";
        const orderStatus = orderBlock?.status?.order || "unknown";
        const fulfillmentStatus = orderBlock?.status?.fulfillment || "unknown";

        acc.totalOrders += 1;
        if (fulfillmentStatus !== "delivered") acc.totalNotDelivered += 1;
        if (
          orderStatus !== "completed" &&
          paymentStatus !== "refunded" &&
          paymentStatus !== "partial_refund"
        ) {
          acc.totalNotCompleted += 1;
        }
        if (paymentStatus !== "paid") acc.totalPaymentNotPaid += 1;

        const orderType = orderBlock.type || "unknown";
        acc.orderTypeCounts[orderType] =
          (acc.orderTypeCounts[orderType] || 0) + 1;

        const channel = orderBlock.channel || "unknown";
        acc.channelCounts[channel] =
          (acc.channelCounts[channel] || 0) + 1;

        acc.paymentStatusCounts[paymentStatus] =
          (acc.paymentStatusCounts[paymentStatus] || 0) + 1;

        acc.orderStatusCounts[orderStatus] =
          (acc.orderStatusCounts[orderStatus] || 0) + 1;

        acc.fulfillmentStatusCounts[fulfillmentStatus] =
          (acc.fulfillmentStatusCounts[fulfillmentStatus] || 0) + 1;

        const paymentMethod = payment?.method || "unknown";
        acc.paymentMethodCounts[paymentMethod] =
          (acc.paymentMethodCounts[paymentMethod] || 0) + 1;

        const deliverySpeed = delivery?.speed?.type || "unknown";
        acc.deliverySpeedCounts[deliverySpeed] =
          (acc.deliverySpeedCounts[deliverySpeed] || 0) + 1;

        const accountType =
          customerSnapshot?.account?.type ||
          customerSnapshot?.account?.accountType ||
          orderBlock?.type ||
          "unknown";
        acc.accountTypeCounts[accountType] =
          (acc.accountTypeCounts[accountType] || 0) + 1;

        const finalIncl = Number(o?.totals?.final_incl || 0);
        const deliveryFeeIncl = Number(o?.totals?.delivery_fee_incl || 0);
        const paidAmountIncl = Number(payment?.paid_amount_incl || 0);
        const requiredAmountIncl = Number(
          o?.payment?.required_amount_incl ??
          o?.totals?.final_incl ??
          0
        );
        const outstandingIncl =
          paymentStatus === "refunded" ||
          paymentStatus === "partial_refund" ||
          orderStatus === "cancelled"
            ? 0
            : Math.max(requiredAmountIncl - paidAmountIncl, 0);

        acc.sumFinalIncl = Number((acc.sumFinalIncl + finalIncl).toFixed(2));
        acc.sumDeliveryFeeIncl = Number(
          (acc.sumDeliveryFeeIncl + deliveryFeeIncl).toFixed(2)
        );
        acc.sumPaidIncl = Number((acc.sumPaidIncl + paidAmountIncl).toFixed(2));
        acc.totalOutstandingIncl = Number(
          (acc.totalOutstandingIncl + outstandingIncl).toFixed(2)
        );

        return acc;
      },
      {
        totalOrders: 0,
        totalNotDelivered: 0,
        totalNotCompleted: 0,
        totalPaymentNotPaid: 0,
        orderTypeCounts: {},
        channelCounts: {},
        paymentStatusCounts: {},
        orderStatusCounts: {},
        fulfillmentStatusCounts: {},
        paymentMethodCounts: {},
        deliverySpeedCounts: {},
        accountTypeCounts: {},
        sumFinalIncl: 0,
        sumDeliveryFeeIncl: 0,
        sumPaidIncl: 0,
        totalOutstandingIncl: 0
      }
    );

    return ok({
      data: pageOrdersWithIndex,
      totals,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
        pages,
        pageWindow,
        moreBefore,
        moreAfter
      }
    });

  } catch (e) {
    return err(
      500,
      "Fetch Failed",
      e?.message || "Unexpected error fetching orders_v2"
    );
  }
}
