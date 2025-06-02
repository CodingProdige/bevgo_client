import { db } from "@/lib/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

const BRAND_MARGIN_MAP = {
  "Favorites": 0.06,
  "Appletiser": 0.06,
  "Bonaqua": 0.06,
  "Burn": 0.06,
  "Cappy": 0.06,
  "Coca-Cola": 0.06,
  "Fanta": 0.06,
  "Grapetiser": 0.06,
  "La Vie De Luc": 0.10,
  "Monster Energy": 0.06,
  "Powerade": 0.06,
  "Powerplay": 0.06,
  "Predator": 0.06,
  "Sanpellegrino": 0.06,
  "Schweppes": 0.06,
  "Spar-Letta": 0.06,
  "Sprite": 0.06,
  "Stoney": 0.06,
  "Twist": 0.06,
  "Valpre": 0.06
};

function getStartDate(range) {
  const now = new Date();
  const start = new Date(now);
  switch (range) {
    case "Month To Date":
      start.setDate(1);
      break;
    case "Three Months":
      start.setMonth(now.getMonth() - 3);
      break;
    case "Six Months":
      start.setMonth(now.getMonth() - 6);
      break;
    case "Nine Months":
      start.setMonth(now.getMonth() - 9);
      break;
    case "Year To Date":
      start.setMonth(0);
      start.setDate(1);
      break;
    case "Since Inception":
      return new Date("2000-01-01");
    default:
      throw new Error("Invalid range");
  }
  return start;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { range, companyCode, goalMRR } = body;
    const startDate = getStartDate(range);
    const endDate = new Date();

    console.log("🟡 Requested Range:", range);
    console.log("🟡 Start:", startDate, "End:", endDate);
    console.log("🟡 Filter Company Code:", companyCode);

    const snapshot = await getDocs(collection(db, "invoices"));
    console.log("🟢 Total invoices fetched:", snapshot.docs.length);

    const customerProfits = {};
    const brandBreakdown = {};
    let totalProfitAllCustomers = 0;
    let totalRebateAllCustomers = 0;
    let totalRevenue = 0;
    let totalOrders = 0;
    let customerCount = 0;

    snapshot.docs.forEach((doc) => {
      const invoice = doc.data();

      const invoiceDate = new Date(invoice.invoiceDate);
      if (isNaN(invoiceDate)) {
        console.warn("⚠️ Skipped invoice with invalid date:", invoice.invoiceDate);
        return;
      }

      if (invoiceDate < startDate || invoiceDate > endDate) {
        return; // not in range
      }

      const finalTotals = invoice.finalTotals;
      if (!finalTotals || !finalTotals.subtotalAfterRebate) {
        console.warn("⚠️ Skipped: missing finalTotals.subtotalAfterRebate");
        return;
      }

      const subtotalAfterRebate = parseFloat(finalTotals.subtotalAfterRebate);
      if (isNaN(subtotalAfterRebate) || subtotalAfterRebate <= 0) {
        console.warn("⚠️ Skipped: subtotalAfterRebate is invalid:", finalTotals.subtotalAfterRebate);
        return;
      }

      const { customer, orderDetails } = invoice;
      if (!customer || !orderDetails || !Array.isArray(orderDetails.cartDetails)) {
        console.warn("⚠️ Skipped: missing customer or cartDetails");
        return;
      }

      const normalizedInvoiceCode = (customer.companyCode || "").trim().toLowerCase();
      const normalizedFilterCode = (companyCode || "").trim().toLowerCase();

      if (companyCode && normalizedInvoiceCode !== normalizedFilterCode) {
        return;
      }

      const customerCode = customer.companyCode;
      const customerName = customer.name;
      const cart = orderDetails.cartDetails;
      const rebateAmount = parseFloat(finalTotals.rebateAmount || "0");

      totalRebateAllCustomers += rebateAmount;
      totalRevenue += subtotalAfterRebate;
      totalOrders++;
      let totalInvoiceProfit = 0;

      cart.forEach((item) => {
        const brand = item.product_brand || "Unknown";
        const margin = BRAND_MARGIN_MAP[brand] !== undefined ? BRAND_MARGIN_MAP[brand] : 0.10;

        const itemRevenue = item.price_excl * item.quantity;
        const itemShareOfSubtotal = subtotalAfterRebate > 0 ? itemRevenue / subtotalAfterRebate : 0;
        const itemRebate = rebateAmount * itemShareOfSubtotal;
        const adjustedRevenue = itemRevenue - itemRebate;
        const cost = item.price_excl * (1 - margin) * item.quantity;
        const itemProfit = adjustedRevenue - cost;

        totalInvoiceProfit += itemProfit;

        if (!brandBreakdown[brand]) {
          brandBreakdown[brand] = { totalProfit: 0, totalQuantity: 0 };
        }
        brandBreakdown[brand].totalProfit += itemProfit;
        brandBreakdown[brand].totalQuantity += item.quantity;
      });

      totalProfitAllCustomers += totalInvoiceProfit;

      if (!customerProfits[customerCode]) {
        customerProfits[customerCode] = {
          customerName,
          totalProfit: 0,
          totalOrders: 0,
          totalSpend: 0
        };
        customerCount++;
      }

      customerProfits[customerCode].totalProfit += totalInvoiceProfit;
      customerProfits[customerCode].totalOrders += 1;
      customerProfits[customerCode].totalSpend += subtotalAfterRebate;
    });

    const averageSpendPerCustomer = customerCount > 0 ? totalRevenue / customerCount : 0;
    const averageOrderTotal = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const clientsNeededForGoal = goalMRR ? Math.ceil(goalMRR / averageSpendPerCustomer) : null;

    const sortedCustomerProfits = Object.fromEntries(
      Object.entries(customerProfits).sort(([, a], [, b]) => b.totalProfit - a.totalProfit)
    );

    console.log("✅ Final Customer Count:", customerCount);
    console.log("✅ Final Total Orders:", totalOrders);
    console.log("✅ Final Profit:", totalProfitAllCustomers);

    return NextResponse.json({
      data: sortedCustomerProfits,
      brandBreakdown,
      totalProfitAllCustomers: parseFloat(totalProfitAllCustomers.toFixed(2)),
      totalRebateAllCustomers: parseFloat(totalRebateAllCustomers.toFixed(2)),
      averageSpendPerCustomer: parseFloat(averageSpendPerCustomer.toFixed(2)),
      averageOrderTotal: parseFloat(averageOrderTotal.toFixed(2)),
      clientsNeededForGoalMRR: clientsNeededForGoal
    });
  } catch (error) {
    console.error("❌ Error in getProfitReport:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
