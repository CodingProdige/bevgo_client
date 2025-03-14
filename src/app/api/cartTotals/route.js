import { db } from "@/lib/firebaseConfig"; // Firestore for users (users DB)
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

// ✅ Function to determine rebate percentage based on subtotal (excluding VAT & returnables)
function calculateRebate(subtotal) {
  if (subtotal > 10000) return 2.0; // 2% rebate
  if (subtotal > 5000) return 1.5;  // 1.5% rebate
  return 1.0; // Default 1% rebate
}

export async function POST(req) {
  try {
    const { userId } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    // ✅ Fetch user document
    const userDocRef = doc(db, "users", userId);
    const userDocSnap = await getDoc(userDocRef);

    if (!userDocSnap.exists()) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const cart = userDocSnap.data().cart || [];

    let subtotal = 0;
    let returnableSubtotal = 0;
    let totalItems = 0;
    let cartDetails = [];

    cart.forEach((item) => {
      const quantity = Number(item.in_cart) || 0;
      const pricePerUnit = parseFloat(item.price_incl) || 0;
      const returnablePrice = parseFloat(item.returnable_item_price_excl_vat) || 0;

      const totalPrice = pricePerUnit * quantity;
      subtotal += totalPrice;
      returnableSubtotal += returnablePrice * quantity;
      totalItems += quantity;

      // ✅ Include full product data
      cartDetails.push({
        ...item, // Spread full product data
        quantity: quantity, // Ensure proper quantity format
        total_price: parseFloat(totalPrice.toFixed(2)), // Ensure numerical format
        returnable_item_price: parseFloat(returnablePrice.toFixed(2)) // Ensure numerical format
      });
    });

    // ✅ Calculate VAT (15%)
    const vat = parseFloat((subtotal * 0.15).toFixed(2));

    // ✅ Calculate total order value
    const total = parseFloat((subtotal + returnableSubtotal + vat).toFixed(2));

    // ✅ Calculate rebate (ONLY on subtotal, excluding VAT & returnables)
    const rebatePercentage = calculateRebate(subtotal);
    const rebateAmount = parseFloat(((subtotal * rebatePercentage) / 100).toFixed(2));

    return NextResponse.json({
      subtotal: parseFloat(subtotal.toFixed(2)), // Excluding VAT & returnables
      returnableSubtotal: parseFloat(returnableSubtotal.toFixed(2)), // Returnables cost
      vat: vat, // 15% VAT
      total: total, // Final order total
      totalItems: totalItems, // Total number of items
      rebatePercentage: rebatePercentage, // ✅ Rebate percentage
      rebateAmount: rebateAmount, // ✅ Rebate amount
      cartDetails: cartDetails // Full cart breakdown
    }, { status: 200 });

  } catch (error) {
    console.error("Error calculating cart totals:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
