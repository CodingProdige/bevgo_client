export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  doc,
  collection,
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

function isRentalItem(item) {
  const variant =
    item?.selected_variant_snapshot ||
    item?.selected_variant ||
    item?.variant ||
    {};
  return variant?.rental?.is_rental === true;
}

function pickDefaultCard(cards = []) {
  const active = cards.filter(
    c => c?.status === "active" && c?.token?.registrationId
  );
  if (active.length === 0) return null;

  const scoreDate = c => {
    const lastCharged = Array.isArray(c.lastCharged) ? c.lastCharged.at(-1) : null;
    return lastCharged || c.updatedAt || c.createdAt || null;
  };

  active.sort((a, b) => {
    const aTime = new Date(scoreDate(a) || 0).getTime();
    const bTime = new Date(scoreDate(b) || 0).getTime();
    return bTime - aTime;
  });

  return active[0];
}

function addMonthsKeepDay(iso, months = 1) {
  const d = new Date(iso);
  const day = d.getDate();
  const targetMonth = d.getMonth() + months;
  const target = new Date(d);
  target.setMonth(targetMonth);

  if (target.getDate() < day) {
    target.setDate(0);
  }

  return target.toISOString();
}

function normalizeBillingPeriod(value) {
  if (!value || typeof value !== "string") return "monthly";
  const normalized = value.trim().toLowerCase();
  if (["daily", "weekly", "monthly", "yearly"].includes(normalized)) {
    return normalized;
  }
  return "monthly";
}

function getPeriodKey(iso, billingPeriod) {
  const date = new Date(iso);
  return date.toISOString().slice(0, 7);
}

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

    /* ───── Create Rental Records ───── */

    const rentalItems = (cart.items || []).filter(isRentalItem);
    const defaultCard = pickDefaultCard(user.paymentMethods?.cards || []);

    if (rentalItems.length > 0) {
      const rentalsCol = collection(db, "rentals_v2");

      for (const item of rentalItems) {
        const variant =
          item.selected_variant_snapshot ||
          item.selected_variant ||
          item.variant ||
          {};
        const product = item.product_snapshot || item.product || {};

        const variantId = variant.variant_id || variant.variantId || null;
        const productUniqueId =
          item.product_unique_id ||
          product?.product?.unique_id ||
          product?.unique_id ||
          null;
        const productTitle =
          product?.product?.title ||
          product?.product_title ||
          product?.title ||
          product?.name ||
          "";
        const productImage =
          product?.media?.hero?.url ||
          product?.media?.image?.url ||
          item?.media?.hero?.url ||
          item?.media?.image?.url ||
          null;
        const rentalId = `${orderId}_${item.product_unique_id || "unknown"}_${variantId || "unknown"}`;

        const billingPeriod = normalizeBillingPeriod(
          variant?.rental?.billing_period
        );
        const periodKey = getPeriodKey(timestamp, billingPeriod);

        const rentalDoc = {
          rentalId,
          orderId,
          orderNumber,
          merchantTransactionId,
          customerId,

          product: {
            product_unique_id: productUniqueId,
            variant_id: variantId,
            title: productTitle,
            image: productImage
          },

          quantity: item.qty || 1,

          billing: {
            status: defaultCard ? "pending_payment" : "pending_card",
            cadence: billingPeriod,
            billing_period: billingPeriod,
            startedAt: timestamp,
            nextChargeAt: null,
            lastChargedAt: null,
            currency: orderDoc.payment.currency,
            cardId: defaultCard?.id || null,
            cardSnapshot: defaultCard
              ? {
                  id: defaultCard.id,
                  brand: defaultCard.brand,
                  last4: defaultCard.last4,
                  expiryMonth: defaultCard.expiryMonth,
                  expiryYear: defaultCard.expiryYear,
                  token: defaultCard.token || null
                }
              : null,
            attempts: []
          },

          customer_snapshot: {
            uid: customerId,
            email: user.email || "",
            account: user.account || {},
            personal: user.personal || {},
            business: user.business || {}
          },

          timestamps: {
            createdAt: timestamp,
            updatedAt: timestamp
          }
        };

        await setDoc(doc(rentalsCol, rentalId), rentalDoc, { merge: true });
      }
    }

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
