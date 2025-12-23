export const runtime = "nodejs";

import { NextResponse } from "next/server";

/* ───────── HELPERS ───────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

/* ───────── CONFIG ───────── */

const ALLOWED_50MIN_LOCATIONS = [
  "paarl",
  "franschhoek",
  "stellenbosch",
  "wellington"
];

const CUT_OFF_HOUR = 16; // 4pm

/* ───────── LOGIC ───────── */

function isBeforeCutoff() {
  const now = new Date();
  return now.getHours() < CUT_OFF_HOUR;
}

function isAddressEligible(address) {
  if (!address?.city) return false;
  return ALLOWED_50MIN_LOCATIONS.includes(
    address.city.toLowerCase()
  );
}

function allItemsInStock(items = []) {
  return items.every(item => {
    const variant = item.selected_variant_snapshot;
    const inventory = variant?.inventory;

    // ❌ No inventory tracking → NOT eligible for fast delivery
    if (!Array.isArray(inventory) || inventory.length === 0) {
      return false;
    }

    // ❌ Any inventory entry with insufficient qty
    return inventory.every(i => (i.qty_available ?? 0) > 0);
  });
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const { cart, deliveryAddress } = await req.json();

    /* ───── NORMALISE CART INPUT ───── */

    let items = null;

    // Case 1: items array passed directly
    if (Array.isArray(cart)) {
      items = cart;
    }

    // Case 2: getCart API response
    else if (Array.isArray(cart?.data?.cart?.items)) {
      items = cart.data.cart.items;
    }

    // Case 3: raw cart document
    else if (Array.isArray(cart?.items)) {
      items = cart.items;
    }

    if (!items) {
      return err(400, "Invalid Cart", "A valid cart object is required.");
    }

    /* ───── ELIGIBILITY CHECKS ───── */

    const reasons = [];

    if (!allItemsInStock(items)) {
      reasons.push("INSUFFICIENT_STOCK_FOR_FAST_DELIVERY");
    }

    if (!isAddressEligible(deliveryAddress)) {
      reasons.push("OUTSIDE_DELIVERY_ZONE");
    }

    if (!isBeforeCutoff()) {
      reasons.push("AFTER_CUTOFF_TIME");
    }

    const eligible = reasons.length === 0;

    return ok({
      eligible,
      reasons,
      cutoffHour: CUT_OFF_HOUR,
      evaluatedAt: new Date().toISOString()
    });

  } catch (e) {
    return err(
      500,
      "Eligibility Check Failed",
      "Unable to determine 50-minute delivery eligibility."
    );
  }
}
