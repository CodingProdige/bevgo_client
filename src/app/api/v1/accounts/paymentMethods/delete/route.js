export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  updateDoc
} from "firebase/firestore";
import { NextResponse } from "next/server";

/* ---------- helpers ---------- */
const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, data: p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

/* ---------- endpoint ---------- */
export async function POST(req) {
  try {
    const { userId, cardId } = await req.json();

    if (!userId || !cardId) {
      return err(
        400,
        "Missing Parameters",
        "userId and cardId are required."
      );
    }

    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      return err(404, "User Not Found", "Could not find user.");
    }

    const userData = snap.data();

    const cards =
      userData.paymentMethods?.cards ?? [];

    const rentalsSnap = await getDocs(collection(db, "rentals_v2"));
    const rentals = rentalsSnap.docs.map(d => d.data());
    const blockedStatuses = new Set(["active", "pending_card", "payment_failed"]);
    const hasActiveRental = rentals.some(r => {
      if (r?.customerId !== userId) return false;
      if (r?.billing?.cardId !== cardId) return false;
      const status = r?.billing?.status || "active";
      return blockedStatuses.has(status);
    });

    if (hasActiveRental) {
      return err(
        409,
        "Card In Use",
        "This card is linked to an active or outstanding rental and cannot be removed."
      );
    }

    const filteredCards = cards.filter(
      c => c.id !== cardId
    );

    if (filteredCards.length === cards.length) {
      return err(
        404,
        "Card Not Found",
        "No card found with that id."
      );
    }

    await updateDoc(userRef, {
      "paymentMethods.cards": filteredCards,
      "paymentMethods.updatedAt": new Date().toISOString()
    });

    return ok({
      message: "Payment method deleted.",
      remainingCards: filteredCards.length
    });

  } catch (error) {
    console.error("PAYMENT_METHOD_DELETE_ERROR:", error);
    return err(
      500,
      "Delete Failed",
      "Unable to delete payment method.",
      { error: error.message }
    );
  }
}
