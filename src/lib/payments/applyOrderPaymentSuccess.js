import {
  collection,
  doc,
  getDoc,
  updateDoc,
  arrayUnion,
  getDocs,
  query,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

const now = () => new Date().toISOString();

function addMonthsKeepDay(iso, months = 1) {
  const d = new Date(iso);
  const day = d.getDate();
  const targetMonth = d.getMonth() + months;
  const target = new Date(d);
  target.setMonth(targetMonth);
  if (target.getDate() < day) target.setDate(0);
  return target.toISOString();
}

function addYearsKeepDay(iso, years = 1) {
  const d = new Date(iso);
  const month = d.getMonth();
  const day = d.getDate();
  const target = new Date(d);
  target.setFullYear(d.getFullYear() + years);
  if (target.getMonth() !== month || target.getDate() < day) {
    target.setDate(0);
  }
  return target.toISOString();
}

function addDays(iso, days = 1) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function getIsoWeekKey(dateObj) {
  const date = new Date(Date.UTC(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate()
  ));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getPeriodKey(billingPeriod, iso) {
  const date = new Date(iso);
  if (billingPeriod === "daily") return date.toISOString().slice(0, 10);
  if (billingPeriod === "weekly") return getIsoWeekKey(date);
  if (billingPeriod === "yearly") return date.toISOString().slice(0, 4);
  return date.toISOString().slice(0, 7);
}

function getNextChargeAt(baseIso, billingPeriod) {
  if (billingPeriod === "daily") return addDays(baseIso, 1);
  if (billingPeriod === "weekly") return addDays(baseIso, 7);
  if (billingPeriod === "yearly") return addYearsKeepDay(baseIso, 1);
  return addMonthsKeepDay(baseIso, 1);
}

/**
 * Applies a successful payment to an order (orders_v2).
 *
 * Supports:
 * - charge-card (CIT / 3DS)
 * - charge-token (MIT / COF)
 * - partial payments
 * - idempotency
 */
export async function applyOrderPaymentSuccess({
  orderId, // 🔒 MUST be orders_v2 docId

  provider = "peach",
  method = "card",
  chargeType = "card", // "card" | "token"

  threeDSecureId = null,

  merchantTransactionId,
  peachTransactionId,

  amount_incl,
  currency,

  token = null // { registrationId?, cardId? }
}) {
  if (!orderId || !peachTransactionId) {
    throw new Error("orderId and peachTransactionId are required");
  }

  /* ───────────────── LOAD ORDER ───────────────── */

  const orderRef = doc(db, "orders_v2", orderId);
  const snap = await getDoc(orderRef);

  if (!snap.exists()) {
    throw new Error(`Order not found in orders_v2: ${orderId}`);
  }

  const order = snap.data();

  /* ───────────────── IDEMPOTENCY ───────────────── */

  const attempts = order?.payment?.attempts || [];

  const alreadyProcessed = attempts.some(
    a => a.peachTransactionId === peachTransactionId
  );

  if (alreadyProcessed) {
    return { idempotent: true };
  }

  /* ───────────────── VALIDATION ───────────────── */

  if (currency !== order.payment.currency) {
    throw new Error("Currency mismatch");
  }

  /* ───────────────── AMOUNT HANDLING ───────────────── */

  const required = Number(order.payment.required_amount_incl || 0);
  const paidSoFar = Number(order.payment.paid_amount_incl || 0);
  const incoming = Number(amount_incl || 0);

  const newPaid = paidSoFar + incoming;
  const isPaid = newPaid >= required;

  /* ───────────────── BUILD ATTEMPT ───────────────── */

  const attempt = {
    provider,
    method,
    chargeType,

    threeDSecureId,

    merchantTransactionId,
    peachTransactionId,

    token:
      chargeType === "token"
        ? {
            registrationId: token?.registrationId || null,
            cardId: token?.cardId || null
          }
        : null,

    amount_incl: incoming,
    currency,
    status: "charged",
    createdAt: now()
  };

  /* ───────────────── UPDATE ORDER ───────────────── */

  const isPersonal = order?.order?.type === "personal";

  const updatePayload = {
    "payment.method": method,
    "payment.status": isPaid ? "paid" : "partial",
    "payment.paid_amount_incl": newPaid,
    "payment.paymentId": peachTransactionId,
    "payment.attempts": arrayUnion(attempt),

    "order.status.payment": isPaid ? "paid" : "partial",

    "timestamps.updatedAt": now()
  };

  if (isPersonal && isPaid) {
    updatePayload["order.editable"] = false;
    updatePayload["order.editable_reason"] =
      "Order is locked because payment was completed.";
    updatePayload["order.status.order"] = "confirmed";
    updatePayload["timestamps.lockedAt"] = now();
  }

  await updateDoc(orderRef, updatePayload);

  /* ───────────────── UPDATE RENTALS ───────────────── */

  const rentalsSnap = await getDocs(
    query(collection(db, "rentals_v2"), where("orderId", "==", orderId))
  );

  const chargeTimestamp = now();

  for (const rentalDoc of rentalsSnap.docs) {
    const rental = rentalDoc.data();
    const billingPeriodRaw =
      rental?.billing?.billing_period ||
      rental?.billing?.cadence ||
      "monthly";
    const billingPeriod =
      typeof billingPeriodRaw === "string"
        ? billingPeriodRaw.toLowerCase()
        : "monthly";

    const periodKey = getPeriodKey(billingPeriod, chargeTimestamp);
    const attempts = Array.isArray(rental?.billing?.attempts)
      ? rental.billing.attempts
      : [];

    const alreadyRecorded = attempts.some(
      a => a?.paymentId === peachTransactionId
    );

    if (alreadyRecorded) {
      continue;
    }

    const attempt = {
      type: "charge",
      status: "charged",
      periodKey,
      merchantTransactionId,
      paymentId: peachTransactionId,
      amount_incl: Number(amount_incl || 0),
      currency,
      createdAt: chargeTimestamp
    };

    const nextChargeAt = getNextChargeAt(chargeTimestamp, billingPeriod);

    await updateDoc(rentalDoc.ref, {
      "billing.status": "active",
      "billing.lastChargedAt": chargeTimestamp,
      "billing.nextChargeAt": nextChargeAt,
      "billing.attempts": [...attempts, attempt],
      "timestamps.updatedAt": chargeTimestamp
    });
  }

  /* ───────────────── UPGRADE SAVED CARD (CIT → MIT) ───────────────── */

  /**
   * After the FIRST successful card payment (CIT),
   * we MUST persist peachTransactionId onto the saved card
   * so that MIT can later use:
   *
   * standingInstruction.initialTransactionId
   */
  if (
    chargeType === "card" &&
    token?.cardId &&
    peachTransactionId &&
    order.customerId
  ) {
    const userRef = doc(db, "users", order.customerId);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists()) {
      const user = userSnap.data();
      const cards = user?.paymentMethods?.cards || [];

      const updatedCards = cards.map(c =>
        c.id === token.cardId
          ? {
              ...c,
              token: {
                ...(c.token || {}),
                peachTransactionId // 🔑 REQUIRED FOR MIT
              },
              updatedAt: now()
            }
          : c
      );

      await updateDoc(userRef, {
        "paymentMethods.cards": updatedCards
      });
    }
  }

  /* ───────────────── DONE ───────────────── */

  return {
    success: true,
    orderId,
    paid: isPaid,
    totalPaid: newPaid
  };
}
