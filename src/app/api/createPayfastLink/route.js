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
    console.log(
      `🔎 Generating PayFast link for orderNumber=${orderNumber}, companyCode=${companyCode || "N/A"}`
    );

    let baseTotal = null;
    let customer = null;

    // 1️⃣ Try get invoice
    let invoice = null;
    try {
      const invoiceRes = await axios.post(`${process.env.BASE_URL}/api/getInvoice`, {
        orderNumber,
        companyCode: companyCode || "",
        isAdmin: true,
      });

      if (invoiceRes.data?.invoices?.length) {
        invoice = invoiceRes.data.invoices[0];
        baseTotal = parseFloat(invoice.finalTotals.finalTotal);
        customer = {
          companyCode: invoice.customer.companyCode,
          companyName: invoice.customer.name,
          email: invoice.customer.email,
        };
        console.log("📄 Invoice found:", { orderNumber, baseTotal, customer });
      }
    } catch (err) {
      console.warn("⚠️ Invoice fetch failed:", err.message);
    }

    // 2️⃣ If no invoice, fallback to order
    if (!invoice) {
      try {
        const orderRes = await axios.get(`${process.env.BASE_URL}/api/getOrder`, {
          params: { orderNumber, isAdmin: true }
        });

        if (orderRes.data?.order) {
          const order = orderRes.data.order;
          baseTotal = parseFloat(
            order.calcFinalTotal?.finalTotal || order.order_details?.total
          );
          console.log("📦 Order found:", { orderNumber, baseTotal });

          // Fetch customer from companyCode
          const resolvedCode = order.companyCode || companyCode;
          if (resolvedCode) {
            try {
              const userRes = await axios.post(
                `https://bevgo-client.vercel.app/api/getUser`,
                { companyCode: resolvedCode }
              );

              if (userRes.status === 200 && userRes.data?.data) {
                customer = {
                  companyCode: resolvedCode,
                  companyName: userRes.data.data.companyName,
                  email: userRes.data.data.email,
                };
              }
            } catch (err) {
              console.error("❌ Customer fetch failed:", err.message);
            }
          }
        }
      } catch (err) {
        console.error("❌ Order fetch failed:", err.message);
      }
    }


    if (!baseTotal || !customer) {
      console.error("❌ Could not find invoice or order + customer details");
      return NextResponse.json(
        { error: "Invoice/Order not found or missing customer" },
        { status: 404 }
      );
    }

    // 3️⃣ Calculate PayFast fees
    const PERCENTAGE = 0.0295;
    const FIXED_FEE = 0.5;
    const adjustedTotal = (baseTotal + FIXED_FEE) / (1 - PERCENTAGE);
    const paymentFee = adjustedTotal - baseTotal;

    console.log("💰 Totals:", {
      baseTotal,
      adjustedTotal: adjustedTotal.toFixed(2),
      paymentFee: paymentFee.toFixed(2),
    });

    // 4️⃣ Build PayFast payload
    const paymentId = orderNumber;
    const payload = {
      merchant_id: process.env.PAYFAST_MERCHANT_ID,
      merchant_key: process.env.PAYFAST_MERCHANT_KEY,
      return_url: `https://client-portal.bevgo.co.za/paymentSuccess?orderNumber=${orderNumber}`,
      cancel_url: `https://client-portal.bevgo.co.za/paymentCancelled?orderNumber=${orderNumber}`,
      notify_url: `${process.env.BASE_URL}/api/payfastWebhook`,
      m_payment_id: paymentId,
      amount: adjustedTotal.toFixed(2),
      item_name: `Payment for #${paymentId}`,
      custom_str1: customer.companyCode, // companyCode
      custom_str2: baseTotal.toFixed(2), // true total excl. fees
      name_first: customer.companyName || "Customer",
      email_address: customer.email || "info@bevgo.co.za",
    };

    console.log("📦 PayFast payload prepared:", payload);

    // 5️⃣ Generate PayFast URL
    const queryString = new URLSearchParams(payload).toString();
    const paymentLink = `https://www.payfast.co.za/eng/process?${queryString}`;

    console.log("🔗 Generated PayFast link:", paymentLink);

    return NextResponse.json({
      message: "Payment link generated",
      invoiceOrOrderTotal: baseTotal.toFixed(2),
      paymentFee: paymentFee.toFixed(2),
      adjustedTotal: adjustedTotal.toFixed(2),
      paymentLink,
    });
  } catch (error) {
    console.error("❌ PayFast link generation error:", error.message);
    return NextResponse.json(
      { error: "Failed to generate payment link", details: error.message },
      { status: 500 }
    );
  }
}
