import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { collection, doc, setDoc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

// API URL for fetching cart totals (POST request)
const CART_TOTALS_API_URL = "https://bevgo-client.vercel.app/api/cartTotals";

// Generate a unique order number
async function generateUniqueOrderNumber() {
  let orderNumber;
  let exists = true;

  while (exists) {
    orderNumber = `BG-${Math.floor(100000 + Math.random() * 900000)}`; // e.g., BG-123456
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      exists = false; // Ensures uniqueness
    }
  }

  return orderNumber;
}

export async function POST(req) {
  try {
    const { userId, payment_terms } = await req.json();

    if (!userId || !payment_terms) {
      return NextResponse.json({ error: "Missing userId or payment_terms" }, { status: 400 });
    }

    // ✅ Fetch user details to get companyCode
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { companyCode } = userSnap.data();
    if (!companyCode) {
      return NextResponse.json({ error: "Company code not found" }, { status: 400 });
    }

    // ✅ Fetch cart totals using POST request with userId in body
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

    // ✅ Generate a unique order number
    const orderNumber = await generateUniqueOrderNumber();

    // ✅ Order data to save
    const orderDetails = {
      orderNumber,
      userId,
      companyCode,
      payment_terms,
      order_status: "Pending", // Default status
      createdAt: new Date().toISOString(),
      pickingSlipPDF: null, // Placeholder for PDF URL
      invoicePDF: null, // Placeholder for invoice PDF URL
      deliveryNotePDF: null, // Placeholder for delivery note PDF URL
      order_details: cartData, // Capturing full cart details
    };

    // ✅ Save the order in Firestore
    const orderRef = doc(db, "orders", orderNumber);
    await setDoc(orderRef, orderDetails);

    // ✅ Clear user's cart
    await updateDoc(userRef, { cart: [] });

    return NextResponse.json({ message: "Order finalized successfully", orderNumber }, { status: 201 });

  } catch (error) {
    console.error("❌ Error finalizing order:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
