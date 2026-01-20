export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, getDocs } from "firebase/firestore";
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

function getCustomerId(rental) {
  return (
    rental?.customerId ||
    rental?.customer_snapshot?.uid ||
    rental?.customer_snapshot?.customerId ||
    null
  );
}

function getCustomerCode(rental) {
  const account = rental?.customer_snapshot?.account || {};
  return (
    account.customerCode ||
    account.customer_code ||
    account.companyCode ||
    account.company_code ||
    null
  );
}

function matchesCustomer(rental, userId, customerCode) {
  const rentalCustomerId = getCustomerId(rental);
  const accountCode = getCustomerCode(rental);

  if (userId && rentalCustomerId !== userId) return false;

  if (customerCode) {
    if (accountCode !== customerCode && rentalCustomerId !== customerCode) {
      return false;
    }
  }

  return true;
}

function matchesFilters(rental, filters) {
  if (!filters) return true;

  const billing = rental?.billing || {};
  const createdAt = parseDate(rental?.timestamps?.createdAt);
  const nextChargeAt = parseDate(billing?.nextChargeAt);

  if (filters.customerId && getCustomerId(rental) !== filters.customerId)
    return false;
  if (filters.orderId && rental?.orderId !== filters.orderId)
    return false;
  if (filters.orderNumber && rental?.orderNumber !== filters.orderNumber)
    return false;
  if (
    filters.merchantTransactionId &&
    rental?.merchantTransactionId !== filters.merchantTransactionId
  )
    return false;
  if (filters.status && billing?.status !== filters.status)
    return false;
  if (filters.billing_period && billing?.billing_period !== filters.billing_period)
    return false;
  if (filters.cadence && billing?.cadence !== filters.cadence)
    return false;

  if (filters.createdFrom) {
    const from = parseDate(filters.createdFrom);
    if (from && (!createdAt || createdAt < from)) return false;
  }

  if (filters.createdTo) {
    const to = parseDate(filters.createdTo);
    if (to && (!createdAt || createdAt > to)) return false;
  }

  if (filters.nextChargeFrom) {
    const from = parseDate(filters.nextChargeFrom);
    if (from && (!nextChargeAt || nextChargeAt < from)) return false;
  }

  if (filters.nextChargeTo) {
    const to = parseDate(filters.nextChargeTo);
    if (to && (!nextChargeAt || nextChargeAt > to)) return false;
  }

  return true;
}

function toNum(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function buildMonthlySeries(rentals, months = 12, offsetMonths = 0) {
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
      rentalCount: 0,
      totalQuantity: 0
    });
  }

  const indexByKey = new Map(series.map((row, idx) => [row.key, idx]));

  for (const rental of rentals) {
    const createdAt = parseDate(rental?.timestamps?.createdAt);
    if (!createdAt) continue;
    const key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
    const idx = indexByKey.get(key);
    if (idx === undefined) continue;

    series[idx].rentalCount += 1;
    series[idx].totalQuantity += toNum(rental?.quantity || 0);
  }

  return series;
}

function buildRentalAnalytics(rentals) {
  return rentals.reduce(
    (acc, r) => {
      const billing = r?.billing || {};
      acc.totalRentals += 1;
      acc.totalQuantity += toNum(r?.quantity || 0);

      const status = billing?.status || "unknown";
      acc.billingStatusCounts[status] =
        (acc.billingStatusCounts[status] || 0) + 1;

      const billingPeriod = billing?.billing_period || "unknown";
      acc.billingPeriodCounts[billingPeriod] =
        (acc.billingPeriodCounts[billingPeriod] || 0) + 1;

      const cadence = billing?.cadence || "unknown";
      acc.billingCadenceCounts[cadence] =
        (acc.billingCadenceCounts[cadence] || 0) + 1;

      return acc;
    },
    {
      totalRentals: 0,
      totalQuantity: 0,
      billingStatusCounts: {},
      billingCadenceCounts: {},
      billingPeriodCounts: {}
    }
  );
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
      page: rawPage,
      sortOrder: rawSortOrder
    } = body || {};

    const customerCode = isEmpty(rawCustomerCode) ? null : rawCustomerCode;
    const userId = isEmpty(rawUserId) ? null : rawUserId;
    const filters = isEmpty(rawFilters) ? null : rawFilters;
    const paginate = !isEmpty(rawPage);
    const page = paginate ? rawPage : 1;
    const sortOrder = isEmpty(rawSortOrder) ? "desc" : rawSortOrder;

    if (!customerCode && !userId) {
      return err(400, "Missing Parameters", "customerCode or userId is required.");
    }

    const snap = await getDocs(collection(db, "rentals_v2"));
    const rentals = snap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data()
    }));

    const filtered = rentals.filter(r => {
      if (!matchesCustomer(r, userId, customerCode)) return false;
      return matchesFilters(r, filters);
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
    const pageRentals = start < total ? filtered.slice(start, end) : [];
    const pageRentalsWithIndex = pageRentals.map((rental, i) => ({
      ...rental,
      rental_index: start + i + 1
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

    const totals = buildRentalAnalytics(filtered);
    const firstRentalAt = filtered.length > 0
      ? parseDate(filtered[0]?.timestamps?.createdAt)
      : null;
    const lastRentalAt = filtered.length > 0
      ? parseDate(filtered[filtered.length - 1]?.timestamps?.createdAt)
      : null;
    const monthlySeries = buildMonthlySeries(filtered, 12, 0);

    const charts = {
      monthlyRentalsUrl: buildQuickChartUrl({
        type: "line",
        data: {
          labels: monthlySeries.map(m => m.key),
          datasets: [
            {
              label: "Rentals",
              data: monthlySeries.map(m => m.rentalCount),
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
              text: "Monthly Rentals",
              color: "#0f172a",
              font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
            }
          }
        }
      }),
      rentalsStatusUrl: buildQuickChartUrl({
        type: "bar",
        data: {
          labels: Object.keys(totals.billingStatusCounts || {}),
          datasets: [
            {
              label: "Rentals by Status",
              data: Object.values(totals.billingStatusCounts || {}),
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
      }),
      rentalsCadenceUrl: buildQuickChartUrl({
        type: "bar",
        data: {
          labels: Object.keys(totals.billingCadenceCounts || {}),
          datasets: [
            {
              label: "Rentals by Cadence",
              data: Object.values(totals.billingCadenceCounts || {}),
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
              text: "Rentals by Cadence",
              color: "#0f172a",
              font: { family: "Inter, Arial, sans-serif", size: 14, weight: "700" }
            }
          }
        }
      })
    };

    return ok({
      data: pageRentalsWithIndex,
      analytics: {
        totals,
        firstRentalAt: firstRentalAt ? firstRentalAt.toISOString() : null,
        lastRentalAt: lastRentalAt ? lastRentalAt.toISOString() : null,
        monthlySeries
      },
      charts,
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
      e?.message || "Unexpected error fetching rentals_v2"
    );
  }
}
