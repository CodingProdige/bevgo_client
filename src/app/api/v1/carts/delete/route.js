export const runtime = "nodejs";

import { NextResponse } from "next/server";
import axios from "axios";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, deleteDoc } from "firebase/firestore";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

/* Product backend (sale stock ops) */
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
    const { uid } = await req.json();

    if (!uid) {
      return err(400, "Invalid Request", "uid is required.");
    }

    const cartRef = doc(db, "carts", uid);
    const snap = await getDoc(cartRef);

    // No cart = nothing to restore
    if (!snap.exists()) {
      return ok({
        data: { cart: null, message: "Cart already empty." },
      });
    }

    const cart = snap.data();
    const items = cart.items || [];

    /* -------------------------------------------------------
     * Restore sale stock ONLY using:
     *  - item.unique_id
     *  - item.selected_variant_id
     *  - item.sale_qty
     * ------------------------------------------------------- */
    for (const it of items) {
      const saleQty = it.sale_qty || 0;

      if (saleQty > 0) {
        await releaseSale(it.unique_id, it.selected_variant_id, saleQty);
      }
    }

    /* -------------------------------------------------------
     * Delete the cart document
     * ------------------------------------------------------- */
    await deleteDoc(cartRef);

    return ok({
      data: {
        cart: null,
        message: "Cart deleted & sale stock restored.",
      },
    });

  } catch (e) {
    console.error(e);
    return err(500, "Delete Failed", "Unexpected server error.", {
      error: e.toString(),
    });
  }
}
