export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import { db } from "@/lib/firebaseConfig";
import { doc, updateDoc, arrayUnion } from "firebase/firestore";

// ----------------------
// HELPERS
// ----------------------
const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

const now = () => new Date().toISOString();

const uid = () =>
  Math.random().toString(36).substring(2, 10) +
  Math.random().toString(36).substring(2, 6);

// ----------------------
// HARD-CODED SANDBOX CREDS
// ----------------------
const PEACH_BASE = "sandbox-card.peachpayments.com";

const PEACH_ACCESS_TOKEN =
  "OGFjN2E0Yzk5YjA1MWY5ZDAxOWIwOWYyZGFhYTA5NDF8JVloWWozeThvUXdZQHJaYz8lQUM=";

const PEACH_RECURRING_ENTITY_ID = "8ac7a4c99b051f9d019b09f2df510947"; // required for stored cards


// ----------------------
// PEACH REQUEST WRAPPER
// ----------------------
function peachRequest(path, form) {
  const body = querystring.stringify(form);

  const options = {
    port: 443,
    host: PEACH_BASE,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      Authorization: `Bearer ${PEACH_ACCESS_TOKEN}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const str = Buffer.concat(chunks).toString("utf8");
        try {
          const json = JSON.parse(str);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          reject(new Error(`Peach parse error: ${str}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}


// ----------------------
// MAIN ENDPOINT
// ----------------------
export async function POST(req) {
  try {
    const payload = await req.json();
    const {
      uid: userId,        // MUST be passed from frontend auth
      cardNumber,
      holder,
      expiryMonth,
      expiryYear,
      cvv,
      billing = {},
    } = payload || {};

    if (!userId) {
      return err(400, "Missing User", "User ID is required.");
    }

    if (!cardNumber || !expiryMonth || !expiryYear || !cvv) {
      return err(
        400,
        "Missing Fields",
        "Card number, expiry month/year and CVV are required."
      );
    }

    // ----------------------
    // 1️⃣ Build minimal Peach tokenization payload
    // ----------------------
    const formData = {
      entityId: PEACH_RECURRING_ENTITY_ID,
      testMode: "EXTERNAL",
      paymentBrand: "MASTER", // works in sandbox

      "card.number": cardNumber,
      "card.holder": holder || "Card Holder",
      "card.expiryMonth": expiryMonth,
      "card.expiryYear": expiryYear,
      "card.cvv": cvv,

      "billing.city": billing.city || "Cape Town",
      "billing.country": billing.country || "ZA",
      "billing.postcode": billing.postcode || "8000",
      "billing.state": billing.state || "WC",
      "billing.street1": billing.street1 || "Test Street",

      "customer.email": payload.email || "unknown@bevgo.co.za",
      "customer.ip": payload.ip || "127.0.0.1",
      "customer.givenName": holder?.split(" ")[0] || "Unknown",
      "customer.surname": holder?.split(" ")[1] || "User",
      "customer.language": "EN",
    };

    // ----------------------
    // 2️⃣ Call Peach — tokenize card
    // ----------------------
    const { status, body } = await peachRequest("/v1/registrations", formData);

    if (status < 200 || status >= 300) {
      return err(
        status,
        "Peach Tokenization Failed",
        "Gateway rejected tokenization request.",
        { gateway: body }
      );
    }

    if (!body.id) {
      return err(
        500,
        "Tokenization Error",
        "Peach did not return a token ID.",
        { gateway: body }
      );
    }

    // Extract masked card info Peach returns
    const masked = body.card || {};

    const registrationId = body.id;
    const merchantTransactionId =
      body.merchantTransactionId || `CARD-SAVE-${userId}-${Date.now()}`;

    // ----------------------
    // 3️⃣ Build Bevgo Saved Card Object (canonical)
    // ----------------------
    const cardId = uid();
    const timestamp = now();

    const savedCard = {
      id: cardId,
      status: "active",
      type: "card",

      brand: masked.brand || "MASTER",
      last4: masked.last4Digits || cardNumber.slice(-4),
      bin: masked.bin || cardNumber.slice(0, 6),
      expiryMonth,
      expiryYear,

      token: {
        provider: "peach",
        registrationId,
        entityId: PEACH_RECURRING_ENTITY_ID,
        merchantTransactionId,
        peachTransactionId: body.ndc || null,
        raw: null // optional debug storage
      },

      billing: {
        name: holder || "Card Holder",
        country: billing.country || "ZA",
        city: billing.city || "Cape Town",
        street1: billing.street1 || "Test Street",
        postcode: billing.postcode || "8000"
      },

      lastCharged: [], // nothing yet — new card

      createdAt: timestamp,
      updatedAt: timestamp
    };

    // ----------------------
    // 4️⃣ Save card to Firestore
    // ----------------------
    const userRef = doc(db, "users", userId);

    await updateDoc(userRef, {
      "account.paymentMethods.cards": arrayUnion(savedCard)
    });

    // ----------------------
    // 5️⃣ Return masked card to client
    // ----------------------
    return ok({
      card: {
        id: savedCard.id,
        brand: savedCard.brand,
        last4: savedCard.last4,
        expiryMonth,
        expiryYear
      },
      registrationId,
      gateway: body
    });
  } catch (error) {
    console.error("Tokenization error:", error);
    return err(500, "Server Error", error.message);
  }
}
