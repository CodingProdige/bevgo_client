// app/api/payfastWebhook/route.js
import { NextResponse } from "next/server";
import axios from "axios";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc, collection, addDoc } from "firebase/firestore";

// 🔹 Utility: log accounting actions
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

export async function POST(req) {
  try {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const data = Object.fromEntries(params);

    console.log("🔔 Incoming Payfast Webhook:", data);

    const {
      m_payment_id,     // = orderNumber
      payment_status,
      amount_gross,     // customer actually paid (incl. fee)
      custom_str1,      // companyCode
      custom_str2,      // base amount excl. fees
      email_address,
    } = data;

    if (!m_payment_id) {
      return NextResponse.json({ error: "Missing m_payment_id" }, { status: 400 });
    }

    let captureResult = null;
    let settleResult = null;
    let updatedType = null;
    let customerEmailResult = null;
    let internalEmailResult = null;

    if (payment_status === "COMPLETE") {
      console.log(`✅ Payment successful for ${m_payment_id}`);

      // Always use base amount (excl. fees) for payment doc
      const capturedAmount = custom_str2 ? Number(custom_str2) : null;
      const fee = amount_gross && capturedAmount
        ? (Number(amount_gross) - capturedAmount).toFixed(2)
        : null;

      // 1️⃣ Check if invoice exists
      const invoiceRef = doc(db, "invoices", m_payment_id);
      const invoiceSnap = await getDoc(invoiceRef);

      if (invoiceSnap.exists()) {
        updatedType = "invoice";
        const companyCode = custom_str1 || invoiceSnap.data()?.customer?.companyCode;

        // Capture payment
        captureResult = await axios.post(`${process.env.BASE_URL}/api/payments/capturePayment`, {
          companyCode,
          amount: capturedAmount,
          grossPaid: Number(amount_gross),
          fee: fee ? Number(fee) : 0,
          method: "Payfast",
          reference: `Payfast Transaction #${m_payment_id}`,
          createdBy: "payfast-webhook",
        }).then(r => r.data);

        // Settle invoice (allocations handled here)
        settleResult = await axios.post(`${process.env.BASE_URL}/api/payments/settleInvoice`, {
          orderNumber: m_payment_id,
        }).then(r => r.data);

      } else {
        // 2️⃣ Fallback to order
        const orderRef = doc(db, "orders", m_payment_id);
        const orderSnap = await getDoc(orderRef);

        if (orderSnap.exists()) {
          updatedType = "order";
          const companyCode = custom_str1 || orderSnap.data()?.companyCode;

          // Mark order as prepaid
          await updateDoc(orderRef, { prePaid: true });
          console.log(`⚡ Order ${m_payment_id} marked as prePaid`);

          // Create new payment doc only (NO settle)
          captureResult = await axios.post(`${process.env.BASE_URL}/api/payments/capturePayment`, {
            companyCode,
            amount: capturedAmount,
            grossPaid: Number(amount_gross),
            fee: fee ? Number(fee) : 0,
            method: "Payfast",
            reference: `Payfast Transaction #${m_payment_id}`,
            createdBy: "payfast-webhook",
          }).then(r => r.data);

          settleResult = { skipped: true, reason: "Invoice not yet created" };
        } else {
          console.warn(`⚠️ Neither invoice nor order found for ${m_payment_id}`);
          updatedType = "notfound";
        }
      }

      // ✉️ Customer email
      try {
        const custMsg =
          updatedType === "invoice"
            ? `<p>Your payment of R${capturedAmount.toFixed(2)} for <strong>Invoice #${m_payment_id}</strong> was successful. Thank you!</p>`
            : updatedType === "order"
              ? `<p>Your payment of R${capturedAmount.toFixed(2)} for <strong>Order #${m_payment_id}</strong> was successful.<br/>This order has been marked as prepaid. The final invoice will be issued once your delivery is completed.</p>`
              : `<p>We received a payment for reference #${m_payment_id}, but could not match it to an invoice or order. Please contact support.</p>`;

        const custRes = await axios.post(`${process.env.BASE_URL}/api/sendEmail`, {
          to: email_address,
          subject:
            updatedType === "invoice"
              ? `Payment Successful for Invoice #${m_payment_id}`
              : updatedType === "order"
                ? `Payment Successful for Order #${m_payment_id}`
                : `Payment Received — Reference #${m_payment_id}`,
          data: { message: custMsg },
        });
        customerEmailResult = custRes.data;
        console.log("📨 Customer email sent:", customerEmailResult);
      } catch (err) {
        console.error("❌ Customer email error:", err.message);
        customerEmailResult = { error: err.message };
      }

      // ✉️ Internal email
      try {
        const intMsg =
          updatedType === "invoice"
            ? `<p>Invoice #${m_payment_id} has been settled.</p>
               <p><strong>Gross Paid:</strong> R${amount_gross}<br/>
                  <strong>Allocated Amount:</strong> R${capturedAmount.toFixed(2)}<br/>
                  ${fee ? `<strong>PayFast Fee:</strong> R${fee}</p>` : ""}`
            : updatedType === "order"
              ? `<p>Order #${m_payment_id} has been marked <strong>prepaid</strong>.</p>
                 <p><strong>Gross Paid:</strong> R${amount_gross}<br/>
                    <strong>Allocated Amount:</strong> R${capturedAmount.toFixed(2)}<br/>
                    ${fee ? `<strong>PayFast Fee:</strong> R${fee}</p>` : ""}`
              : `<p>Payment received for reference #${m_payment_id}, but no matching invoice/order found.</p>
                 <p><strong>Gross Paid:</strong> R${amount_gross}<br/>
                    <strong>Allocated Amount:</strong> ${capturedAmount ? "R" + capturedAmount.toFixed(2) : "N/A"}<br/>
                    ${fee ? `<strong>PayFast Fee:</strong> R${fee}</p>` : ""}`;

        const intRes = await axios.post(`${process.env.BASE_URL}/api/sendEmail`, {
          to: "info@bevgo.co.za",
          subject: `Customer Payment Successful`,
          data: { message: intMsg },
        });
        internalEmailResult = intRes.data;
        console.log("📨 Internal email sent:", internalEmailResult);
      } catch (err) {
        console.error("❌ Internal email error:", err.message);
        internalEmailResult = { error: err.message };
      }

      // 🧾 Log PayFast transaction
      await logAccountingAction({
        action: "PAYFAST_PAYMENT",
        orderNumber: m_payment_id,
        companyCode: custom_str1 || "UNKNOWN",
        grossPaid: Number(amount_gross),
        allocatedAmount: capturedAmount,
        fee: fee ? Number(fee) : 0,
        paymentMethod: "Payfast",
        performedBy: "payfast-webhook",
        type: updatedType,
      });
    } else {
      console.log(`⚠️ Payment ${payment_status} for ${m_payment_id}`);
    }

    return NextResponse.json(
      {
        message: "Webhook processed",
        payment_status,
        orderNumber: m_payment_id,
        updatedType,
        captureResult,
        settleResult,
        customerEmailResult,
        internalEmailResult,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    return NextResponse.json(
      { error: "Webhook processing failed", details: error.message },
      { status: 500 }
    );
  }
}
