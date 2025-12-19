export const runtime = "nodejs";

import { NextResponse } from "next/server";
import axios from "axios";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, setDoc } from "firebase/firestore";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const PRODUCT_BASE =
  "https://bevgo-pricelist.vercel.app/api/catalogue/v1/products/sale";

async function releaseSale(unique_id, variant_id, qty) {
  if (qty > 0) {
    await axios.post(`${PRODUCT_BASE}/release`, {
      unique_id,
      variant_id,
      qty,
    });
  }
}

export async function POST(req) {
  try {
    const { uid, unique_id, variant_id } = await req.json();

    if (!uid || !unique_id || !variant_id) {
      return err(
        400,
        "Invalid Request",
        "uid, unique_id, and variant_id are required."
      );
    }

    const cartRef = doc(db, "carts", uid);
    const snap = await getDoc(cartRef);

    if (!snap.exists()) {
      return ok({
        data: { cart: null, message: "Cart already empty." },
      });
    }

    let cart = snap.data();
    let items = cart.items || [];

    // Find matching item
    const index = items.findIndex(
      (it) =>
        it.unique_id === unique_id &&
        it.selected_variant_id == variant_id
    );

    if (index < 0) {
      return ok({
        data: { cart, message: "Item not found in cart." },
      });
    }

    const item = items[index];

    // This *is* your actual reservation quantity
    const saleQty = item.sale_qty || 0;

    // Restore sale stock
    if (saleQty > 0) {
      await releaseSale(unique_id, variant_id, saleQty);
    }

    // Remove item
    items.splice(index, 1);

    cart.items = items;
    cart.timestamps = {
      ...(cart.timestamps || {}),
      updatedAt: new Date().toISOString(),
    };

    await setDoc(cartRef, cart, { merge: true });

    return ok({
      data: {
        cart,
        message: "Item removed & sale stock restored.",
      },
    });

  } catch (e) {
    console.error(e);
    return err(500, "Remove Failed", "Unexpected error.", {
      error: e.toString(),
    });
  }
}
