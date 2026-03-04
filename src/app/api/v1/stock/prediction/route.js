export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const DAY_MS = 24 * 60 * 60 * 1000;
const PDF_FUNCTION_URL = "https://generatepdf-th2kiymgaa-uc.a.run.app";

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseIso(value) {
  if (!value || typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function diffDaysInclusive(fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

function getCreatedAt(order) {
  const raw = order?.timestamps?.createdAt;
  if (!raw) return null;
  if (typeof raw === "string") return parseIso(raw);
  if (typeof raw?.toDate === "function") return raw.toDate();
  if (Number.isFinite(Number(raw?.seconds))) {
    return new Date(Number(raw.seconds) * 1000);
  }
  return null;
}

function isOrderEligible(order) {
  const orderStatus = String(order?.order?.status?.order || "").toLowerCase();
  const paymentStatus = String(order?.payment?.status || order?.order?.status?.payment || "").toLowerCase();

  if (orderStatus === "cancelled") return false;
  if (paymentStatus === "refunded") return false;
  return true;
}

function getItemQty(item) {
  const q = toNum(item?.quantity, NaN);
  if (Number.isFinite(q)) return q;
  return toNum(item?.qty, 0);
}

function getItemMeta(item) {
  const variant = item?.selected_variant_snapshot || {};
  const productSnapshot = item?.product_snapshot || {};
  const product = productSnapshot?.product || {};

  return {
    variantId: variant?.variant_id ? String(variant.variant_id) : null,
    sku: variant?.sku ? String(variant.sku) : null,
    productId:
      product?.unique_id ||
      productSnapshot?.docId ||
      null,
    label: variant?.label || null,
    productTitle: product?.title || null
  };
}

function getGroupingKey(meta, mode = "variant") {
  if (mode === "sku") {
    return meta?.sku || meta?.variantId || meta?.productId || "unknown";
  }
  if (mode === "product") {
    return meta?.productId || meta?.sku || meta?.variantId || "unknown";
  }
  return meta?.variantId || meta?.sku || meta?.productId || "unknown";
}

function formatNum(value, decimals = 0) {
  return Number(value || 0).toLocaleString("en-ZA", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildReportHtml({ generatedAt, inputs, historyWindow, totals, items }) {
  const generatedAtLabel = new Date(generatedAt).toLocaleString("en-ZA");
  const grouped = new Map();

  for (const item of items) {
    const productTitle = item?.productTitle || "Untitled Product";
    const key = String(productTitle).toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, { productTitle, variants: [] });
    }
    grouped.get(key).variants.push(item);
  }

  const productRowsHtml = Array.from(grouped.values())
    .map((group, index) => {
      const variantsHtml = group.variants
        .map(
          (v, vIndex) => `
            <tr>
              <td>${vIndex + 1}</td>
              <td>${esc(v.label || "Default Variant")}</td>
              <td class="right">${formatNum(v.avgDailyQty, 4)}</td>
              <td class="right">${formatNum(v.forecastQty)}</td>
              <td class="right">${formatNum(v.safetyQty)}</td>
              <td class="right"><strong>${formatNum(v.recommendedStockQty)}</strong></td>
              <td>&nbsp;</td>
            </tr>
          `
        )
        .join("");

      return `
        <tr>
          <td style="width:40px;">${index + 1}</td>
          <td><strong>${esc(group.productTitle)}</strong></td>
        </tr>
        <tr>
          <td></td>
          <td style="padding:0;">
            <table class="variant-table">
              <thead>
                <tr>
                  <th style="width:40px;">#</th>
                  <th>Variant</th>
                  <th class="right">Avg/Day</th>
                  <th class="right">Forecast Qty</th>
                  <th class="right">Safety Qty</th>
                  <th class="right">Recommended Qty</th>
                  <th>Manual Order Qty</th>
                </tr>
              </thead>
              <tbody>
                ${variantsHtml}
              </tbody>
            </table>
          </td>
        </tr>
      `;
    })
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Stock Prediction Report</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        font-family: Arial, sans-serif;
        font-size: 12px;
        color: #111;
      }
      h1, h2, h3, p { margin: 0; }
      .header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        border-bottom: 2px solid #111;
        padding-bottom: 12px;
        margin-bottom: 16px;
      }
      .company {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .title {
        font-size: 20px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
      .meta {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-bottom: 16px;
      }
      .card {
        border: 1px solid #111;
        padding: 10px;
        min-height: 85px;
      }
      .card h3 {
        font-size: 11px;
        text-transform: uppercase;
        margin-bottom: 6px;
        letter-spacing: 0.5px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 12px;
        font-size: 12px;
      }
      th, td {
        border: 1px solid #111;
        padding: 6px 8px;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #f3f3f3;
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.4px;
      }
      .right { text-align: right; }
      .summary {
        margin-top: 16px;
        width: 360px;
      }
      .summary td:first-child { width: 65%; }
      .summary td:last-child { text-align: right; font-weight: 700; }
      .variant-table {
        width: 100%;
        border-collapse: collapse;
        margin: 0;
        font-size: 11px;
      }
      .variant-table th,
      .variant-table td {
        border: 1px solid #d1d5db;
        padding: 5px 7px;
      }
      .variant-table th {
        background: #f9fafb;
        text-transform: uppercase;
        font-size: 10px;
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="company">
        <div style="font-weight:700;">BEVGO DISTRIBUTIONS</div>
        <div>Stock Planning & Forecasting Report</div>
        <div>Generated: ${esc(generatedAtLabel)}</div>
      </div>
      <div class="title">Stock Forecast</div>
    </div>

    <div class="meta">
      <div class="card">
        <h3>Forecast Inputs</h3>
        <p>Forecast Days: <strong>${esc(inputs.forecastDays)}</strong></p>
        <p>Lookback Days: <strong>${esc(inputs.lookbackDays)}</strong></p>
        <p>Safety Buffer: <strong>${esc(inputs.safetyBufferPct)}%</strong></p>
        <p>Group By: <strong>${esc(inputs.groupBy)}</strong></p>
      </div>
      <div class="card">
        <h3>Summary</h3>
        <p>History From: <strong>${esc(new Date(historyWindow.fromDate).toLocaleString("en-ZA"))}</strong></p>
        <p>History To: <strong>${esc(new Date(historyWindow.toDateExclusive).toLocaleString("en-ZA"))}</strong></p>
        <p>Total Items: <strong>${esc(totals.totalItems)}</strong></p>
        <p>Total Recommended: <strong>${esc(formatNum(totals.totalRecommendedStockQty))}</strong></p>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Product</th>
        </tr>
      </thead>
      <tbody>
        ${productRowsHtml || '<tr><td colspan="2">No items found for selected lookback period.</td></tr>'}
      </tbody>
    </table>

    <table class="summary">
      <tbody>
        <tr>
          <td>Total Items</td>
          <td>${formatNum(totals.totalItems)}</td>
        </tr>
        <tr>
          <td>Total Forecast Qty</td>
          <td>${formatNum(totals.totalForecastQty)}</td>
        </tr>
        <tr>
          <td>Total Safety Qty</td>
          <td>${formatNum(totals.totalSafetyQty)}</td>
        </tr>
        <tr>
          <td>Total Recommended Stock Qty</td>
          <td>${formatNum(totals.totalRecommendedStockQty)}</td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;
}

async function createPdfReport(payload) {
  const htmlContent = buildReportHtml(payload);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `stock-prediction-${ts}`;

  const response = await fetch(PDF_FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ htmlContent, fileName })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`PDF service failed (${response.status}) ${text}`.trim());
  }

  const json = await response.json();
  const pdfUrl = json?.pdfUrl || null;
  if (!pdfUrl) throw new Error("PDF generation failed: missing pdfUrl.");
  return pdfUrl;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      forecastDays: rawForecastDays,
      days: rawDays,
      lookbackDays = 90,
      safetyBufferPct = 0,
      groupBy = "variant"
    } = body || {};

    const safeLookbackDays = Math.max(1, Math.floor(toNum(lookbackDays, 90)));
    const safeSafetyPct = Math.max(0, toNum(safetyBufferPct, 0));
    const safeForecastDays = Math.max(
      1,
      Math.floor(toNum(rawForecastDays ?? rawDays, 30))
    );
    const mode = ["variant", "sku", "product"].includes(String(groupBy))
      ? String(groupBy)
      : "variant";

    const forecastFrom = new Date();
    const forecastTo = new Date(
      forecastFrom.getTime() + (safeForecastDays - 1) * DAY_MS
    );
    const periodDays = diffDaysInclusive(forecastFrom, forecastTo);
    const historyEnd = new Date(forecastFrom);
    const historyStart = new Date(historyEnd.getTime() - safeLookbackDays * DAY_MS);

    const snap = await getDocs(collection(db, "orders_v2"));
    const orders = snap.docs.map(d => ({ docId: d.id, ...d.data() }));

    const usage = new Map();

    for (const order of orders) {
      if (!isOrderEligible(order)) continue;
      const createdAt = getCreatedAt(order);
      if (!createdAt) continue;
      if (createdAt < historyStart || createdAt >= historyEnd) continue;

      const items = Array.isArray(order?.items) ? order.items : [];
      for (const item of items) {
        const qty = getItemQty(item);
        if (qty <= 0) continue;

        const meta = getItemMeta(item);
        const key = getGroupingKey(meta, mode);
        const existing = usage.get(key) || {
          key,
          variantId: meta.variantId,
          sku: meta.sku,
          productId: meta.productId,
          productTitle: meta.productTitle,
          label: meta.label,
          consumedQty: 0
        };

        existing.consumedQty = Number((existing.consumedQty + qty).toFixed(2));
        usage.set(key, existing);
      }
    }

    const items = Array.from(usage.values()).map(entry => {
      const avgPerDay = entry.consumedQty / safeLookbackDays;
      const forecastQty = Math.ceil(avgPerDay * periodDays);
      const safetyQty = Math.ceil(forecastQty * (safeSafetyPct / 100));
      const recommendedStockQty = Math.max(0, forecastQty + safetyQty);

      return {
        key: entry.key,
        variantId: entry.variantId,
        sku: entry.sku,
        productId: entry.productId,
        productTitle: entry.productTitle,
        label: entry.label,
        consumedQtyInLookback: Number(entry.consumedQty.toFixed(2)),
        avgDailyQty: Number(avgPerDay.toFixed(4)),
        forecastQty,
        safetyQty,
        recommendedStockQty
      };
    });

    items.sort((a, b) => b.recommendedStockQty - a.recommendedStockQty);

    const totals = items.reduce(
      (acc, item) => {
        acc.totalForecastQty += item.forecastQty;
        acc.totalSafetyQty += item.safetyQty;
        acc.totalRecommendedStockQty += item.recommendedStockQty;
        return acc;
      },
      {
        totalItems: items.length,
        totalForecastQty: 0,
        totalSafetyQty: 0,
        totalRecommendedStockQty: 0
      }
    );

    const payload = {
      inputs: {
        fromDate: forecastFrom.toISOString(),
        toDate: forecastTo.toISOString(),
        periodDays,
        forecastDays: safeForecastDays,
        lookbackDays: safeLookbackDays,
        safetyBufferPct: safeSafetyPct,
        groupBy: mode
      },
      historyWindow: {
        fromDate: historyStart.toISOString(),
        toDateExclusive: historyEnd.toISOString()
      },
      totals,
      items
    };

    const pdfUrl = await createPdfReport({
      generatedAt: new Date().toISOString(),
      ...payload
    });

    return ok({
      ...payload,
      report: {
        pdfUrl
      }
    });
  } catch (e) {
    return err(500, "Stock Prediction Failed", e?.message || "Unexpected error.");
  }
}
