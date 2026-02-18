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

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const r2 = v => Number((Number(v) || 0).toFixed(2));
const VAT_RATE = 0.15;

const isMeaningfulString = value =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.trim().toLowerCase() !== "null" &&
  value.trim().toLowerCase() !== "undefined";

const toFiniteOr = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const hasNumber = value => Number.isFinite(Number(value));

async function resolveOrderId(orderNumber) {
  if (!orderNumber) return null;
  const matchSnap = await getDocs(
    query(collection(db, "orders_v2"), where("order.orderNumber", "==", orderNumber))
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

function computeOrderPaymentStatus(required, paid) {
  if (paid <= 0) return "unpaid";
  if (paid + 0.0001 >= required) return "paid";
  return "partial";
}

function buildReconciledTotals(order, overrides = {}) {
  const totals = order?.totals || {};
  const hasInclOverride = hasNumber(overrides?.deliveryFeeIncl);
  const hasExclOverride = hasNumber(overrides?.deliveryFeeExcl);
  const hasVatOverride = hasNumber(overrides?.deliveryFeeVat);

  const overrideIncl = hasInclOverride ? r2(overrides.deliveryFeeIncl) : null;
  const overrideExcl = hasExclOverride ? r2(overrides.deliveryFeeExcl) : null;
  const overrideVat = hasVatOverride ? r2(overrides.deliveryFeeVat) : null;

  const deliveryFeeIncl = hasNumber(totals?.delivery_fee_incl)
    ? (overrideIncl ?? r2(totals.delivery_fee_incl))
    : (overrideIncl ?? r2(order?.delivery?.fee?.amount || 0));

  // If incl is explicitly overridden, derive excl/vat unless caller explicitly overrides them too.
  const derivedExclFromIncl = deliveryFeeIncl > 0 ? r2(deliveryFeeIncl / (1 + VAT_RATE)) : 0;
  const derivedVatFromIncl = r2(deliveryFeeIncl - derivedExclFromIncl);

  const deliveryFeeExcl = hasExclOverride
    ? overrideExcl
    : hasInclOverride
      ? derivedExclFromIncl
      : hasNumber(totals?.delivery_fee_excl)
        ? r2(totals.delivery_fee_excl)
        : derivedExclFromIncl;

  const deliveryFeeVat = hasVatOverride
    ? overrideVat
    : hasInclOverride
      ? r2(deliveryFeeIncl - deliveryFeeExcl)
      : hasNumber(totals?.delivery_fee_vat)
        ? r2(totals.delivery_fee_vat)
        : r2(deliveryFeeIncl - deliveryFeeExcl);

  const prevDeliveryExcl = r2(toFiniteOr(totals?.delivery_fee_excl, 0));
  const prevDeliveryIncl = r2(toFiniteOr(totals?.delivery_fee_incl, 0));
  const prevDeliveryVat = r2(toFiniteOr(totals?.delivery_fee_vat, 0));

  const deltaExcl = r2(deliveryFeeExcl - prevDeliveryExcl);
  const deltaIncl = r2(deliveryFeeIncl - prevDeliveryIncl);
  const deltaVat = r2(deliveryFeeVat - prevDeliveryVat);

  const nextTotals = {
    ...totals,
    delivery_fee_excl: deliveryFeeExcl,
    delivery_fee_incl: deliveryFeeIncl,
    delivery_fee_vat: deliveryFeeVat,
    final_excl: r2(toFiniteOr(totals?.final_excl, 0) + deltaExcl),
    final_incl: r2(toFiniteOr(totals?.final_incl, 0) + deltaIncl),
    vat_total: r2(toFiniteOr(totals?.vat_total, 0) + deltaVat)
  };

  if (hasNumber(totals?.base_final_excl)) {
    nextTotals.base_final_excl = r2(Number(totals.base_final_excl) + deltaExcl);
  }
  if (hasNumber(totals?.base_final_incl)) {
    nextTotals.base_final_incl = r2(Number(totals.base_final_incl) + deltaIncl);
  }
  if (hasNumber(totals?.final_excl_after_discount)) {
    nextTotals.final_excl_after_discount = r2(
      Number(totals.final_excl_after_discount) + deltaExcl
    );
  }
  if (hasNumber(totals?.final_incl_after_discount)) {
    nextTotals.final_incl_after_discount = r2(
      Number(totals.final_incl_after_discount) + deltaIncl
    );
  }
  if (totals?.credit && hasNumber(totals?.credit?.final_payable_incl)) {
    nextTotals.credit = {
      ...totals.credit,
      final_payable_incl: r2(Number(totals.credit.final_payable_incl) + deltaIncl)
    };
  }

  return { nextTotals, deltaExcl, deltaIncl, deltaVat };
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const payload = body && typeof body === "object" ? body : {};
    const {
      orderId: rawOrderId,
      orderNumber: rawOrderNumber,
      paidAmountIncl,
      deliveryFeeIncl,
      deliveryFeeExcl,
      deliveryFeeVat
    } = payload;

    const orderId = isMeaningfulString(rawOrderId) ? rawOrderId.trim() : "";
    const orderNumber = isMeaningfulString(rawOrderNumber) ? rawOrderNumber.trim() : "";

    if (!orderId && !orderNumber) {
      return err(400, "Missing Input", "Provide orderId or orderNumber.");
    }

    const resolvedOrderId = orderId || (await resolveOrderId(orderNumber));
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const orderRef = doc(db, "orders_v2", resolvedOrderId);
    const snap = await getDoc(orderRef);
    if (!snap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const order = snap.data();
    const deliveryOverrides = {
      deliveryFeeIncl,
      deliveryFeeExcl,
      deliveryFeeVat
    };

    const providedDeliveryValues = [
      deliveryFeeIncl,
      deliveryFeeExcl,
      deliveryFeeVat
    ].filter(v => v !== undefined && v !== null);

    if (providedDeliveryValues.some(v => !Number.isFinite(Number(v)) || Number(v) < 0)) {
      return err(
        400,
        "Invalid Input",
        "deliveryFeeIncl/deliveryFeeExcl/deliveryFeeVat must be numbers >= 0."
      );
    }

    const { nextTotals, deltaExcl, deltaIncl, deltaVat } = buildReconciledTotals(
      order,
      deliveryOverrides
    );

    const nextRequired = r2(nextTotals?.final_incl || 0);
    const currentPaid = r2(order?.payment?.paid_amount_incl || 0);
    const paidOverrideProvided = paidAmountIncl !== undefined && paidAmountIncl !== null;
    const nextPaid = paidOverrideProvided ? r2(paidAmountIncl) : currentPaid;

    if (!Number.isFinite(nextPaid) || nextPaid < 0) {
      return err(400, "Invalid Input", "paidAmountIncl must be a number >= 0.");
    }

    const nextPaymentStatus = computeOrderPaymentStatus(nextRequired, nextPaid);
    const now = new Date().toISOString();

    await updateDoc(orderRef, {
      totals: nextTotals,
      "delivery.fee.amount": r2(nextTotals?.delivery_fee_incl || 0),
      "payment.required_amount_incl": nextRequired,
      "payment.paid_amount_incl": nextPaid,
      "payment.status": nextPaymentStatus,
      "order.status.payment": nextPaymentStatus,
      "timestamps.updatedAt": now
    });

    return ok({
      orderId: resolvedOrderId,
      orderNumber: order?.order?.orderNumber || null,
      input_applied: {
        deliveryFeeIncl: hasNumber(deliveryFeeIncl) ? r2(deliveryFeeIncl) : null,
        deliveryFeeExcl: hasNumber(deliveryFeeExcl) ? r2(deliveryFeeExcl) : null,
        deliveryFeeVat: hasNumber(deliveryFeeVat) ? r2(deliveryFeeVat) : null,
        paidAmountIncl: paidOverrideProvided ? nextPaid : null
      },
      totals_before: order?.totals || {},
      totals_after: nextTotals,
      delivery_fee_delta: {
        excl: deltaExcl,
        incl: deltaIncl,
        vat: deltaVat
      },
      payment_before: {
        required_amount_incl: r2(order?.payment?.required_amount_incl || 0),
        paid_amount_incl: currentPaid,
        status: order?.payment?.status || order?.order?.status?.payment || null
      },
      payment_after: {
        required_amount_incl: nextRequired,
        paid_amount_incl: nextPaid,
        status: nextPaymentStatus
      }
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Reconcile Totals Failed",
      e?.message ?? "Unexpected error reconciling order totals."
    );
  }
}
