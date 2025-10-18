import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, writeBatch } from "firebase/firestore";
import { NextResponse } from "next/server";

const PRODUCTS_API_URL = "https://pricing.bevgo.co.za/api/getProduct";

function applyFreeItemFlag(item, freeItem) {
  if (freeItem === true) {
    item.freeItem = true;
    // Zero out pricing since it’s a freebie
    item.price_excl = 0;
    item.price_incl = 0;
    if (item.sale_price != null) item.sale_price = 0;
    if (item.price_per_unit_incl != null) item.price_per_unit_incl = 0;
  } else if (freeItem === false) {
    // If explicitly set to false, just store the flag; do NOT try to restore prices (we don't have originals)
    item.freeItem = false;
  }
  return item;
}

export async function POST(req) {
  try {
    const { userId, unique_code, action, quantity, freeItem } = await req.json();

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
        // ✅ Apply/record freeItem flag (and zero prices if true)
        updatedCart[productIndex] = applyFreeItemFlag(updatedCart[productIndex], freeItem);
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

        // ✅ Append freeItem flag & zero prices if applicable
        applyFreeItemFlag(product, freeItem);

        updatedCart.push(product);
      }
    }

    else if (action === "edit") {
      if (productIndex !== -1) {
        // ✅ Replace quantity with exact number (not additive)
        updatedCart[productIndex].in_cart = Number(quantity);
        // ✅ Apply/record freeItem flag (and zero prices if true)
        updatedCart[productIndex] = applyFreeItemFlag(updatedCart[productIndex], freeItem);
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

        // ✅ Append freeItem flag & zero prices if applicable
        applyFreeItemFlag(product, freeItem);

        updatedCart.push(product);
      }
    }

    else if (action === "remove") {
      if (productIndex !== -1) {
        // Remove by unique_code (freeItem flag isn’t needed here, but we accept it in payload for consistency)
        updatedCart.splice(productIndex, 1);
      }
    }

    // 🧹 Cleanup: remove any zero-quantity items
    updatedCart = updatedCart.filter(item => Number(item.in_cart) > 0);

    batch.update(userDocRef, { cart: updatedCart });
    await batch.commit();

    const totalItems = updatedCart.reduce((acc, item) => acc + (Number(item.in_cart) || 0), 0);

    return NextResponse.json({ cart: updatedCart, totalItems }, { status: 200 });

  } catch (error) {
    console.error("❌ Error updating cart:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
