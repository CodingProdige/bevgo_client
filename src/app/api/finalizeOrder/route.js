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
    const { userId, payment_terms, companyCode: rawCompanyCode } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    const companyCode = rawCompanyCode?.trim();
    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    // ✅ Try find user by companyCode (in users or customers)
    let userSnap;
    const usersQuery = query(collection(db, "users"), where("companyCode", "==", companyCode));
    const userResults = await getDocs(usersQuery);

    if (!userResults.empty) {
      userSnap = userResults.docs[0];
    } else {
      const customersQuery = query(collection(db, "customers"), where("companyCode", "==", companyCode));
      const customerResults = await getDocs(customersQuery);

      if (!customerResults.empty) {
        userSnap = customerResults.docs[0];
      } else {
        return NextResponse.json({ error: "User not found for provided companyCode" }, { status: 404 });
      }
    }

    const userData = userSnap.data();
    const { email, companyName, emailOptOut } = userData;

    let finalPaymentTerms = payment_terms?.trim() || userData?.payment_terms;
    if (!finalPaymentTerms) {
      finalPaymentTerms = userData?.payment_terms || null;
    }

    // ✅ Fetch cart totals
    const response = await fetch(CART_TOTALS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Failed to fetch cart totals" }, { status: 500 });
    }

    const cartData = await response.json();

    if (cartData.totalItems === 0) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    const rebatePercentage = calculateRebate(cartData.subtotal);
    const rebateAmount = (cartData.subtotal * rebatePercentage) / 100;

    const orderNumber = await generateUniqueOrderNumber();

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
      payment_status: "Pending",
    };

    // ✅ Save order
    await setDoc(doc(db, "orders", orderNumber), orderDetails);

    // ✅ Clear the cart for the correct user ID (not just company match)
    const cartUserRef = doc(db, "users", userId);
    await updateDoc(cartUserRef, { cart: [] });

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
    console.error("❌ Error finalizing order:", error);
    return NextResponse.json({ error: "Something went wrong", details: error.message }, { status: 500 });
  }
}
