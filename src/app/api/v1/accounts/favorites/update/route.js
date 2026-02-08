export const runtime = "nodejs";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && Object.keys(value).length === 0) return true;
  return false;
}

function normalizeFavorite(item) {
  if (!item) return null;
  if (typeof item === "string") return item;
  if (typeof item === "object") {
    const uniqueId = item.unique_id || item.uniqueId || item.product_unique_id;
    return uniqueId || null;
  }
  return null;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      uid: rawUid,
      userId: rawUserId,
      unique_id: rawUniqueId,
      uniqueId: rawUniqueIdAlt,
      productUniqueId: rawProductUniqueId,
      product: rawProduct,
      action: rawAction
    } = body || {};

    const uid = isEmpty(rawUid) ? rawUserId : rawUid;
    const action = isEmpty(rawAction) ? null : rawAction;
    const uniqueId =
      rawUniqueId ||
      rawUniqueIdAlt ||
      rawProductUniqueId ||
      rawProduct?.unique_id ||
      rawProduct?.uniqueId ||
      null;

    if (!uid || !uniqueId || !["add", "remove"].includes(action)) {
      return err(
        400,
        "Missing or Invalid Fields",
        "uid, unique_id, and action(add/remove) are required."
      );
    }

    const userRef = doc(db, "users", uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      return err(404, "User Not Found", `No user found with uid: ${uid}`);
    }

    const existing = userSnap.data()?.preferences?.favoriteProducts || [];
    const normalizedExisting = existing.map(normalizeFavorite).filter(Boolean);

    const alreadyExists = normalizedExisting.includes(uniqueId);

    let updated = normalizedExisting;
    if (action === "add" && !alreadyExists) {
      updated = [...normalizedExisting, uniqueId];
    }
    if (action === "remove" && alreadyExists) {
      updated = normalizedExisting.filter(item => item !== uniqueId);
    }

    await updateDoc(userRef, {
      "preferences.favoriteProducts": updated
    });

    return ok({ favorites: updated });
  } catch (e) {
    return err(500, "Favorites Update Failed", e?.message || "Unexpected error.");
  }
}
