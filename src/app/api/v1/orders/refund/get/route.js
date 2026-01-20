export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

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

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      refundId: rawRefundId,
      orderId: rawOrderId,
      orderNumber: rawOrderNumber,
      merchantTransactionId: rawMerchantTransactionId,
      status: rawStatus,
      page: rawPage,
      sortOrder: rawSortOrder
    } = body || {};

    const refundId = isEmpty(rawRefundId) ? null : rawRefundId;
    const orderId = isEmpty(rawOrderId) ? null : rawOrderId;
    const orderNumber = isEmpty(rawOrderNumber) ? null : rawOrderNumber;
    const merchantTransactionId = isEmpty(rawMerchantTransactionId)
      ? null
      : rawMerchantTransactionId;
    const status = isEmpty(rawStatus) ? null : String(rawStatus).trim();
    const paginate = !isEmpty(rawPage);
    const page = paginate ? rawPage : 1;
    const sortOrder = isEmpty(rawSortOrder) ? "desc" : rawSortOrder;

    if (refundId) {
      const ref = doc(db, "refunds_v2", refundId);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        return err(404, "Refund Not Found", "Refund request could not be located.");
      }
      return ok({ data: { docId: snap.id, ...snap.data() } });
    }

    const snap = await getDocs(collection(db, "refunds_v2"));
    const refunds = snap.docs.map(d => ({
      docId: d.id,
      ...d.data()
    }));

    const filtered = refunds.filter(r => {
      const refund = r?.refund || {};
      if (orderId && refund.orderId !== orderId) return false;
      if (orderNumber && refund.orderNumber !== orderNumber) return false;
      if (merchantTransactionId && refund.merchantTransactionId !== merchantTransactionId)
        return false;
      if (status && refund.status !== status) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const aTime =
        parseDate(a?.timestamps?.requestedAt)?.getTime() || 0;
      const bTime =
        parseDate(b?.timestamps?.requestedAt)?.getTime() || 0;
      return sortOrder === "asc" ? aTime - bTime : bTime - aTime;
    });

    const safePage = Number(page) > 0 ? Number(page) : 1;
    const total = filtered.length;
    const pageSize = paginate ? PAGE_SIZE : total;
    const totalPages = total > 0 ? (paginate ? Math.ceil(total / PAGE_SIZE) : 1) : 0;
    const start = paginate ? (safePage - 1) * PAGE_SIZE : 0;
    const end = paginate ? start + PAGE_SIZE : total;
    const pageRefunds = start < total ? filtered.slice(start, end) : [];

    return ok({
      data: pageRefunds,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages
      }
    });
  } catch (e) {
    return err(
      500,
      "Fetch Failed",
      e?.message || "Unexpected error fetching refunds_v2"
    );
  }
}
