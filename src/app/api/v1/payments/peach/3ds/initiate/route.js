export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────────────── HELPERS ───────────────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, x = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...x }, { status: s });

const now = () => new Date().toISOString();

/* ───────────────── ENV ───────────────── */

const ENTITY_ID_3DS = process.env.PEACH_S2S_ENTITY_ID;
const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;

const HOST = "oppwa.com";



/* ───────────────── BRAND DETECTION ───────────────── */

function detectBrand(pan) {
  if (!pan) return "VISA";
  if (/^4/.test(pan)) return "VISA";
  if (/^5[1-5]/.test(pan)) return "MASTER";
  if (/^3[47]/.test(pan)) return "AMEX";
  if (/^6(?:011|5)/.test(pan)) return "DISCOVER";
  if (/^(30|36|38)/.test(pan)) return "DINERS";
  if (/^35/.test(pan)) return "JCB";
  return "VISA";
}

/* ───────────────── PEACH REQUEST ───────────────── */
function peachRequest(path, form) {
  const body = querystring.stringify(form);

  const options = {
    port: 443,
    host: HOST,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "Authorization": `Bearer ${ACCESS_TOKEN}`
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(raw));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}



/* ───────────────── ENDPOINT ───────────────── */

export async function POST(req) {
  try {
    const { userId, amount, currency, card, browser, orderId } =
      await req.json();

    if (!orderId) {
      return err(400, "Missing Order ID", "orderId is required.");
    }

    if (!amount || !currency) {
      return err(400, "Invalid Amount", "Amount and currency are required.");
    }

    if (
      !card?.number ||
      !card?.expiryMonth ||
      !card?.expiryYear ||
      !card?.cvv
    ) {
      return err(400, "Invalid Card", "Complete card details are required.");
    }

    if (!browser?.returnUrl) {
      return err(
        400,
        "Missing Return URL",
        "browser.returnUrl is required."
      );
    }

    /* ───── Load order to get orderNumber ───── */

    const orderRef = doc(db, "orders_v2", orderId);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return err(404, "Order Not Found", "Order does not exist.");
    }

    const order = orderSnap.data();
    const orderNumber = order?.order?.orderNumber;

    if (!orderNumber) {
      return err(
        500,
        "Invalid Order",
        "order.orderNumber missing on order."
      );
    }

    /* ───── merchantTransactionId (≤16 chars) ───── */

    const merchantTransactionId = orderId.slice(0, 16);

    /* ───── Build return URL WITH orderNumber ───── */

    const shopperResultUrl =
      `${browser.returnUrl}?orderNumber=${encodeURIComponent(orderNumber)}`;

    /* ───── Build 3DS Payload ───── */

    const form = {
      entityId: ENTITY_ID_3DS,
      amount,
      currency,

      paymentBrand: detectBrand(card.number),
      merchantTransactionId,
      transactionCategory: "EC",

      "card.number": card.number,
      "card.holder": card.holder || "Card Holder",
      "card.expiryMonth": card.expiryMonth,
      "card.expiryYear": card.expiryYear,
      "card.cvv": card.cvv,

      "merchant.name": "Bevgo",
      "merchant.city": "Paarl",
      "merchant.country": "ZA",
      "merchant.mcc": "5399",

      "customer.ip": browser.ip || "127.0.0.1",
      "customer.browser.userAgent":
        browser.userAgent || "Mozilla/5.0 (Bevgo App)",
      "customer.browser.language": browser.language || "en",
      "customer.browser.acceptHeader":
        browser.acceptHeader || "text/html",
      "customer.browser.timezone": browser.timezone || "0",

      shopperResultUrl
    };

    /* ───── Call Peach ───── */

    const data = await peachRequest("/v1/threeDSecure", form);

    if (!data?.id) {
      return err(
        502,
        "3DS Initiation Failed",
        data?.result?.description || "Unable to initiate 3D Secure.",
        { gateway: data }
      );
    }

    const timestamp = now();
    const frictionless = !data.redirect;

    /* ───── Persist 3DS Attempt ───── */

    await setDoc(
      doc(db, "payment_3ds_attempts", data.id),
      {
        threeDSecureId: data.id,
        orderId,
        orderNumber,
        userId: userId || null,

        status: frictionless ? "frictionless" : "initiated",
        frictionless,

        amount,
        currency,
        merchantTransactionId,

        card: {
          bin: data.card?.bin || null,
          last4: data.card?.last4Digits || null,
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear,
          holder: card.holder || null
        },

        browser,
        peach: {
          entityId: ENTITY_ID_3DS,
          rawInitResponse: data
        },

        createdAt: timestamp,
        updatedAt: timestamp
      },
      { merge: false }
    );

    /* ───── Response ───── */

    if (frictionless) {
      return ok({
        threeDSecureId: data.id,
        frictionless: true,
        orderNumber,
        title: "Authentication Complete",
        message: "No additional verification was required."
      });
    }

    return ok({
      threeDSecureId: data.id,
      frictionless: false,
      orderNumber,
      redirectUrl: data.redirect.url,
      redirectParams: data.redirect.parameters,
      title: "Verification Required",
      message: "Please complete verification with your bank."
    });

  } catch (e) {
    return err(500, "Server Error", e.message);
  }
}
