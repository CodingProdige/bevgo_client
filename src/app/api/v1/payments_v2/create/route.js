export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { addDoc, collection, updateDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const now = () => new Date().toISOString();
const r2 = v => Number((Number(v) || 0).toFixed(2));

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      customerId,
      customerCode = null,
      payment = {},
      proof = null,
      createdBy = null
    } = body || {};

    const method = String(payment?.method || "").trim();
    const currency = String(payment?.currency || "ZAR").trim();
    const amountIncl = Number(payment?.amount_incl);

    if (!customerId) {
      return err(400, "Missing Input", "customerId is required.");
    }

    if (!["cash", "eft", "card_machine"].includes(method)) {
      return err(
        400,
        "Invalid Method",
        "payment.method must be 'cash', 'eft', or 'card_machine'."
      );
    }

    if (!Number.isFinite(amountIncl) || amountIncl <= 0) {
      return err(400, "Invalid Amount", "payment.amount_incl must be > 0.");
    }

    const timestamp = now();
    const paymentDoc = {
      payment: {
        method,
        amount_incl: r2(amountIncl),
        remaining_amount_incl: r2(amountIncl),
        currency,
        status: "unallocated",
        reference: payment?.reference || null,
        note: payment?.note || null
      },
      customer: {
        customerId,
        customerCode: customerCode || null
      },
      proof: proof && typeof proof === "object"
        ? {
            type: proof.type || null,
            url: proof.url || null
          }
        : null,
      allocations: [],
      timestamps: {
        createdAt: timestamp,
        updatedAt: timestamp
      },
      meta: {
        createdBy: createdBy || null
      }
    };

    const ref = await addDoc(collection(db, "payments_v2"), paymentDoc);
    await updateDoc(doc(db, "payments_v2", ref.id), { docId: ref.id });

    return ok({
      docId: ref.id,
      payment: paymentDoc
    }, 201);
  } catch (e) {
    return err(
      500,
      "Create Payment Failed",
      e?.message || "Unexpected error creating payment."
    );
  }
}
