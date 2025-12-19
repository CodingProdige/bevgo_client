export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { doc, updateDoc, arrayUnion } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const {
      userId,
      token,
      brand,
      last4,
      expiryMonth,
      expiryYear,
      peachTransactionId,
      merchantTransactionId
    } = await req.json();

    const card = {
      card_id: `card_${Date.now()}`,
      token,
      brand,
      last4,
      expiryMonth,
      expiryYear,
      peachTransactionId,
      merchantTransactionId,
      isActive: true,
      lastCharged: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await updateDoc(doc(db, "users", userId), {
      paymentMethods: arrayUnion(card),
    });

    return NextResponse.json({ ok: true, data: card });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: "Failed to save card", error: err },
      { status: 500 }
    );
  }
}
