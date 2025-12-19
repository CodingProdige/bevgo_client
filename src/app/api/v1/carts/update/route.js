export const runtime = "nodejs";

import { NextResponse } from "next/server";
import axios from "axios";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, setDoc } from "firebase/firestore";

/* ------------- HELPERS ------------- */
const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false,title:t,message:m,...e },{ status:s });

const now = ()=>new Date().toISOString();
const VAT = 0.15;
const r2 = v => Number(v.toFixed(2));

/* Product API (cross-backend) */
const PRODUCT_BASE = "https://bevgo-pricelist.vercel.app/api/catalogue/v1/products/sale";

/* Reserve sale quantity */
async function reserveSale(unique_id, variant_id, qty){
  if (qty <= 0) return;
  await axios.post(`${PRODUCT_BASE}/reserve`, { unique_id, variant_id, qty });
}

/* Release sale quantity */
async function releaseSale(unique_id, variant_id, qty){
  if (qty <= 0) return;
  await axios.post(`${PRODUCT_BASE}/release`, { unique_id, variant_id, qty });
}

/* ------------- ENDPOINT ------------- */

export async function POST(req){
  try{
    const body = await req.json();
    const { uid, product, variant_id, mode, qty } = body || {};

    if (!uid || !product || !product.product?.unique_id || !variant_id || !mode || qty == null){
      return err(400,"Invalid Request",
        "uid, product (with product.product.unique_id), variant_id, mode, qty are required."
      );
    }

    if (!["set","change"].includes(mode)){
      return err(400,"Invalid Mode","mode must be 'set' or 'change'.");
    }

    const p = product;
    const product_unique_id = p.product.unique_id;

    /* Find variant */
    const variant = p.variants?.find(v => v.variant_id == variant_id);
    if (!variant) return err(400,"Variant Not Found","Variant does not exist.");
    if (!variant.placement?.isActive) return err(400,"Variant Inactive","Variant is not active.");

    const isOnSale = variant.sale?.is_on_sale === true;
    const saleAvailable = isOnSale ? (variant.sale.qty_available || 0) : 0;

    /* Load cart */
    const cartRef = doc(db,"carts",uid);
    const snap = await getDoc(cartRef);

    let cart = snap.exists() ? snap.data() : {
      cart:{ cart_id:`CART-${uid}`, user_id:uid, status:"active" },
      items:[],
      totals:{},
      timestamps:{ createdAt:now(), updatedAt:now() }
    };
    let items = cart.items || [];

    const existingIndex = items.findIndex(
      it => it.product_unique_id === product_unique_id &&
            it.selected_variant?.variant_id == variant_id
    );

    const existing = existingIndex >= 0 ? items[existingIndex] : null;
    const currentQty = existing?.qty || 0;
    const currentSaleQty = existing?.sale_qty || 0;

    /* Resolve final qty */
    let finalQty = mode === "set" ? qty : currentQty + qty;
    if (finalQty < 0) finalQty = 0;

    /* If final quantity = 0 → remove + release sale stock */
    if (finalQty === 0){
      if (existing){
        if (isOnSale && currentSaleQty > 0){
          await releaseSale(product_unique_id, variant_id, currentSaleQty);
        }
        items.splice(existingIndex,1);
      }

      cart.items = items;
      cart.timestamps.updatedAt = now();
      await setDoc(cartRef, cart, { merge:true });
      return ok({ data:{ cart } });
    }

    /* ---------------- SALE RESERVATION LOGIC ---------------- */

    let newSaleQty = 0;
    let newRegularQty = 0;

    if (isOnSale){

      if (!existing){
        // Entire new quantity
        newSaleQty = Math.min(finalQty, saleAvailable);
        newRegularQty = finalQty - newSaleQty;

        if (newSaleQty > 0){
          await reserveSale(product_unique_id, variant_id, newSaleQty);
        }
      } else {
        // Compute sale delta
        const requiredSaleQty = Math.min(finalQty, saleAvailable + existing.sale_qty);

        if (requiredSaleQty > currentSaleQty){
          const diff = requiredSaleQty - currentSaleQty;
          await reserveSale(product_unique_id, variant_id, diff);
        }
        else if (requiredSaleQty < currentSaleQty){
          const diff = currentSaleQty - requiredSaleQty;
          await releaseSale(product_unique_id, variant_id, diff);
        }

        newSaleQty = requiredSaleQty;
        newRegularQty = finalQty - requiredSaleQty;
      }

    } else {
      newSaleQty = 0;
      newRegularQty = finalQty;
    }

    /* ---------------- Build item snapshot ---------------- */

    const item = {
      product_unique_id,
      qty: finalQty,
      sale_qty: newSaleQty,
      regular_qty: newRegularQty,
      grouping: p.grouping,
      placement: p.placement,
      media: p.media,
      product: p.product,
      ratings: p.ratings || { average:null, count:0, lastUpdated:null },

      selected_variant:{
        ...variant,
        sale_reservation_qty: newSaleQty
      },

      timestamps:{
        createdAt: existing?.timestamps?.createdAt || now(),
        updatedAt: now()
      }
    };

    if (existingIndex >= 0) items[existingIndex] = item;
    else items.push(item);

    cart.items = items;

    /* ---------------- Recalculate totals ---------------- */

    let totals = {
      subtotal_excl:0,
      subtotal_incl:0,
      rebate_amount:0,
      sale_savings_excl:0,
      deposit_total_excl:0,
      vat_total:0,
      final_excl:0,
      final_incl:0
    };

    for (const it of items){
      const v = it.selected_variant;
      const base = v.pricing.selling_price_excl;
      const sale = v.sale?.is_on_sale ? v.sale.sale_price_excl : base;

      const saleSub = it.sale_qty * sale;
      const regSub  = it.regular_qty * base;
      const subtotal = saleSub + regSub;

      totals.subtotal_excl += subtotal;

      if (v.sale?.is_on_sale){
        totals.sale_savings_excl += it.sale_qty * (base - sale);
      }

      totals.deposit_total_excl += v.pricing.deposit_included
        ? it.qty * (v.returnable?.pricing?.full_returnable_price_excl || 0)
        : 0;
    }

    totals.final_excl = totals.subtotal_excl + totals.deposit_total_excl;
    totals.vat_total = totals.final_excl * VAT;
    totals.final_incl = totals.final_excl + totals.vat_total;
    totals.subtotal_incl = totals.final_incl;

    Object.keys(totals).forEach(k => totals[k] = r2(totals[k]));

    cart.totals = totals;
    cart.timestamps.updatedAt = now();

    await setDoc(cartRef, cart, { merge:true });
    return ok({ data:{ cart } });

  }catch(e){
    console.error(e);
    return err(500,"Cart Update Failed","Unexpected error",{ error:e.toString() });
  }
}
