export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  DEFAULT_DELIVERY_AREAS,
  evaluateDeliveryArea
} from "@/lib/deliveryAreaCheck";

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status, title, message, extra = {}) =>
  NextResponse.json({ ok: false, title, message, ...extra }, { status });

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));

    const looksLikeAddress =
      body &&
      typeof body === "object" &&
      (
        "streetAddress" in body ||
        "city" in body ||
        "postalCode" in body ||
        "stateProvinceRegion" in body ||
        "country" in body
      );

    const {
      deliveryAddress = null,
      inStoreCollection = false,
      serviceAreas = null
    } = body || {};
    const resolvedDeliveryAddress =
      deliveryAddress && typeof deliveryAddress === "object"
        ? deliveryAddress
        : looksLikeAddress
          ? body
          : null;

    if (inStoreCollection === true) {
      return ok({
        supported: true,
        canPlaceOrder: true,
        reasonCode: "IN_STORE_COLLECTION",
        message: "In-store collection selected. Delivery area check not required.",
        matchedArea: null,
        serviceAreasCount: Array.isArray(serviceAreas)
          ? serviceAreas.length
          : DEFAULT_DELIVERY_AREAS.length
      });
    }

    const result = evaluateDeliveryArea(
      resolvedDeliveryAddress,
      Array.isArray(serviceAreas) ? serviceAreas : DEFAULT_DELIVERY_AREAS
    );

    return ok({
      ...result,
      serviceAreasCount: Array.isArray(serviceAreas)
        ? serviceAreas.length
        : DEFAULT_DELIVERY_AREAS.length
    });
  } catch (e) {
    return err(
      500,
      "Delivery Area Check Failed",
      e?.message || "Unable to validate delivery area."
    );
  }
}
