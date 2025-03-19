import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode } = await req.json();

    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    // ✅ Query Firestore for orders with matching companyCode, excluding canceled orders
    const ordersRef = collection(db, "orders");
    const ordersQuery = query(ordersRef, where("companyCode", "==", companyCode));
    const querySnapshot = await getDocs(ordersQuery);

    // ✅ Initialize statistics
    let totalRebateAmount = 0;
    let totalOrders = 0;
    let totalOrderValue = 0;
    let totalPaymentPendingOrders = 0;
    let productCounts = {};

    querySnapshot.forEach((doc) => {
      const order = doc.data();

      // ✅ Exclude canceled orders
      if (order.order_status === "Canceled") return;

      totalOrders++;
      totalRebateAmount += order.rebateAmount || 0;
      totalOrderValue += order.order_details?.total || 0;

      if (order.payment_status === "Payment Pending") {
        totalPaymentPendingOrders++;
      }

      // ✅ Count ordered products
      order.order_details?.cartDetails?.forEach((item) => {
        if (!productCounts[item.unique_code]) {
          productCounts[item.unique_code] = {
            product_title: item.product_title,
            total_quantity: 0,
            product_image: item.product_image, // ✅ Includes product image
          };
        }
        productCounts[item.unique_code].total_quantity += item.quantity;
      });
    });

    // ✅ Sort products by most ordered & get top 20
    const topOrderedProducts = Object.values(productCounts)
      .sort((a, b) => b.total_quantity - a.total_quantity)
      .slice(0, 20);

    return NextResponse.json({
      totalRebateAmount: parseFloat(totalRebateAmount.toFixed(2)),
      totalOrders, // ✅ Excludes canceled orders
      totalOrderValue: parseFloat(totalOrderValue.toFixed(2)),
      totalPaymentPendingOrders,
      topOrderedProducts, // ✅ Includes product titles, images, and total quantities
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Error fetching order statistics:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
