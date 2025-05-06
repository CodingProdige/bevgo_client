import { db } from "@/lib/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

// 🧮 Brand-specific profit margins
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

// 🗓️ Compute date range
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

// 🚀 Main handler
export async function POST(req) {
  try {
    const body = await req.json();
    const { range, companyCode } = body;
    const startDate = getStartDate(range);
    const endDate = new Date();

    const invoicesRef = collection(db, "invoices");
    const snapshot = await getDocs(invoicesRef);

    const filteredDocs = snapshot.docs.filter((doc) => {
      const data = doc.data();
      const invoiceDate = new Date(data.invoiceDate);
      return invoiceDate >= startDate && invoiceDate <= endDate;
    });

    console.log("Invoices found in range:", filteredDocs.length);

    const customerProfits = {};
    let totalProfitAllCustomers = 0;

    filteredDocs.forEach((doc) => {
      const invoice = doc.data();

      if (!invoice.customer || !invoice.orderDetails || !Array.isArray(invoice.orderDetails.cartDetails)) {
        return;
      }

      // Filter by companyCode if provided
      if (companyCode && invoice.customer.companyCode !== companyCode) {
        return;
      }

      const customerCode = invoice.customer.companyCode;
      const customerName = invoice.customer.name;
      const cart = invoice.orderDetails.cartDetails;
      let profit = 0;

      cart.forEach((item) => {
        const brand = item.product_brand || "Unknown";
        const margin = BRAND_MARGIN_MAP[brand] !== undefined ? BRAND_MARGIN_MAP[brand] : 0.10;
        const cost = item.price_excl * (1 - margin);
        const revenue = item.price_excl;
        profit += (revenue - cost) * item.quantity;
      });

      totalProfitAllCustomers += profit;

      if (!customerProfits[customerCode]) {
        customerProfits[customerCode] = {
          customerName,
          totalProfit: 0,
          totalOrders: 0
        };
      }

      customerProfits[customerCode].totalProfit += profit;
      customerProfits[customerCode].totalOrders += 1;
    });

    return NextResponse.json({
      data: customerProfits,
      totalProfitAllCustomers: parseFloat(totalProfitAllCustomers.toFixed(2))
    });
  } catch (error) {
    console.error("Error in getProfitReport:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
