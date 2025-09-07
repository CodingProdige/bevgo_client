// app/api/stock-reorder/route.js
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import ejs from 'ejs';
import fs from 'fs/promises';
import path from 'path';

// -------------------- External endpoints --------------------
const PREDICTION_URL = 'https://bevgo-client.vercel.app/api/stockPrediction';
const GET_PRODUCT_URL = 'https://bevgo-pricelist.vercel.app/api/getProduct';
const PDF_FUNCTION_URL = 'https://generatepdf-th2kiymgaa-uc.a.run.app';

// -------------------- Template path --------------------
const TEMPLATE_PATH = path.join(process.cwd(), 'src/lib/emailTemplates/reorderTemplate.ejs');

// -------------------- Tunables --------------------
const DEFAULT_SAFETY_STOCK_PCT = 0.05; // 5%
const CONCURRENCY = 10; // concurrent getProduct calls

// Optional: display-only lead-times in the PDF (not used in the math)
const DEFAULT_VENDOR_LEAD_TIMES = {
  // 'Peninsula Beverages': 2,
  // 'La Vie De Luc': 2,
};

// -------------------- Helpers --------------------
const isNum = (v) => Number.isFinite(Number(v));
const num = (v, d = 0) => (isNum(v) ? Number(v) : d);

const pick = (obj, keys, fallback) => {
  for (const k of keys) if (obj?.[k] !== undefined && obj?.[k] !== null) return obj[k];
  return fallback;
};

const pickVendor = (p) =>
  pick(p, ['vendor', 'supplier', 'product_vendor', 'product_supplier', 'product_brand'], 'Unknown Vendor');
const pickTitle = (p) => pick(p, ['product_title', 'productName', 'title'], 'Untitled');
const pickBrand = (p) => pick(p, ['product_brand', 'brand'], '');
const pickPack = (p) => pick(p, ['pack_size', 'packSize'], '');
const pickMOQUnits = (p) => num(p?.moq_units ?? p?.min_order_units ?? p?.minimum_order_units, 0);

// Prefer supplier case price; fallback to normal case price (both are per CASE)
const pickCasePriceExcl = (p) => {
  if (isNum(p?.supplier_price_excl)) return Number(p.supplier_price_excl);
  if (isNum(p?.price_excl)) return Number(p.price_excl);
  return null;
};

// Returnable deposit per CASE (full or partial), with fallbacks
const pickReturnablePerCaseExcl = (p, mode) => {
  const has = !!p?.has_returnable || !!p?.assigned_returnable;
  if (!has) return null;

  const keyTop = mode === 'full' ? 'returnable_full_price_excl' : 'returnable_partial_price_excl';
  if (isNum(p?.[keyTop])) return Number(p[keyTop]);

  const assigned = p?.assigned_returnable || {};
  const keyAssigned = mode === 'full' ? 'price_excl' : 'partial_price_excl';
  if (isNum(assigned?.[keyAssigned])) return Number(assigned[keyAssigned]);

  return null;
};

const parseUnitsPerCase = (packSize) => {
  if (packSize == null) return null;
  const s = String(packSize).trim();
  if (/^\d+$/.test(s)) return Number(s); // e.g. "24"
  const m = s.match(/(\d+)\s*x\s*\d*\.?\d*\s*(ml|l|lt)?/i); // e.g. "24 x 300ml"
  if (m && m[1]) return Number(m[1]);
  return null;
};

const groupBy = (rows, key) =>
  rows.reduce((acc, r) => {
    const k = r[key] ?? 'Unknown';
    (acc[k] ??= []).push(r);
    return acc;
  }, {});

const mapWithConcurrency = async (items, limit, fn) => {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return out;
};

// Safe, timestamped filenames (prevents slashes/illegal chars)
function buildUniqueFileName(baseName = 'bevgo-stock-reorder') {
  // Replace illegal filename chars just in case a custom baseName is sent
  const safeBase = String(baseName).replace(/[\/\\:*?"<>|]+/g, '-').trim() || 'bevgo-stock-reorder';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); // e.g. 2025-09-05T08-41-22-123Z
  return `${safeBase}-${timestamp}.pdf`;
}

// -------------------- Core calls --------------------
async function getForecast({ days, mood, countryCode, companyCode, compare }) {
  const r = await fetch(PREDICTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ days, mood, companyCode, countryCode, compare }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Prediction endpoint failed: ${r.status} ${txt}`);
  }
  const j = await r.json();
  return Array.isArray(j?.results?.forecast) ? j.results.forecast : [];
}

// POST { unique_code } -> { product }
async function getProductByCode(uniqueCode) {
  const r = await fetch(GET_PRODUCT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ unique_code: String(uniqueCode) }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.product ?? null;
}

// -------------------- Route: POST --------------------
export async function POST(req) {
  try {
    const body = await req.json();
    const {
      days = 7,
      mood = 'normal',
      countryCode = 'ZA',
      companyCode,
      compare = { from: '', to: '' },

      safetyStockPct = DEFAULT_SAFETY_STOCK_PCT,
      vendorFilter,                 // optional: ['Vendor A', 'Vendor B']
      includeZero = false,          // include rows even if orderCases = 0

      includeReturnables = true,    // include returnable deposits in value
      returnableMode = 'partial',   // 'partial' | 'full'

      // Branding / header info for the PDF:
      bannerUrl = "https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo%20Header%20Banner.png?alt=media&token=fb6ef880-b618-46c5-a1c3-e9bc1dd3690e", 
      companyAddress = "Unit 2, 4 EK Green Str. Charleston Hill, Paarl, Western Cape, South Africa, 7646", 
      companyContact = "071 619 1616", 
      companyEmail = "info@bevgo.co.za", 
      companyVAT = 4760314296,

      // Optional vendor lead times override (object map)
      vendorLeadTimes = DEFAULT_VENDOR_LEAD_TIMES,

      // PDF controls
      pdf = false,                  // if true, generate PDF via Cloud Run
      fileName,                     // optional base name for PDF (timestamp appended regardless)
    } = body || {};

    // 1) Forecast (per productCode)
    const forecast = await getForecast({ days, mood, countryCode, companyCode, compare });

    // Gather unique codes
    const codes = forecast
      .map((f) => String(f.productCode ?? '').trim())
      .filter((c) => c.length > 0);

    // 2) Fetch product records by code (bounded concurrency)
    const productsByCodeArr = await mapWithConcurrency(codes, CONCURRENCY, async (code) => {
      const product = await getProductByCode(code);
      return { code, product };
    });

    // 3) Build order rows (ALL quantities in CASES)
    const rows = [];
    for (const f of forecast) {
      const code = String(f.productCode ?? '').trim();
      if (!code) continue;

      const pWrap = productsByCodeArr.find((x) => x?.code === code);
      const product = pWrap?.product;
      if (!product) continue;

      const packSize = pickPack(product);
      const unitsPerCase = parseUnitsPerCase(packSize) || 0;

      // Product / forecast images
      const imageUrl = product?.product_image || f.imageUrl || null;

      // Treat catalog & forecast quantities as CASES
      const onHandCases   = num(product?.units_in_stock, 0);
      const forecastCases = num(f.forecastQty, 0);
      const safetyCases   = Math.ceil(forecastCases * num(safetyStockPct, DEFAULT_SAFETY_STOCK_PCT));

      // REQUIRED formula: order = forecast − onHand + safety
      let orderCases = Math.max(0, forecastCases - onHandCases + safetyCases);

      // Optional: MOQ provided in UNITS? Convert to CASES if pack is known.
      const moqUnits = pickMOQUnits(product);
      if (moqUnits && unitsPerCase > 0) {
        const moqCases = Math.ceil(moqUnits / unitsPerCase);
        if (orderCases < moqCases) orderCases = moqCases;
      }

      // Helper for PDF: show equivalent units when pack is known
      const orderUnits = unitsPerCase > 0 ? orderCases * unitsPerCase : null;

      // ---- Value calculation (per CASE) ----
      const casePriceExcl = pickCasePriceExcl(product); // supplier first
      const depositPerCaseExcl =
        includeReturnables ? pickReturnablePerCaseExcl(product, returnableMode) : null;

      const totalCasePriceExcl =
        casePriceExcl != null
          ? casePriceExcl + (isNum(depositPerCaseExcl) ? Number(depositPerCaseExcl) : 0)
          : null;

      const estimatedOrderValueExcl =
        totalCasePriceExcl != null ? +(orderCases * totalCasePriceExcl).toFixed(2) : null;

      const row = {
        uniqueCode: code,
        title: pickTitle(product) || f.productName,
        brand: pickBrand(product) || f.brand || '',
        vendor: pickVendor(product),
        packSize,
        unitsPerCase: unitsPerCase || null,

        // CASES for table
        onHandCases,
        forecastCases,
        safetyCases,
        orderCases: Math.round(orderCases),

        // tiny helper line in PDF
        orderUnits,

        // pricing
        casePriceExcl,
        depositPerCaseExcl: isNum(depositPerCaseExcl) ? Number(depositPerCaseExcl) : null,
        totalCasePriceExcl,
        estimatedOrderValueExcl,

        // media
        imageUrl,

        // context
        mood,
        days,
      };

      if (includeZero || row.orderCases > 0) rows.push(row);
    }

    // 4) Group & totals
    const filtered = Array.isArray(vendorFilter) && vendorFilter.length
      ? rows.filter((r) => vendorFilter.includes(r.vendor))
      : rows;

    const rowsByVendor = groupBy(filtered, 'vendor');
    const grandTotal = filtered.reduce((sum, r) => sum + (r.estimatedOrderValueExcl ?? 0), 0);

    const meta = {
      days,
      mood,
      countryCode,
      companyCode,
      generatedAt: new Date().toISOString(),
      generatedLocal: new Date().toLocaleString('en-ZA'),
      includeReturnables,
      returnableMode,
      // branding for the header section in the EJS template:
      bannerUrl,
      companyAddress,
      companyContact,
      companyEmail,
      companyVAT,
    };

    // 5) PDF or JSON
    const url = new URL(req.url);
    const wantsPdf = pdf || url.searchParams.get('format') === 'pdf';

    if (wantsPdf) {
      const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
      const html = await ejs.render(template, {
        meta,
        rowsByVendor,
        leadTimes: vendorLeadTimes || DEFAULT_VENDOR_LEAD_TIMES,
      });

      // Build a safe, timestamped filename (even if client passed fileName)
      const uniqueFileName = buildUniqueFileName(fileName || 'bevgo-stock-reorder');

      const resp = await fetch(PDF_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          htmlContent: html,
          fileName: uniqueFileName,
        }),
      });

      if (!resp.ok) {
        const txt = await resp.text();
        return NextResponse.json(
          { error: `PDF generation failed: ${resp.status} ${txt}` },
          { status: 500 }
        );
      }

      const { pdfUrl } = await resp.json();
      return NextResponse.json({
        meta,
        totals: {
          grandTotalExcl: +grandTotal.toFixed(2),
          vendorCounts: Object.fromEntries(
            Object.entries(rowsByVendor).map(([v, items]) => [v, items.length])
          ),
        },
        ordersByVendor: rowsByVendor,
        pdfUrl,
      });
    }

    // JSON only
    return NextResponse.json({
      meta,
      totals: {
        grandTotalExcl: +grandTotal.toFixed(2),
        vendorCounts: Object.fromEntries(
          Object.entries(rowsByVendor).map(([v, items]) => [v, items.length])
        ),
      },
      ordersByVendor: rowsByVendor,
    });
  } catch (err) {
    console.error('stock-reorder error:', err);
    return NextResponse.json({ error: err?.message || 'Internal Server Error' }, { status: 500 });
  }
}

// -------------------- Route: GET (convenience) --------------------
// /api/stock-reorder?days=7&mood=normal&companyCode=...&countryCode=ZA&format=pdf
export async function GET(req) {
  const url = new URL(req.url);
  const days = Number(url.searchParams.get('days') ?? 7);
  const mood = url.searchParams.get('mood') ?? 'normal';
  const companyCode = url.searchParams.get('companyCode') ?? undefined;
  const countryCode = url.searchParams.get('countryCode') ?? 'ZA';
  const pdf = url.searchParams.get('format') === 'pdf';

  const postReq = new Request(req.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days, mood, companyCode, countryCode, pdf }),
  });
  return POST(postReq);
}
