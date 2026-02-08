export const runtime = "nodejs";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";
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
      product: rawProduct
    } = body || {};

    const uid = isEmpty(rawUid) ? rawUserId : rawUid;
    const uniqueId =
      rawUniqueId ||
      rawUniqueIdAlt ||
      rawProductUniqueId ||
      rawProduct?.unique_id ||
      rawProduct?.uniqueId ||
      null;

    if (!uid || !uniqueId) {
      return err(
        400,
        "Missing Fields",
        "uid and unique_id are required."
      );
    }

    const userRef = doc(db, "users", uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      return ok({ isFavorite: false });
    }

    const favorites = userSnap.data()?.preferences?.favoriteProducts || [];
    const normalizedFavorites = favorites.map(normalizeFavorite).filter(Boolean);
    const isFavorite = normalizedFavorites.includes(uniqueId);

    return ok({ isFavorite });
  } catch (e) {
    return err(500, "Favorites Check Failed", e?.message || "Unexpected error.");
  }
}
