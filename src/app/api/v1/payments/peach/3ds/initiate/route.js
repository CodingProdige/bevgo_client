// (same imports)
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";



const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, x = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...x }, { status: s });

const now = () => new Date().toISOString();

const ENTITY_ID_3DS = process.env.PEACH_S2S_ENTITY_ID;
const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;
const HOST = "oppwa.com";

function detectBrand(pan) {
  if (!pan) return "VISA";
  if (/^4/.test(pan)) return "VISA";
  if (/^5[1-5]/.test(pan)) return "MASTER";
  if (/^3[47]/.test(pan)) return "AMEX";
  return "VISA";
}

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

export async function POST(req) {
  try {
    const { userId, amount, currency, card, browser, orderId } =
      await req.json();

    if (!orderId || !amount || !currency || !card)
      return err(400, "Invalid Request", "Missing required parameters.");

    if (!ENTITY_ID_3DS || !ACCESS_TOKEN)
      return err(500, "Config Error", "3DS credentials not configured.");

    const formattedAmount = Number(amount).toFixed(2);

    const orderSnap = await getDoc(doc(db, "orders_v2", orderId));
    if (!orderSnap.exists())
      return err(404, "Order Not Found", "Invalid orderId.");

    const orderData = orderSnap.data() || {};
    const orderNumber = orderData?.order?.orderNumber;

    const merchantTransactionId =
      orderData?.order?.merchantTransactionId ||
      orderNumber ||
      String(orderId).slice(0, 16);

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

    const brand = detectBrand(card.number);

    const form = {
      entityId: ENTITY_ID_3DS,
      amount: formattedAmount,
      currency,
      paymentBrand: brand,
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

      shopperResultUrl: "https://3ds.bevgo.co.za/complete",

      "customer.ip": ip,

      "customer.browser.acceptHeader": acceptHeader,
      "customer.browser.userAgent": userAgent,
      "customer.browser.language": language,
      "customer.browser.screenColorDepth":
        String(browserInfo.screenColorDepth ?? "24"),
      "customer.browser.screenHeight":
        String(browserInfo.screenHeight ?? "900"),
      "customer.browser.screenWidth":
        String(browserInfo.screenWidth ?? "1440"),
      "customer.browser.javaEnabled":
        String(browserInfo.javaEnabled ?? "false"),
      "customer.browser.timezone":
        String(browserInfo.timezone ?? 120),
      "customer.browser.challengeWindow":
        String(browserInfo.challengeWindow ?? "4")
    };

    const gatewayResponse = await peachRequest("/v1/threeDSecure", form);

    if (!gatewayResponse?.id)
      return err(
        502,
        "3DS Initiation Failed",
        gatewayResponse?.result?.description || "Unknown gateway error.",
        { gateway: gatewayResponse }
      );

    const threeDSecureId = gatewayResponse.id;
    const redirect = gatewayResponse.redirect || null;
    const frictionless = !redirect;

    await setDoc(
      doc(db, "payment_3ds_attempts", threeDSecureId),
      {
        threeDSecureId,
        orderId,
        orderNumber,
        userId: userId ?? null,
        amount: formattedAmount,
        currency,
        merchantTransactionId,
        transactionCategory: "EC",
        customerIp: ip,
        card: {
          brand,
          holder: card.holder,
          number: card.number,
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear,
          cvv: card.cvv,
          last4: card.number?.slice(-4) || null
        },
        channel: "BROWSER",
        frictionless,
        status: frictionless ? "frictionless" : "initiated",
        redirect,
        peach: gatewayResponse,
        createdAt: now(),
        updatedAt: now()
      },
      { merge: false }
    );

    return ok({
      threeDSecureId,
      frictionless,
      redirect,
      startUrl: `https://3ds.bevgo.co.za/start?threeDSecureId=${encodeURIComponent(
        threeDSecureId
      )}`
    });
  } catch (e) {
    console.error(e);
    return err(500, "Server Error", e.message || "Unexpected error.");
  }
}
