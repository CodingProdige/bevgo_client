export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  getDocs
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

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getCustomerId(order) {
  return (
    order?.order?.customerId ||
    order?.customer_snapshot?.customerId ||
    order?.customer_snapshot?.uid ||
    null
  );
}

function getCustomerCode(order) {
  const account = order?.customer_snapshot?.account || {};
  return (
    account.customerCode ||
    account.customer_code ||
    account.companyCode ||
    account.company_code ||
    null
  );
}

function matchesCustomer(order, userId, customerCode) {
  const orderCustomerId = getCustomerId(order);
  const snapshotCustomerId = order?.customer_snapshot?.customerId || null;
  const accountCode = getCustomerCode(order);

  if (userId && orderCustomerId !== userId && snapshotCustomerId !== userId)
    return false;

  if (customerCode) {
    if (
      accountCode !== customerCode &&
      orderCustomerId !== customerCode &&
      snapshotCustomerId !== customerCode
    ) {
      return false;
    }
  }

  return true;
}

function getRentalCustomerId(rental) {
  return (
    rental?.customerId ||
    rental?.customer_snapshot?.uid ||
    null
  );
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

function toNum(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function getRefundIncl(order) {
  const paymentStatus =
    order?.payment?.status || order?.order?.status?.payment || "unknown";
  if (paymentStatus !== "refunded" && paymentStatus !== "partial_refund") return 0;
  const refundAmount = toNum(order?.payment?.refund_amount_incl);
  if (refundAmount > 0) return refundAmount;
  return toNum(order?.payment?.paid_amount_incl);
}

function pctChange(current, previous) {
  if (!previous) return "→ +0%";
  const value = (((current - previous) / previous) * 100);
  const fixed = value.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, "");
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "+";
  return `${arrow} ${sign}${trimmed}%`;
}

function buildTotals(orders) {
  return orders.reduce(
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
      if (paymentStatus === "refunded" || paymentStatus === "partial_refund") {
        acc.totalRefundedOrders += 1;
      }

      const orderType = orderBlock.type || "unknown";
      acc.orderTypeCounts[orderType] =
        (acc.orderTypeCounts[orderType] || 0) + 1;

      const channel = orderBlock.channel || "unknown";
      acc.channelCounts[channel] =
        (acc.channelCounts[channel] || 0) + 1;

      acc.paymentStatusCounts[paymentStatus] =
        (acc.paymentStatusCounts[paymentStatus] || 0) + 1;
      if (paymentStatus === "refunded" || paymentStatus === "partial_refund") {
        acc.refundStatusCounts[paymentStatus] =
          (acc.refundStatusCounts[paymentStatus] || 0) + 1;
      }

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

      const finalIncl = toNum(o?.totals?.final_incl);
      const deliveryFeeIncl = toNum(o?.totals?.delivery_fee_incl);
      const paidAmountIncl = toNum(payment?.paid_amount_incl);
      const refundAmountIncl = toNum(payment?.refund_amount_incl);
      const refundFallbackIncl =
        paymentStatus === "refunded" ? paidAmountIncl : 0;

      acc.sumFinalIncl = Number((acc.sumFinalIncl + finalIncl).toFixed(2));
      acc.sumDeliveryFeeIncl = Number(
        (acc.sumDeliveryFeeIncl + deliveryFeeIncl).toFixed(2)
      );
      acc.sumPaidIncl = Number((acc.sumPaidIncl + paidAmountIncl).toFixed(2));
      acc.sumRefundedIncl = Number(
        (acc.sumRefundedIncl + (refundAmountIncl || refundFallbackIncl)).toFixed(2)
      );

      return acc;
    },
    {
      totalOrders: 0,
      totalNotDelivered: 0,
      totalNotCompleted: 0,
      totalPaymentNotPaid: 0,
      totalRefundedOrders: 0,
      orderTypeCounts: {},
      channelCounts: {},
      paymentStatusCounts: {},
      refundStatusCounts: {},
      orderStatusCounts: {},
      fulfillmentStatusCounts: {},
      paymentMethodCounts: {},
      deliverySpeedCounts: {},
      accountTypeCounts: {},
      sumFinalIncl: 0,
      sumDeliveryFeeIncl: 0,
      sumPaidIncl: 0,
      sumRefundedIncl: 0
    }
  );
}

function buildMonthlySeries(orders, months = 12, offsetMonths = 0) {
  const now = new Date();
  const series = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(
      now.getFullYear(),
      now.getMonth() - i - offsetMonths,
      1
    );
    const year = d.getFullYear();
    const month = d.getMonth();
    const key = `${year}-${String(month + 1).padStart(2, "0")}`;
    series.push({
      key,
      year,
      month: month + 1,
      orderCount: 0,
      sumFinalIncl: 0,
      sumPaidIncl: 0,
      sumRefundedIncl: 0
    });
  }

  const indexByKey = new Map(series.map((row, idx) => [row.key, idx]));

  for (const order of orders) {
    const createdAt = parseDate(order?.timestamps?.createdAt);
    if (!createdAt) continue;
    const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
    const idx = indexByKey.get(key);
    if (idx === undefined) continue;

    const finalIncl = toNum(order?.totals?.final_incl);
    const paidIncl = toNum(order?.payment?.paid_amount_incl);
    const refundIncl = getRefundIncl(order);

    series[idx].orderCount += 1;
    series[idx].sumFinalIncl = Number(
      (series[idx].sumFinalIncl + finalIncl).toFixed(2)
    );
    series[idx].sumPaidIncl = Number(
      (series[idx].sumPaidIncl + paidIncl).toFixed(2)
    );
    series[idx].sumRefundedIncl = Number(
      (series[idx].sumRefundedIncl + refundIncl).toFixed(2)
    );
  }

  return series;
}

function buildDailySeries(orders, startDate) {
  const year = startDate.getFullYear();
  const month = startDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const series = [];

  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    series.push({
      key,
      day,
      orderCount: 0,
      sumFinalIncl: 0,
      sumPaidIncl: 0,
      sumRefundedIncl: 0
    });
  }

  const indexByKey = new Map(series.map((row, idx) => [row.key, idx]));

  for (const order of orders) {
    const createdAt = parseDate(order?.timestamps?.createdAt);
    if (!createdAt) continue;
    if (createdAt.getFullYear() !== year || createdAt.getMonth() !== month) {
      continue;
    }
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(createdAt.getDate()).padStart(2, "0")}`;
    const idx = indexByKey.get(key);
    if (idx === undefined) continue;

    const finalIncl = toNum(order?.totals?.final_incl);
    const paidIncl = toNum(order?.payment?.paid_amount_incl);
    const refundIncl = getRefundIncl(order);

    series[idx].orderCount += 1;
    series[idx].sumFinalIncl = Number(
      (series[idx].sumFinalIncl + finalIncl).toFixed(2)
    );
    series[idx].sumPaidIncl = Number(
      (series[idx].sumPaidIncl + paidIncl).toFixed(2)
    );
    series[idx].sumRefundedIncl = Number(
      (series[idx].sumRefundedIncl + refundIncl).toFixed(2)
    );
  }

  return series;
}

function buildRentalAnalytics(rentals) {
  return rentals.reduce(
    (acc, r) => {
      acc.totalRentals += 1;
      const qty = toNum(r?.quantity || 0);
      acc.totalQuantity += qty;

      const status = r?.billing?.status || "unknown";
      acc.billingStatusCounts[status] =
        (acc.billingStatusCounts[status] || 0) + 1;

      const cadence = r?.billing?.cadence || r?.billing?.billing_period || "unknown";
      acc.billingCadenceCounts[cadence] =
        (acc.billingCadenceCounts[cadence] || 0) + 1;

      return acc;
    },
    {
      totalRentals: 0,
      totalQuantity: 0,
      billingStatusCounts: {},
      billingCadenceCounts: {}
    }
  );
}

function buildRentalBillingAnalytics(rentals, options = {}) {
  const { page = 1, paginate = false } = options;
  const history = [];

  const summary = rentals.reduce(
    (acc, r) => {
      const attempts = Array.isArray(r?.billing?.attempts)
        ? r.billing.attempts
        : [];
      for (const a of attempts) {
        acc.totalAttempts += 1;
        const status = a?.status || "unknown";
        acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;

        if (a?.type) {
          acc.typeCounts[a.type] = (acc.typeCounts[a.type] || 0) + 1;
        }

        const amountIncl = toNum(a?.amount_incl);
        if (status === "charged") {
          if (amountIncl > 0) {
            acc.sumAmountIncl = Number(
              (acc.sumAmountIncl + amountIncl).toFixed(2)
            );
          }

          history.push({
            rentalId: r?.rentalId || r?.docId || null,
            orderId: r?.orderId || null,
            orderNumber: r?.orderNumber || null,
            status,
            type: a?.type || null,
            periodKey: a?.periodKey || null,
            amount_incl: amountIncl,
            currency: a?.currency || r?.billing?.currency || "ZAR",
            createdAt: a?.createdAt || null
          });
        }
      }

      if (r?.billing?.lastChargedAt) {
        acc.lastChargedAt =
          !acc.lastChargedAt ||
          r.billing.lastChargedAt > acc.lastChargedAt
            ? r.billing.lastChargedAt
            : acc.lastChargedAt;
      }

      if (r?.billing?.nextChargeAt) {
        acc.nextChargeAt =
          !acc.nextChargeAt ||
          r.billing.nextChargeAt < acc.nextChargeAt
            ? r.billing.nextChargeAt
            : acc.nextChargeAt;
      }

      return acc;
    },
    {
      totalAttempts: 0,
      sumAmountIncl: 0,
      statusCounts: {},
      typeCounts: {},
      lastChargedAt: null,
      nextChargeAt: null
    }
  );

  history.sort((a, b) => {
    const aTime = parseDate(a.createdAt)?.getTime() || 0;
    const bTime = parseDate(b.createdAt)?.getTime() || 0;
    return bTime - aTime;
  });

  const safePage = Number(page) > 0 ? Number(page) : 1;
  const total = history.length;
  const pageSize = paginate ? PAGE_SIZE : total;
  const totalPages = total > 0 ? (paginate ? Math.ceil(total / PAGE_SIZE) : 1) : 0;
  const start = paginate ? (safePage - 1) * PAGE_SIZE : 0;
  const end = paginate ? start + PAGE_SIZE : total;
  const pageHistory = start < total ? history.slice(start, end) : [];
  const pageHistoryWithIndex = pageHistory.map((item, i) => ({
    ...item,
    attempt_index: start + i + 1
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

  return {
    ...summary,
    history: pageHistoryWithIndex,
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
  };
}

function getRentalCreatedAt(rental) {
  return parseDate(rental?.timestamps?.createdAt) || null;
}

function buildQuickChartUrl(config, width = 800, height = 400) {
  const base = "https://quickchart.io/chart";
  const params = new URLSearchParams({
    c: JSON.stringify(config),
    w: String(width),
    h: String(height),
    bkg: "white"
  });
  return `${base}?${params.toString()}`;
}

function baseChartOptions() {
  return {
    plugins: {
      legend: {
        display: true,
        labels: {
          color: "#0f172a",
          font: { family: "Inter, Arial, sans-serif", size: 12, weight: "600" },
          boxWidth: 12,
          boxHeight: 12
        }
      },
      tooltip: {
        backgroundColor: "rgba(15, 23, 42, 0.95)",
        titleColor: "#e2e8f0",
        bodyColor: "#e2e8f0",
        borderColor: "#334155",
        borderWidth: 1
      }
    },
    layout: { padding: 16 },
    scales: {
      x: {
        grid: { color: "rgba(148, 163, 184, 0.25)" },
        ticks: { color: "#334155", font: { size: 11 } }
      },
      y: {
        beginAtZero: true,
        grid: { color: "rgba(148, 163, 184, 0.25)" },
        ticks: { color: "#334155", font: { size: 11 } }
      }
    }
  };
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      customerCode: rawCustomerCode,
      userId: rawUserId,
      filters: rawFilters,
      ordersPage: rawOrdersPage,
      rentalsPage: rawRentalsPage,
      rentalAttemptsPage: rawRentalAttemptsPage,
      sortOrder: rawSortOrder
    } = body || {};

    const customerCode = isEmpty(rawCustomerCode) ? null : rawCustomerCode;
    const userId = isEmpty(rawUserId) ? null : rawUserId;
    const filters = isEmpty(rawFilters) ? null : rawFilters;
    const paginate = !isEmpty(rawOrdersPage);
    const page = paginate ? rawOrdersPage : 1;
    const rentalsPaginate = !isEmpty(rawRentalsPage);
    const rentalsPage = rentalsPaginate ? rawRentalsPage : 1;
    const rentalAttemptsPaginate = !isEmpty(rawRentalAttemptsPage);
    const rentalAttemptsPage = rentalAttemptsPaginate ? rawRentalAttemptsPage : 1;
    const sortOrder = isEmpty(rawSortOrder) ? "desc" : rawSortOrder;

    if (!customerCode && !userId) {
      return err(400, "Missing Parameters", "customerCode or userId is required.");
    }

    const orderSnap = await getDocs(collection(db, "orders_v2"));
    const orders = orderSnap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data()
    }));

    const rentalSnap = await getDocs(collection(db, "rentals_v2"));
    const rentals = rentalSnap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data()
    }));

    const filtered = orders.filter(o => {
      if (!matchesCustomer(o, userId, customerCode)) return false;
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

    const totals = buildTotals(filtered);

    const filteredRentals = rentals.filter(r => {
      const rentalCustomerId = getRentalCustomerId(r);
      const rentalAccountCode = getCustomerCode(r);

      if (userId && rentalCustomerId !== userId) return false;
      if (customerCode) {
        if (rentalAccountCode !== customerCode && rentalCustomerId !== customerCode) {
          return false;
        }
      }
      return true;
    });

    filteredRentals.sort((a, b) => {
      const aTime = getRentalCreatedAt(a)?.getTime() || 0;
      const bTime = getRentalCreatedAt(b)?.getTime() || 0;
      return sortOrder === "asc" ? aTime - bTime : bTime - aTime;
    });

    const rentalsTotal = filteredRentals.length;
    const safeRentalsPage = Number(rentalsPage) > 0 ? Number(rentalsPage) : 1;
    const rentalsPageSize = rentalsPaginate ? PAGE_SIZE : rentalsTotal;
    const rentalsTotalPages =
      rentalsTotal > 0
        ? (rentalsPaginate ? Math.ceil(rentalsTotal / PAGE_SIZE) : 1)
        : 0;
    const rentalsStart = rentalsPaginate ? (safeRentalsPage - 1) * PAGE_SIZE : 0;
    const rentalsEnd = rentalsPaginate ? rentalsStart + PAGE_SIZE : rentalsTotal;
    const pageRentals =
      rentalsStart < rentalsTotal
        ? filteredRentals.slice(rentalsStart, rentalsEnd)
        : [];
    const pageRentalsWithIndex = pageRentals.map((rental, i) => ({
      ...rental,
      rental_index: rentalsStart + i + 1
    }));

    const rentalsPages = rentalsTotalPages > 0
      ? Array.from({ length: rentalsTotalPages }, (_, i) => i + 1)
      : [];

    const rentalsWindowStart = Math.max(1, safeRentalsPage - 3);
    const rentalsWindowEnd = Math.min(rentalsTotalPages, safeRentalsPage + 3);
    const rentalsPageWindow = rentalsTotalPages > 0
      ? Array.from({ length: rentalsWindowEnd - rentalsWindowStart + 1 }, (_, i) => rentalsWindowStart + i)
      : [];
    const rentalsMoreBefore = Math.max(0, rentalsWindowStart - 1);
    const rentalsMoreAfter = Math.max(0, rentalsTotalPages - rentalsWindowEnd);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const startOfYear = new Date(now);
    startOfYear.setFullYear(now.getFullYear() - 1);
    const startOfPrevYear = new Date(now);
    startOfPrevYear.setFullYear(now.getFullYear() - 2);

    let firstOrderAt = null;
    let lastOrderAt = null;

    const spend = {
      currentMonth: {
        orderCount: 0,
        sumFinalIncl: 0,
        sumPaidIncl: 0,
        sumRefundedIncl: 0
      },
      previousMonth: {
        orderCount: 0,
        sumFinalIncl: 0,
        sumPaidIncl: 0,
        sumRefundedIncl: 0
      },
      last12Months: {
        orderCount: 0,
        sumFinalIncl: 0,
        sumPaidIncl: 0,
        sumRefundedIncl: 0
      },
      previous12Months: {
        orderCount: 0,
        sumFinalIncl: 0,
        sumPaidIncl: 0,
        sumRefundedIncl: 0
      }
    };

    for (const order of filtered) {
      const createdAt = parseDate(order?.timestamps?.createdAt);
      const finalIncl = toNum(order?.totals?.final_incl);
      const paidIncl = toNum(order?.payment?.paid_amount_incl);
      const paymentStatus =
        order?.payment?.status || order?.order?.status?.payment || "unknown";
      const refundIncl =
        paymentStatus === "refunded" || paymentStatus === "partial_refund"
          ? toNum(order?.payment?.refund_amount_incl || paidIncl)
          : 0;

      if (createdAt) {
        if (!firstOrderAt || createdAt < firstOrderAt) firstOrderAt = createdAt;
        if (!lastOrderAt || createdAt > lastOrderAt) lastOrderAt = createdAt;

        if (createdAt >= startOfMonth) {
          spend.currentMonth.orderCount += 1;
          spend.currentMonth.sumFinalIncl = Number(
            (spend.currentMonth.sumFinalIncl + finalIncl).toFixed(2)
          );
          spend.currentMonth.sumPaidIncl = Number(
            (spend.currentMonth.sumPaidIncl + paidIncl).toFixed(2)
          );
          spend.currentMonth.sumRefundedIncl = Number(
            ((spend.currentMonth.sumRefundedIncl || 0) + refundIncl).toFixed(2)
          );
        } else if (createdAt >= startOfPrevMonth && createdAt < startOfMonth) {
          spend.previousMonth.orderCount += 1;
          spend.previousMonth.sumFinalIncl = Number(
            (spend.previousMonth.sumFinalIncl + finalIncl).toFixed(2)
          );
          spend.previousMonth.sumPaidIncl = Number(
            (spend.previousMonth.sumPaidIncl + paidIncl).toFixed(2)
          );
          spend.previousMonth.sumRefundedIncl = Number(
            ((spend.previousMonth.sumRefundedIncl || 0) + refundIncl).toFixed(2)
          );
        }

        if (createdAt >= startOfYear) {
          spend.last12Months.orderCount += 1;
          spend.last12Months.sumFinalIncl = Number(
            (spend.last12Months.sumFinalIncl + finalIncl).toFixed(2)
          );
          spend.last12Months.sumPaidIncl = Number(
            (spend.last12Months.sumPaidIncl + paidIncl).toFixed(2)
          );
          spend.last12Months.sumRefundedIncl = Number(
            ((spend.last12Months.sumRefundedIncl || 0) + refundIncl).toFixed(2)
          );
        } else if (createdAt >= startOfPrevYear && createdAt < startOfYear) {
          spend.previous12Months.orderCount += 1;
          spend.previous12Months.sumFinalIncl = Number(
            (spend.previous12Months.sumFinalIncl + finalIncl).toFixed(2)
          );
          spend.previous12Months.sumPaidIncl = Number(
            (spend.previous12Months.sumPaidIncl + paidIncl).toFixed(2)
          );
          spend.previous12Months.sumRefundedIncl = Number(
            ((spend.previous12Months.sumRefundedIncl || 0) + refundIncl).toFixed(2)
          );
        }
      }
    }

    const analytics = {
      totals,
      averageOrderValue:
        totals.totalOrders > 0
          ? Number((totals.sumFinalIncl / totals.totalOrders).toFixed(2))
          : 0,
      firstOrderAt: firstOrderAt ? firstOrderAt.toISOString() : null,
      lastOrderAt: lastOrderAt ? lastOrderAt.toISOString() : null,
      monthlySeries: buildMonthlySeries(filtered, 12),
      spend: {
        ...spend,
        currentMonth: {
          ...spend.currentMonth,
          changePct: {
            orderCount: pctChange(
              spend.currentMonth.orderCount,
              spend.previousMonth.orderCount
            ),
            sumFinalIncl: pctChange(
              spend.currentMonth.sumFinalIncl,
              spend.previousMonth.sumFinalIncl
            ),
            sumPaidIncl: pctChange(
              spend.currentMonth.sumPaidIncl,
              spend.previousMonth.sumPaidIncl
            ),
            sumRefundedIncl: pctChange(
              spend.currentMonth.sumRefundedIncl,
              spend.previousMonth.sumRefundedIncl
            )
          }
        },
        last12Months: {
          ...spend.last12Months,
          changePct: {
            orderCount: pctChange(
              spend.last12Months.orderCount,
              spend.previous12Months.orderCount
            ),
            sumFinalIncl: pctChange(
              spend.last12Months.sumFinalIncl,
              spend.previous12Months.sumFinalIncl
            ),
            sumPaidIncl: pctChange(
              spend.last12Months.sumPaidIncl,
              spend.previous12Months.sumPaidIncl
            ),
            sumRefundedIncl: pctChange(
              spend.last12Months.sumRefundedIncl,
              spend.previous12Months.sumRefundedIncl
            )
          }
        },
        monthChangePct: {
          orderCount: pctChange(
            spend.currentMonth.orderCount,
            spend.previousMonth.orderCount
          ),
          sumFinalIncl: pctChange(
            spend.currentMonth.sumFinalIncl,
            spend.previousMonth.sumFinalIncl
          ),
          sumPaidIncl: pctChange(
            spend.currentMonth.sumPaidIncl,
            spend.previousMonth.sumPaidIncl
          ),
          sumRefundedIncl: pctChange(
            spend.currentMonth.sumRefundedIncl,
            spend.previousMonth.sumRefundedIncl
          )
        },
        yearChangePct: {
          orderCount: pctChange(
            spend.last12Months.orderCount,
            spend.previous12Months.orderCount
          ),
          sumFinalIncl: pctChange(
            spend.last12Months.sumFinalIncl,
            spend.previous12Months.sumFinalIncl
          ),
          sumPaidIncl: pctChange(
            spend.last12Months.sumPaidIncl,
            spend.previous12Months.sumPaidIncl
          ),
          sumRefundedIncl: pctChange(
            spend.last12Months.sumRefundedIncl,
            spend.previous12Months.sumRefundedIncl
          )
        }
      },
      rentals: buildRentalAnalytics(filteredRentals),
      rentalsBilling: buildRentalBillingAnalytics(filteredRentals, {
        page: rentalAttemptsPage,
        paginate: rentalAttemptsPaginate
      })
    };

    const monthlySeries = buildMonthlySeries(filtered, 12, 0);
    const previous12Series = buildMonthlySeries(filtered, 12, 12);
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const currentMonthSeries = buildDailySeries(filtered, startOfCurrentMonth);
    const previousMonthSeries = buildDailySeries(filtered, startOfPreviousMonth);

    const monthlyLabels = monthlySeries.map(m => m.key);
    const charts = {
      monthlySpendUrl: buildQuickChartUrl({
        type: "line",
        data: {
          labels: monthlyLabels,
          datasets: [
            {
              label: "Spend (final incl)",
              data: monthlySeries.map(m => m.sumFinalIncl),
              borderColor: "#2563eb",
              backgroundColor: "rgba(37, 99, 235, 0.15)",
              pointBackgroundColor: "#2563eb",
              pointRadius: 3,
              tension: 0.3,
              fill: true
            }
          ]
        },
        options: {
          ...baseChartOptions(),
          plugins: {
            ...baseChartOptions().plugins,
            title: {
              display: true,
              text: "Monthly Spend (Final Incl)",
              color: "#0f172a",
              font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
            }
          }
        }
      }),
      monthlyOrdersUrl: buildQuickChartUrl({
        type: "bar",
        data: {
          labels: monthlyLabels,
          datasets: [
            {
              label: "Orders",
              data: monthlySeries.map(m => m.orderCount),
              backgroundColor: "rgba(22, 163, 74, 0.8)",
              borderColor: "#166534",
              borderWidth: 1
            }
          ]
        },
        options: {
          ...baseChartOptions(),
          plugins: {
            ...baseChartOptions().plugins,
            title: {
              display: true,
              text: "Monthly Orders",
              color: "#0f172a",
              font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
            }
          }
        }
      }),
      monthlyRefundsUrl: buildQuickChartUrl({
        type: "line",
        data: {
          labels: monthlyLabels,
          datasets: [
            {
              label: "Refunds (incl)",
              data: monthlySeries.map(m => m.sumRefundedIncl || 0),
              borderColor: "#dc2626",
              backgroundColor: "rgba(220, 38, 38, 0.15)",
              pointBackgroundColor: "#dc2626",
              pointRadius: 3,
              tension: 0.3,
              fill: true
            }
          ]
        },
        options: {
          ...baseChartOptions(),
          plugins: {
            ...baseChartOptions().plugins,
            title: {
              display: true,
              text: "Monthly Refunds (Incl)",
              color: "#0f172a",
              font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
            }
          }
        }
      }),
      rentalsStatusUrl: buildQuickChartUrl({
        type: "bar",
        data: {
          labels: Object.keys(analytics.rentals.billingStatusCounts || {}),
          datasets: [
            {
              label: "Rentals by Status",
              data: Object.values(analytics.rentals.billingStatusCounts || {}),
              backgroundColor: "rgba(124, 58, 237, 0.8)",
              borderColor: "#5b21b6",
              borderWidth: 1
            }
          ]
        },
        options: {
          ...baseChartOptions(),
          plugins: {
            ...baseChartOptions().plugins,
            title: {
              display: true,
              text: "Rentals by Status",
              color: "#0f172a",
              font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
            }
          }
        }
      })
      ,
      spendSummaryUrl: buildQuickChartUrl({
        type: "line",
        data: {
          labels: monthlyLabels,
          datasets: [
            {
              label: "Final Incl",
              data: monthlySeries.map(m => m.sumFinalIncl),
              borderColor: "#0ea5e9",
              backgroundColor: "rgba(14, 165, 233, 0.15)",
              pointBackgroundColor: "#0ea5e9",
              pointRadius: 3,
              tension: 0.3,
              fill: true
            },
            {
              label: "Paid Incl",
              data: monthlySeries.map(m => m.sumPaidIncl),
              borderColor: "#22c55e",
              backgroundColor: "rgba(34, 197, 94, 0.15)",
              pointBackgroundColor: "#22c55e",
              pointRadius: 3,
              tension: 0.3,
              fill: true
            },
            {
              label: "Refunded Incl",
              data: monthlySeries.map(m => m.sumRefundedIncl || 0),
              borderColor: "#f97316",
              backgroundColor: "rgba(249, 115, 22, 0.15)",
              pointBackgroundColor: "#f97316",
              pointRadius: 3,
              tension: 0.3,
              fill: true
            }
          ]
        },
        options: {
          ...baseChartOptions(),
          plugins: {
            ...baseChartOptions().plugins,
            title: {
              display: true,
              text: "Spend Summary",
              color: "#0f172a",
              font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
            }
          }
        }
      })
    };

    analytics.monthlySeries = monthlySeries;

    analytics.spend.currentMonth.chartUrl = buildQuickChartUrl({
      type: "line",
      data: {
        labels: currentMonthSeries.map(d => d.key),
        datasets: [
          {
            label: "Final Incl",
            data: currentMonthSeries.map(d => d.sumFinalIncl),
            borderColor: "#0ea5e9",
            backgroundColor: "rgba(14, 165, 233, 0.15)",
            pointBackgroundColor: "#0ea5e9",
            pointRadius: 2,
            tension: 0.3,
            fill: true
          }
        ]
      },
      options: {
        ...baseChartOptions(),
        plugins: {
          ...baseChartOptions().plugins,
          title: {
            display: true,
            text: "Current Month Spend",
            color: "#0f172a",
            font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
          }
        }
      }
    }, 900, 320);

    analytics.spend.previousMonth.chartUrl = buildQuickChartUrl({
      type: "line",
      data: {
        labels: previousMonthSeries.map(d => d.key),
        datasets: [
          {
            label: "Final Incl",
            data: previousMonthSeries.map(d => d.sumFinalIncl),
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.15)",
            pointBackgroundColor: "#2563eb",
            pointRadius: 2,
            tension: 0.3,
            fill: true
          }
        ]
      },
      options: {
        ...baseChartOptions(),
        plugins: {
          ...baseChartOptions().plugins,
          title: {
            display: true,
            text: "Previous Month Spend",
            color: "#0f172a",
            font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
          }
        }
      }
    }, 900, 320);

    analytics.spend.last12Months.chartUrl = buildQuickChartUrl({
      type: "line",
      data: {
        labels: monthlySeries.map(m => m.key),
        datasets: [
          {
            label: "Final Incl",
            data: monthlySeries.map(m => m.sumFinalIncl),
            borderColor: "#0ea5e9",
            backgroundColor: "rgba(14, 165, 233, 0.15)",
            pointBackgroundColor: "#0ea5e9",
            pointRadius: 3,
            tension: 0.3,
            fill: true
          }
        ]
      },
      options: {
        ...baseChartOptions(),
        plugins: {
          ...baseChartOptions().plugins,
          title: {
            display: true,
            text: "Last 12 Months Spend",
            color: "#0f172a",
            font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
          }
        }
      }
    });

    analytics.spend.previous12Months.chartUrl = buildQuickChartUrl({
      type: "line",
      data: {
        labels: previous12Series.map(m => m.key),
        datasets: [
          {
            label: "Final Incl",
            data: previous12Series.map(m => m.sumFinalIncl),
            borderColor: "#64748b",
            backgroundColor: "rgba(100, 116, 139, 0.15)",
            pointBackgroundColor: "#64748b",
            pointRadius: 3,
            tension: 0.3,
            fill: true
          }
        ]
      },
      options: {
        ...baseChartOptions(),
        plugins: {
          ...baseChartOptions().plugins,
          title: {
            display: true,
            text: "Previous 12 Months Spend",
            color: "#0f172a",
            font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
          }
        }
      }
    });

    return ok({
      data: pageOrdersWithIndex,
      rentals: pageRentalsWithIndex,
      analytics,
      charts,
      rentalsPagination: {
        page: safeRentalsPage,
        pageSize: rentalsPageSize,
        total: rentalsTotal,
        totalPages: rentalsTotalPages,
        pages: rentalsPages,
        pageWindow: rentalsPageWindow,
        moreBefore: rentalsMoreBefore,
        moreAfter: rentalsMoreAfter
      },
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
