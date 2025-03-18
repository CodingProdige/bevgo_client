import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { doc, updateDoc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { orderNumber, data } = await req.json();

    if (!orderNumber || !data || typeof data !== "object") {
      return NextResponse.json({ error: "Missing or invalid parameters" }, { status: 400 });
    }

    // ✅ Reference the Firestore document
    const orderRef = doc(db, "orders", orderNumber);

    // ✅ Check if the order exists before updating
    const orderSnap = await getDoc(orderRef);
    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // ✅ Update the order document with the provided data
    await updateDoc(orderRef, data);

    return NextResponse.json({ message: "Order updated successfully", updatedFields: data }, { status: 200 });

  } catch (error) {
    console.error("❌ Error updating order:", error);
    return NextResponse.json({ error: "Something went wrong", details: error.message }, { status: 500 });
  }
}
