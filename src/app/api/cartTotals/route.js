import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const VAT_RATE = 0.15; // 15% VAT

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

    let subtotal = 0;
    let returnableSubtotal = 0;
    let totalItems = 0;

    const cartDetails = cart.map(item => {
      const pricePerUnit = Number(item.price_incl || 0);
      const quantity = Number(item.in_cart || 0);
      const totalPrice = pricePerUnit * quantity;
      const returnablePrice = item.returnable_item_price_excl_vat ? Number(item.returnable_item_price_excl_vat) * quantity : 0;

      subtotal += totalPrice;
      returnableSubtotal += returnablePrice;
      totalItems += quantity; // ✅ Correctly summing total items

      return {
        unique_code: item.unique_code,
        product_title: item.product_title,
        price_per_unit: pricePerUnit.toFixed(2),
        quantity,
        total_price: totalPrice.toFixed(2),
        returnable_item_code: item.returnable_item_code || null,
        returnable_item_price: returnablePrice.toFixed(2),
      };
    });

    const vat = subtotal * VAT_RATE;
    const total = subtotal + vat;

    return NextResponse.json({
      subtotal: subtotal.toFixed(2),
      returnableSubtotal: returnableSubtotal.toFixed(2),
      vat: vat.toFixed(2),
      total: total.toFixed(2),
      totalItems, // ✅ Corrected to sum properly
      cartDetails,
    }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
