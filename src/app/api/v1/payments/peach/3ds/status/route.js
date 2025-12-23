export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────────────── HELPERS ───────────────── */

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, x = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...x }, { status: s });

const now = () => new Date().toISOString();

/* ───────────────── ENV (LIVE S2S) ───────────────── */

const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;
const ENTITY_ID_3DS = process.env.PEACH_S2S_ENTITY_ID;
const HOST = "oppwa.com";

/* ───────────────── PEACH GET ───────────────── */

function peachGet(path) {
  const options = {
    port: 443,
    host: HOST,
    path,
    method: "GET",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`
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
    req.end();
  });
}

/* ───────────────── ENDPOINT ───────────────── */

export async function POST(req) {
  try {
    const { threeDSecureId, orderId } = await req.json();

    let attemptId = threeDSecureId;
    let ref;
    let attempt;

    /* ───── Resolve 3DS attempt ───── */

    if (!attemptId) {
      if (!orderId) {
        return err(
          400,
          "Missing Parameters",
          "threeDSecureId or orderId is required"
        );
      }

      const q = query(
        collection(db, "payment_3ds_attempts"),
        where("orderId", "==", orderId),
        orderBy("createdAt", "desc"),
        limit(1)
      );

      const snaps = await getDocs(q);

      if (snaps.empty) {
        return err(
          404,
          "3DS Attempt Not Found",
          "No 3DS attempt found for this order"
        );
      }

      const docSnap = snaps.docs[0];
      attemptId = docSnap.id;
      attempt = docSnap.data();
      ref = docSnap.ref;
    } else {
      ref = doc(db, "payment_3ds_attempts", attemptId);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        return err(
          404,
          "3DS Attempt Not Found",
          "Invalid threeDSecureId"
        );
      }

      attempt = snap.data();
    }

    /* ───── Fetch status from Peach ───── */

    const data = await peachGet(
      `/v1/threeDSecure/${attemptId}?entityId=${ENTITY_ID_3DS}`
    );

    const resultCode = data?.result?.code || "";
    const resultDescription = data?.result?.description || null;

    const authenticated = resultCode === "000.000.000";

    let status = "pending";
    if (authenticated) status = "authenticated";
    else if (
      resultCode.startsWith("100.") ||
      resultCode.startsWith("200.") ||
      resultCode.startsWith("800.")
    )
      status = "failed";

    /* ───── Extract 3DS metadata (diagnostics) ───── */

    const threeDS = data?.authentication?.threeDSecure || {};

    const flow = threeDS?.flow || null;
    const liabilityShift = threeDS?.liabilityShift ?? null;
    const challengeRequired = threeDS?.challengeRequired ?? null;

    /* ───── Recommendation (non-breaking hint) ───── */

    let recommendation = "unknown";

    if (authenticated) {
      recommendation = "charge_allowed";
    } else if (flow === "FRICTIONLESS") {
      recommendation = "issuer_rejected_frictionless";
    } else if (challengeRequired === false) {
      recommendation = "issuer_declined_authentication";
    } else {
      recommendation = "retry_or_use_different_card";
    }

    /* ───── Update Firestore ───── */

    await updateDoc(ref, {
      status,
      authenticated,
      peach: {
        ...(attempt.peach || {}),
        rawStatusResponse: data
      },
      updatedAt: now()
    });

    /* ───── Resolve orderNumber ───── */

    let orderNumber = attempt.orderNumber || null;

    if (!orderNumber && attempt.orderId) {
      const orderRef = doc(db, "orders_v2", attempt.orderId);
      const orderSnap = await getDoc(orderRef);

      if (orderSnap.exists()) {
        orderNumber = orderSnap.data()?.order?.orderNumber || null;
      }
    }

    /* ───── Response (additive only) ───── */

    return ok({
      threeDSecureId: attemptId,
      orderId: attempt.orderId,
      orderNumber,
      authenticated,
      status,
      canCharge: authenticated,

      // 👇 NEW — purely diagnostic, no behavior change
      gateway: {
        code: resultCode,
        description: resultDescription,
        flow,
        liabilityShift,
        challengeRequired,
        recommendation
      }
    });

  } catch (e) {
    return err(500, "Server Error", e.message);
  }
}
