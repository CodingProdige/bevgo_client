export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc
} from "firebase/firestore";

import { db } from "@/lib/firebaseConfig";
import { applyOrderPaymentSuccess } from "@/lib/payments/applyOrderPaymentSuccess";

/* ───────── HELPERS ───────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

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
      merchantTransactionId,
      amount,
      currency,
      threeDSecureId,
      customer
    } = await req.json();

    if (!merchantTransactionId || !amount || !currency || !threeDSecureId) {
      return err(
        400,
        "Missing Information",
        "merchantTransactionId, amount, currency and threeDSecureId are required."
      );
    }

    /* ───── FIND ORDER ───── */

    let snap = await getDocs(
      query(
        collection(db, "orders_v2"),
        where("order.merchantTransactionId", "==", merchantTransactionId)
      )
    );

    if (snap.empty) {
      snap = await getDocs(
        query(
          collection(db, "orders_v2"),
          where("order.orderNumber", "==", merchantTransactionId)
        )
      );
    }

    if (snap.empty) {
      return err(404, "Order Not Found", "No matching order found.");
    }

    if (snap.size > 1) {
      return err(409, "Multiple Orders Found", "Ambiguous merchantTransactionId.");
    }

    const docSnap = snap.docs[0];
    const orderDoc = docSnap.data();
    const documentId = docSnap.id;
    const orderId = orderDoc?.order?.orderId;

    if (!orderId) {
      return err(500, "Invalid Order", "order.orderId missing.");
    }

    const formattedAmount = Number(amount).toFixed(2);

    /* ───── POST-3DS CHARGE ───── */

    const peachPayload = {
      entityId: ENTITY_ID,
      amount: formattedAmount,
      currency,
      paymentType: "DB",

      threeDSecureId,

      merchantTransactionId: orderDoc.order.merchantTransactionId,

      createRegistration: "true",

      "standingInstruction.mode": "INITIAL",
      "standingInstruction.source": "CIT",
      "standingInstruction.type": "UNSCHEDULED",

      "customer.email": customer?.email || "unknown@bevgo.co.za"
    };

    const peachRes = await peachRequest("/v1/payments", peachPayload);

    if (!peachRes?.result?.code?.startsWith("000.")) {
      return err(
        402,
        "Payment Failed",
        peachRes?.result?.description || "Payment declined",
        { gateway: peachRes }
      );
    }

    /* ───── APPLY PAYMENT ───── */

    await applyOrderPaymentSuccess({
      orderId,
      provider: "peach",
      method: "card",
      chargeType: "card",
      merchantTransactionId: orderDoc.order.merchantTransactionId,
      peachTransactionId: peachRes.id,
      amount_incl: Number(formattedAmount),
      currency
    });

    return ok({
      paymentId: peachRes.id,
      registrationId: peachRes?.registrationId || null,
      orderId,
      documentId,
      merchantTransactionId: orderDoc.order.merchantTransactionId
    });

  } catch (e) {
    console.error("🟥 charge-card fatal error:", e);
    return err(500, "Payment Error", e?.message || "Unexpected error.");
  }
}
