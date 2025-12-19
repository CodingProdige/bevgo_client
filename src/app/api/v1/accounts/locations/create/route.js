export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc } from "firebase/firestore";

/* ---------------- Helpers ---------------- */
const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, data: p }, { status: s });

const err = (s, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status: s });

const now = () => new Date().toISOString();

/* ---------------- POST /add-delivery-location ---------------- */
export async function POST(req) {
  try {
    const body = await req.json().catch(() => null);

    if (!body)
      return err(400, "Invalid Request", "Missing JSON body.");

    const { userId, location } = body;

    if (!userId)
      return err(400, "Missing userId", "A valid userId is required.");

    if (!location || typeof location !== "object")
      return err(400, "Missing Location", "A delivery location object is required.");

    if (!location.locationName || !location.streetAddress)
      return err(
        400,
        "Invalid Location",
        "locationName and streetAddress are required."
      );

    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);

    if (!snap.exists())
      return err(404, "User Not Found", `User ${userId} does not exist.`);

    const userData = snap.data();
    const existing = Array.isArray(userData.deliveryLocations)
      ? userData.deliveryLocations
      : [];

    // Normalize default flag
    const newIsDefault = location.is_default === true;

    // If this is default, wipe other defaults
    const updatedExisting = newIsDefault
      ? existing.map(loc => ({ ...loc, is_default: false }))
      : existing;

    const newLocation = {
      id: crypto.randomUUID(),
      locationName: location.locationName || "",
      streetAddress: location.streetAddress || "",
      addressLine2: location.addressLine2 || "",
      city: location.city || "",
      stateProvinceRegion: location.stateProvinceRegion || "",
      postalCode: location.postalCode || "",
      country: location.country || "",
      deliveryInstructions: location.deliveryInstructions || "",
      is_default: newIsDefault,
      createdAt: now(),
      updatedAt: now(),
    };

    const updatedLocations = [...updatedExisting, newLocation];

    await updateDoc(userRef, {
      deliveryLocations: updatedLocations,
      updatedAt: now(),
    });

    return ok({
      userId,
      added: newLocation,
      deliveryLocations: updatedLocations
    });

  } catch (error) {
    console.error("ADD_DELIVERY_LOCATION_ERROR", error);
    return err(
      500,
      "Server Error",
      "Failed to add delivery location.",
      { details: error.message }
    );
  }
}
