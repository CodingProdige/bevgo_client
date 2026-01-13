export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  updateDoc
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

const nowIso = () => new Date().toISOString();
const VAT = 0.15;

function addMonthsKeepDay(iso, months = 1) {
  const d = new Date(iso);
  const day = d.getDate();
  const targetMonth = d.getMonth() + months;
  const target = new Date(d);
  target.setMonth(targetMonth);
  if (target.getDate() < day) target.setDate(0);
  return target.toISOString();
}

function addYearsKeepDay(iso, years = 1) {
  const d = new Date(iso);
  const month = d.getMonth();
  const day = d.getDate();
  const target = new Date(d);
  target.setFullYear(d.getFullYear() + years);
  if (target.getMonth() !== month || target.getDate() < day) {
    target.setDate(0);
  }
  return target.toISOString();
}

function addDays(iso, days = 1) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function getIsoWeekKey(dateObj) {
  const date = new Date(Date.UTC(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate()
  ));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getPeriodKey(billingPeriod) {
  const now = new Date();
  if (billingPeriod === "daily") return now.toISOString().slice(0, 10);
  if (billingPeriod === "weekly") return getIsoWeekKey(now);
  if (billingPeriod === "yearly") return now.toISOString().slice(0, 4);
  return now.toISOString().slice(0, 7); // monthly default
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildMerchantTransactionId(base, periodKey) {
  const compactBase = (base || "RENTAL").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const suffix = `R${periodKey.replace("-", "")}`; // RYYYYMM
  const maxBaseLen = 16 - suffix.length;
  const trimmedBase = compactBase.slice(0, Math.max(1, maxBaseLen));
  return `${trimmedBase}${suffix}`.slice(0, 16);
}

function getRentalPriceExcl(product, variantId) {
  const variants = product?.variants || [];
  const match = variants.find(v => String(v.variant_id) === String(variantId));
  if (!match) return null;

  return (
    match?.pricing?.rental_price_excl ??
    match?.pricing?.rental_price ??
    match?.rental?.rental_price_excl ??
    match?.rental_price_excl ??
    null
  );
}

async function fetchFreshProduct(uniqueId) {
  const url = `https://bevgo-pricelist.vercel.app/api/catalogue/v1/products/product/get?id=${uniqueId}`;
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`Catalogue API: ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.message || "Invalid response");
  return json.data?.data || json.data;
}

/* ───────── PEACH REQUEST ───────── */

const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;
const ENTITY_ID = process.env.PEACH_S2S_ENTITY_ID;
const HOST = "oppwa.com";

function peachRequest(path, form) {
  const body = querystring.stringify(form);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        port: 443,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(raw));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ───────── CORE HANDLER ───────── */

async function handleBilling({
  dryRun = false,
  limit = 0,
  concurrency = 3,
  maxRuntimeMs = 20000
}) {
  if (!ACCESS_TOKEN || !ENTITY_ID) {
    return err(500, "Config Error", "PEACH credentials are not configured.");
  }

  const startedAt = Date.now();
  const stopAt = startedAt + Math.max(1000, Number(maxRuntimeMs) || 20000);

  const snap = await getDocs(collection(db, "rentals_v2"));
  const rentals = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const now = new Date();
  const due = rentals.filter(r => {
    const status = r?.billing?.status || "unknown";
    const nextChargeAt = parseDate(r?.billing?.nextChargeAt);
    return status === "active" && nextChargeAt && nextChargeAt <= now;
  });

  let processed = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;
  const results = [];

  async function processRental(rental) {
    const rentalRef = doc(db, "rentals_v2", rental.id);
    const billingPeriod = (
      rental?.billing?.billing_period ||
      rental?.billing?.cadence ||
      "monthly"
    ).toLowerCase();
    const periodKey = getPeriodKey(billingPeriod);
    const attempts = Array.isArray(rental?.billing?.attempts)
      ? rental.billing.attempts
      : [];

    const alreadyCharged = attempts.some(
      a => a?.periodKey === periodKey && a?.status === "charged"
    );

    if (alreadyCharged) {
      return { rentalId: rental.id, status: "already_charged", outcome: "skipped" };
    }

    const cardId = rental?.billing?.cardId;
    if (!cardId) {
      const attempt = {
        type: "charge",
        status: "skipped_no_card",
        periodKey,
        createdAt: nowIso()
      };
      if (!dryRun) {
        await updateDoc(rentalRef, {
          "billing.status": "pending_card",
          "billing.attempts": [...attempts, attempt],
          "timestamps.updatedAt": nowIso()
        });
      }
      return { rentalId: rental.id, status: "no_card", outcome: "skipped" };
    }

    const customerId = rental?.customerId;
    const userSnap = await getDoc(doc(db, "users", customerId));
    if (!userSnap.exists()) {
      return { rentalId: rental.id, status: "user_not_found", outcome: "failed" };
    }

    const user = userSnap.data();
    const cards = user?.paymentMethods?.cards || [];
    const card = cards.find(c => c.id === cardId && c.status === "active");

    if (!card?.token?.registrationId || !card?.token?.peachTransactionId) {
      const attempt = {
        type: "charge",
        status: "skipped_invalid_card",
        periodKey,
        createdAt: nowIso()
      };
      if (!dryRun) {
        await updateDoc(rentalRef, {
          "billing.status": "pending_card",
          "billing.attempts": [...attempts, attempt],
          "timestamps.updatedAt": nowIso()
        });
      }
      return { rentalId: rental.id, status: "invalid_card", outcome: "skipped" };
    }

    let product;
    try {
      product = await fetchFreshProduct(rental?.product?.product_unique_id);
    } catch (e) {
      const attempt = {
        type: "charge",
        status: "failed_price_fetch",
        periodKey,
        createdAt: nowIso(),
        error: e?.message || "price_fetch_failed"
      };
      if (!dryRun) {
        await updateDoc(rentalRef, {
          "billing.attempts": [...attempts, attempt],
          "timestamps.updatedAt": nowIso()
        });
      }
      return { rentalId: rental.id, status: "price_fetch_failed", outcome: "failed" };
    }

    const rentalPriceExcl = getRentalPriceExcl(
      product,
      rental?.product?.variant_id
    );

    if (!rentalPriceExcl || rentalPriceExcl <= 0) {
      const attempt = {
        type: "charge",
        status: "failed_no_rental_price",
        periodKey,
        createdAt: nowIso()
      };
      if (!dryRun) {
        await updateDoc(rentalRef, {
          "billing.attempts": [...attempts, attempt],
          "timestamps.updatedAt": nowIso()
        });
      }
      return { rentalId: rental.id, status: "no_rental_price", outcome: "failed" };
    }

    const qty = Number(rental?.quantity || 1);
    const amountExcl = Number((rentalPriceExcl * qty).toFixed(2));
    const amountIncl = Number((amountExcl * (1 + VAT)).toFixed(2));
    const currency = rental?.billing?.currency || "ZAR";

    const baseId =
      rental?.orderNumber ||
      rental?.merchantTransactionId ||
      rental?.orderId ||
      rental?.rentalId ||
      "RENTAL";
    const merchantTransactionId = buildMerchantTransactionId(baseId, periodKey);

    const payload = {
      entityId: ENTITY_ID,
      amount: amountIncl.toFixed(2),
      currency,
      paymentType: "DB",
      "standingInstruction.mode": "REPEATED",
      "standingInstruction.source": "MIT",
      "standingInstruction.type": "UNSCHEDULED",
      "standingInstruction.initialTransactionId": card.token.peachTransactionId,
      merchantTransactionId
    };

    let gateway;
    if (!dryRun) {
      gateway = await peachRequest(
        `/v1/registrations/${card.token.registrationId}/payments`,
        payload
      );
    } else {
      gateway = { result: { code: "000.000.000", description: "dry_run" }, id: "dry_run" };
    }

    if (!gateway?.result?.code?.startsWith("000.")) {
      const attempt = {
        type: "charge",
        status: "failed",
        periodKey,
        merchantTransactionId,
        paymentId: gateway?.id || null,
        amount_incl: amountIncl,
        currency,
        createdAt: nowIso(),
        gateway
      };
      if (!dryRun) {
        await updateDoc(rentalRef, {
          "billing.status": "payment_failed",
          "billing.attempts": [...attempts, attempt],
          "timestamps.updatedAt": nowIso()
        });
      }
      return { rentalId: rental.id, status: "failed", outcome: "failed", gateway };
    }

    const attempt = {
      type: "charge",
      status: "charged",
      periodKey,
      merchantTransactionId,
      paymentId: gateway?.id || null,
      amount_excl: amountExcl,
      amount_incl: amountIncl,
      currency,
      createdAt: nowIso()
    };

    const baseNext = rental?.billing?.nextChargeAt || nowIso();
    const nextChargeAt =
      billingPeriod === "daily"
        ? addDays(baseNext, 1)
        : billingPeriod === "weekly"
          ? addDays(baseNext, 7)
          : billingPeriod === "yearly"
            ? addYearsKeepDay(baseNext, 1)
            : addMonthsKeepDay(baseNext, 1);

    if (!dryRun) {
      await updateDoc(rentalRef, {
        "billing.status": "active",
        "billing.lastChargedAt": nowIso(),
        "billing.nextChargeAt": nextChargeAt,
        "billing.attempts": [...attempts, attempt],
        "timestamps.updatedAt": nowIso()
      });
    }

    return {
      rentalId: rental.id,
      status: "charged",
      paymentId: gateway?.id || null,
      amount_incl: amountIncl,
      outcome: "success"
    };
  }

  for (let i = 0; i < due.length; i += concurrency) {
    if (Date.now() > stopAt) break;
    if (limit && processed >= limit) break;

    const batch = due.slice(i, i + concurrency);
    const remaining = limit ? Math.max(0, limit - processed) : batch.length;
    const toRun = limit ? batch.slice(0, remaining) : batch;

    processed += toRun.length;

    const batchResults = await Promise.all(toRun.map(r => processRental(r)));
    for (const res of batchResults) {
      if (res.outcome === "success") success += 1;
      else if (res.outcome === "failed") failed += 1;
      else skipped += 1;
      results.push(res);
    }
  }

  return ok({
    processed,
    success,
    failed,
    skipped,
    results
  });
}

/* ───────── ENDPOINTS ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      dryRun = false,
      limit = 0,
      concurrency = 3,
      maxRuntimeMs = 20000
    } = body || {};
    return await handleBilling({ dryRun, limit, concurrency, maxRuntimeMs });
  } catch (e) {
    return err(500, "Rental Billing Failed", e?.message || "Unexpected error.");
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : 0;
    const concurrencyParam = searchParams.get("concurrency");
    const maxRuntimeParam = searchParams.get("maxRuntimeMs");
    const concurrency = concurrencyParam ? Number(concurrencyParam) : 3;
    const maxRuntimeMs = maxRuntimeParam ? Number(maxRuntimeParam) : 20000;
    return await handleBilling({ dryRun, limit, concurrency, maxRuntimeMs });
  } catch (e) {
    return err(500, "Rental Billing Failed", e?.message || "Unexpected error.");
  }
}
