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

    let totalRebateAmount = 0;
    let totalOrders = 0;
    let totalOrdersPaymentPending = 0;
    let totalOrderValue = 0;
    let totalOrdersCanceled = 0;

    let productCounts = {}; // Track most ordered products

    querySnapshot.docs.forEach((doc) => {
      const orderData = doc.data();
      totalOrders++;

      // ✅ Total rebate amount
      if (orderData.rebateAmount) {
        totalRebateAmount += orderData.rebateAmount;
      }

      // ✅ Check if payment status is "Payment Pending"
      if (orderData.payment_status === "Payment Pending") {
        totalOrdersPaymentPending++;
      }

      // ✅ Total of all order totals
      if (orderData.order_details?.total) {
        totalOrderValue += orderData.order_details.total;
      }

      // ✅ Check if the order was canceled
      if (orderData.order_canceled === true) {
        totalOrdersCanceled++;
      }

      // ✅ Count total quantity of each product
      if (orderData.order_details?.cartDetails) {
        orderData.order_details.cartDetails.forEach((product) => {
          const productKey = `${product.unique_code}-${product.product_title}`;
          if (!productCounts[productKey]) {
            productCounts[productKey] = {
              unique_code: product.unique_code,
              product_title: product.product_title,
              total_quantity: 0,
            };
          }
          productCounts[productKey].total_quantity += parseInt(product.quantity) || 0;
        });
      }
    });

    // ✅ Sort and get top 20 most ordered products
    const topProducts = Object.values(productCounts)
      .sort((a, b) => b.total_quantity - a.total_quantity)
      .slice(0, 20);

    return NextResponse.json({
      totalRebateAmount: parseFloat(totalRebateAmount.toFixed(2)), // ✅ Total rebate amount
      totalOrders, // ✅ Total number of orders
      totalOrdersPaymentPending, // ✅ Total orders with payment status "Payment Pending"
      totalOrderValue: parseFloat(totalOrderValue.toFixed(2)), // ✅ Total of all order totals
      topOrderedProducts: topProducts, // ✅ Top 20 most ordered products
      totalOrdersCanceled, // ✅ Total orders where order_canceled is true
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Error fetching order statistics:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
