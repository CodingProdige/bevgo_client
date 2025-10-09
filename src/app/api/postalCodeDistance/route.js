// app/api/distance/route.js
import { NextResponse } from "next/server";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

export async function POST(req) {
  try {
    const { fromPostal, toPostal } = await req.json();

    // 🧩 If toPostal missing or null, return 0 fee immediately
    if (!toPostal || toPostal === null || toPostal === "" || toPostal === "null") {
      return NextResponse.json({
        fromPostal: fromPostal || null,
        toPostal: toPostal || null,
        distanceKm: 0,
        durationMinutes: 0,
        distanceText: "N/A",
        durationText: "N/A",
        deliveryFee: 0,
        tiers: [
          { range: "0–25 km", fee: 0 },
          { range: "26–50 km", fee: 40 },
          { range: "51+ km", fee: 80 },
        ],
      });
    }

    if (!fromPostal) {
      return NextResponse.json({ error: "Missing fromPostal" }, { status: 400 });
    }

    console.log(`🚚 Calculating driving distance between ${fromPostal} and ${toPostal}`);

    const baseUrl = "https://maps.googleapis.com/maps/api/distancematrix/json";
    const params = new URLSearchParams({
      origins: `${fromPostal}, South Africa`,
      destinations: `${toPostal}, South Africa`,
      mode: "driving",
      region: "za",
      key: GOOGLE_MAPS_API_KEY,
    });

    const response = await fetch(`${baseUrl}?${params.toString()}`);
    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error(`Google API error: ${data.status}`);
    }

    const element = data.rows[0].elements[0];

    if (element.status !== "OK") {
      throw new Error(`Could not find route between ${fromPostal} and ${toPostal}`);
    }

    const distanceKm = element.distance.value / 1000;
    const durationMinutes = element.duration.value / 60;

    // 💰 Delivery fee logic (numeric only)
    let deliveryFee = 0;
    if (distanceKm <= 25) deliveryFee = 0;
    else if (distanceKm <= 50) deliveryFee = 40;
    else deliveryFee = 80; // fallback tier

    return NextResponse.json({
      fromPostal,
      toPostal,
      distanceKm: Number(distanceKm.toFixed(2)),
      durationMinutes: Number(durationMinutes.toFixed(1)),
      distanceText: element.distance.text,
      durationText: element.duration.text,
      deliveryFee,
      tiers: [
        { range: "0–25 km", fee: 0 },
        { range: "26–50 km", fee: 40 },
        { range: "51+ km", fee: 80 },
      ],
    });
  } catch (error) {
    console.error("❌ Distance calculation failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
