import { db } from "@/lib/firebaseConfig"; // Firestore for users (users DB)
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { userId, unique_code } = await req.json();

    if (!userId || !unique_code) {
      return NextResponse.json({ error: "Missing userId or unique_code" }, { status: 400 });
    }

    // ✅ Fetch the user document directly by `userId` (Document ID)
    const userDocRef = doc(db, "users", userId);
    const userDocSnap = await getDoc(userDocRef);

    if (!userDocSnap.exists()) {
      return NextResponse.json({ in_cart: 0 }, { status: 200 }); // User not found, return 0
    }

    // ✅ Ensure cart exists, otherwise return 0
    const cart = userDocSnap.data().cart || [];

    // ✅ Check if the product exists in the cart
    const product = cart.find(item => item.unique_code === unique_code);

    return NextResponse.json({ in_cart: product ? product.in_cart : 0 }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
