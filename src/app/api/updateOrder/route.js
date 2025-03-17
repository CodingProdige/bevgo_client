import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { doc, updateDoc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { orderNumber, field, fieldData } = await req.json();

    // ✅ Validate required parameters
    if (!orderNumber || !field || fieldData === undefined) {
      return NextResponse.json({ error: "Missing orderNumber, field, or fieldData" }, { status: 400 });
    }

    // ✅ Reference the order document in Firestore
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    // ✅ Check if order exists
    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // ✅ Update the specified field
    await updateDoc(orderRef, {
      [field]: fieldData
    });

    return NextResponse.json({ message: `Order ${orderNumber} updated successfully`, updatedField: field, newValue: fieldData }, { status: 200 });

  } catch (error) {
    console.error("❌ Error updating order:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
