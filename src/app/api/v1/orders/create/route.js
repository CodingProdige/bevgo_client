export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  doc,
  getDoc,
  setDoc,
  runTransaction
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";
import crypto from "crypto";

/* ───────────────── HELPERS ───────────────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status, title, message, extra = {}) =>
  NextResponse.json(
    { ok: false, title, message, ...extra },
    { status }
  );

const now = () => new Date().toISOString();

/* ───────────────── ENDPOINT ───────────────── */

export async function POST(req) {
  try {
    const {
      cartId,
      customerId,
      type = "personal",
      source = "web",
      customerNote = null,
      deliverySpeed = "standard"
    } = await req.json();

    if (!cartId || !customerId) {
      return err(400, "Missing Parameters", "cartId and customerId are required.");
    }

    /* ───── Load Cart from Catalogue Service ───── */

    const res = await fetch(
      "https://bevgo-pricelist.vercel.app/api/catalogue/v1/carts/cart/fetchCart",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: cartId })
      }
    );

    if (!res.ok) {
      return err(502, "Cart Service Error", "Unable to fetch cart from catalogue service.");
    }

    const json = await res.json();
    if (!json?.ok || !json?.data?.cart) {
      return err(400, "Invalid Cart", "Cart could not be loaded.");
    }

    const cart = json.data.cart;

    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return err(400, "Empty Cart", "Cannot create order from empty cart.");
    }

    /* ───── Validate 50-minute eligibility ───── */

    const isEligibleFor50 = cart.meta?.delivery_50min_eligible === true;

    if (deliverySpeed === "express_50" && !isEligibleFor50) {
      return err(400, "Delivery Not Eligible", "This cart is not eligible for 50-minute delivery.");
    }

    /* ───── Load Customer ───── */

    const userRef = doc(db, "users", customerId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return err(404, "User Not Found", "Customer does not exist.");
    }

    const user = userSnap.data();

    /* ───── Canonical Internal Order ID (UUID) ───── */

    const orderId = crypto.randomUUID(); // internal, never exposed to Peach

    const timestamp = now();

    /* ───── Generate Sequential Order Number ───── */

    const counterRef = doc(db, "system_counters", "orders");
    let orderNumber;

    await runTransaction(db, async tx => {
      const snap = await tx.get(counterRef);
      const last = snap.exists() ? snap.data().last : 0;
      const next = last + 1;

      tx.set(counterRef, { last: next }, { merge: true });

      orderNumber = `BVG-${String(next).padStart(6, "0")}`;
    });

    /* ───── Peach-safe merchantTransactionId ───── */
    /* <= 16 chars, deterministic, idempotent */

    const merchantTransactionId = orderNumber.replace("-", "");
    // e.g. BVG000123

    /* ───── Build Order Document ───── */

    const orderDoc = {
      docId: orderId,

      order: {
        orderId,
        orderNumber,
        merchantTransactionId,
        customerId,
        type,
        channel: cart.cart?.channel || source,
        editable: true,
        status: {
          order: "draft",
          payment: "unpaid",
          fulfillment: "not_started"
        }
      },

      items: cart.items,
      totals: cart.totals,

      customer_snapshot: {
        customerId,
        account: user.account || {},
        personal: user.personal || {}
      },

      payment: {
        method: null,
        currency: "ZAR",
        required_amount_incl: cart.totals.final_incl,
        paid_amount_incl: 0,
        status: "unpaid",
        attempts: []
      },

      delivery: {
        method: "delivery",
        speed: {
          type: deliverySpeed,
          eligible: isEligibleFor50,
          sla_minutes: deliverySpeed === "express_50" ? 50 : null
        },
        address_snapshot: null,
        scheduledDate: null,
        notes: null
      },

      delivery_docs: {
        picking_slip: { url: null, generatedAt: null },
        delivery_note: { url: null, generatedAt: null },
        proof_of_delivery: { url: null, uploadedAt: null }
      },

      audit: { edits: [] },

      meta: {
        source,
        customerNote,
        createdFromCartId: cartId
      },

      timestamps: {
        createdAt: timestamp,
        updatedAt: timestamp,
        lockedAt: null
      }
    };

    /* ───── Persist Order ───── */

    await setDoc(doc(db, "orders_v2", orderId), orderDoc);

    return ok({
      orderId,
      orderNumber,
      merchantTransactionId,
      status: orderDoc.order.status.order
    });

  } catch (e) {
    return err(500, "Server Error", e?.message || "Unexpected server error.");
  }
}
