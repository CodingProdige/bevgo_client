import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const body = await req.json();
    const companyCode = body?.companyCode || null;

    console.log("🔎 Received companyCode:", companyCode);

    // ✅ Query Firestore for orders
    const ordersRef = collection(db, "orders");
    let ordersQuery = companyCode
      ? query(ordersRef, where("companyCode", "==", companyCode)) // Filter by companyCode
      : query(ordersRef); // Fetch all orders if no companyCode is provided

    console.log("📡 Fetching orders from Firestore...");
    const querySnapshot = await getDocs(ordersQuery);

    if (querySnapshot.empty) {
      console.log("⚠️ No orders found!");
    }

    // ✅ Extract order data
    const orders = querySnapshot.docs.map(doc => ({
      orderId: doc.id,
      ...doc.data(),
    }));

    console.log(`✅ Orders retrieved: ${orders.length}`);

    return NextResponse.json({ orders }, { status: 200 });

  } catch (error) {
    console.error("❌ Error fetching orders:", error);
    return NextResponse.json({ error: "Something went wrong", details: error.message }, { status: 500 });
  }
}
