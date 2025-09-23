// app/api/payfastWebhook/route.js
import { NextResponse } from "next/server";
import axios from "axios";

export async function POST(req) {
  try {
    // Parse x-www-form-urlencoded from Payfast
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const data = Object.fromEntries(params);

    console.log("🔔 Incoming Payfast Webhook:", data);

    const {
      m_payment_id,
      payment_status,
      amount_gross,
      amount_fee,
      amount_net,
      custom_str1,
      email_address,
    } = data;

    if (!m_payment_id) {
      return NextResponse.json({ error: "Missing m_payment_id" }, { status: 400 });
    }

    let customerEmailResult = null;
    let internalEmailResult = null;
    let invoiceUpdateResult = null;

    // ✅ Payment successful
    if (payment_status === "COMPLETE") {
      console.log(`✅ Payment successful for invoice ${m_payment_id}`);

      // 🔄 Update invoice
      try {
        const updateRes = await axios.post(`${process.env.BASE_URL}/api/updateInvoicePaymentStatus`, {
          orderNumber: m_payment_id,
          paymentStatus: "Paid",
        });
        invoiceUpdateResult = updateRes.data;
        console.log("📌 Invoice updated:", invoiceUpdateResult);
      } catch (err) {
        console.error("❌ Failed to update invoice:", err.message);
        invoiceUpdateResult = { error: err.message };
      }

      // 📧 Customer email
      try {
        const custRes = await axios.post(`${process.env.BASE_URL}/api/sendEmail`, {
          to: email_address,
          subject: `Payment Successful for Invoice #${m_payment_id}`,
          data: {
            message: `<p>Your payment of R${amount_gross} was successful. Thank you!</p>`,
          },
        });
        customerEmailResult = custRes.data;
        console.log("📨 Customer email sent:", custRes.data);
      } catch (err) {
        console.error("❌ Customer email error:", err.message);
        customerEmailResult = { error: err.message };
      }

      // 📧 Internal email
      try {
        const intRes = await axios.post(`${process.env.BASE_URL}/api/sendEmail`, {
          to: "accounts@bevgo.co.za",
          subject: `Customer Payment Successful`,
          data: {
            message: `<p>Invoice #${m_payment_id} has been paid (Net: R${amount_net}).</p>`,
          },
        });
        internalEmailResult = intRes.data;
        console.log("📨 Internal email sent:", intRes.data);
      } catch (err) {
        console.error("❌ Internal email error:", err.message);
        internalEmailResult = { error: err.message };
      }
    }

    // ⚠️ Failed or Cancelled payments
    else if (payment_status === "FAILED" || payment_status === "CANCELLED") {
      console.log(`⚠️ Payment ${payment_status} for invoice ${m_payment_id}`);

      // 📧 Customer email
      try {
        const custRes = await axios.post(`${process.env.BASE_URL}/api/sendEmail`, {
          to: email_address,
          subject: `Payment ${payment_status} for Invoice #${m_payment_id}`,
          data: {
            message: `<p>Your payment for Invoice #${m_payment_id} was ${payment_status.toLowerCase()}.</p>`,
          },
        });
        customerEmailResult = custRes.data;
        console.log("📨 Customer email sent:", custRes.data);
      } catch (err) {
        console.error("❌ Customer email error:", err.message);
        customerEmailResult = { error: err.message };
      }

      // 📧 Internal email
      try {
        const intRes = await axios.post(`${process.env.BASE_URL}/api/sendEmail`, {
          to: "accounts@bevgo.co.za",
          subject: `Customer Payment ${payment_status}`,
          data: {
            message: `<p>Invoice #${m_payment_id} payment was ${payment_status.toLowerCase()}.</p>`,
          },
        });
        internalEmailResult = intRes.data;
        console.log("📨 Internal email sent:", intRes.data);
      } catch (err) {
        console.error("❌ Internal email error:", err.message);
        internalEmailResult = { error: err.message };
      }
    }

    // 📝 Return response including email + update results
    return NextResponse.json(
      {
        message: "Webhook processed",
        payment_status,
        invoice: m_payment_id,
        invoiceUpdateResult,
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
