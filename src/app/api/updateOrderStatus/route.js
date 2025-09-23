import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { orderNumber } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "orderNumber is required" }, { status: 400 });
    }

    // Reference Firestore doc
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return NextResponse.json(
        { error: "No order found with this orderNumber" },
        { status: 404 }
      );
    }

    // Update status to "Dispatched"
    await updateDoc(orderRef, { order_status: "On the Way" });

    // Fetch updated order
    const updatedSnap = await getDoc(orderRef);
    const updatedOrder = { id: updatedSnap.id, ...updatedSnap.data() };

    return NextResponse.json(
      { message: "Order status updated to Dispatched", order: updatedOrder },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Error updating order:", error);
    return NextResponse.json({ error: "Failed to update order" }, { status: 500 });
  }
}
