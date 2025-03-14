import { db } from "@/lib/firebaseConfig"; // Firestore for users (users DB)
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { userId } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    // Fetch user document
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

      // Include full product data
      cartDetails.push({
        ...item, // Spread full product data
        quantity: quantity, // Ensure proper quantity format
        total_price: parseFloat(totalPrice.toFixed(2)), // Ensure numerical format
        returnable_item_price: parseFloat(returnablePrice.toFixed(2)) // Ensure numerical format
      });
    });

    const vat = parseFloat((subtotal * 0.15).toFixed(2)); // VAT at 15%
    const total = parseFloat((subtotal + returnableSubtotal + vat).toFixed(2));

    return NextResponse.json({
      subtotal: parseFloat(subtotal.toFixed(2)),
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
