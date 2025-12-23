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

const normalizeChannel = value => {
  const raw = String(value || "web").toLowerCase();
  if (["app", "ios", "android", "mobile"].includes(raw)) return "APP";
  if (["browser", "web"].includes(raw)) return "BROWSER";
  return "BROWSER";
};

const normalizeThreeDSChannel = value => {
  const raw = String(value || "").toUpperCase();
  if (raw === "01") return "APP";
  if (raw === "02") return "BROWSER";
  if (raw === "APP" || raw === "BROWSER") return raw;
  return normalizeChannel(value);
};

const threeDSChannelValue = channel =>
  channel === "APP" ? "01" : "02";

function buildThreeDSecureFields(threeDSecure, channel) {
  const fields = { "threeDSecure.channel": threeDSChannelValue(channel) };
  if (!threeDSecure || typeof threeDSecure !== "object") return fields;

  const providedChannel = threeDSecure.channel;
  if (providedChannel) {
    const normalized = normalizeThreeDSChannel(providedChannel);
    if (!normalized || normalized !== channel) {
      return null;
    }
  }

  for (const [key, value] of Object.entries(threeDSecure)) {
    if (value == null || key === "channel") continue;
    const formKey = key.startsWith("threeDSecure.")
      ? key
      : `threeDSecure.${key}`;
    fields[formKey] = value;
  }

  return fields;
}

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
  return "VISA";
}

/* ───────────────── PEACH REQUEST ───────────────── */

function peachRequest(path, form) {
  const body = querystring.stringify(form);

  const options = {
    host: HOST,
    port: 443,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      Authorization: `Bearer ${ACCESS_TOKEN}`
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
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
    const {
      userId,
      amount,
      currency,
      card,
      browser,
      channel,
      threeDSecure,
      orderId
    } = await req.json();

    if (!orderId || !amount || !currency || !card) {
      return err(400, "Invalid Request", "Missing required parameters.");
    }

    /* ───── Amount normalization (STRICT) ───── */
    const formattedAmount = Number(amount).toFixed(2);
    if (Number.isNaN(Number(formattedAmount))) {
      return err(400, "Invalid Amount", "Amount must be numeric.");
    }

    /* ───── Load order ───── */
    const orderSnap = await getDoc(doc(db, "orders_v2", orderId));
    if (!orderSnap.exists()) {
      return err(404, "Order Not Found", "Invalid orderId.");
    }

    const orderNumber = orderSnap.data()?.order?.orderNumber;
    if (!orderNumber) {
      return err(500, "Invalid Order", "orderNumber missing.");
    }

    const merchantTransactionId = orderId.slice(0, 16);

    /* ───── Browser-channel 3DS payload (EMVCo compliant) ───── */
    const deviceChannel = normalizeChannel(channel);
    const threeDSecureFields = buildThreeDSecureFields(
      threeDSecure,
      deviceChannel
    );

    if (!threeDSecureFields) {
      return err(
        400,
        "Invalid 3DS Channel",
        "threeDSecure.channel conflicts with channel."
      );
    }

    const headers = req.headers;
    const browserInfo = browser || {};
    const acceptHeader =
      browserInfo.acceptHeader || headers.get("accept") || "*/*";
    const userAgent =
      browserInfo.userAgent || headers.get("user-agent") || "unknown";
    const language =
      browserInfo.language ||
      headers.get("accept-language")?.split(",")[0] ||
      "en";
    const ip =
      browserInfo.ip ||
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "127.0.0.1";

    const form = {
      entityId: ENTITY_ID_3DS,
      amount: formattedAmount,
      currency,
      paymentBrand: detectBrand(card.number),
      merchantTransactionId,
      transactionCategory: "EC",

      "card.holder": card.holder,
      "card.number": card.number,
      "card.expiryMonth": card.expiryMonth,
      "card.expiryYear": card.expiryYear,
      "card.cvv": card.cvv,

      "merchant.name": "Bevgo",
      "merchant.city": "Paarl",
      "merchant.country": "ZA",
      "merchant.mcc": "5399",

      shopperResultUrl:
        "https://client-portal.bevgo.co.za/redirect",

      "customer.ip": ip,
      ...threeDSecureFields
    };

    if (deviceChannel === "BROWSER") {
      form["customer.browser.acceptHeader"] = acceptHeader;
      form["customer.browser.userAgent"] = userAgent;
      form["customer.browser.language"] = language;
      form["customer.browser.timezone"] =
        browserInfo.timezone || "120";

      form["customer.browser.screenHeight"] =
        browserInfo.screenHeight || "900";
      form["customer.browser.screenWidth"] =
        browserInfo.screenWidth || "1440";
      form["customer.browser.screenColorDepth"] =
        browserInfo.screenColorDepth || "24";
      form["customer.browser.javaEnabled"] =
        browserInfo.javaEnabled || "false";
      form["customer.browser.challengeWindow"] =
        browserInfo.challengeWindow || "4";
    }

    const data = await peachRequest("/v1/threeDSecure", form);

    if (!data?.id) {
      return err(
        502,
        "3DS Initiation Failed",
        data?.result?.description || "Unknown error",
        { gateway: data }
      );
    }

    const timestamp = now();
    const frictionless = !data.redirect;

    await setDoc(
      doc(db, "payment_3ds_attempts", data.id),
      {
        threeDSecureId: data.id,
        orderId,
        orderNumber,
        userId,
        amount: formattedAmount,
        currency,
        merchantTransactionId,
        channel: deviceChannel,
        frictionless,
        status: frictionless ? "frictionless" : "initiated",
        peach: data,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      { merge: false }
    );

    return ok({
      threeDSecureId: data.id,
      frictionless,
      orderNumber,
      redirect: data.redirect || null
    });

  } catch (e) {
    return err(500, "Server Error", e.message);
  }
}
