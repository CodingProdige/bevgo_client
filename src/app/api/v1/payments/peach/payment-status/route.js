export const runtime = "nodejs";

import { NextResponse } from "next/server";
import https from "https";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, x = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...x }, { status: s });

const ACCESS_TOKEN = process.env.PEACH_S2S_ACCESS_TOKEN;
const ENTITY_ID = process.env.PEACH_S2S_ENTITY_ID;
const HOST = "oppwa.com";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isFinal(code = "") {
  if (!code) return false;
  if (code.startsWith("000.000") || code.startsWith("000.100.1")) return true;
  if (!code.startsWith("000.")) return true;
  return false;
}

function mapStatus(code = "") {
  if (!code) return "unknown";
  if (code.startsWith("000.000") || code.startsWith("000.100.1"))
    return "succeeded";
  if (code.startsWith("000.200.000")) return "pending";
  if (!code.startsWith("000.")) return "failed";
  return "pending";
}

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

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const paymentId = searchParams.get("paymentId");
    const poll = searchParams.get("poll") === "true";
    const maxAttempts = Math.min(
      Number(searchParams.get("attempts") || 8),
      15
    );

    if (!paymentId) {
      return err(400, "Missing Payment Id", "paymentId is required.");
    }

    let attempts = 0;
    let data;
    let code = "";

    do {
      data = await peachGet(`/v1/payments/${paymentId}?entityId=${ENTITY_ID}`);
      code = data?.result?.code || "";
      if (!poll || isFinal(code)) break;
      attempts++;
      await sleep(2000);
    } while (attempts < maxAttempts);

    return ok({
      paymentId,
      result: data?.result || null,
      paymentType: data?.paymentType || null,
      paymentBrand: data?.paymentBrand || null,
      merchantTransactionId: data?.merchantTransactionId || null,
      status: mapStatus(code), //succeeded/pending/failed
      resultCode: code || null,
      polled: poll,
      attempts,
      raw: data
    });
  } catch (e) {
    return err(500, "Payment Status Error", e?.message || "Server error.");
  }
}
