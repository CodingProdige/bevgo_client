import {
  doc,
  getDoc,
  updateDoc,
  arrayUnion
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

const now = () => new Date().toISOString();

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
    updatePayload["order.status.order"] = "confirmed";
    updatePayload["timestamps.lockedAt"] = now();
  }

  await updateDoc(orderRef, updatePayload);

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
