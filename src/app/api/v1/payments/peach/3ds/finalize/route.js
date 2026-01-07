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

function detectBrand(pan) {
  if (!pan) return "VISA";
  if (/^4/.test(pan)) return "VISA";
  if (/^5[1-5]/.test(pan)) return "MASTER";
  if (/^3[47]/.test(pan)) return "AMEX";
  return "VISA";
}

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
    const {
      threeDSecureId,
      orderId,
      amount,
      currency,
      card: bodyCard,
      includeStandingInstruction = true,
      createRegistration = true
    } = await req.json();

    if (!threeDSecureId)
      return err(400, "Missing Reference", "threeDSecureId is required.");

    if (!ENTITY_ID || !ACCESS_TOKEN)
      return err(500, "Config Error", "3DS credentials not configured.");

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

    const finalAmount = amount || attempt?.amount;
    const finalCurrency = currency || attempt?.currency;

    if (!finalAmount || !finalCurrency)
      return err(400, "Missing Amount", "amount & currency required.");

    const card = attempt?.card || bodyCard;
    const verificationId =
      attempt?.gatewayLast?.threeDSecure?.verificationId ||
      attempt?.peach?.threeDSecure?.verificationId ||
      null;

    if (!card?.number || !card?.expiryMonth || !card?.expiryYear || !card?.holder || !card?.cvv)
      return err(
        400,
        "Missing Card",
        "Card snapshot missing — initiate didn't store it."
      );

    // ⭐ payment payload after 3DS authentication
    const payload = {
      entityId: ENTITY_ID,
      paymentType: "DB",
      amount: Number(finalAmount).toFixed(2),
      currency: finalCurrency,
      merchantTransactionId,
      threeDSecureId,
      transactionCategory: attempt?.transactionCategory || "EC",
      paymentBrand: card.brand || detectBrand(card.number),
      "card.number": card.number,
      "card.expiryMonth": card.expiryMonth,
      "card.expiryYear": card.expiryYear,
      "card.holder": card.holder,
      "card.cvv": card.cvv
    };

    if (attempt?.customerIp) {
      payload["customer.ip"] = attempt.customerIp;
    }

    if (verificationId) {
      payload["threeDSecure.verificationId"] = verificationId;
    }

    if (createRegistration) {
      payload.createRegistration = "true";
    }

    if (includeStandingInstruction) {
      payload["standingInstruction.mode"] = "INITIAL";
      payload["standingInstruction.source"] = "CIT";
      payload["standingInstruction.type"] = "UNSCHEDULED";
    }

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
        {
          gateway,
          parameterErrors: gateway?.parameterErrors || null,
          invalid: gateway?.result?.parameterErrors || null,
          resultDetails: gateway?.resultDetails || null
        }
      );
    }

    await updateDoc(ref, {
      finalized: true,
      status: "charged",
      gatewayCharge: gateway,
      card: {
        brand: card.brand || detectBrand(card.number),
        holder: card.holder,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        last4: card.number?.slice(-4) || null
      },
      cardMasked: true,
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
        amount_incl: Number(finalAmount),
        currency: finalCurrency
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
