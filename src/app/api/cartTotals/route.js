import { db } from "@/lib/firebaseConfig"; // Firestore for users (users DB)
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const VAT_RATE = 0.15; // South Africa VAT rate

export async function POST(req) {
  try {
    const { userId } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    // ✅ Fetch user's cart
    const userDocRef = doc(db, "users", userId);
    const userDocSnap = await getDoc(userDocRef);

    if (!userDocSnap.exists()) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const cart = userDocSnap.data().cart || [];

    // ✅ Initialize totals
    let subtotal = 0;
    let returnableSubtotal = 0;
    let vatAmount = 0;
    let total = 0;

    // ✅ Iterate over cart items to calculate totals
    const cartDetails = cart.map((item) => {
      const itemTotal = item.price_incl * item.in_cart; // Total per item
      subtotal += itemTotal;

      // ✅ If product has a returnable item, add its cost
      let returnableCost = 0;
      if (item.returnable_item_code) {
        returnableCost = item.returnable_item_price_excl_vat * item.in_cart;
        returnableSubtotal += returnableCost;
      }

      return {
        unique_code: item.unique_code,
        product_title: item.product_title,
        price_per_unit: item.price_incl.toFixed(2),
        quantity: item.in_cart,
        total_price: itemTotal.toFixed(2),
        returnable_item_code: item.returnable_item_code || null,
        returnable_item_price: returnableCost.toFixed(2),
      };
    });

    // ✅ Calculate VAT
    vatAmount = (subtotal + returnableSubtotal) * VAT_RATE;
    total = subtotal + returnableSubtotal + vatAmount;

    // ✅ Response object
    const cartSummary = {
      subtotal: subtotal.toFixed(2),
      returnableSubtotal: returnableSubtotal.toFixed(2),
      vat: vatAmount.toFixed(2),
      total: total.toFixed(2),
      totalItems: cart.reduce((acc, item) => acc + item.in_cart, 0),
      cartDetails,
    };

    return NextResponse.json(cartSummary, { status: 200 });

  } catch (error) {
    console.error("Error calculating cart total:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
