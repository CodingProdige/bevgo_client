import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode } = await req.json();

    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    // ✅ Query Firestore for orders with matching companyCode
    const ordersRef = collection(db, "orders");
    const ordersQuery = query(ordersRef, where("companyCode", "==", companyCode));
    const querySnapshot = await getDocs(ordersQuery);

    // ✅ Extract order data
    let statusCounts = {
      Pending: 0,
      Processing: 0,
      "Awaiting Payment": 0,
      Picking: 0,
      Packed: 0,
      "Out for Delivery": 0,
      Delivered: 0
    };

    const orders = querySnapshot.docs.map(doc => {
      const orderData = doc.data();
      if (statusCounts.hasOwnProperty(orderData.order_status)) {
        statusCounts[orderData.order_status]++;
      }

      return {
        orderId: doc.id,
        ...orderData,
      };
    });

    return NextResponse.json({ orders, statusCounts }, { status: 200 });

  } catch (error) {
    console.error("❌ Error fetching orders:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
