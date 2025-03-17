import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { doc, getDoc, setDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

// ✅ Function to generate an 8-digit unique order number
async function generateUniqueOrderNumber() {
  let orderNumber;
  let exists = true;

  while (exists) {
    orderNumber = `${Math.floor(10000000 + Math.random() * 90000000)}`; // e.g., BG-12345678
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

    // ✅ Fetch the existing order document
    const existingOrderRef = doc(db, "orders", orderNumber);
    const existingOrderSnap = await getDoc(existingOrderRef);

    if (!existingOrderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const existingOrderData = existingOrderSnap.data();

    // ✅ Generate a new unique order number
    const newOrderNumber = await generateUniqueOrderNumber();

    // ✅ Create a new order document with the duplicated data
    const newOrderData = {
      ...existingOrderData,
      orderNumber: newOrderNumber, // ✅ Assign a new unique order number
      createdAt: new Date().toISOString(), // ✅ Update the creation date
      order_status: "Pending", // ✅ Reset order status
      pickingSlipPDF: null,
      invoicePDF: null,
      deliveryNotePDF: null,
      order_canceled: false, // ✅ Reset order cancellation status
      payment_status: "Payment Pending",
    };

    // ✅ Save the duplicated order in Firestore
    const newOrderRef = doc(db, "orders", newOrderNumber);
    await setDoc(newOrderRef, newOrderData);

    return NextResponse.json({
      message: "Order duplicated successfully",
      newOrderNumber,
    }, { status: 201 });

  } catch (error) {
    console.error("❌ Error duplicating order:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
