// app/api/updateCredit/route.js
import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs, updateDoc, doc, increment } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode, amount } = await req.json();

    if (!companyCode || amount === undefined) {
      return NextResponse.json(
        { error: "Missing required parameters: companyCode and amount" },
        { status: 400 }
      );
    }

    // 🔎 Find user by companyCode
    const usersRef = collection(db, "users");
    const q = query(usersRef, where("companyCode", "==", companyCode));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return NextResponse.json(
        { error: "No user found with that companyCode" },
        { status: 404 }
      );
    }

    const userDoc = snapshot.docs[0]; // assuming companyCode is unique
    const userRef = doc(db, "users", userDoc.id);

    // ✅ Adjust account_credit atomically
    await updateDoc(userRef, {
      account_credit: increment(amount),
    });

    return NextResponse.json(
      {
        message: `Account credit updated by ${amount}`,
        companyCode,
        direction: amount >= 0 ? "added" : "removed",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Failed to update account_credit:", error.message);
    return NextResponse.json(
      { error: "Failed to update account_credit", details: error.message },
      { status: 500 }
    );
  }
}
