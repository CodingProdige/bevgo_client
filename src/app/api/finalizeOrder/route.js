/**
 * ✅ Finalize Order Endpoint
 *
 * This endpoint:
 * - Receives a `userId` and `companyCode` from the client
 * - Fetches the matching user/customer document using the companyCode
 * - Fetches the user's cart totals from the cartTotals API
 * - Calculates applicable rebate based on subtotal
 * - Generates a unique 8-digit order number
 * - Creates a new order document in the "orders" collection
 * - Clears the cart for the user with the matching `userId`
 *
 * Expected payload:
 * {
 *   userId: string,
 *   companyCode: string,
 *   payment_terms?: string
 * }
 *
 * Returns:
 * - Order number, rebate info, order total, and customer details
 */


import path from "path";
import { promises as fs } from "fs";
import ejs from "ejs";
import { sendEmail } from "@/lib/emailService";
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

    let body;
    try {
      body = await req.json();
    } catch (err) {
      console.error("❌ Failed to parse JSON body:", await req.text());
      return NextResponse.json({ error: "Malformed JSON in request body" }, { status: 400 });
    }

    const { userId, payment_terms, companyCode } = body;

    console.log("✅ Parsed body:", { userId, companyCode, payment_terms });

    if (!userId?.trim()) {
      console.warn("⚠️ Missing userId");
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    if (!companyCode?.trim()) {
      console.warn("⚠️ Missing companyCode");
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    // Try find user by companyCode
    console.log("🔎 Searching for user by companyCode:", companyCode);
    let userSnap;
    const usersQuery = query(collection(db, "users"), where("companyCode", "==", companyCode));
    const userResults = await getDocs(usersQuery);

    if (!userResults.empty) {
      userSnap = userResults.docs[0];
      console.log("✅ Found user in 'users' collection");
    } else {
      const customersQuery = query(collection(db, "customers"), where("companyCode", "==", companyCode));
      const customerResults = await getDocs(customersQuery);

      if (!customerResults.empty) {
        userSnap = customerResults.docs[0];
        console.log("✅ Found user in 'customers' collection");
      } else {
        console.warn("❌ No user found for companyCode:", companyCode);
        return NextResponse.json({ error: "User not found for provided companyCode" }, { status: 404 });
      }
    }

    const userData = userSnap.data();
    const { email, companyName, emailOptOut } = userData;
    console.log("📦 Retrieved user data:", { companyName, email });

    let finalPaymentTerms = payment_terms?.trim() || userData?.payment_terms || null;
    console.log("📌 Final payment terms:", finalPaymentTerms);

    // Fetch cart totals
    console.log("🔁 Fetching cart totals from:", CART_TOTALS_API_URL);
    const response = await fetch(CART_TOTALS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Failed to fetch cart totals:", response.status, errorText);
      return NextResponse.json({ error: "Failed to fetch cart totals" }, { status: 500 });
    }

    const cartData = await response.json();
    console.log("🛒 Cart data received:", cartData);

    if (cartData.totalItems === 0) {
      console.warn("🚫 Cart is empty");
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    const rebatePercentage = calculateRebate(cartData.subtotal);
    const rebateAmount = (cartData.subtotal * rebatePercentage) / 100;
    console.log("💸 Rebate calculated:", { rebatePercentage, rebateAmount });

    const orderNumber = await generateUniqueOrderNumber();
    console.log("📦 Generated order number:", orderNumber);

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
      order_canceled: false,
      payment_status: "Pending"
    };

    await setDoc(doc(db, "orders", orderNumber), orderDetails);
    console.log("✅ Order saved to Firestore");

    const cartUserRef = doc(db, "users", userId);
    await updateDoc(cartUserRef, { cart: [] });
    console.log("🧹 Cleared user cart");

    return NextResponse.json({
      message: "Order finalized successfully",
      orderNumber,
      rebatePercentage,
      rebateAmount,
      orderTotal: cartData.total ?? cartData.subtotal ?? 0,
      companyName,
      companyEmail: email,
      emailOptOut: emailOptOut ?? false,
    }, { status: 201 });

  } catch (error) {
    console.error("❌ Unexpected error:", error.message);
    return NextResponse.json({ error: "Something went wrong", details: error.message }, { status: 500 });
  }
}
