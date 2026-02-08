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
    const { uid: rawUid, userId: rawUserId } = body || {};
    const uid = isEmpty(rawUid) ? rawUserId : rawUid;

    if (!uid) {
      return err(400, "Missing Fields", "uid is required.");
    }

    const userRef = doc(db, "users", uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      return ok({ favorites: [] });
    }

    const favorites = userSnap.data()?.preferences?.favoriteProducts || [];
    const normalizedFavorites = favorites.map(normalizeFavorite).filter(Boolean);

    return ok({ favorites: normalizedFavorites });
  } catch (e) {
    return err(500, "Favorites Fetch Failed", e?.message || "Unexpected error.");
  }
}
