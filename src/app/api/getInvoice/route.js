import { db } from "@/lib/firebaseConfig";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  startAt,
  endAt,
  doc,
  getDoc,
} from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const {
      companyCode,
      orderNumber,
      dateRange,     // optional explicit range: { from: ISO, to: ISO }
      paymentStatus, // optional; if "Overdue" we derive after fetch
      isAdmin,
      periodDays,    // NEW: if >0, also filter by last N days (intersection with dateRange if provided)
    } = await req.json();

    const normalizedStatus = (paymentStatus || "").toLowerCase();
    const now = new Date();
    const days = Number.isFinite(Number(periodDays)) && Number(periodDays) > 0 ? Number(periodDays) : null;

    // 🔎 Single invoice path (no period logic needed beyond returning metadata)
    if (orderNumber) {
      const invoiceRef = doc(db, "invoices", orderNumber);
      const invoiceSnap = await getDoc(invoiceRef);

      if (!invoiceSnap.exists()) {
        return NextResponse.json(
          { message: `No invoice found with order number ${orderNumber}` },
          { status: 404 }
        );
      }

      const invoices = [invoiceSnap.data()];

      // 🆕 add derivedStatus
      const enrichedInvoices = invoices.map((inv) => ({
        ...inv,
        derivedStatus: deriveStatus(inv),
      }));

      const { totalPendingValue, totalPaidValue } = sumTotalsByStatus(enrichedInvoices);
      const pct = percentagesPendingVsPaid(enrichedInvoices);

      return NextResponse.json(
        {
          message: "Invoice retrieved successfully",
          invoices: enrichedInvoices,
          totalPendingValue,
          totalPaidValue,
          periodApplied: false,
          periodDaysUsed: null,
          periodRange: null,
          ...pct,
        },
        { status: 200 }
      );
    }

    // ✅ Build base query
    const invoicesRef = collection(db, "invoices");
    const constraints = [];

    // Company scoping
    if (companyCode) {
      constraints.push(where("customer.companyCode", "==", companyCode));
    } else if (!isAdmin) {
      // Non-admin must provide companyCode
      return NextResponse.json(
        {
          message: "No parameters provided, returning empty result.",
          invoices: [],
          totalPendingValue: 0,
          totalPaidValue: 0,
          periodApplied: false,
          periodDaysUsed: null,
          periodRange: null,
          pendingCountInPeriod: 0,
          paidCountInPeriod: 0,
          pendingPercentageInPeriod: 0,
          paidPercentageInPeriod: 0,
        },
        { status: 200 }
      );
    }

    // 🗓️ Compute an effective date window (intersection of explicit dateRange and periodDays)
    let effectiveFromISO = null;
    let effectiveToISO = null;

    if (dateRange?.from && dateRange?.to) {
      effectiveFromISO = new Date(dateRange.from).toISOString();
      effectiveToISO = new Date(dateRange.to).toISOString();
    }

    if (days) {
      const periodFrom = new Date(now);
      periodFrom.setDate(now.getDate() - days);
      const periodFromISO = periodFrom.toISOString();
      const periodToISO = now.toISOString();

      if (effectiveFromISO && effectiveToISO) {
        effectiveFromISO = new Date(Math.max(Date.parse(effectiveFromISO), Date.parse(periodFromISO))).toISOString();
        effectiveToISO = new Date(Math.min(Date.parse(effectiveToISO), Date.parse(periodToISO))).toISOString();
      } else {
        effectiveFromISO = periodFromISO;
        effectiveToISO = periodToISO;
      }
    }

    if (effectiveFromISO && effectiveToISO) {
      constraints.push(orderBy("invoiceDate"));
      constraints.push(startAt(effectiveFromISO));
      constraints.push(endAt(effectiveToISO));
      console.log(`📅 Effective date window: ${effectiveFromISO} to ${effectiveToISO}`);
    }

    if (paymentStatus && normalizedStatus !== "overdue") {
      constraints.push(where("payment_status", "==", paymentStatus));
      console.log(`🔍 Firestore filter: payment_status == ${paymentStatus}`);
    }

    // ✅ Execute query
    const q = constraints.length > 0 ? query(invoicesRef, ...constraints) : invoicesRef;
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return NextResponse.json(
        {
          message: "No invoices found",
          invoices: [],
          totalPendingValue: 0,
          totalPaidValue: 0,
          periodApplied: !!days,
          periodDaysUsed: days,
          periodRange: days ? { from: effectiveFromISO, to: effectiveToISO } : null,
          pendingCountInPeriod: 0,
          paidCountInPeriod: 0,
          pendingPercentageInPeriod: 0,
          paidPercentageInPeriod: 0,
        },
        { status: 200 }
      );
    }

    // Map docs
    let invoices = snapshot.docs.map((d) => d.data());

    // 🆕 add derivedStatus
    invoices = invoices.map((inv) => ({
      ...inv,
      derivedStatus: deriveStatus(inv),
    }));

    if (normalizedStatus === "overdue") {
      let cutoffDate = dateRange?.to ? new Date(dateRange.to) : now;
      invoices = invoices.filter((invoice) => {
        return invoice.derivedStatus === "Overdue";
      });
      console.log("⚠️ Applied derived Overdue filter after fetch.");
    }

    const { totalPendingValue, totalPaidValue } = sumTotalsByStatus(invoices);
    const pct = percentagesPendingVsPaid(invoices);

    return NextResponse.json(
      {
        message: "Invoices retrieved successfully",
        invoices,
        totalPendingValue,
        totalPaidValue,
        periodApplied: !!days,
        periodDaysUsed: days,
        periodRange: days ? { from: effectiveFromISO, to: effectiveToISO } : null,
        ...pct,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Failed to retrieve invoices:", error);
    return NextResponse.json(
      { error: "Failed to retrieve invoices", details: error?.message || String(error) },
      { status: 500 }
    );
  }
}

/* ------------------------ helpers ------------------------ */

function num(val) {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function sumTotalsByStatus(invoices) {
  let totalPendingValue = 0;
  let totalPaidValue = 0;

  for (const inv of invoices) {
    const v = num(inv?.finalTotals?.finalTotal);
    const status = (inv?.payment_status || "").toLowerCase();
    if (!isNaN(v)) {
      if (status === "pending") totalPendingValue += v;
      if (status === "paid") totalPaidValue += v;
    }
  }

  return {
    totalPendingValue: Number(totalPendingValue.toFixed(2)),
    totalPaidValue: Number(totalPaidValue.toFixed(2)),
  };
}

function percentagesPendingVsPaid(invoices) {
  let pendingCount = 0;
  let paidCount = 0;

  for (const inv of invoices) {
    const status = (inv?.payment_status || "").toLowerCase();
    if (status === "pending") pendingCount++;
    if (status === "paid") paidCount++;
  }

  const denom = pendingCount + paidCount;
  const pendingPct = denom === 0 ? 0 : (pendingCount / denom) * 100;
  const paidPct = denom === 0 ? 0 : (paidCount / denom) * 100;

  return {
    pendingCountInPeriod: pendingCount,
    paidCountInPeriod: paidCount,
    pendingPercentageInPeriod: Number(pendingPct.toFixed(2)),
    paidPercentageInPeriod: Number(paidPct.toFixed(2)),
  };
}

function parseDue(dueDate) {
  if (!dueDate) return null;
  if (typeof dueDate === "string") {
    const parts = dueDate.split("/");
    if (parts.length === 3) {
      const [m, d, y] = parts.map(Number);
      const dt = new Date(y, m - 1, d);
      return isNaN(dt) ? null : dt;
    }
    const dt = new Date(Date.parse(dueDate));
    return isNaN(dt) ? null : dt;
  } else {
    const dt = new Date(dueDate);
    return isNaN(dt) ? null : dt;
  }
}

/* 🆕 deriveStatus helper */
function deriveStatus(inv) {
  const status = (inv.payment_status || "").toLowerCase();
  const method = (inv.paymentMethod || "").toLowerCase();
  const due = parseDue(inv.dueDate);
  const today = new Date();

  if (status === "paid") return "Paid";

  if (status === "pending") {
    if (method === "eft") {
      return due && due < today ? "Overdue" : "Pending";
    }
    if (["cash", "card", "payfast", "yoco"].includes(method)) {
      return "Paid";
    }
    return "Pending";
  }

  return "Ignored";
}
