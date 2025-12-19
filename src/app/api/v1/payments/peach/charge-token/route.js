export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

const now = () => new Date().toISOString();

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
      cardId,
      amount,
      currency,
      merchantTransactionId
    } = await req.json();

    if (!userId || !cardId || !amount || !currency || !merchantTransactionId) {
      return err(400, "Missing Information", "Payment details are incomplete.");
    }

    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      return err(404, "User Not Found", "User does not exist.");
    }

    const user = snap.data();
    const cards = user.paymentMethods?.cards || [];
    const card = cards.find(c => c.id === cardId && c.status === "active");

    if (!card) {
      return err(404, "Card Not Found", "Selected card is not available.");
    }

    /* ───── IDEMPOTENCY ───── */

    const existing = (card.paymentAttempts || []).find(
      a => a.merchantTransactionId === merchantTransactionId
    );

    if (existing) {
      return ok({
        idempotent: true,
        paymentId: existing.paymentId
      });
    }

    /* ───── PEACH PAYMENT ───── */

    const peachPayload = {
      entityId: ENTITY_ID,
      amount,
      currency,
      paymentType: "DB",

      "standingInstruction.mode": "REPEATED",
      "standingInstruction.source": "MIT",
      "standingInstruction.type": "UNSCHEDULED",
      "standingInstruction.initialTransactionId":
        card.token.peachTransactionId,

      merchantTransactionId
    };

    const data = await peachRequest(
      `/v1/registrations/${card.token.registrationId}/payments`,
      peachPayload
    );

    if (!data?.result?.code?.startsWith("000.")) {
      return err(
        402,
        "Payment Failed",
        data?.result?.description || "Payment could not be completed.",
        { gateway: data }
      );
    }

    const timestamp = now();

    const paymentAttempt = {
      merchantTransactionId,
      paymentId: data.id,
      amount,
      currency,
      status: "success",
      createdAt: timestamp
    };

    const updatedCards = cards.map(c =>
      c.id === cardId
        ? {
            ...c,
            paymentAttempts: [...(c.paymentAttempts || []), paymentAttempt],
            lastCharged: [...(c.lastCharged || []), timestamp],
            updatedAt: timestamp
          }
        : c
    );

    await updateDoc(userRef, {
      "paymentMethods.cards": updatedCards
    });

    return ok({
      paymentId: data.id,
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
