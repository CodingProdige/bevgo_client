// app/api/createPayfastLink/route.js
import { NextResponse } from "next/server";
import axios from "axios";

export async function POST(req) {
  try {
    console.log("📥 Incoming request to /api/createPayfastLink");

    const { orderNumber, companyCode } = await req.json();
    if (!orderNumber) {
      console.error("❌ Missing orderNumber in request body");
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }
    console.log(`🔎 Fetching invoice for orderNumber=${orderNumber}, companyCode=${companyCode || "N/A"}`);

    // 1️⃣ Get invoice details
    const invoiceRes = await axios.post(
      `${process.env.BASE_URL}/api/getInvoice`,
      { orderNumber, companyCode: companyCode || "", isAdmin: true }
    );

    if (!invoiceRes.data?.invoices?.length) {
      console.error("❌ No invoice found for", orderNumber);
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const invoice = invoiceRes.data.invoices[0];
    console.log("📄 Invoice data retrieved:", {
      invoiceNumber: invoice.invoiceNumber,
      customer: invoice.customer?.name,
      finalTotal: invoice.finalTotals?.finalTotal,
    });

    const baseTotal = parseFloat(invoice.finalTotals.finalTotal);

    // 2️⃣ Calculate PayFast fees
    const PERCENTAGE = 0.0295;
    const FIXED_FEE = 0.50;
    const adjustedTotal = (baseTotal + FIXED_FEE) / (1 - PERCENTAGE);
    const paymentFee = adjustedTotal - baseTotal;

    console.log("💰 Calculated totals:", {
      baseTotal,
      adjustedTotal: adjustedTotal.toFixed(2),
      paymentFee: paymentFee.toFixed(2),
    });

    // 3️⃣ Build PayFast payload
    const paymentId = invoice.orderNumber || invoice.invoiceNumber;

    const payload = {
      merchant_id: process.env.PAYFAST_MERCHANT_ID,
      merchant_key: process.env.PAYFAST_MERCHANT_KEY,
      return_url: `https://client-portal.bevgo.co.za/paymentSuccess?orderNumber=${orderNumber}`,
      cancel_url: `https://client-portal.bevgo.co.za/paymentCancelled?orderNumber=${orderNumber}`,
      notify_url: `${process.env.BASE_URL}/api/payfastWebhook`,
      m_payment_id: paymentId,
      amount: adjustedTotal.toFixed(2),
      item_name: `Invoice #${paymentId}`,
      custom_str1: invoice.customer.companyCode,
      name_first: invoice.customer.name || "Customer",
      email_address: invoice.customer.email || "info@bevgo.co.za",
    };
    

    console.log("📦 PayFast payload prepared:", payload);

    // 4️⃣ Generate PayFast URL
    const queryString = new URLSearchParams(payload).toString();
    const paymentLink = `https://www.payfast.co.za/eng/process?${queryString}`;

    console.log("🔗 Generated PayFast link:", paymentLink);

    return NextResponse.json({
      message: "Payment link generated",
      invoiceTotal: baseTotal.toFixed(2),
      paymentFee: paymentFee.toFixed(2),
      adjustedTotal: adjustedTotal.toFixed(2),
      paymentLink,
    });
  } catch (error) {
    console.error("❌ PayFast link generation error:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });

    return NextResponse.json(
      {
        error: "Failed to generate payment link",
        details: error.response?.data || error.message,
        status: error.response?.status || 500,
      },
      { status: 500 }
    );
  }
}
