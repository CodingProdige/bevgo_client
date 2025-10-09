// app/api/cartTotals/route.js
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";
import axios from "axios";

function calculateRebate(subtotal) {
  if (subtotal > 20000) return 3.0;
  if (subtotal > 15000) return 2.5;
  if (subtotal > 10000) return 2.0;
  if (subtotal > 5000) return 1.5;
  return 1.0;
}

export async function POST(req) {
  try {
    const {
      companyCode,
      userId,
      creditApplied = 0,
      useCredit = false,
      deliveryFee = 0   // ✅ New parameter
    } = await req.json();

    if (!companyCode && !userId) {
      return NextResponse.json({ error: "Missing companyCode or userId" }, { status: 400 });
    }

    let userSnap;

    // 🔎 Step 1: Prefer direct userId lookup
    if (userId) {
      const userDocRef = doc(db, "users", userId);
      const userDocSnap = await getDoc(userDocRef);
      if (userDocSnap.exists()) {
        userSnap = userDocSnap;
      }
    }

    // 🔎 Step 2: Fallback to companyCode lookup
    if (!userSnap && companyCode) {
      const usersQuery = query(collection(db, "users"), where("companyCode", "==", companyCode));
      const userResults = await getDocs(usersQuery);

      if (!userResults.empty) {
        userSnap = userResults.docs[0];
      } else {
        const customersQuery = query(collection(db, "customers"), where("companyCode", "==", companyCode));
        const customerResults = await getDocs(customersQuery);

        if (!customerResults.empty) {
          userSnap = customerResults.docs[0];
        }
      }
    }

    if (!userSnap) {
      return NextResponse.json({ error: "No user or customer found" }, { status: 404 });
    }

    const userData = userSnap.data();
    const cart = userData.cart || [];

    let subtotalExclVAT = 0;
    let returnableSubtotal = 0;
    let totalItems = 0;
    let cartDetails = [];

    cart.forEach((item) => {
      const quantity = Number(item.in_cart) || 0;
      const priceExclVAT = item.on_sale && item.sale_price
        ? parseFloat(item.sale_price)
        : parseFloat(item.price_excl) || 0;

      const returnablePrice =
        item.assigned_returnable?.price_excl
          ? parseFloat(item.assigned_returnable.price_excl)
          : 0;

      const totalPrice = priceExclVAT * quantity;

      subtotalExclVAT += totalPrice;
      returnableSubtotal += returnablePrice * quantity;
      totalItems += quantity;

      cartDetails.push({
        ...item,
        quantity,
        total_price: parseFloat(totalPrice.toFixed(2)),
        returnable_item_price: parseFloat(returnablePrice.toFixed(2)),
      });
    });

    const rebatePercentage = calculateRebate(subtotalExclVAT);
    const rebateAmount = parseFloat(((subtotalExclVAT * rebatePercentage) / 100).toFixed(2));
    const subtotalAfterRebate = subtotalExclVAT - rebateAmount;
    const subtotalIncludingReturnables = subtotalAfterRebate + returnableSubtotal;
    const vat = parseFloat((subtotalIncludingReturnables * 0.15).toFixed(2));

    // ✅ Include delivery fee before total
    const grossTotal = parseFloat((subtotalIncludingReturnables + vat + Number(deliveryFee)).toFixed(2));

    // 🔹 Handle credit logic
    let appliedCredit = 0;
    let remainingCredit = 0;

    if (useCredit && companyCode) {
      try {
        const creditRes = await axios.get(
          `${process.env.BASE_URL}/api/accounting/payments/capturePayment`,
          { params: { companyCode } }
        );

        const availableCredit = creditRes.data?.creditSummary?.availableCredit || 0;
        appliedCredit = Math.min(availableCredit, grossTotal);
        remainingCredit = availableCredit - appliedCredit;
      } catch (err) {
        console.error("⚠️ Failed to fetch credit summary:", err.message);
      }
    } else {
      appliedCredit = Math.min(Number(creditApplied) || 0, grossTotal);
      remainingCredit = (Number(creditApplied) || 0) - appliedCredit;
    }

    const orderTotalAfterCredit = parseFloat((grossTotal - appliedCredit).toFixed(2));

    return NextResponse.json({
      subtotal: parseFloat(subtotalExclVAT.toFixed(2)),
      rebatePercentage,
      rebateAmount,
      subtotalAfterRebate: parseFloat(subtotalAfterRebate.toFixed(2)),
      subtotalIncludingReturnables: parseFloat(subtotalIncludingReturnables.toFixed(2)),
      returnableSubtotal: parseFloat(returnableSubtotal.toFixed(2)),
      vat,
      deliveryFee: parseFloat(Number(deliveryFee).toFixed(2)), // ✅ Added for transparency
      grossTotal,
      total: orderTotalAfterCredit,
      appliedCredit,
      remainingCredit: remainingCredit > 0 ? parseFloat(remainingCredit.toFixed(2)) : 0,
      totalItems,
      cartDetails
    }, { status: 200 });

  } catch (error) {
    console.error("Error calculating cart totals:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
