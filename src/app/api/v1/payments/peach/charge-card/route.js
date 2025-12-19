export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import { doc, getDoc, updateDoc } from "firebase/firestore";
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

const ACCESS_TOKEN = process.env.PEACH_ACCESS_TOKEN;
const ENTITY_ID = process.env.PEACH_ENTITY_RECURRING;
const HOST = "sandbox-card.peachpayments.com";

/* ───────── PEACH ───────── */

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
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
    const {
      userId,
      amount,
      currency,
      merchantTransactionId,
      card,
      billing,
      customer,
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

    /* ───── IDEMPOTENCY ───── */
    for (const c of cards) {
      const attempt = (c.paymentAttempts || []).find(
        a => a.merchantTransactionId === merchantTransactionId
      );
      if (attempt) {
        return ok({
          idempotent: true,
          paymentId: attempt.paymentId
        });
      }
    }

    /* ───── PEACH PAYMENT ───── */

    const peachPayload = {
      entityId: ENTITY_ID,
      amount,
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

      "customer.email": customer?.email || "unknown@bevgo.co.za"
    };

    const data = await peachRequest("/v1/payments", peachPayload);

    if (!data?.result?.code?.startsWith("000.")) {
      return err(
        402,
        "Payment Failed",
        data?.result?.description || "Your card was declined.",
        { gateway: data }
      );
    }

    const timestamp = now();

    /* ───── DUPLICATE CARD CHECK ───── */

    let cardId = null;

    const existingCard = cards.find(c =>
      c.bin === data.card?.bin &&
      c.last4 === data.card?.last4Digits &&
      c.expiryMonth === data.card?.expiryMonth &&
      c.expiryYear === data.card?.expiryYear
    );

    if (existingCard) {
      cardId = existingCard.id;
    }

    /* ───── BUILD PAYMENT ATTEMPT ───── */

    const paymentAttempt = {
      merchantTransactionId,
      paymentId: data.id,
      amount,
      currency,
      status: "success",
      createdAt: timestamp
    };

    let updatedCards;

    if (existingCard) {
      updatedCards = cards.map(c =>
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

        brand: data.paymentBrand,
        last4: data.card.last4Digits,
        bin: data.card.bin,
        expiryMonth: data.card.expiryMonth,
        expiryYear: data.card.expiryYear,

        token: {
          provider: "peach",
          registrationId: data.registrationId,
          entityId: ENTITY_ID,
          merchantTransactionId,
          peachTransactionId: data.id,
          raw: null
        },

        billing: billing || null,

        paymentAttempts: [paymentAttempt],
        lastCharged: [timestamp],
        createdAt: timestamp,
        updatedAt: timestamp
      };

      updatedCards = [...cards, newCard];
      cardId = newCard.id;
    } else {
      updatedCards = cards;
    }

    await updateDoc(userRef, {
      "paymentMethods.cards": updatedCards
    });

    return ok({
      paymentId: data.id,
      cardId,
      title: "Payment Successful",
      message: "Your payment was completed successfully.",
      raw: data
    });

  } catch (e) {
    return err(
      500,
      "Payment Error",
      "Something went wrong while processing your payment."
    );
  }
}
