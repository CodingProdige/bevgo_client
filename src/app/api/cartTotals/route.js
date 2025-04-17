import { db } from "@/lib/firebaseConfig"; // Firestore for users (users DB)
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

// ✅ Function to determine rebate percentage based on subtotal (excluding VAT & returnables)
function calculateRebate(subtotal) {
  if (subtotal > 20000) return 3.0; // 2% rebate
  if (subtotal > 15000) return 2.5; // 2% rebate
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

    let subtotalExclVAT = 0;
    let returnableSubtotal = 0;
    let totalItems = 0;
    let cartDetails = [];

    cart.forEach((item) => {
      const quantity = Number(item.in_cart) || 0;
      const priceExclVAT = parseFloat(item.price_excl) || 0;
      const returnablePrice = parseFloat(item.returnable_item_price_excl_vat) || 0;

      const totalPrice = priceExclVAT * quantity;
      subtotalExclVAT += totalPrice;
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

    // ✅ Calculate rebate (ONLY on subtotal excluding VAT & returnables)
    const rebatePercentage = calculateRebate(subtotalExclVAT);
    const rebateAmount = parseFloat(((subtotalExclVAT * rebatePercentage) / 100).toFixed(2));

    // ✅ Apply rebate to subtotal BEFORE adding returnables
    const subtotalAfterRebate = subtotalExclVAT - rebateAmount;

    // ✅ New subtotal including returnables (before VAT)
    const subtotalIncludingReturnables = subtotalAfterRebate + returnableSubtotal;

    // ✅ Calculate VAT (15%) on **subtotal INCLUDING returnables but AFTER rebate**
    const vat = parseFloat((subtotalIncludingReturnables * 0.15).toFixed(2));

    // ✅ Calculate final total including returnables and VAT
    const total = parseFloat((subtotalIncludingReturnables + vat).toFixed(2));

    return NextResponse.json({
      subtotal: parseFloat(subtotalExclVAT.toFixed(2)), // ✅ Original subtotal (before rebate)
      rebatePercentage: rebatePercentage, // ✅ Rebate percentage applied
      rebateAmount: rebateAmount, // ✅ Amount saved from rebate
      subtotalAfterRebate: parseFloat(subtotalAfterRebate.toFixed(2)), // ✅ Subtotal AFTER rebate
      subtotalIncludingReturnables: parseFloat(subtotalIncludingReturnables.toFixed(2)), // ✅ New subtotal before VAT
      returnableSubtotal: parseFloat(returnableSubtotal.toFixed(2)), // ✅ Returnables cost
      vat: vat, // ✅ VAT applied after rebate & returnables
      total: total, // ✅ Final total after rebate, returnables & VAT
      totalItems: totalItems, // ✅ Total number of items in cart
      cartDetails: cartDetails // ✅ Full cart breakdown
    }, { status: 200 });

  } catch (error) {
    console.error("Error calculating cart totals:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
