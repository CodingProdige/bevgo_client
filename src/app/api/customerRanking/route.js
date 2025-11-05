// src/api/companyInvoiceSummary/route.js
export const runtime = "nodejs";
export const preferredRegion = "cdg1";

import { db } from "@/lib/firebaseConfig";
import { NextResponse } from "next/server";
import {
  collection as col,
  getDocs as getDocsWeb,
  query as qWeb,
  where as whereWeb,
  limit as limitWeb,
} from "firebase/firestore";

export async function POST(req) {
  try {
    const { companyCode, dateRange, periodDays } = await req.json();

    // ----- Effective window: current month start -> now (intersect with inputs) -----
    const now = new Date();
    let fromISO = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    let toISO = now.toISOString();

    if (dateRange?.from && dateRange?.to) {
      const drFrom = new Date(dateRange.from).toISOString();
      const drTo = new Date(dateRange.to).toISOString();
      fromISO = new Date(Math.max(Date.parse(fromISO), Date.parse(drFrom))).toISOString();
      toISO   = new Date(Math.min(Date.parse(toISO),   Date.parse(drTo))).toISOString();
    }
    if (Number.isFinite(Number(periodDays)) && Number(periodDays) > 0) {
      const n = Number(periodDays);
      const pFrom = new Date(now); pFrom.setDate(now.getDate() - n);
      const pFromISO = pFrom.toISOString();
      const pToISO   = now.toISOString();
      fromISO = new Date(Math.max(Date.parse(fromISO), Date.parse(pFromISO))).toISOString();
      toISO   = new Date(Math.min(Date.parse(toISO),   Date.parse(pToISO))).toISOString();
    }

    // ----- Query invoices (Web SDK modular) -----
    const constraints = [
      whereWeb("invoiceDate", ">=", fromISO),
      whereWeb("invoiceDate", "<=", toISO),
    ];
    if (companyCode) constraints.push(whereWeb("customer.companyCode", "==", companyCode));

    const invSnap = await getDocsWeb(qWeb(col(db, "invoices"), ...constraints));

    if (invSnap.empty) {
      return NextResponse.json({
        message: "No invoices found for the given filters",
        sorted: [],
        grandTotals: { companies: 0, invoices: 0, spend: 0, points: 0 },
        periodApplied: true,
        periodRange: { from: fromISO, to: toISO },
        scale: { minPoints: 0, maxPoints: 0 }
      });
    }

    // ----- Aggregate by companyCode -----
    const byCompany = new Map(); // code -> { totalSpend, invoicesCount }
    let allInvoicesCount = 0;
    let allSpend = 0;

    for (const d of invSnap.docs) {
      const inv = d.data() || {};
      const code = inv?.customer?.companyCode || null;
      if (!code) continue;

      const v = toNum(inv?.finalTotals?.finalTotal);
      const entry = byCompany.get(code) || { totalSpend: 0, invoicesCount: 0 };
      entry.totalSpend += v;
      entry.invoicesCount += 1;
      byCompany.set(code, entry);

      allInvoicesCount += 1;
      allSpend += v;
    }

    if (byCompany.size === 0) {
      return NextResponse.json({
        message: "No invoices with a companyCode",
        sorted: [],
        grandTotals: {
          companies: 0,
          invoices: allInvoicesCount,
          spend: round2(allSpend),
          points: 0
        },
        periodApplied: true,
        periodRange: { from: fromISO, to: toISO },
        scale: { minPoints: 0, maxPoints: 0 }
      });
    }

    const companyCodes = Array.from(byCompany.keys());

    // ----- Fetch users per companyCode WITHOUT 'in' (batched) -----
    const usersByCode = new Map();
    const poolSize = 10;
    for (let i = 0; i < companyCodes.length; i += poolSize) {
      const batch = companyCodes.slice(i, i + poolSize);
      await Promise.all(
        batch.map(async (code) => {
          const uQ = qWeb(col(db, "users"), whereWeb("companyCode", "==", code), limitWeb(1));
          const uSnap = await getDocsWeb(uQ);
          if (!uSnap.empty) {
            const u = uSnap.docs[0].data();
            usersByCode.set(code, pickCustomerFields(u));
          } else {
            usersByCode.set(code, { companyCode: code });
          }
        })
      );
    }

    // ----- Build rows & compute raw points -----
    let rows = companyCodes.map((code) => {
      const agg = byCompany.get(code);
      const customer = usersByCode.get(code) || { companyCode: code };
      const perInvoice = agg.invoicesCount * 10;
      const byValue = Math.round(agg.totalSpend / 10);
      const points = perInvoice + byValue;
      return {
        companyCode: code,
        invoicesCount: agg.invoicesCount,
        totalSpend: round2(agg.totalSpend),
        points,
        pointsBreakdown: { perInvoice, byValue },
        customer
      };
    });

    // Omit points <= 0
    rows = rows.filter((r) => r.points > 0);

    // ----- Min–max normalize to 0..1 (pointsScore) -----
    let minPoints = Infinity, maxPoints = -Infinity;
    for (const r of rows) {
      if (r.points < minPoints) minPoints = r.points;
      if (r.points > maxPoints) maxPoints = r.points;
    }
    if (rows.length === 0) {
      return NextResponse.json({
        message: "No positive-point customers in the period",
        sorted: [],
        grandTotals: { companies: 0, invoices: allInvoicesCount, spend: round2(allSpend), points: 0 },
        periodApplied: true,
        periodRange: { from: fromISO, to: toISO },
        scale: { minPoints: 0, maxPoints: 0 }
      });
    }

    const denom = maxPoints - minPoints;
    rows = rows.map((r) => ({
      ...r,
      pointsScore: denom > 0 ? (r.points - minPoints) / denom : 1 // all equal → 1
    }));

    // ✅ Sort by points DESC so the max is at the top (best for bar scaling)
    rows.sort((a, b) => b.points - a.points);

    // Optional: rank field for the UI
    rows = rows.map((r, i) => ({ ...r, rank: i + 1 }));

    const totalPoints = rows.reduce((s, r) => s + r.points, 0);

    return NextResponse.json({
      message: "Company invoice summary computed",
      sorted: rows,
      grandTotals: {
        companies: rows.length,
        invoices: allInvoicesCount,
        spend: round2(allSpend),
        points: totalPoints
      },
      periodApplied: true,
      periodRange: { from: fromISO, to: toISO },
      scale: { minPoints, maxPoints }
    });
  } catch (error) {
    console.error("❌ companyInvoiceSummary error:", error);
    return NextResponse.json(
      { error: "Failed to summarize invoices", details: String(error?.message || error) },
      { status: 500 }
    );
  }
}

/* ---------------- helpers ---------------- */

function toNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function pickCustomerFields(u) {
  return {
    companyCode: u?.companyCode || "",
    name: u?.companyName || u?.name || "",
    email: u?.email || "",
    phone: u?.phone || u?.phone_number || "",
    address: u?.deliveryAddress || u?.address || "",
    vat: u?.vat || ""
  };
}
