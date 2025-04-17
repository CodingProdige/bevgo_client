import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, writeBatch } from "firebase/firestore";
import { NextResponse } from "next/server";

const PRODUCTS_API_URL = "https://pricing.bevgo.co.za/api/getProduct";
const RETURNABLES_API_URL = "https://pricing.bevgo.co.za/api/getReturnables";

const returnableMappings = {
  130: ["247", "683", "609", "485"],
  150: ["537", "117", "617", "687"],
  110: [],
  115: ["712", "965"],
  120: [],
};

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
    let productIndex = cart.findIndex(item => item.unique_code === unique_code);
    let updatedCart = [...cart];

    const batch = writeBatch(db);

    const returnablesResponse = await fetch(RETURNABLES_API_URL);
    const returnablesData = await returnablesResponse.json();

    if (action === "add" || action === "edit") {
      if (quantity === 0) {
        if (productIndex !== -1) updatedCart.splice(productIndex, 1);
      } else {
        if (productIndex !== -1) {
          if (action === "edit") {
            updatedCart[productIndex].in_cart = quantity;
          } else {
            updatedCart[productIndex].in_cart += quantity;
          }
        } else {
          const response = await fetch(PRODUCTS_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ unique_code }),
          });

          if (!response.ok) {
            return NextResponse.json({ error: "Product not found" }, { status: 404 });
          }

          const { product } = await response.json();
          product.in_cart = quantity;

          let returnableItem = null;
          for (const [returnableCode, productCodes] of Object.entries(returnableMappings)) {
            if (productCodes.includes(unique_code)) {
              for (const category in returnablesData) {
                const found = returnablesData[category].find(item => item.code === Number(returnableCode));
                if (found) {
                  returnableItem = {
                    returnable_item_code: found.code,
                    returnable_item_price_excl_vat: found.price,
                  };
                  break;
                }
              }
            }
          }

          if (returnableItem) {
            product.returnable_item_code = returnableItem.returnable_item_code;
            product.returnable_item_price_excl_vat = returnableItem.returnable_item_price_excl_vat;
          }

          updatedCart.push(product);
        }
      }
    } else if (action === "remove") {
      if (productIndex !== -1) {
        updatedCart.splice(productIndex, 1);
      }
    }

    // 🧹 Final cleanup: remove any products with in_cart === 0
    updatedCart = updatedCart.filter(item => item.in_cart > 0);

    batch.update(userDocRef, { cart: updatedCart });
    await batch.commit();

    const totalItems = updatedCart.reduce((acc, item) => acc + item.in_cart, 0);

    return NextResponse.json({ cart: updatedCart, totalItems }, { status: 200 });

  } catch (error) {
    console.error("❌ Error updating cart:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
