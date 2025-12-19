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

/* ───────────────── ENV ───────────────── */

const ACCESS_TOKEN = process.env.PEACH_ACCESS_TOKEN;
const ENTITY_ID_3DS = process.env.PEACH_ENTITY_3DS;
const HOST = "sandbox-card.peachpayments.com";

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
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
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

    /* ───── Resolve by orderId if needed ───── */
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

    /* ───── FETCH STATUS FROM PEACH ───── */

    const data = await peachGet(
      `/v1/threeDSecure/${attemptId}?entityId=${ENTITY_ID_3DS}`
    );

    const code = data?.result?.code || "";
    const authenticated = code.startsWith("000.");

    let status = "pending";
    if (authenticated) status = "authenticated";
    else if (code.startsWith("100.") || code.startsWith("200."))
      status = "failed";

    /* ───── UPDATE FIRESTORE ───── */

    await updateDoc(ref, {
      status,
      authenticated,
      peach: {
        ...(attempt.peach || {}),
        rawStatusResponse: data
      },
      updatedAt: now()
    });

    /* ───── RESPONSE ───── */

    return ok({
      threeDSecureId: attemptId,
      orderId: attempt.orderId,
      authenticated,
      status,
      canCharge: authenticated
    });

  } catch (e) {
    return err(500, "Server Error", e.message);
  }
}
