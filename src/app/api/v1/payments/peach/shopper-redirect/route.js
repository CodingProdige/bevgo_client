export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, x = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...x }, { status: s });

function appendQueryParam(rawUrl, key, value) {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const joiner = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${joiner}${encodeURIComponent(key)}=${encodeURIComponent(
      value
    )}`;
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const merchantTransactionId = searchParams.get("merchantTransactionId");

    if (!merchantTransactionId) {
      return err(
        400,
        "Missing merchantTransactionId",
        "merchantTransactionId is required."
      );
    }

    const snap = await getDoc(
      doc(db, "peach_redirects", merchantTransactionId)
    );

    if (!snap.exists()) {
      return err(
        404,
        "Redirect Not Found",
        "No redirect data found for this transaction."
      );
    }

    const data = snap.data() || {};
    const shopperResultUrl = data.shopperResultUrl;
    const paymentId = data.paymentId;
    const orderNumber = data.orderNumber || null;

    if (!shopperResultUrl || !paymentId) {
      return err(
        409,
        "Redirect Missing Data",
        "shopperResultUrl or paymentId missing."
      );
    }

    let redirectUrl = appendQueryParam(shopperResultUrl, "paymentId", paymentId);
    redirectUrl = appendQueryParam(
      redirectUrl,
      "merchantTransactionId",
      merchantTransactionId
    );
    if (orderNumber) {
      redirectUrl = appendQueryParam(redirectUrl, "orderNumber", orderNumber);
    }

    return NextResponse.redirect(redirectUrl, { status: 302 });
  } catch (e) {
    return err(500, "Redirect Error", e?.message || "Server error.");
  }
}
