export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  doc,
  getDoc,
  setDoc,
  runTransaction
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

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
      return err(
        400,
        "Missing Parameters",
        "cartId and customerId are required."
      );
    }

    /* ───── Load Cart ───── */

    const cartRef = doc(db, "carts", cartId);
    const cartSnap = await getDoc(cartRef);

    if (!cartSnap.exists()) {
      return err(404, "Cart Not Found", "No cart found for this cartId.");
    }

    const cart = cartSnap.data();

    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return err(400, "Empty Cart", "Cannot create order from empty cart.");
    }

    /* ───── Validate 50-min eligibility (from cart if present) ───── */
    const isEligibleFor50 =
      cart.meta?.delivery_50min_eligible === true;

    if (deliverySpeed === "express_50" && !isEligibleFor50) {
      return err(
        400,
        "Delivery Not Eligible",
        "This cart is not eligible for 50-minute delivery."
      );
    }

    /* ───── Load Customer ───── */

    const userRef = doc(db, "users", customerId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return err(404, "User Not Found", "Customer does not exist.");
    }

    const user = userSnap.data();

    /* ───── Generate Order ID ───── */

    const orderId = `ord_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 7)}`;

    const timestamp = now();

    /* ───── Generate Sequential Order Number ───── */

    const counterRef = doc(db, "system_counters", "orders");
    let orderNumber = null;

    await runTransaction(db, async tx => {
      const snap = await tx.get(counterRef);
      const last = snap.exists() ? snap.data().last : 0;
      const next = last + 1;

      tx.set(counterRef, { last: next }, { merge: true });

      orderNumber = `BVG-${String(next).padStart(6, "0")}`;
    });

    /* ───── Build Order Document ───── */

    const orderDoc = {
      docId: orderId,

      order: {
        orderId,
        orderNumber,
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

      audit: {
        edits: []
      },

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

    await setDoc(doc(db, "orders", orderId), orderDoc);

    return ok({
      orderId,
      orderNumber,
      status: orderDoc.order.status.order
    });

  } catch (e) {
    return err(500, "Server Error", e.message);
  }
}
