import { db } from "@/lib/firebase"; // Firestore for users (customers DB)
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const PRODUCTS_API_URL = "https://your-products-api.com/api/products/getProduct"; // Replace with actual URL

export async function POST(req) {
  try {
    const { userId, unique_code, action } = await req.json();

    if (!userId || !unique_code || !["add", "remove"].includes(action)) {
      return NextResponse.json({ error: "Missing or invalid parameters" }, { status: 400 });
    }

    // Reference to the user's Firestore document
    const userDocRef = doc(db, "customers", userId);
    const userDocSnap = await getDoc(userDocRef);

    let cart = userDocSnap.exists() ? userDocSnap.data().cart || [] : [];

    // Check if the product already exists in the cart
    let productIndex = cart.findIndex(item => item.unique_code === unique_code);
    let updatedCart = [...cart];

    if (action === "add") {
      if (productIndex !== -1) {
        // Product exists, increment count
        updatedCart[productIndex].in_cart += 1;
      } else {
        // Fetch product details from Project A's API
        const response = await fetch(PRODUCTS_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unique_code }),
        });

        if (!response.ok) {
          return NextResponse.json({ error: "Product not found" }, { status: 404 });
        }

        const { product } = await response.json();
        product.in_cart = 1; // Set initial cart count
        updatedCart.push(product);
      }
    } else if (action === "remove") {
      if (productIndex !== -1) {
        if (updatedCart[productIndex].in_cart > 1) {
          updatedCart[productIndex].in_cart -= 1;
        } else {
          // If count reaches 0, remove item from cart
          updatedCart.splice(productIndex, 1);
        }
      }
    }

    // Update Firestore document in Customers DB
    await updateDoc(userDocRef, { cart: updatedCart });

    // Calculate total cart items
    const totalItems = updatedCart.reduce((acc, item) => acc + item.in_cart, 0);

    return NextResponse.json({ cart: updatedCart, totalItems }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
