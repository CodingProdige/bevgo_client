import { NextResponse } from "next/server";
import axios from "axios";
import { db } from "@/lib/firebaseConfig";
import {
  doc, getDoc, updateDoc,
  collection, addDoc,
  query, where, getDocs,
} from "firebase/firestore";

/* ----------------------------- helpers ----------------------------- */

async function logAccountingAction(action) {
  try {
    await addDoc(collection(db, "accountingLogs"), {
      ...action,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Failed to log accounting action:", err.message);
  }
}

function mapPayfastToTxnStatus(s) {
  switch ((s || "").toUpperCase()) {
    case "COMPLETE": return "Paid";
    case "CANCELLED": return "Cancelled";
    case "FAILED": return "Failed";
    case "PENDING":
    default: return "Pending";
  }
}

async function updateTransactionStatus(transactionNumber, payfastStatus) {
  if (!transactionNumber) return { skipped: true, reason: "missing transactionNumber" };
  try {
    const res = await axios.post(
      `${process.env.BASE_URL}/api/transactions/updateTransactionStatus`,
      { transactionNumber, paymentStatus: mapPayfastToTxnStatus(payfastStatus) },
      { timeout: 10000 }
    );
    return res.data;
  } catch (err) {
    console.error("❌ updateTransactionStatus error:", err.message);
    return { error: err.message };
  }
}

// ✅ Idempotency pre-check: do we already have a payment for this transaction?
async function paymentAlreadyCaptured(transactionNumber) {
  try {
    if (!transactionNumber) return false;
    const q = query(
      collection(db, "payments"),
      where("transactionNumber", "==", String(transactionNumber))
    );
    const snap = await getDocs(q);
    return !snap.empty;
  } catch (e) {
    console.error("paymentAlreadyCaptured check failed:", e.message);
    // fail-open
    return false;
  }
}

/* ------------------------------ webhook ------------------------------ */

export async function POST(req) {
  try {
    const raw = await req.text();
    const data = Object.fromEntries(new URLSearchParams(raw));
    console.log("🔔 PayFast IPN:", data);

    const {
      // IDs / routing
      m_payment_id,        // legacy: invoice/order number OR (in PREORDER) the transactionNumber
      // money + meta
      payment_status,      // COMPLETE | PENDING | FAILED | CANCELLED
      amount_gross,        // includes PayFast fee
      custom_str1,         // companyCode
      custom_str2,         // base amount excl. fees (we treat this as the "credit" amount)
      custom_str3,         // transactionNumber (always set by our link generator)
      custom_str4,         // paymentContext: INVOICE | ORDER | PREORDER
      custom_str5,         // reference: invoiceNumber | orderNumber | "" (PREORDER)
      // contact
      email_address,
    } = data;

    if (!m_payment_id) {
      return NextResponse.json({ error: "Missing m_payment_id" }, { status: 400 });
    }

    const companyCode = custom_str1 || "UNKNOWN";
    const baseAmount = custom_str2 != null ? Number(custom_str2) : null;
    const paymentContext = String(custom_str4 || "").toUpperCase();
    const reference = custom_str5 || "";

    // Prefer explicit transactionNumber; for PREORDER, m_payment_id == transactionNumber
    const transactionNumber =
      custom_str3 || (paymentContext === "PREORDER" ? String(m_payment_id) : null);

    // 1) Always update initTransaction status
    const txnStatusUpdate = await updateTransactionStatus(transactionNumber, payment_status);

    /* 2) On success: capture payment (idempotent) and do minimal context-specific updates */
    let captureResult = null;
    let settleResult = null;
    let orderUpdateResult = null;

    if (payment_status === "COMPLETE") {
      // fee = gross - base (if both present)
      const fee =
        amount_gross && baseAmount != null
          ? Number((Number(amount_gross) - baseAmount).toFixed(2))
          : 0;

      // ✅ IDEMPOTENCY GUARD
      const already = await paymentAlreadyCaptured(transactionNumber);

      if (!already) {
        try {
          const url = `${process.env.BASE_URL}/api/accounting/payments/capturePayment`;

          // 🔑 SIMPLE RULE:
          // - INVOICE → leave unallocated (no creditApplied)
          // - ORDER/PREORDER → fully allocate now: creditApplied = baseAmount
          const payload = {
            companyCode,
            amount: baseAmount,                         // allocation amount (excl. fees)
            grossPaid: Number(amount_gross || 0),       // gross incl. fee
            fee,
            method: "Payfast",
            reference:
              paymentContext === "INVOICE" ? `Payfast Invoice #${reference}`
              : paymentContext === "ORDER" ? `Payfast Order #${reference}`
              : `Payfast Pre-Order Txn #${transactionNumber}`,
            createdBy: "payfast-webhook",
            transactionNumber,                          // for idempotency
            paymentContext,
            referenceRaw: reference,
            ...(paymentContext === "ORDER"   ? { orderNumber: reference }   : {}),
            ...(paymentContext === "INVOICE" ? { invoiceNumber: reference } : {}),
            ...(paymentContext === "ORDER" || paymentContext === "PREORDER"
                ? { creditApplied: baseAmount }         // 👈 FULLY allocate now
                : {}),
          };

          captureResult = await axios.post(url, payload, { timeout: 15000 }).then(r => r.data);
        } catch (err) {
          console.error("❌ capturePayment error:", err?.response?.status, err?.response?.data || err.message);
          captureResult = { error: err.message, status: err?.response?.status, data: err?.response?.data };
        }
      } else {
        captureResult = { skipped: true, reason: "payment already exists for this transactionNumber" };
      }

      // ---- context-specific processing ----
      if (paymentContext === "INVOICE" && reference) {
        // For invoices: allocate now via settleInvoice
        try {
          const settleUrl = `${process.env.BASE_URL}/api/accounting/payments/settleInvoice`;
          settleResult = await axios.post(settleUrl, { orderNumber: reference }, { timeout: 15000 }).then(r => r.data);
        } catch (err) {
          console.error("❌ settleInvoice error:", err?.response?.status, err?.response?.data || err.message);
          settleResult = { error: err.message, status: err?.response?.status, data: err?.response?.data };
        }
      } else if (paymentContext === "ORDER" && reference) {
        // Mark order prepaid (idempotent). We DO NOT call settleInvoice here.
        try {
          const orderRef = doc(db, "orders", reference);
          const orderSnap = await getDoc(orderRef);
          if (orderSnap.exists()) {
            const wasPrepaid = !!orderSnap.data()?.prePaid;
            if (!wasPrepaid) {
              await updateDoc(orderRef, { prePaid: true });
              orderUpdateResult = { ok: true, prePaid: true };
            } else {
              orderUpdateResult = { ok: true, prePaid: true, idempotent: true };
            }
          } else {
            orderUpdateResult = { skipped: true, reason: "Order not found" };
          }
        } catch (err) {
          console.error("❌ order update error:", err.message);
          orderUpdateResult = { error: err.message };
        }
      }
      // PREORDER: nothing else (payment already fully allocated in capturePayment)
    }

    /* 3) Customer email (optional) */
    try {
      const ok = payment_status === "COMPLETE";
      const subject = ok
        ? (paymentContext === "INVOICE"
            ? `Payment Successful — Invoice #${reference}`
            : paymentContext === "ORDER"
              ? `Payment Successful — Order #${reference}`
              : `Payment Successful — Transaction #${transactionNumber}`)
        : `Payment ${payment_status} — ${
            paymentContext === "PREORDER" ? `Transaction #${transactionNumber}` : `Reference #${reference || m_payment_id}`
          }`;

      const amountText = baseAmount != null ? `R${baseAmount.toFixed(2)}` : "your payment";
      const body = ok
        ? (paymentContext === "INVOICE"
            ? `<p>Your payment of ${amountText} for <strong>Invoice #${reference}</strong> was successful. Thank you!</p>`
            : paymentContext === "ORDER"
              ? `<p>Your payment of ${amountText} for <strong>Order #${reference}</strong> was successful. Thank you!</p>`
              : `<p>Your payment of ${amountText} for <strong>Transaction #${transactionNumber}</strong> was successful. Thank you!</p>`)
        : `<p>Your payment status is <strong>${payment_status}</strong> for ${
            paymentContext === "PREORDER"
              ? `Transaction <strong>#${transactionNumber}</strong>`
              : `Reference <strong>#${reference || m_payment_id}</strong>`
          }.</p>`;

      if (email_address) {
        await axios.post(`${process.env.BASE_URL}/api/sendEmail`, {
          to: email_address,
          subject,
          data: { message: body },
        });
      }
    } catch (err) {
      console.error("❌ Customer email error:", err.message);
    }

    /* 4) Log everything */
    await logAccountingAction({
      action: "PAYFAST_IPN",
      payment_status,
      paymentContext,
      reference,
      transactionNumber,
      companyCode,
      grossPaid: Number(amount_gross || 0),
      baseAmount: baseAmount != null ? baseAmount : null,
      captureResult,
      settleResult,
      orderUpdateResult,
      txnStatusUpdate,
      performedBy: "payfast-webhook",
    });

    return NextResponse.json(
      {
        message: "Webhook processed",
        payment_status,
        paymentContext,
        reference,
        transactionNumber,
        captureResult,
        settleResult,
        orderUpdateResult,
        txnStatusUpdate,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    return NextResponse.json({ error: "Webhook processing failed", details: error.message }, { status: 500 });
  }
}
