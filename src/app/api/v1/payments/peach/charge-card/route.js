export const runtime = "nodejs";

import { applyOrderPaymentSuccess } from "@/lib/payments/applyOrderPaymentSuccess";
import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";
import crypto from "crypto";

/* ───────── HELPERS ───────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/* ───────── ENV ───────── */

const HOST = "oppwa.com";
const ENTITY_ID = process.env.PEACH_S2S_ENTITY_ID;
const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;
const DEFAULT_SHOPPER_RESULT_URL =
  process.env.PEACH_SHOPPER_RESULT_URL || "https://3ds.bevgo.co.za/complete";
const BASE_URL = process.env.BASE_URL;

function appendQueryParam(rawUrl, key, value) {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const joiner = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${joiner}${encodeURIComponent(key)}=${encodeURIComponent(
      value
    )}`;
  }
}

function getQueryParam(rawUrl, key) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get(key);
  } catch {
    return null;
  }
}

/* ───────── VALIDATE CONFIG ───────── */

function ensureConfig() {
  if (!ENTITY_ID || !ACCESS_TOKEN) {
    throw new Error("ENTITY_ID or ACCESS_TOKEN not configured");
  }
}

/* ───────── PEACH REQUEST (ALIGNED) ───────── */

function peachRequest(path, form) {
  const body = querystring.stringify(form);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        port: 443,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      },
      res => {
        const buf = [];
        res.on("data", c => buf.push(c));
        res.on("end", () => {
          const text = Buffer.concat(buf).toString("utf8");

          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(
              new Error(
                `Gateway returned invalid JSON: ${text?.slice(0, 200) || ""}`
              )
            );
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    ensureConfig();

    const {
      userId,
      amount,
      currency,
      merchantTransactionId,
      card,
      billing,
      customer,
      shopperResultUrl,
      saveCard = true
    } = await req.json();

    if (!userId || !amount || !currency || !merchantTransactionId || !card) {
      return err(400, "Missing Information", "Please check your payment details.");
    }

    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      return err(404, "User Not Found", "User does not exist.");
    }

    const user = snap.data();
    const cards = user.paymentMethods?.cards || [];

    /* ───── BUILD PEACH PAYLOAD ───── */

    const shopperResultUrlBase = shopperResultUrl || DEFAULT_SHOPPER_RESULT_URL;

    if (!BASE_URL) {
      return err(
        500,
        "Config Error",
        "BASE_URL is required to build shopper redirect URL."
      );
    }

    const formattedAmount = Number(amount).toFixed(2);

    const redirectUrl = `${BASE_URL}/api/v1/payments/peach/shopper-redirect?merchantTransactionId=${encodeURIComponent(
      merchantTransactionId
    )}`;

    const peachPayload = {
      entityId: ENTITY_ID,
      amount: formattedAmount,
      currency,
      paymentBrand: card.brand || "VISA",
      paymentType: "DB",

      "card.number": card.number,
      "card.holder": card.holder,
      "card.expiryMonth": card.expiryMonth,
      "card.expiryYear": card.expiryYear,
      "card.cvv": card.cvv,

      merchantTransactionId,
      createRegistration: "true",

      "standingInstruction.mode": "INITIAL",
      "standingInstruction.source": "CIT",
      "standingInstruction.type": "UNSCHEDULED",

      "customer.email": customer?.email || "unknown@bevgo.co.za",
      shopperResultUrl: redirectUrl
    };

    const gateway = await peachRequest("/v1/payments", peachPayload);

    if (!gateway?.result?.code?.startsWith("000.")) {
      return err(
        402,
        "Payment Failed",
        gateway?.result?.description || "Your card was declined.",
        { gateway }
      );
    }

    const timestamp = now();

    /* ───── DUPLICATE CARD CHECK ───── */

    let cardId = null;
    const cardsList = cards || [];

    const existingCard =
      cardsList.find(
        c =>
          c.bin === gateway.card?.bin &&
          c.last4 === gateway.card?.last4Digits &&
          c.expiryMonth === gateway.card?.expiryMonth &&
          c.expiryYear === gateway.card?.expiryYear
      ) || null;

    const paymentAttempt = {
      merchantTransactionId,
      paymentId: gateway.id,
      amount: formattedAmount,
      currency,
      status: "success",
      createdAt: timestamp
    };

    let updatedCards;

    if (existingCard) {
      cardId = existingCard.id;

      updatedCards = cardsList.map(c =>
        c.id === existingCard.id
          ? {
              ...c,
              paymentAttempts: [...(c.paymentAttempts || []), paymentAttempt],
              lastCharged: [...(c.lastCharged || []), timestamp],
              updatedAt: timestamp
            }
          : c
      );
    } else if (saveCard) {
      const newCard = {
        id: uid(),
        status: "active",
        type: "card",

        brand: gateway.paymentBrand,
        last4: gateway.card.last4Digits,
        bin: gateway.card.bin,
        expiryMonth: gateway.card.expiryMonth,
        expiryYear: gateway.card.expiryYear,

        token: {
          provider: "peach",
          registrationId: gateway.registrationId,
          entityId: ENTITY_ID,
          merchantTransactionId,
          peachTransactionId: gateway.id,
          raw: null
        },

        billing: billing || null,

        paymentAttempts: [paymentAttempt],
        lastCharged: [timestamp],
        createdAt: timestamp,
        updatedAt: timestamp
      };

      updatedCards = [...cardsList, newCard];
      cardId = newCard.id;
    } else {
      updatedCards = cardsList;
    }

    await updateDoc(userRef, {
      "paymentMethods.cards": updatedCards
    });

    /* ───── RESOLVE ORDER ───── */

    const orderSnap = await getDocs(
      query(
        collection(db, "orders_v2"),
        where("order.merchantTransactionId", "==", merchantTransactionId)
      )
    );

    let orderId = null;

    if (!orderSnap.empty) {
      orderId = orderSnap.docs[0].id;
    } else {
      const fallbackSnap = await getDocs(
        query(
          collection(db, "orders_v2"),
          where("order.orderNumber", "==", merchantTransactionId)
        )
      );
      if (!fallbackSnap.empty) {
        orderId = fallbackSnap.docs[0].id;
      }
    }

    if (!orderId) {
      throw new Error(`Order not found in orders_v2: ${merchantTransactionId}`);
    }

    /* ───── APPLY ORDER PAYMENT SUCCESS ───── */

    await applyOrderPaymentSuccess({
      orderId,

      provider: "peach",
      method: "card",
      chargeType: "card",

      threeDSecureId: null,

      merchantTransactionId,
      peachTransactionId: gateway.id,

      amount_incl: Number(formattedAmount),
      currency
    });

    const orderNumberFromUrl = getQueryParam(
      shopperResultUrlBase,
      "orderNumber"
    );

    await setDoc(
      doc(db, "peach_redirects", merchantTransactionId),
      {
        merchantTransactionId,
        paymentId: gateway.id,
        shopperResultUrl: shopperResultUrlBase,
        orderNumber: orderNumberFromUrl,
        createdAt: now(),
        updatedAt: now()
      },
      { merge: true }
    );

    const shopperResultUrlWithPaymentId = appendQueryParam(
      shopperResultUrlBase,
      "paymentId",
      gateway.id
    );

    return ok({
      paymentId: gateway.id,
      cardId,
      title: "Payment Successful",
      message: "Your payment was completed successfully.",
      shopperResultUrl: shopperResultUrlWithPaymentId,
      gateway
    });
  } catch (e) {
    return err(
      500,
      "Payment Error",
      e?.message || "Something went wrong while processing your payment."
    );
  }
}
