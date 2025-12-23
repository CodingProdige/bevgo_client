export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
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
    const { orderId, generatedBy = "system" } = await req.json();

    if (!orderId) {
      return err(400, "Missing Order ID", "orderId is required.");
    }

    /* ───── Load Order ───── */

    const orderRef = doc(db, "orders_v2", orderId);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return err(404, "Order Not Found", "Invalid orderId.");
    }

    const order = orderSnap.data();

    /* ───── Idempotency: Invoice already exists ───── */

    if (order?.invoice?.invoiceId) {
      return ok({
        orderId,
        invoiceId: order.invoice.invoiceId,
        status: "already_created"
      });
    }

    /* ───── Generate Sequential Invoice Number ───── */

    const counterRef = doc(db, "system_counters", "invoices");

    let invoiceNumber;
    let invoiceId;

    await runTransaction(db, async tx => {
      const snap = await tx.get(counterRef);
      const last = snap.exists() ? snap.data().last : 0;
      const next = last + 1;

      tx.set(counterRef, { last: next }, { merge: true });

      invoiceNumber = `INV-${String(next).padStart(6, "0")}`;
      invoiceId = `inv_${next}_${orderId}`;
    });

    const issuedAt = now();

    /* ───── Build Invoice Doc ───── */

    const invoiceDoc = {
      docId: invoiceId,

      invoice: {
        invoiceId,
        invoiceNumber,
        orderId,
        status: "issued"
      },

      order_snapshot: {
        docId: order.docId,
        order: order.order,
        items: order.items,
        totals: order.totals,
        customer_snapshot: order.customer_snapshot,
        delivery: order.delivery,
        meta: order.meta
      },

      timestamps: {
        issuedAt
      }
    };

    /* ───── Persist Invoice ───── */

    await setDoc(doc(db, "invoices", invoiceId), invoiceDoc);

    /* ───── Lock Order & Attach Invoice ───── */

    await updateDoc(orderRef, {
      invoice: {
        invoiceId,
        invoiceNumber,
        status: "issued",
        generatedAt: issuedAt,
        generatedBy
      },

      "order.editable": false,

      timestamps: {
        ...(order.timestamps || {}),
        updatedAt: issuedAt,
        lockedAt: issuedAt
      }
    });

    return ok({
      orderId,
      invoiceId,
      invoiceNumber,
      locked: true
    });

  } catch (e) {
    return err(500, "Server Error", e.message);
  }
}
