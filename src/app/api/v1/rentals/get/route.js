export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

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

function matchesFilters(rental, filters) {
  if (!filters) return true;

  const billing = rental?.billing || {};
  const createdAt = parseDate(rental?.timestamps?.createdAt);
  const nextChargeAt = parseDate(billing?.nextChargeAt);

  if (filters.customerId && rental?.customerId !== filters.customerId)
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

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      rentalId: rawRentalId,
      customerId: rawCustomerId,
      orderId: rawOrderId,
      orderNumber: rawOrderNumber,
      merchantTransactionId: rawMerchantTransactionId,
      filters: rawFilters,
      page: rawPage,
      sortOrder: rawSortOrder
    } = body || {};

    const rentalId = isEmpty(rawRentalId) ? null : rawRentalId;
    const customerId = isEmpty(rawCustomerId) ? null : rawCustomerId;
    const orderId = isEmpty(rawOrderId) ? null : rawOrderId;
    const orderNumber = isEmpty(rawOrderNumber) ? null : rawOrderNumber;
    const merchantTransactionId = isEmpty(rawMerchantTransactionId)
      ? null
      : rawMerchantTransactionId;
    const filters = isEmpty(rawFilters) ? null : rawFilters;
    const paginate = !isEmpty(rawPage);
    const page = paginate ? rawPage : 1;
    const sortOrder = isEmpty(rawSortOrder) ? "desc" : rawSortOrder;

    if (rentalId) {
      const ref = doc(db, "rentals_v2", rentalId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        return ok({ data: { id: snap.id, ...snap.data() } });
      }
    }

    const snap = await getDocs(collection(db, "rentals_v2"));
    const rentals = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (rentalId) {
      const match = rentals.find(
        r => r?.rentalId === rentalId || r?.id === rentalId
      );
      if (!match) {
        return err(404, "Rental Not Found", `No rental found with id: ${rentalId}`);
      }
      return ok({ data: match });
    }

    if (customerId || orderId || orderNumber || merchantTransactionId) {
      const match = rentals.filter(r => {
        if (customerId && r?.customerId !== customerId) return false;
        if (orderId && r?.orderId !== orderId) return false;
        if (orderNumber && r?.orderNumber !== orderNumber) return false;
        if (
          merchantTransactionId &&
          r?.merchantTransactionId !== merchantTransactionId
        )
          return false;
        return true;
      });

      if (match.length === 0) {
        return err(
          404,
          "Rental Not Found",
          "No rentals found with the provided reference."
        );
      }

      return ok({ data: match });
    }

    const filtered = rentals.filter(r => matchesFilters(r, filters));

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
      (acc, r) => {
        const billing = r?.billing || {};
        acc.totalRentals += 1;

        const status = billing?.status || "unknown";
        acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;

        const billingPeriod = billing?.billing_period || "unknown";
        acc.billingPeriodCounts[billingPeriod] =
          (acc.billingPeriodCounts[billingPeriod] || 0) + 1;

        const cadence = billing?.cadence || "unknown";
        acc.cadenceCounts[cadence] = (acc.cadenceCounts[cadence] || 0) + 1;

        return acc;
      },
      {
        totalRentals: 0,
        statusCounts: {},
        cadenceCounts: {},
        billingPeriodCounts: {}
      }
    );

    return ok({
      data: pageRentals,
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
    return err(500, "Rental Fetch Failed", e?.message || "Unexpected error.");
  }
}
