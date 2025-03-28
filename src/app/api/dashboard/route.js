import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where, orderBy, startAt, endAt } from "firebase/firestore";
import { NextResponse } from "next/server";

// Helper function to calculate date range based on days
function getDateRange(days) {
  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.setDate(now.getDate() - days)).toISOString();
  return { from, to };
}

export async function POST(req) {
  try {
    const { companyCode, dateRange } = await req.json();

    // ✅ Check for valid date range
    let fromDate, toDate;
    const validRanges = [7, 30, 90];
    if (validRanges.includes(dateRange)) {
      const range = getDateRange(dateRange);
      fromDate = range.from;
      toDate = range.to;
    } else {
      // Default to last 7 days if range is not valid or not specified
      const defaultRange = getDateRange(7);
      fromDate = defaultRange.from;
      toDate = defaultRange.to;
    }

    console.log(`📌 Fetching dashboard data for companyCode: ${companyCode || "Admin View"} with date range: ${dateRange || "7"} days`);

    let result = {};

    // 📊 Admin View: Fetch global statistics
    const invoicesRef = collection(db, "invoices");
    let invoiceQuery;

    if (!companyCode) {
      // Admin view: Fetch all invoices
      invoiceQuery = query(invoicesRef, orderBy("invoiceDate"), startAt(fromDate), endAt(toDate));
    } else {
      // Customer-specific view: Fetch invoices for specific company
      invoiceQuery = query(
        invoicesRef,
        where("customer.companyCode", "==", companyCode),
        orderBy("invoiceDate"),
        startAt(fromDate),
        endAt(toDate)
      );
    }

    const invoiceSnapshot = await getDocs(invoiceQuery);

    let totalSales = 0;
    let outstandingPayments = 0;
    let recentOrders = [];
    let pendingInvoices = [];
    let topProducts = {};
    let totalOrders = 0;

    for (const doc of invoiceSnapshot.docs) {
      const data = doc.data();
      const amount = parseFloat(data.finalTotals.finalTotal);
      totalSales += amount;
      totalOrders += 1;

      if (data.payment_status !== "Paid") {
        outstandingPayments += amount;
        pendingInvoices.push({
          orderNumber: data.orderNumber,
          total: amount.toFixed(2),
          payment_status: data.payment_status,
        });
      }

      recentOrders.push({
        orderNumber: data.orderNumber,
        date: data.invoiceDate,
        total: amount.toFixed(2),
        payment_status: data.payment_status,
      });

      // ✅ Aggregate products from the cart details of each order
      for (const item of data.orderDetails.cartDetails) {
        const productId = item.unique_code || item.product_id || item.product_title;

        if (!topProducts[productId]) {
          topProducts[productId] = {
            product_id: productId,
            product_title: item.product_title,
            product_brand: item.product_brand,
            product_image: item.product_image,
            totalQuantity: 0,
            totalSold: 0,
            totalOrders: 0,
          };
        }

        // Accumulate quantities and total sales
        topProducts[productId].totalQuantity += item.quantity;
        topProducts[productId].totalSold += item.total_price;
        topProducts[productId].totalOrders += 1;
      }
    }

    // Sort topProducts by totalQuantity in descending order and get the top 20
    const sortedTopProducts = Object.values(topProducts)
      .sort((a, b) => b.totalQuantity - a.totalQuantity)
      .slice(0, 20);

    result = {
      totalSales: totalSales.toFixed(2),
      outstandingPayments: outstandingPayments.toFixed(2),
      totalOrders,
      recentOrders: recentOrders.slice(0, 10), // Limit to the most recent 10 orders
      pendingInvoices,
      topProducts: sortedTopProducts,
      averageOrderValue: (totalSales / totalOrders || 0).toFixed(2),
    };

    console.log("✅ Dashboard data generated successfully.");
    return NextResponse.json({ message: "Dashboard data retrieved successfully", result }, { status: 200 });

  } catch (error) {
    console.error("❌ Failed to retrieve dashboard data:", error.message);
    return NextResponse.json({ error: "Failed to retrieve dashboard data", details: error.message }, { status: 500 });
  }
}
