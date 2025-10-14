import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, writeBatch } from "firebase/firestore";
import { NextResponse } from "next/server";

const PRODUCTS_API_URL = "https://pricing.bevgo.co.za/api/getProduct";

export async function POST(req) {
  try {
    const { userId, unique_code, action, quantity } = await req.json();

    if (!userId || !unique_code || !["add", "remove", "edit"].includes(action)) {
      return NextResponse.json({ error: "Missing or invalid parameters" }, { status: 400 });
    }

    if (action !== "remove" && (quantity === undefined || quantity < 0)) {
      return NextResponse.json({ error: "Invalid quantity parameter" }, { status: 400 });
    }

    const userDocRef = doc(db, "users", userId);
    const userDocSnap = await getDoc(userDocRef);
    let cart = userDocSnap.exists() ? userDocSnap.data().cart || [] : [];
    let updatedCart = [...cart];
    const batch = writeBatch(db);

    // 🔍 Find product in existing cart
    const productIndex = updatedCart.findIndex(item => item.unique_code === unique_code);

    if (action === "add") {
      if (productIndex !== -1) {
        // ✅ Add only the new quantity to existing one from DB
        updatedCart[productIndex].in_cart = Number(updatedCart[productIndex].in_cart || 0) + Number(quantity);
      } else {
        // 🆕 Fetch product data from catalog
        const response = await fetch(PRODUCTS_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unique_code }),
        });

        if (!response.ok) {
          return NextResponse.json({ error: "Product not found" }, { status: 404 });
        }

        const { product } = await response.json();
        product.in_cart = Number(quantity);
        updatedCart.push(product);
      }
    }

    else if (action === "edit") {
      if (productIndex !== -1) {
        // ✅ Replace quantity with exact number (not additive)
        updatedCart[productIndex].in_cart = Number(quantity);
      } else {
        // If editing something not in cart, treat it as add
        const response = await fetch(PRODUCTS_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unique_code }),
        });

        if (!response.ok) {
          return NextResponse.json({ error: "Product not found" }, { status: 404 });
        }

        const { product } = await response.json();
        product.in_cart = Number(quantity);
        updatedCart.push(product);
      }
    }

    else if (action === "remove") {
      if (productIndex !== -1) {
        updatedCart.splice(productIndex, 1);
      }
    }

    // 🧹 Cleanup: remove any zero-quantity items
    updatedCart = updatedCart.filter(item => item.in_cart > 0);

    batch.update(userDocRef, { cart: updatedCart });
    await batch.commit();

    const totalItems = updatedCart.reduce((acc, item) => acc + (Number(item.in_cart) || 0), 0);

    return NextResponse.json({ cart: updatedCart, totalItems }, { status: 200 });

  } catch (error) {
    console.error("❌ Error updating cart:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
