import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { doc, getDoc, setDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

// ✅ Function to generate a unique order number
async function generateUniqueOrderNumber(companyCode) {
  let orderNumber;
  let exists = true;

  while (exists) {
    orderNumber = `${companyCode}-${Math.floor(100000 + Math.random() * 900000)}`; // e.g., BEVGO9340-123456
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
    const { orderNumber } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    // ✅ Fetch the original order
    const originalOrderRef = doc(db, "orders", orderNumber);
    const originalOrderSnap = await getDoc(originalOrderRef);

    if (!originalOrderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const originalOrder = originalOrderSnap.data();

    // ✅ Generate a new unique order number
    const newOrderNumber = await generateUniqueOrderNumber(originalOrder.companyCode);

    // ✅ Duplicate the order with new order number
    const newOrderDetails = {
      ...originalOrder, // Copy everything
      orderId: newOrderNumber, // ✅ Assign new order ID
      orderNumber: newOrderNumber, // ✅ Assign new order number
      createdAt: new Date().toISOString(), // ✅ Update createdAt timestamp
      order_status: "Pending", // ✅ Reset order status to Pending
    };

    // ✅ Save the duplicated order in Firestore
    const newOrderRef = doc(db, "orders", newOrderNumber);
    await setDoc(newOrderRef, newOrderDetails);

    return NextResponse.json({
      message: "Order duplicated successfully",
      newOrderNumber,
    }, { status: 201 });

  } catch (error) {
    console.error("❌ Error duplicating order:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
