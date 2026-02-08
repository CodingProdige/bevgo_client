export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";
import { pricingDb } from "@/lib/firebasePricingConfig";
import { VAT_RATE } from "@/app/api/v1/orders/updateAtomic/functions/lineCalculator";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const now = () => new Date().toISOString();
const r2 = v => Number((Number(v) || 0).toFixed(2));

async function resolveOrderId(orderNumber) {
  if (!orderNumber) return null;

  const matchSnap = await getDocs(
    query(
      collection(db, "orders_v2"),
      where("order.orderNumber", "==", orderNumber)
    )
  );

  if (matchSnap.size > 1) {
    throw {
      code: 409,
      title: "Multiple Orders Found",
      message: "Multiple orders match this orderNumber."
    };
  }

  if (matchSnap.empty) return null;
  return matchSnap.docs[0].id;
}

async function fetchReturnableSnapshot(returnableId) {
  const snap = await getDoc(doc(pricingDb, "returnables_v2", returnableId));
  if (!snap.exists()) return null;
  return { docId: snap.id, ...snap.data() };
}

function allocationKey(returnableId, state) {
  return `${returnableId}_${state}`;
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      orderNumber: rawOrderNumber,
      docId: rawDocId,
      quantity: rawQuantity,
      mode: rawMode,
      state: rawState
    } = body || {};

    const orderNumber = rawOrderNumber ? String(rawOrderNumber).trim() : null;
    const returnableId = rawDocId ? String(rawDocId).trim() : null;
    const quantity = Number(rawQuantity);
    const mode = String(rawMode || "").trim().toLowerCase();
    const state = String(rawState || "").trim().toLowerCase();

    if (!orderNumber) {
      return err(400, "Missing Input", "orderNumber is required.");
    }

    if (!returnableId) {
      return err(400, "Missing Input", "docId (returnable id) is required.");
    }

    if (!["set", "increment", "decrement", "remove"].includes(mode)) {
      return err(
        400,
        "Invalid Mode",
        "mode must be one of: set, increment, decrement, remove."
      );
    }

    if (!["full", "partial"].includes(state)) {
      return err(
        400,
        "Invalid State",
        "state must be 'full' or 'partial'."
      );
    }

    if (mode !== "remove" && !Number.isFinite(quantity)) {
      return err(400, "Invalid Quantity", "quantity must be a number.");
    }

    if (mode !== "remove" && quantity <= 0) {
      return err(400, "Invalid Quantity", "quantity must be greater than zero.");
    }

    const resolvedOrderId = await resolveOrderId(orderNumber);
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const ref = doc(db, "orders_v2", resolvedOrderId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const order = snap.data();
    const snapshot = await fetchReturnableSnapshot(returnableId);
    if (!snapshot) {
      return err(404, "Returnable Not Found", "Returnable could not be located.");
    }

    const existing = Array.isArray(order?.returns?.returnables)
      ? order.returns.returnables
      : Array.isArray(order?.credit_notes?.returnables)
        ? order.credit_notes.returnables
        : [];

    const key = allocationKey(returnableId, state);
    const nextAllocations = [];
    let updated = false;

    const resolvedQuantity = mode === "remove" ? 0 : Math.max(0, quantity || 0);

    for (const entry of existing) {
      const entryState = entry?.state || "full";
      const entryKey = allocationKey(entry?.returnableId, entryState);
      if (entryKey !== key) {
        nextAllocations.push({ ...entry, state: entryState });
        continue;
      }

      const currentQty = Number(entry?.quantity || 0);
      let nextQty = currentQty;

      if (mode === "set") nextQty = resolvedQuantity;
      if (mode === "increment") nextQty = currentQty + resolvedQuantity;
      if (mode === "decrement") nextQty = currentQty - resolvedQuantity;
      if (mode === "remove") nextQty = 0;

      nextQty = Math.max(0, nextQty);

      if (nextQty > 0) {
        nextAllocations.push({ ...entry, quantity: nextQty });
      }

      updated = true;
    }

    if (!updated && resolvedQuantity > 0) {
      nextAllocations.push({
        returnableId,
        quantity: resolvedQuantity,
        state,
        snapshot
      });
    }

    const allocations = nextAllocations
      .map(entry => {
        const snap = entry.snapshot || snapshot;
        const entryState = entry?.state || "full";
        const unitExcl = r2(
          entryState === "partial"
            ? snap?.pricing?.partial_returnable_price_excl || 0
            : snap?.pricing?.full_returnable_price_excl || 0
        );
        const lineExcl = r2(unitExcl * (entry?.quantity || 0));
        const lineVat = r2(lineExcl * VAT_RATE);
        const lineIncl = r2(lineExcl + lineVat);

        return {
          returnableId: entry.returnableId,
          quantity: entry.quantity,
          state: entryState,
          snapshot_state: entryState,
          unit_price_excl: unitExcl,
          line_total_excl: lineExcl,
          line_total_vat: lineVat,
          line_total_incl: lineIncl,
          snapshot: snap
        };
      })
      .filter(entry => entry.quantity > 0);

    const totals = allocations.reduce(
      (acc, entry) => {
        acc.excl += entry.line_total_excl || 0;
        acc.vat += entry.line_total_vat || 0;
        acc.incl += entry.line_total_incl || 0;
        return acc;
      },
      { excl: 0, vat: 0, incl: 0 }
    );

    const creditTotals = {
      excl: r2(totals.excl),
      vat: r2(totals.vat),
      incl: r2(totals.incl)
    };

    const collectedReturnsIncl = r2(creditTotals.incl);

    const returnsModule = allocations.length
      ? {
          updatedAt: now(),
          returnables: allocations,
          totals: creditTotals,
          collected_returns_incl: collectedReturnsIncl
        }
      : {
          updatedAt: now(),
          returnables: [],
          totals: { excl: 0, vat: 0, incl: 0 },
          collected_returns_incl: 0
        };

    const totalsUpdate = {
      ...order?.totals,
      collected_returns_incl: collectedReturnsIncl
    };

    await updateDoc(ref, {
      totals: totalsUpdate,
      returns: returnsModule,
      "timestamps.updatedAt": now()
    });

    return ok({
      orderId: resolvedOrderId,
      orderNumber: order?.order?.orderNumber || null,
      totals: totalsUpdate,
      returns: returnsModule
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Assign Returnables Failed",
      e?.message ?? "Unexpected error assigning returnables."
    );
  }
}
