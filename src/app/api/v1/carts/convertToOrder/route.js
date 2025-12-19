export const runtime = "nodejs";

import { NextResponse } from "next/server";
import axios from "axios";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

/* -------------------------------------------------------
   Generate sequential order_id with failsafe
------------------------------------------------------- */
async function generateOrderId() {
  let nextId = 1;

  const snap = await getDocs(collection(db, "orders_v2"));
  if (!snap.empty) {
    const ids = [];
    snap.forEach((d) => {
      const id = d.data()?.order_id;
      if (typeof id === "number") ids.push(id);
    });
    if (ids.length > 0) nextId = Math.max(...ids) + 1;
  }

  // failsafe: ensure it doesn't exist
  let exists = true;
  while (exists) {
    const check = await getDocs(
      collection(db, "orders_v2"),
    );

    exists = false;
    check.forEach((o) => {
      if (o.data()?.order_id === nextId) exists = true;
    });

    if (exists) nextId++;
  }

  return nextId;
}

/* -------------------------------------------------------
   MAIN ENDPOINT
------------------------------------------------------- */

export async function POST(req) {
  try {
    const {
      uid,
      delivery_address, // full object
      payment_method = null // optional, for personal accounts
    } = await req.json();

    if (!uid)
      return err(400, "Invalid Request", "uid is required.");

    /* ---------------- Fetch Cart ---------------- */
    const cartRef = doc(db, "carts", uid);
    const cartSnap = await getDoc(cartRef);

    if (!cartSnap.exists())
      return err(404, "Cart Not Found", "No cart exists for this user.");

    const cart = cartSnap.data();

    if (!cart.items || cart.items.length === 0)
      return err(400, "Cart Empty", "Cannot convert an empty cart.");

    /* ---------------- Fetch User Doc ---------------- */
    const userRef = doc(db, "users", uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists())
      return err(404, "User Not Found", "User document missing.");

    const user = userSnap.data();

    /* ---------------- Determine Payment Logic ---------------- */
    const isBusiness = user.account?.type === "business";
    const isApprovedCredit = user.account?.isCreditApproved === true;

    let payment_required = true;
    let payment_status = "pending";

    if (isBusiness && isApprovedCredit) {
      payment_required = false;
      payment_status = "waived";
    } else {
      payment_required = true;
      payment_status = "pending";
    }

    /* ---------------- Generate Order ID ---------------- */
    const order_id = await generateOrderId();
    const order_number = `BG-${String(order_id).padStart(6, "0")}`;

    /* ---------------- Build Final Order Document ---------------- */
    const now = new Date().toISOString();

    const orderDoc = {
      order_id,
      order_number,
      uid,

      cart_snapshot: {
        items: cart.items,
        totals: cart.totals,
        cart: cart.cart,
        warnings: cart.warnings || {}
      },

      customer_snapshot: user,

      delivery_address: delivery_address || null,

      payment: {
        payment_required,
        payment_status,
        method: payment_required ? payment_method : "account_credit",
        transaction_id: null
      },

      status: {
        order_status: "pending",
        createdAt: now,
        updatedAt: now
      },

      delivery_docs: {
        delivery_note: {
          url: null,
          generatedAt: null,
          generatedBy: null
        },
        picking_slip: {
          url: null,
          generatedAt: null,
          generatedBy: null
        },
        proof_of_delivery: {
          url: null,
          uploadedAt: null,
          uploadedBy: null
        }
      },

      invoice: {
        invoice_id: null,
        url: null,
        generatedAt: null,
        generatedBy: "system",
        status: "not_generated",
        notes: null
      }
    };

    /* ---------------- Persist Order ---------------- */
    const orderRef = doc(db, "orders_v2", String(order_id));
    await setDoc(orderRef, orderDoc);

    /* ---------------- Mark Cart as Converted ---------------- */
    await updateDoc(cartRef, {
      "cart.status": "converted",
      items: [],
      timestamps: { updatedAt: now }
    });

    return ok({
      message: "Order created successfully.",
      data: {
        order_id,
        order_number,
        payment_required,
        payment_status
      }
    });

  } catch (e) {
    console.error(e);
    return err(500, "Order Creation Failed", "Unexpected server error.", {
      error: e.toString()
    });
  }
}
