import { db } from "@/lib/firebaseConfig"; // Firestore for users (users DB)
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const PRODUCTS_API_URL = "https://pricing.bevgo.co.za/api/getProduct"; // Replace with actual URL

export async function POST(req) {
  try {
    const { userId, unique_code, action } = await req.json();

    if (!userId || !unique_code || !["add", "remove"].includes(action)) {
      return NextResponse.json({ error: "Missing or invalid parameters" }, { status: 400 });
    }

    // Reference to the user's Firestore document
    const userDocRef = doc(db, "users", userId);
    const userDocSnap = await getDoc(userDocRef);

    let favorites = [];

    if (userDocSnap.exists()) {
      favorites = userDocSnap.data().favorites || [];
    } else {
      // 🔥 If the user does not exist, create an empty favorites array
      await setDoc(userDocRef, { favorites: [] });
    }

    // Check if the product is already in favorites
    let productExists = favorites.some(item => item.unique_code === unique_code);
    let updatedFavorites = [...favorites];

    if (action === "add") {
      if (!productExists) {
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
        updatedFavorites.push(product);
      }
    } else if (action === "remove") {
      if (productExists) {
        updatedFavorites = updatedFavorites.filter(item => item.unique_code !== unique_code);
      }
    }

    // 🔥 Use setDoc() instead of updateDoc() to create the document if it doesn’t exist
    await setDoc(userDocRef, { favorites: updatedFavorites }, { merge: true });

    return NextResponse.json({ favorites: updatedFavorites }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
