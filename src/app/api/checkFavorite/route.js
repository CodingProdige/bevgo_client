import { db } from "@/lib/firebaseConfig"; // Firestore for users (users DB)
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { userId, unique_code } = await req.json();

    if (!userId || !unique_code) {
      return NextResponse.json({ error: "Missing userId or unique_code" }, { status: 400 });
    }

    // Reference to the user's Firestore document
    const userDocRef = doc(db, "users", userId);
    const userDocSnap = await getDoc(userDocRef);

    if (!userDocSnap.exists()) {
      return NextResponse.json({ isFavorite: false }, { status: 200 }); // User doesn't exist, return false
    }

    const favorites = userDocSnap.data().favorites || [];

    // Check if the product exists in favorites
    const isFavorite = favorites.some(item => item.unique_code === unique_code);

    return NextResponse.json({ isFavorite }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
