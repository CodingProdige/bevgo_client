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

function withCancelFlag(order) {
  return {
    ...order,
    can_cancel: canCancelOrder(order),
    refund_summary: buildRefundSummary(order)
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

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      orderId: rawOrderId,
      orderNumber: rawOrderNumber,
      merchantTransactionId: rawMerchantTransactionId,
      userId: rawUserId,
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
    const isAdmin = accessType === "admin";
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

    const snap = await getDocs(collection(db, "orders_v2"));

    const orders = snap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data() // 🔥 FULL RAW DOCUMENT
    })).map(withCancelFlag);

    if (orderId) {
      const match = orders.find(
        o => o?.order?.orderId === orderId || o?.docId === orderId
      );

      if (!match) {
        return err(404, "Order Not Found", `No order found with id: ${orderId}`);
      }

      return ok({ data: match });
    }

    if (orderNumber || merchantTransactionId) {
      const match = orders.find(
        o =>
          (orderNumber && o?.order?.orderNumber === orderNumber) ||
          (merchantTransactionId &&
            o?.order?.merchantTransactionId === merchantTransactionId)
      );

      if (!match) {
        return err(
          404,
          "Order Not Found",
          "No order found with the provided reference."
        );
      }

      return ok({ data: match });
    }

    const filtered = orders.filter(o => {
      if (userId && !isAdmin && o?.order?.customerId !== userId) return false;
      return matchesFilters(o, filters);
    });

    filtered.sort((a, b) => {
      const aTime = parseDate(a?.timestamps?.createdAt)?.getTime() || 0;
      const bTime = parseDate(b?.timestamps?.createdAt)?.getTime() || 0;
      return sortOrder === "asc" ? aTime - bTime : bTime - aTime;
    });

    const safePage = Number(page) > 0 ? Number(page) : 1;
    const total = filtered.length;
    const pageSize = paginate ? PAGE_SIZE : total;
    const totalPages = total > 0 ? (paginate ? Math.ceil(total / PAGE_SIZE) : 1) : 0;
    const start = paginate ? (safePage - 1) * PAGE_SIZE : 0;
    const end = paginate ? start + PAGE_SIZE : total;
    const pageOrders = start < total ? filtered.slice(start, end) : [];
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

        acc.sumFinalIncl = Number((acc.sumFinalIncl + finalIncl).toFixed(2));
        acc.sumDeliveryFeeIncl = Number(
          (acc.sumDeliveryFeeIncl + deliveryFeeIncl).toFixed(2)
        );
        acc.sumPaidIncl = Number((acc.sumPaidIncl + paidAmountIncl).toFixed(2));

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
        sumPaidIncl: 0
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
