export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
} from "firebase/firestore";
import { NextResponse } from "next/server";

const CART_TOTALS_API_URL = "https://bevgo-client.vercel.app/api/cartTotals";
const UPDATE_STOCK_API_URL = "https://bevgo-pricelist.vercel.app/updateProductStock";
const USE_CREDIT_API_URL = "https://bevgo-client.vercel.app/api/accounting/payments/useCredit";

// 🔧 Helper: Send Slack alert
async function sendSlackAlert(message) {
  try {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    console.error("⚠️ Failed to send Slack alert:", err.message);
  }
}

async function generateUniqueOrderNumber() {
  let orderNumber;
  let exists = true;

  while (exists) {
    orderNumber = `${Math.floor(10000000 + Math.random() * 90000000)}`;
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);
    exists = orderSnap.exists();
  }
  return orderNumber;
}

function calculateRebate(subtotal) {
  if (subtotal > 15000) return 3.0;
  if (subtotal > 10000) return 2.0;
  if (subtotal > 5000) return 1.5;
  return 1.0;
}

export async function POST(req) {
  try {
    console.log("🔍 Incoming request to /api/finalizeOrder");

    const body = await req.json();
    const { 
      userId, 
      payment_terms, 
      companyCode, 
      useCredit = false,
      paymentIntent = "N/A",
      deliveryInstructions = "",
      deliveryAddress = "",
      deliveryPostalCode = "",
      deliveryFee = 0
    } = body;

    if (!userId?.trim() || !companyCode?.trim()) {
      return NextResponse.json({ error: "Missing userId or companyCode" }, { status: 400 });
    }

    // 🔎 Find user by companyCode
    let userSnap;
    const usersQuery = query(collection(db, "users"), where("companyCode", "==", companyCode));
    const userResults = await getDocs(usersQuery);
    if (!userResults.empty) {
      userSnap = userResults.docs[0];
    } else {
      const customersQuery = query(collection(db, "customers"), where("companyCode", "==", companyCode));
      const customerResults = await getDocs(customersQuery);
      if (!customerResults.empty) userSnap = customerResults.docs[0];
      else return NextResponse.json({ error: "User not found for provided companyCode" }, { status: 404 });
    }

    const userData = userSnap.data();
    const { email, companyName, emailOptOut } = userData;
    const finalPaymentTerms = payment_terms?.trim() || userData?.payment_terms || null;

    // 🔁 Fetch cart totals including deliveryFee and useCredit flag
    const response = await fetch(CART_TOTALS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, companyCode, useCredit, deliveryFee }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Failed to fetch cart totals:", response.status, errorText);
      return NextResponse.json({ error: "Failed to fetch cart totals" }, { status: 500 });
    }

    const cartData = await response.json();
    if (cartData.totalItems === 0) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    const rebatePercentage = calculateRebate(cartData.subtotal);
    const rebateAmount = (cartData.subtotal * rebatePercentage) / 100;
    const orderNumber = await generateUniqueOrderNumber();
    const prePaid = cartData.total <= 0;

    // 🧾 Store delivery fee and order data
    const orderDetails = {
      orderNumber,
      userId,
      companyCode,
      payment_terms: finalPaymentTerms ?? "0",
      order_status: "Pending",
      createdAt: new Date().toISOString(),
      pickingSlipPDF: null,
      invoicePDF: null,
      deliveryNotePDF: null,
      order_details: cartData,
      rebatePercentage,
      rebateAmount,
      deliveryFee: parseFloat(Number(deliveryFee).toFixed(2)),
      order_canceled: false,
      payment_status: "Pending",
      prePaid,
      paymentIntent,
      deliveryInstructions,
      deliveryAddress,
      deliveryPostalCode,
    };

    await setDoc(doc(db, "orders", orderNumber), orderDetails);

    // ⚡ Apply credit immediately if useCredit is true and credit available
    const appliedCredit = Number(cartData.appliedCredit || 0);
    if (useCredit && appliedCredit > 0) {
      console.log(`💳 Applying R${appliedCredit} credit to order ${orderNumber}`);

      try {
        const creditRes = await fetch(USE_CREDIT_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyCode,
            orderNumber,
            creditApplied: appliedCredit, // ✅ fixed to use actual applied credit
          }),
        });

        if (!creditRes.ok) {
          const errText = await creditRes.text();
          throw new Error(errText);
        }

        const creditResult = await creditRes.json();
        console.log("✅ Credit application result:", creditResult);
      } catch (err) {
        console.error("⚠️ Failed to apply credit:", err.message);
        await sendSlackAlert(`⚠️ Failed to apply credit for order #${orderNumber}: ${err.message}`);
      }
    } else {
      console.log("ℹ️ No credit applied (either useCredit=false or no available credit).");
    }

    // 🔧 Update product stock
    try {
      const stockUpdateRes = await fetch(UPDATE_STOCK_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: (cartData.cartDetails || []).map(item => ({
            unique_code: item.unique_code,
            quantity: item.quantity,
          })),
        }),
      });

      if (!stockUpdateRes.ok) {
        const errorText = await stockUpdateRes.text();
        await sendSlackAlert(
          `⚠️ Stock update failed for order #${orderNumber}\nStatus: ${stockUpdateRes.status}\nError: ${errorText}`
        );
      }
    } catch (err) {
      await sendSlackAlert(`⚠️ Stock update API call failed for order #${orderNumber}\nError: ${err.message}`);
    }

    // 🧹 Clear cart
    await updateDoc(doc(db, "users", userId), { cart: [] });

    return NextResponse.json({
      message: "Order finalized successfully",
      orderNumber,
      rebatePercentage,
      rebateAmount,
      deliveryFee: parseFloat(Number(deliveryFee).toFixed(2)),
      orderTotal: cartData.total ?? cartData.subtotal ?? 0,
      appliedCredit: appliedCredit,
      remainingCredit: cartData.remainingCredit,
      companyName,
      companyEmail: email,
      emailOptOut: emailOptOut ?? false,
      prePaid,
      paymentIntent,
      deliveryInstructions,
      deliveryAddress,
      deliveryPostalCode,
    }, { status: 201 });

  } catch (error) {
    console.error("❌ Unexpected error:", error.message);
    return NextResponse.json({ error: "Something went wrong", details: error.message }, { status: 500 });
  }
}
