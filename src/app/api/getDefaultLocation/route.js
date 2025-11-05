export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { collection, query, where, limit, getDocs } from "firebase/firestore";

/**
 * GET  /api/deliveryLocations/default?companyCode=DJ3921
 * POST /api/deliveryLocations/default  { "companyCode": "DJ3921" }
 */
async function findDefaultLocation(companyCode) {
  const ref = collection(db, "deliveryLocations");
  const q = query(
    ref,
    where("companyCode", "==", companyCode),
    where("defaultLocation", "==", true),
    limit(1)
  );

  const snap = await getDocs(q);
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();

  return {
    id: doc.id,
    companyCode: data.companyCode ?? null,
    defaultLocation: !!data.defaultLocation,
    deliveryAddress: data.deliveryAddress ?? data.address ?? null,
    postal_code: data.postal_code ?? data.postalCode ?? null,
    raw: data,
  };
}

function ok(found, location = null) {
  return NextResponse.json({ ok: true, found, location }, { status: 200 });
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const companyCode = (searchParams.get("companyCode") || "").trim();

    if (!companyCode) {
      return NextResponse.json(
        { ok: false, error: "Missing required query param: companyCode" },
        { status: 400 }
      );
    }

    const location = await findDefaultLocation(companyCode);
    return ok(!!location, location ?? null);
  } catch (err) {
    console.error("GET /deliveryLocations/default error:", err);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const companyCode = (body.companyCode || "").trim();

    if (!companyCode) {
      return NextResponse.json(
        { ok: false, error: "Missing required body field: companyCode" },
        { status: 400 }
      );
    }

    const location = await findDefaultLocation(companyCode);
    return ok(!!location, location ?? null);
  } catch (err) {
    console.error("POST /deliveryLocations/default error:", err);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
