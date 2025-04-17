import { db } from "@/lib/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const usersRef = collection(db, "users");
    const snapshot = await getDocs(usersRef);

    const usersWithCarts = [];

    snapshot.forEach((docSnap) => {
      const userData = docSnap.data();
      const cart = userData.cart || [];

      if (cart.length > 0) {
        const totalItems = cart.reduce((sum, item) => sum + (parseInt(item.in_cart) || 0), 0);
        usersWithCarts.push({
            companyCode: userData.companyCode,
          id: docSnap.id,
          email: userData.email || "N/A",
          totalItems,
          cart,
        });
      }
    });

    return NextResponse.json(
      {
        message: "Users with cart items retrieved successfully",
        usersWithCarts,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Error fetching user carts:", error);
    return NextResponse.json(
      { error: "Failed to retrieve cart data", details: error.message },
      { status: 500 }
    );
  }
}
