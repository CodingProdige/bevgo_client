export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs
} from "firebase/firestore";

import { db } from "@/lib/firebaseConfig";
import { applyOrderPaymentSuccess } from "@/lib/payments/applyOrderPaymentSuccess";

/* ───────── HELPERS ───────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

const now = () => new Date().toISOString();

/* ───────── ENV (LIVE S2S) ───────── */

const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;
const ENTITY_ID = process.env.PEACH_S2S_ENTITY_ID;
const HOST = "oppwa.com";

/* ───────── PEACH REQUEST ───────── */

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
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(raw));
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

    if (merchantTransactionId.length > 16) {
      return err(
        400,
        "Invalid merchantTransactionId",
        "Must be ≤ 16 characters."
      );
    }

    const formattedAmount = Number(amount).toFixed(2);

    /* ───── RESOLVE ORDER ───── */

    const q = query(
      collection(db, "orders_v2"),
      where("order.merchantTransactionId", "==", merchantTransactionId)
    );

    const qs = await getDocs(q);

    if (qs.empty) {
      return err(404, "Order Not Found", "No order matches this transaction.");
    }

    if (qs.size > 1) {
      return err(409, "Multiple Orders Found", "Ambiguous transaction.");
    }

    const orderSnap = qs.docs[0];
    const order = orderSnap.data();
    const orderId = orderSnap.id;

    if (order?.order?.status?.payment === "paid") {
      return err(409, "Already Paid", "This order has already been paid.");
    }

    /* ───── LOAD USER & CARD ───── */

    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return err(404, "User Not Found", "User does not exist.");
    }

    const user = userSnap.data();
    const cards = user.paymentMethods?.cards || [];

    const card = cards.find(c => c.id === cardId && c.status === "active");

    if (!card?.token?.registrationId || !card?.token?.peachTransactionId) {
      return err(
        404,
        "Card Not Found",
        "Selected card is not available for token payments."
      );
    }

    /* ───── PEACH MIT TOKEN CHARGE ───── */

    const peachPayload = {
      entityId: ENTITY_ID,
      amount: formattedAmount,
      currency,
      paymentType: "DB",

      "standingInstruction.mode": "REPEATED",
      "standingInstruction.source": "MIT",
      "standingInstruction.type": "UNSCHEDULED",
      "standingInstruction.initialTransactionId":
        card.token.peachTransactionId,

      merchantTransactionId
    };

    const peachRes = await peachRequest(
      `/v1/registrations/${card.token.registrationId}/payments`,
      peachPayload
    );

    if (!peachRes?.result?.code?.startsWith("000.")) {
      return err(
        402,
        "Payment Failed",
        peachRes?.result?.description || "Payment could not be completed.",
        { gateway: peachRes }
      );
    }

    /* ───── APPLY ORDER PAYMENT ───── */

    await applyOrderPaymentSuccess({
      orderId,
      provider: "peach",
      method: "card",
      chargeType: "token",
      merchantTransactionId,
      peachTransactionId: peachRes.id,
      amount_incl: Number(formattedAmount),
      currency,
      token: {
        registrationId: card.token.registrationId,
        cardId: card.id
      }
    });

    /* ───── UPDATE CARD METADATA ───── */

    const timestamp = now();

    const updatedCards = cards.map(c =>
      c.id === cardId
        ? {
            ...c,
            paymentAttempts: [
              ...(c.paymentAttempts || []),
              {
                merchantTransactionId,
                paymentId: peachRes.id,
                amount: formattedAmount,
                currency,
                status: "success",
                createdAt: timestamp
              }
            ],
            lastCharged: [...(c.lastCharged || []), timestamp],
            updatedAt: timestamp
          }
        : c
    );

    await updateDoc(userRef, {
      "paymentMethods.cards": updatedCards
    });

    return ok({
      paymentId: peachRes.id,
      orderId,
      merchantTransactionId
    });

  } catch (e) {
    console.error("🟥 charge-token fatal error:", e);
    return err(500, "Payment Error", e?.message || "Unexpected error.");
  }
}
