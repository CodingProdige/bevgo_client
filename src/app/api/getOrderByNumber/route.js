import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { orderNumber } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    // ✅ Reference the specific order document by orderNumber
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    return NextResponse.json({ order: { orderId: orderSnap.id, ...orderSnap.data() } }, { status: 200 });

  } catch (error) {
    console.error("❌ Error fetching order:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
