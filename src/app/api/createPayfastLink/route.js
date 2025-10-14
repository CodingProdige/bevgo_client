// app/api/createPayfastLink/route.js
import { NextResponse } from "next/server";
import axios from "axios";

const ALLOWED_CONTEXTS = new Set(["INVOICE", "ORDER", "PREORDER"]);

// PayFast fee calc: 2.95% + R0.50
function calcAdjusted(base) {
  const PERCENTAGE = 0.0295;
  const FIXED_FEE = 0.5;
  const adjusted = (base + FIXED_FEE) / (1 - PERCENTAGE);
  return {
    adjustedTotal: adjusted,
    paymentFee: adjusted - base,
  };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const {
      paymentContext,            // "INVOICE" | "ORDER" | "PREORDER"
      reference,                 // invoiceNumber OR orderNumber (for INVOICE/ORDER)
      companyCode,               // required in all cases
      baseTotal,                 // required for PREORDER; optional override for others
      // Back-compat input (if someone still posts orderNumber):
      orderNumber,               // legacy field -> mapped to reference when present
    } = body || {};

    // Normalize inputs
    const ctx = String(paymentContext || "").toUpperCase();
    if (!ALLOWED_CONTEXTS.has(ctx)) {
      return NextResponse.json(
        { error: `Invalid paymentContext. Allowed: ${Array.from(ALLOWED_CONTEXTS).join(", ")}` },
        { status: 400 }
      );
    }
    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    const ref = reference || orderNumber || ""; // for INVOICE/ORDER

    // Helper: create init transaction for ALL cases
    async function createInitTxn({ companyCode, orderNumberOrRef }) {
      const res = await axios.post(
        `${process.env.BASE_URL}/api/transactions/createTransaction`,
        {
          companyCode: companyCode || null,
          // For PREORDER there is no order yet -> null; for INVOICE/ORDER we can store the ref if you want
          orderNumber: ctx === "PREORDER" ? null : (orderNumberOrRef || null),
        }
      );
      const tn = res.data?.transaction?.transactionNumber;
      if (!tn) throw new Error("No transactionNumber returned from createTransaction");
      return tn;
    }

    // Optional: fetch customer display info
    let customer = { companyCode, companyName: "Customer", email: "info@bevgo.co.za" };
    try {
      const userRes = await axios.post(`https://bevgo-client.vercel.app/api/getUser`, { companyCode });
      if (userRes.status === 200 && userRes.data?.data) {
        customer.companyName = userRes.data.data.companyName || customer.companyName;
        customer.email = userRes.data.data.email || customer.email;
      }
    } catch (e) {
      console.warn("⚠️ Customer lookup failed; using defaults:", e.message);
    }

    let resolvedBase = null;

    if (ctx === "PREORDER") {
      // PREORDER must provide baseTotal (or compute it server-side elsewhere)
      if (baseTotal == null || isNaN(Number(baseTotal))) {
        return NextResponse.json({ error: "Missing or invalid baseTotal for PREORDER" }, { status: 400 });
      }
      resolvedBase = Number(baseTotal);
    } else if (ctx === "INVOICE") {
      if (!ref) {
        return NextResponse.json({ error: "Missing reference (invoiceNumber) for INVOICE" }, { status: 400 });
      }
      if (baseTotal != null && !isNaN(Number(baseTotal))) {
        resolvedBase = Number(baseTotal);
      } else {
        // Derive from invoice if not supplied
        const invRes = await axios.post(`${process.env.BASE_URL}/api/getInvoice`, {
          orderNumber: ref,
          companyCode,
          isAdmin: true,
        });
        const inv = invRes.data?.invoices?.[0];
        if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
        resolvedBase = Number(inv.finalTotals.finalTotal);
      }
    } else if (ctx === "ORDER") {
      if (!ref) {
        return NextResponse.json({ error: "Missing reference (orderNumber) for ORDER" }, { status: 400 });
      }
      if (baseTotal != null && !isNaN(Number(baseTotal))) {
        resolvedBase = Number(baseTotal);
      } else {
        // Derive from order if not supplied
        const ordRes = await axios.get(`${process.env.BASE_URL}/api/getOrder`, {
          params: { orderNumber: ref, isAdmin: true }
        });
        const order = ordRes.data?.order;
        if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
        resolvedBase = Number(order.calcFinalTotal?.finalTotal || order.order_details?.total);
      }
    }

    if (resolvedBase == null || isNaN(resolvedBase) || resolvedBase <= 0) {
      return NextResponse.json({ error: "Unable to resolve a valid baseTotal" }, { status: 400 });
    }

    // 1) Create init transaction now (always)
    const transactionNumber = await createInitTxn({
      companyCode,
      orderNumberOrRef: ref || null,
    });

    // 2) Compute PayFast totals
    const { adjustedTotal, paymentFee } = calcAdjusted(resolvedBase);

    // 3) Build PayFast payload
    const commonMeta = {
      custom_str1: companyCode,                   // companyCode
      custom_str2: resolvedBase.toFixed(2),       // base excl. fees
      custom_str3: transactionNumber,             // link to initTransactions
      custom_str4: ctx,                           // payment context
      custom_str5: ref,                           // invoice/order ref or "" for PREORDER
      name_first: customer.companyName,
      email_address: customer.email,
    };

    const payload =
      ctx === "PREORDER"
        ? {
            merchant_id: process.env.PAYFAST_MERCHANT_ID,
            merchant_key: process.env.PAYFAST_MERCHANT_KEY,
            return_url: `https://client-portal.bevgo.co.za/paymentSuccess?transactionNumber=${transactionNumber}`,
            cancel_url: `https://client-portal.bevgo.co.za/paymentCancelled?transactionNumber=${transactionNumber}`,
            notify_url: `${process.env.BASE_URL}/api/payfastWebhook`,
            m_payment_id: transactionNumber, // PREORDER → use transactionNumber
            amount: adjustedTotal.toFixed(2),
            item_name: `Payment for PREORDER (${transactionNumber})`,
            ...commonMeta,
          }
        : {
            merchant_id: process.env.PAYFAST_MERCHANT_ID,
            merchant_key: process.env.PAYFAST_MERCHANT_KEY,
            return_url: `https://client-portal.bevgo.co.za/paymentSuccess?${ctx.toLowerCase()}Number=${encodeURIComponent(ref)}`,
            cancel_url: `https://client-portal.bevgo.co.za/paymentCancelled?${ctx.toLowerCase()}Number=${encodeURIComponent(ref)}`,
            notify_url: `${process.env.BASE_URL}/api/payfastWebhook`,
            m_payment_id: ref, // INVOICE/ORDER → keep legacy behavior
            amount: adjustedTotal.toFixed(2),
            item_name: `Payment for ${ctx} #${ref}`,
            ...commonMeta,
          };

    const paymentLink = `https://www.payfast.co.za/eng/process?${new URLSearchParams(payload)}`;

    // 4) Respond
    return NextResponse.json({
      message: "Payment link generated",
      paymentContext: ctx,
      reference: ref, // invoiceNumber/orderNumber (or "")
      baseTotal: resolvedBase.toFixed(2),
      paymentFee: paymentFee.toFixed(2),
      adjustedTotal: adjustedTotal.toFixed(2),
      transactionNumber,
      paymentLink,
      // (Optional) echo the outbound payload for debugging:
      // debugPayload: payload,
    });
  } catch (error) {
    console.error("❌ createPayfastLink error:", error);
    return NextResponse.json(
      { error: "Failed to generate payment link", details: error.message },
      { status: 500 }
    );
  }
}
