import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, writeBatch } from "firebase/firestore";
import { NextResponse } from "next/server";

const PRODUCTS_API_URL = "https://pricing.bevgo.co.za/api/getProduct";

/* ----------------------------- helpers ----------------------------- */

function normalizeFreeFlag(val) {
  // Only `true` is treated as free; anything else → false
  return val === true;
}

function applyFreeItemFlag(item, freeItem) {
  const isFree = normalizeFreeFlag(freeItem);
  item.freeItem = isFree;
  if (isFree) {
    // Zero out pricing since it’s a freebie
    item.price_excl = 0;
    item.price_incl = 0;
    if (item.sale_price != null) item.sale_price = 0;
    if (item.price_per_unit_incl != null) item.price_per_unit_incl = 0;
  }
  return item;
}

function findLineIndex(cart, unique_code, freeItem) {
  const isFree = normalizeFreeFlag(freeItem);
  return cart.findIndex(
    (item) =>
      item.unique_code === unique_code &&
      normalizeFreeFlag(item.freeItem) === isFree
  );
}

/* ------------------------------- route ------------------------------ */

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

    // Start with current cart
    let cart = userDocSnap.exists() ? userDocSnap.data().cart || [] : [];

    // 🔧 Normalize legacy items: ensure freeItem is a boolean
    cart = cart.map((i) => ({ ...i, freeItem: normalizeFreeFlag(i.freeItem) }));

    let updatedCart = [...cart];
    const batch = writeBatch(db);

    // 🔍 Find product line by composite identity (unique_code + free flag)
    const productIndex = findLineIndex(updatedCart, unique_code, freeItem);

    if (action === "add") {
      if (productIndex !== -1) {
        // ✅ Add only to this specific line (paid or free)
        updatedCart[productIndex].in_cart =
          Number(updatedCart[productIndex].in_cart || 0) + Number(quantity);

        // ✅ Keep its free/paid identity as sent
        updatedCart[productIndex] = applyFreeItemFlag(updatedCart[productIndex], freeItem);
      } else {
        // 🆕 Fetch catalog product and create a new line with the requested free/paid identity
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
        applyFreeItemFlag(product, freeItem); // sets freeItem + zero pricing if free

        updatedCart.push(product);
      }
    }

    else if (action === "edit") {
      if (productIndex !== -1) {
        // ✅ Replace quantity on THIS specific line (paid or free)
        updatedCart[productIndex].in_cart = Number(quantity);
        updatedCart[productIndex] = applyFreeItemFlag(updatedCart[productIndex], freeItem);
      } else {
        // If the exact (unique_code, free flag) line doesn't exist, treat as add for that identity
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
        applyFreeItemFlag(product, freeItem);

        updatedCart.push(product);
      }
    }

    else if (action === "remove") {
      // 🗑 Remove only the matching line (unique_code + free flag).
      // If client omits `freeItem`, normalizeFreeFlag(false) is used and will target the paid line only.
      const idx = findLineIndex(updatedCart, unique_code, freeItem);
      if (idx !== -1) updatedCart.splice(idx, 1);
    }

    // 🧹 Cleanup: remove any zero-quantity items (on a per-line basis)
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
