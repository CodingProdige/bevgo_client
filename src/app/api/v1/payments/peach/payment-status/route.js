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

    if (!paymentId) {
      return err(400, "Missing Payment Id", "paymentId is required.");
    }

    const data = await peachGet(
      `/v1/payments/${paymentId}?entityId=${ENTITY_ID}`
    );

    return ok({
      paymentId,
      result: data?.result || null,
      paymentType: data?.paymentType || null,
      paymentBrand: data?.paymentBrand || null,
      merchantTransactionId: data?.merchantTransactionId || null,
      status: data?.result?.code || null,
      raw: data
    });
  } catch (e) {
    return err(500, "Payment Status Error", e?.message || "Server error.");
  }
}
