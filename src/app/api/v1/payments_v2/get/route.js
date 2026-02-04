export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { customerId, status, page: rawPage } = body || {};

    if (!customerId) {
      return err(400, "Missing Input", "customerId is required.");
    }

    const snap = await getDocs(collection(db, "payments_v2"));
    const payments = snap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data()
    })).filter(payment => {
      if (payment?.customer?.customerId !== customerId) return false;
      if (!status) return true;
      const paymentStatus = payment?.payment?.status || null;
      if (status === "unallocated_or_partial") {
        return paymentStatus === "unallocated" || paymentStatus === "partially_allocated";
      }
      return paymentStatus === status;
    }).sort((a, b) => {
      const aTime = new Date(a?.timestamps?.createdAt || 0).getTime();
      const bTime = new Date(b?.timestamps?.createdAt || 0).getTime();
      return bTime - aTime;
    });

    const PAGE_SIZE = 50;
    const paginate = rawPage != null;
    const page = paginate ? Number(rawPage) : 1;
    const safePage = Number(page) > 0 ? Number(page) : 1;

    const total = payments.length;
    const pageSize = paginate ? PAGE_SIZE : total;
    const totalPages = total > 0 ? (paginate ? Math.ceil(total / PAGE_SIZE) : 1) : 0;
    const start = paginate ? (safePage - 1) * PAGE_SIZE : 0;
    const end = paginate ? start + PAGE_SIZE : total;
    const pagePayments = start < total
      ? payments.slice(start, end).map((payment, i) => ({
          ...payment,
          payment_index: start + i + 1
        }))
      : [];

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

    const totals = payments.reduce(
      (acc, payment) => {
        acc.totalPayments += 1;
        acc.totalAmountIncl += Number(payment?.payment?.amount_incl || 0);
        acc.totalRemainingIncl += Number(payment?.payment?.remaining_amount_incl || 0);
        return acc;
      },
      { totalPayments: 0, totalAmountIncl: 0, totalRemainingIncl: 0 }
    );

    return ok({
      payments: pagePayments,
      totals: {
        totalPayments: totals.totalPayments,
        totalAmountIncl: Number(totals.totalAmountIncl.toFixed(2)),
        totalRemainingIncl: Number(totals.totalRemainingIncl.toFixed(2))
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
      "Fetch Payments Failed",
      e?.message || "Unexpected error fetching payments."
    );
  }
}
