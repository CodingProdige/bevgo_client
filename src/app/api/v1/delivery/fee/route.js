export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });

const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

const ORIGIN_ADDRESS =
  "Unit 2, 4 EK Green Str, Charelston Hill, Paarl, 7646";

function buildDestination(address) {
  if (!address || typeof address !== "object") return "";
  const parts = [
    address.streetAddress,
    address.addressLine2,
    address.city,
    address.stateProvinceRegion,
    address.postalCode,
    address.country
  ].filter(Boolean);
  return parts.join(", ");
}

function getFeeBand(distanceKm) {
  if (distanceKm > 70) return { fee: 99, band: ">70km" };
  if (distanceKm > 40) return { fee: 80, band: ">40km" };
  if (distanceKm > 25) return { fee: 60, band: ">25km" };
  if (distanceKm > 15) return { fee: 40, band: ">15km" };
  return { fee: 0, band: "0-15km" };
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { address, userId } = body || {};

    if (!address) {
      return err(400, "Missing Address", "address is required.");
    }

    const destination = buildDestination(address);
    if (!destination) {
      return err(400, "Invalid Address", "address fields are incomplete.");
    }

    let accountType = null;
    if (userId) {
      const userSnap = await getDoc(doc(db, "users", userId));
      accountType = userSnap.exists()
        ? userSnap.data()?.account?.accountType || null
        : null;
    }

    const apiKey =
      process.env.GOOGLE_DISTANCE_MATRIX_API_KEY ||
      process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      return err(500, "Config Error", "Google Maps API key is not configured.");
    }

    const url =
      "https://maps.googleapis.com/maps/api/distancematrix/json" +
      `?origins=${encodeURIComponent(ORIGIN_ADDRESS)}` +
      `&destinations=${encodeURIComponent(destination)}` +
      "&units=metric" +
      `&key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) {
      return err(502, "Distance Error", "Failed to fetch distance.", {
        status: res.status
      });
    }

    const json = await res.json();
    const element = json?.rows?.[0]?.elements?.[0];
    if (!element || element?.status !== "OK") {
      return err(400, "Distance Error", "Distance could not be calculated.", {
        apiStatus: element?.status || json?.status || "unknown"
      });
    }

    const distanceMeters = Number(element.distance?.value || 0);
    const durationSeconds = Number(element.duration?.value || 0);
    const distanceKm = Number((distanceMeters / 1000).toFixed(2));
    const durationMinutes = Number((durationSeconds / 60).toFixed(1));

    const { fee, band } = getFeeBand(distanceKm);
    const isBusiness = accountType === "business";

    return ok({
      accountType,
      isBusiness,
      origin: ORIGIN_ADDRESS,
      destination,
      distance: {
        meters: distanceMeters,
        km: distanceKm,
        text: element.distance?.text || null
      },
      duration: {
        seconds: durationSeconds,
        minutes: durationMinutes,
        text: element.duration?.text || null
      },
      fee: {
        amount: isBusiness ? 0 : fee,
        currency: "ZAR",
        band,
        reason: isBusiness ? "business_accounts_free_delivery" : "distance_band"
      },
      raw: {
        apiStatus: json?.status || null,
        elementStatus: element?.status || null
      }
    });
  } catch (e) {
    return err(500, "Delivery Fee Error", e?.message || "Unexpected error.");
  }
}
