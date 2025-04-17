import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const body = await req.json();
    const companyCode = body?.companyCode || null;
    const isAdmin = body?.isAdmin || false;

    console.log("🔎 Params => companyCode:", companyCode, "| isAdmin:", isAdmin);

    const ordersRef = collection(db, "orders");
    let ordersQuery;

    if (isAdmin === true) {
      ordersQuery = query(ordersRef);
      console.log("🔐 Admin access: fetching all orders.");
    } else if (companyCode) {
      ordersQuery = query(ordersRef, where("companyCode", "==", companyCode));
      console.log(`📦 Fetching orders for companyCode: ${companyCode}`);
    } else {
      console.log("⚠️ No companyCode or isAdmin provided — returning empty result.");
      return NextResponse.json(
        { message: "No parameters provided, returning empty result.", orders: [] },
        { status: 200 }
      );
    }

    const querySnapshot = await getDocs(ordersQuery);

    if (querySnapshot.empty) {
      console.log("⚠️ No orders found!");
    }

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
