export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import querystring from "querystring";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";
import { applyOrderPaymentSuccess } from "@/lib/payments/applyOrderPaymentSuccess";

/* HELPERS */
const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, x = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...x }, { status: s });

const now = () => new Date().toISOString();

/* ENV */
const HOST = "oppwa.com";
const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;
const ENTITY_ID = process.env.PEACH_S2S_ENTITY_ID;

/* HTTP WRAPPER */
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

/* ENDPOINT */
export async function POST(req) {
  try {
    const { threeDSecureId, orderId, amount, currency } = await req.json();

    if (!threeDSecureId)
      return err(400, "Missing Reference", "threeDSecureId is required.");

    if (!amount || !currency)
      return err(400, "Missing Amount", "amount & currency required.");

    const ref = doc(db, "payment_3ds_attempts", threeDSecureId);
    const snap = await getDoc(ref);

    if (!snap.exists())
      return err(404, "3DS Session Not Found", threeDSecureId);

    const attempt = snap.data();

    if (attempt.finalized === true) {
      return ok({
        alreadyFinalized: true,
        message: "Payment already finalized."
      });
    }

    const merchantTransactionId =
      attempt?.merchantTransactionId || attempt?.orderNumber;

    if (!merchantTransactionId)
      return err(
        400,
        "Missing Transaction",
        "merchantTransactionId is missing."
      );

    // ⭐ card snapshot must exist
    if (!attempt.card)
      return err(
        400,
        "Missing Card",
        "Card snapshot missing — initiate didn't store it."
      );

    // ⭐ payment payload (Peach expects full card again)
    const payload = {
      entityId: ENTITY_ID,
      paymentType: "DB",
      amount,
      currency,

      paymentBrand: attempt.card.brand,

      "card.number": attempt.card.number,
      "card.expiryMonth": attempt.card.expiryMonth,
      "card.expiryYear": attempt.card.expiryYear,
      "card.holder": attempt.card.holder,

      merchantTransactionId
    };

    console.log("🔵 FINALIZE PAYLOAD →", payload);

    const gateway = await peachRequest("/v1/payments", payload);

    const code = gateway?.result?.code || "";

    if (!code.startsWith("000.")) {
      await updateDoc(ref, {
        status: "charge_failed",
        gatewayCharge: gateway,
        updatedAt: now()
      });

      return err(
        402,
        "Charge Failed",
        gateway?.result?.description || "Your bank declined the payment.",
        { gateway }
      );
    }

    await updateDoc(ref, {
      finalized: true,
      status: "charged",
      gatewayCharge: gateway,
      updatedAt: now()
    });

    const finalOrderId = orderId || attempt?.orderId;

    if (finalOrderId) {
      await applyOrderPaymentSuccess({
        orderId: finalOrderId,
        provider: "peach",
        method: "card",
        chargeType: "card",
        threeDSecureId,
        merchantTransactionId,
        peachTransactionId: gateway.id,
        amount_incl: Number(amount),
        currency
      });
    }

    return ok({
      title: "Payment Complete",
      message: "Your bank has approved your payment.",
      paymentId: gateway.id,
      merchantTransactionId,
      gateway
    });

  } catch (e) {
    console.error("🟥 FINALIZE ERROR:", e);
    return err(
      500,
      "Finalize Error",
      e?.message || "Unexpected error while completing payment."
    );
  }
}
