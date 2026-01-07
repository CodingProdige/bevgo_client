export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";
import { db } from "@/lib/firebaseConfig";
import {
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";

/* ───────── CORS CONFIG ───────── */

const ALLOWED_ORIGIN = "https://3ds.bevgo.co.za";

function withCors(res) {
  res.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return res;
}

/* ───────── HELPERS ───────── */

const ok = (p = {}, s = 200) =>
  withCors(NextResponse.json({ ok: true, ...p }, { status: s }));

const err = (s, t, m, x = {}) =>
  withCors(NextResponse.json({ ok: false, title: t, message: m, ...x }, { status: s }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── ENV ───────── */

const HOST = "oppwa.com";
const ENTITY_ID = process.env.PEACH_S2S_ENTITY_ID;
const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;

/* ───────── PEACH REQUEST ───────── */

async function fetchStatus(id) {
  const path = `/v1/threeDSecure/${id}?entityId=${ENTITY_ID}`;

  const options = {
    port: 443,
    host: HOST,
    path,
    method: "GET",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const buf = [];
      res.on("data", (c) => buf.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(buf).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

/* ───────── STATE HELPERS (PATCHED) ───────── */

/**
 * Determine if polling should stop
 */
function isFinal(gateway) {
  const code = gateway?.result?.code || "";
  const auth = gateway?.threeDSecure?.authenticationStatus;
  const eci = gateway?.threeDSecure?.eci;

  // Fully authenticated
  if (auth === "Y" || eci === "05" || code.startsWith("000.000") || code.startsWith("000.3"))
    return true;

  // Explicit declines/failures
  if (!code.startsWith("000.")) return true;

  // Still in async steps
  return false;
}

/**
 * Map gateway to simplified status
 */
function mapStatus(gateway) {
  const code = gateway?.result?.code || "";
  const auth = gateway?.threeDSecure?.authenticationStatus;
  const eci = gateway?.threeDSecure?.eci;

  // 🔥 SUCCESS (3DS passed)
  if (auth === "Y" || eci === "05" || code.startsWith("000.3") || code.startsWith("000.000"))
    return "authenticated";

  // In progress
  if (code.startsWith("000.")) return "pending";

  // Declined / timed-out / abandoned
  return "failed";
}

/* ───────── OPTIONS (Preflight) ───────── */

export async function OPTIONS() {
  return withCors(NextResponse.json({ ok: true }));
}

/* ───────── GET ───────── */

export async function GET(req, { params }) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id") || params?.id;
    const poll = searchParams.get("poll") === "true";

    if (!id) return err(400, "Missing id", "3DS id is required.");
    if (!ENTITY_ID || !ACCESS_TOKEN)
      return err(500, "Config Error", "3DS credentials missing.");

    const ref = doc(db, "payment_3ds_attempts", id);
    const baseSnap = await getDoc(ref);

    if (!baseSnap.exists())
      return err(404, "Attempt Not Found", `No attempt ${id}`);

    let attempt = 0;
    let gateway;
    let lastStatus = null;

    do {
      gateway = await fetchStatus(id);

      const status = mapStatus(gateway);

      // only write DB when changed
      if (status !== lastStatus) {
        await updateDoc(ref, {
          status,
          gatewayLast: gateway,
          resultCode: gateway?.result?.code || "",
          threeDSVerificationId: gateway?.threeDSecure?.verificationId || null,
          updatedAt: serverTimestamp(),
        });
        lastStatus = status;
      }

      if (!poll || isFinal(gateway)) break;

      attempt++;
      await sleep(2000);
    } while (attempt < 8);

    const finalSnap = await getDoc(ref);
    const finalDoc = finalSnap.data();

    return ok({
      gateway,
      polled: poll,
      attempts: attempt,
      status: finalDoc?.status,
    });

  } catch (e) {
    console.error("3DS Poll Error", e);
    return err(
      500,
      "3DS Status Failed",
      e?.message || "Unexpected error",
      { error: String(e) }
    );
  }
}
