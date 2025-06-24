import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

function calculateRebate(subtotal) {
  if (subtotal > 20000) return 3.0;
  if (subtotal > 15000) return 2.5;
  if (subtotal > 10000) return 2.0;
  if (subtotal > 5000) return 1.5;
  return 1.0;
}

export async function POST(req) {
  try {
    const { userId } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

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
      const priceExclVAT = item.on_sale && item.sale_price
        ? parseFloat(item.sale_price)
        : parseFloat(item.price_excl) || 0;

      const returnablePrice = parseFloat(item.returnable_item_price_excl_vat) || 0;
      const totalPrice = priceExclVAT * quantity;

      subtotalExclVAT += totalPrice;
      returnableSubtotal += returnablePrice * quantity;
      totalItems += quantity;

      cartDetails.push({
        ...item,
        quantity: quantity,
        total_price: parseFloat(totalPrice.toFixed(2)),
        returnable_item_price: parseFloat(returnablePrice.toFixed(2)),
      });
    });

    const rebatePercentage = calculateRebate(subtotalExclVAT);
    const rebateAmount = parseFloat(((subtotalExclVAT * rebatePercentage) / 100).toFixed(2));
    const subtotalAfterRebate = subtotalExclVAT - rebateAmount;
    const subtotalIncludingReturnables = subtotalAfterRebate + returnableSubtotal;
    const vat = parseFloat((subtotalIncludingReturnables * 0.15).toFixed(2));
    const total = parseFloat((subtotalIncludingReturnables + vat).toFixed(2));

    return NextResponse.json({
      subtotal: parseFloat(subtotalExclVAT.toFixed(2)),
      rebatePercentage: rebatePercentage,
      rebateAmount: rebateAmount,
      subtotalAfterRebate: parseFloat(subtotalAfterRebate.toFixed(2)),
      subtotalIncludingReturnables: parseFloat(subtotalIncludingReturnables.toFixed(2)),
      returnableSubtotal: parseFloat(returnableSubtotal.toFixed(2)),
      vat: vat,
      total: total,
      totalItems: totalItems,
      cartDetails: cartDetails
    }, { status: 200 });

  } catch (error) {
    console.error("Error calculating cart totals:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
