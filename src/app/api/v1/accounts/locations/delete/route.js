export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc } from "firebase/firestore";

const ok = (p={}, s=200) => NextResponse.json({ ok:true, data:p }, { status:s });
const err = (s,t,m,x={}) => NextResponse.json({ ok:false, title:t, message:m, ...x }, { status:s });

const now = () => new Date().toISOString();

export async function POST(req) {
  try {
    const body = await req.json().catch(() => null);

    if (!body)
      return err(400, "Invalid JSON", "Missing body.");

    const { userId, locationId } = body;

    if (!userId || !locationId)
      return err(400, "Missing Fields", "userId and locationId required.");

    const ref = doc(db, "users", userId);
    const snap = await getDoc(ref);

    if (!snap.exists())
      return err(404, "User Not Found", `No user ${userId}`);

    const data = snap.data();
    const existing = Array.isArray(data.deliveryLocations) ? data.deliveryLocations : [];

    const updated = existing.filter(loc => loc.id !== locationId);

    if (updated.length === existing.length)
      return err(404, "Location Not Found", `Location ${locationId} not found.`);

    await updateDoc(ref, {
      deliveryLocations: updated,
      updatedAt: now(),
    });

    return ok({
      userId,
      deletedId: locationId,
      deliveryLocations: updated
    });

  } catch (e) {
    console.error("DELETE_LOCATION_ERROR:", e);
    return err(
      500,
      "Server Error",
      "Failed to delete location.",
      { details: e.message }
    );
  }
}
