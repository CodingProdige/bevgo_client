export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, setDoc } from "firebase/firestore";

/* ------------------------------- HELPERS ------------------------------- */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const now = () => new Date().toISOString();
const f2 = (n) => Number(parseFloat(n || 0).toFixed(2));
const VAT = 0.15;

/* EMPTY DEFAULT MODULES */
const EMPTY_TOTALS = {
  subtotal_excl: 0,
  subtotal_incl: 0,
  rebate_amount: 0,
  sale_savings_excl: 0,
  deposit_total_excl: 0,
  final_excl: 0,
  final_incl: 0,
  vat_total: 0,
};

const EMPTY_CART_OBJECT = (uid) => ({
  timestamps: {
    createdAt: now(),
    updatedAt: now(),
  },
  totals: { ...EMPTY_TOTALS },
  cart: {
    status: "active",
    cart_id: `CART-${uid}`,
    user_id: uid,
  },
  items: [],
});

/* ------------------------------- CATALOGUE FETCH ------------------------------- */

async function fetchFreshProduct(uniqueId) {
  const url = `https://bevgo-pricelist.vercel.app/api/catalogue/v1/products/product/get?id=${uniqueId}`;

  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`Catalogue API: ${res.status}`);

  const json = await res.json();
  if (!json.ok) throw new Error(json.message || "Invalid response");

  return json.data;
}

/* ------------------------------- ENDPOINT ------------------------------- */

export async function POST(req) {
  try {
    const body = await req.json();
    const { uid } = body || {};

    if (!uid) return err(400, "Invalid Request", "uid is required.");

    const cartRef = doc(db, "carts", uid);
    const cartSnap = await getDoc(cartRef);

    /* ---------------------- NO CART FOUND ---------------------- */
    if (!cartSnap.exists()) {
      return ok({
        data: {
          cart: {
            ...EMPTY_CART_OBJECT(uid),
            items: [],
            totals: { ...EMPTY_TOTALS },
            item_count: 0,             // ⭐ ALWAYS
            cart_corrected: false,      // ⭐ ALWAYS
          },
          warnings: { global: [], items: [] },
        },
      });
    }

    /* ---------------------- LOAD CART ---------------------- */

    let cartData = cartSnap.data();
    let items = cartData.items || [];

    let warningsGlobal = [];
    let warningsItems = [];
    let cartCorrected = false;

    /* ---------------------- PROCESS ITEMS ---------------------- */

    for (let i = items.length - 1; i >= 0; i--) {
      let item = items[i];
      const productId = item.product_unique_id;

      /** Attach item warnings module */
      item.warnings = [];

      let fresh;
      try {
        fresh = await fetchFreshProduct(productId);
      } catch (e) {
        warningsGlobal.push({
          type: "catalogue_fetch_failed",
          product_unique_id: productId,
          message: "Failed to refresh product data — using snapshot.",
        });

        fresh = item.product_snapshot;
      }

      /* ---------------- REMOVE if inactive ---------------- */
      if (!fresh.placement?.isActive) {
        item.warnings.push({
          type: "product_inactive_removed",
          message: "Product deactivated.",
        });

        items.splice(i, 1);
        warningsItems.push(...item.warnings);
        cartCorrected = true;
        continue;
      }

      /* ---------------- REMOVE if supplier unavailable ---------------- */
      if (fresh.placement?.supplier_out_of_stock) {
        item.warnings.push({
          type: "supplier_unavailable_removed",
          message: "Supplier cannot supply this product.",
        });

        items.splice(i, 1);
        warningsItems.push(...item.warnings);
        cartCorrected = true;
        continue;
      }

      /* ---------------- Refresh product-level fields ---------------- */
      item.product_snapshot = fresh;
      item.grouping = fresh.grouping;
      item.placement = fresh.placement;
      item.media = fresh.media;
      item.product = fresh.product;
      item.ratings = fresh.ratings || { average: null, count: 0 };

      const freshVariant = fresh.variants?.find(
        (v) => String(v.variant_id) === String(item.selected_variant_id)
      );

      if (!freshVariant || !freshVariant.placement?.isActive) {
        item.warnings.push({
          type: "variant_removed",
          message: "Variant no longer active.",
        });

        items.splice(i, 1);
        warningsItems.push(...item.warnings);
        cartCorrected = true;
        continue;
      }

      /* ---------------- Sale reconciliation ---------------- */
      const saleAvailable = Math.max(parseInt(freshVariant.sale?.qty_available || 0), 0);
      const isOnSale =
        freshVariant.sale?.is_on_sale &&
        freshVariant.sale?.sale_price_excl > 0 &&
        saleAvailable > 0;

      let sale_qty = item.sale_qty;
      let regular_qty = item.regular_qty;

      if (isOnSale) {
        if (sale_qty > saleAvailable) {
          const diff = sale_qty - saleAvailable;
          sale_qty = saleAvailable;
          regular_qty += diff;

          item.warnings.push({
            type: "sale_quantity_reduced",
            message: "Sale qty reduced due to limited availability.",
          });

          cartCorrected = true;
        }
      } else {
        if (sale_qty > 0) {
          regular_qty += sale_qty;
          sale_qty = 0;

          item.warnings.push({
            type: "sale_no_longer_valid",
            message: "Sale has ended — moved to regular pricing.",
          });

          cartCorrected = true;
        }
      }

      /* ---------------- Update variant snapshot ---------------- */
      item.selected_variant_snapshot = freshVariant;
      item.sale_qty = sale_qty;
      item.regular_qty = regular_qty;
      item.qty = sale_qty + regular_qty;
      item.timestamps.updatedAt = now();

      items[i] = item;

      if (item.warnings.length > 0) warningsItems.push(...item.warnings);
    }

    /* ---------------------- Recalculate Totals ---------------------- */

    let totals = { ...EMPTY_TOTALS };

    for (const item of items) {
      const v = item.selected_variant_snapshot;
      const base = f2(v.pricing?.selling_price_excl);
      const sale = v.sale?.is_on_sale && v.sale?.sale_price_excl > 0
        ? f2(v.sale.sale_price_excl)
        : base;

      const saleSubtotal = f2(item.sale_qty * sale);
      const regularSubtotal = f2(item.regular_qty * base);

      const subtotal = f2(saleSubtotal + regularSubtotal);
      totals.subtotal_excl = f2(totals.subtotal_excl + subtotal);

      const depositSubtotal =
        v.pricing?.deposit_included
          ? f2(item.qty * (v.returnable?.data?.pricing?.full_returnable_price_excl || 0))
          : 0;

      totals.deposit_total_excl = f2(totals.deposit_total_excl + depositSubtotal);

      totals.subtotal_incl = f2(totals.subtotal_excl * (1 + VAT));
      totals.final_excl = f2(totals.subtotal_excl + totals.deposit_total_excl);
      totals.final_incl = f2(totals.final_excl * (1 + VAT));
      totals.vat_total = f2(totals.final_incl - totals.final_excl);

      if (v.sale?.is_on_sale)
        totals.sale_savings_excl = f2(
          totals.sale_savings_excl + item.sale_qty * (base - sale)
        );
    }

    /* ---------------------- SAVE IF CORRECTED ---------------------- */

    if (cartCorrected) {
      cartData.items = items;
      cartData.totals = totals;
      cartData.timestamps.updatedAt = now();
      await setDoc(cartRef, cartData, { merge: true });
    }

    /* ---------------------- FINAL RESPONSE ---------------------- */

    return ok({
      data: {
        cart: {
          ...cartData,
          items,
          totals,
          item_count: items.reduce((a, it) => a + (it.qty || 0), 0), // ⭐ ALWAYS
          cart_corrected: cartCorrected,                            // ⭐ ALWAYS
        },
        warnings: {
          global: warningsGlobal,
          items: warningsItems,
        },
      },
    });

  } catch (e) {
    console.error(e);
    return err(500, "Cart Retrieval Failed", "Unexpected server error.", {
      error: e.toString(),
    });
  }
}
