// app/api/cartTotals/route.js
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, collection, query, where, getDocs, limit } from "firebase/firestore";
import { NextResponse } from "next/server";
import axios from "axios";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

function calculateRebate(subtotal) {
  if (subtotal > 20000) return 3.0;
  if (subtotal > 15000) return 2.5;
  if (subtotal > 10000) return 2.0;
  if (subtotal > 5000) return 1.5;
  return 1.0;
}

async function getDistanceAndFee({ fromPostal, toPostal }) {
  // Short-circuit: no toPostal => N/A + fee 0
  if (!toPostal || toPostal === null || toPostal === "" || toPostal === "null") {
    return {
      fromPostal: fromPostal || null,
      toPostal: toPostal || "",
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
    };
  }

  if (!fromPostal) throw new Error("Missing fromPostal");
  if (!GOOGLE_MAPS_API_KEY) throw new Error("Missing GOOGLE_MAPS_API_KEY");

  const baseUrl = "https://maps.googleapis.com/maps/api/distancematrix/json";
  const params = new URLSearchParams({
    origins: `${fromPostal}, South Africa`,
    destinations: `${toPostal}, South Africa`,
    mode: "driving",
    region: "za",
    key: GOOGLE_MAPS_API_KEY,
  });

  const res = await fetch(`${baseUrl}?${params.toString()}`);
  const data = await res.json();
  if (data.status !== "OK") throw new Error(`Google API error: ${data.status}`);

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK") {
    throw new Error(`Could not find route between ${fromPostal} and ${toPostal}`);
  }

  const distanceKm = element.distance.value / 1000;
  const durationMinutes = element.duration.value / 60;

  let deliveryFee = 0;
  if (distanceKm <= 25) deliveryFee = 0;
  else if (distanceKm <= 50) deliveryFee = 40;
  else deliveryFee = 80;

  return {
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
  };
}

// 🔎 Strict default delivery location lookup (boolean true, then legacy "true")
async function resolveDefaultDeliveryPostalFromLocations(companyCode) {
  if (!companyCode) return "";

  // Preferred: defaultLocation === true (boolean)
  const qBool = query(
    collection(db, "deliveryLocations"),
    where("companyCode", "==", companyCode),
    where("defaultLocation", "==", true),
    limit(1)
  );
  let snap = await getDocs(qBool);

  // Legacy fallback: defaultLocation === "true" (string)
  if (snap.empty) {
    const qStr = query(
      collection(db, "deliveryLocations"),
      where("companyCode", "==", companyCode),
      where("defaultLocation", "==", "true"),
      limit(1)
    );
    snap = await getDocs(qStr);
  }

  if (snap.empty) return "";

  const d = snap.docs[0].data();
  const pc = (d?.postal_code ?? d?.postalCode ?? "").toString().trim();
  return pc.length > 0 ? pc : "";
}

export async function POST(req) {
  try {
    const {
      companyCode,
      userId,
      creditApplied = 0,
      useCredit = false,
      deliveryFee: deliveryFeeInput = 0, // may be overridden by distance calc
      useDistanceCalc = false,
      fromPostal, // optional override; otherwise infer from users/{userId}
      toPostal,   // optional; fallback chain applies when useDistanceCalc === true
    } = await req.json();

    if (!companyCode && !userId) {
      return NextResponse.json({ error: "Missing companyCode or userId" }, { status: 400 });
    }

    // ---------- Load docs ----------
    let userIdSnap = null; // users/{userId} profile (fromPostal inference, cart if present)
    if (userId) {
      const byIdRef = doc(db, "users", userId);
      const byIdSnap = await getDoc(byIdRef);
      if (byIdSnap.exists()) userIdSnap = byIdSnap;
    }

    // customerSnapCompany: ALWAYS fetched via companyCode (for customer object)
    let customerSnapCompany = null;
    if (companyCode) {
      const usersQuery = query(collection(db, "users"), where("companyCode", "==", companyCode));
      const usersByCompany = await getDocs(usersQuery);
      if (!usersByCompany.empty) {
        customerSnapCompany = usersByCompany.docs[0];
      } else {
        const customersQuery = query(collection(db, "customers"), where("companyCode", "==", companyCode));
        const customersByCompany = await getDocs(customersQuery);
        if (!customersByCompany.empty) {
          customerSnapCompany = customersByCompany.docs[0];
        }
      }
    }

    // pricingSnap: source for cart/pricing (prefer users/{userId}, else company doc)
    const pricingSnap = userIdSnap ?? customerSnapCompany;
    if (!pricingSnap) {
      return NextResponse.json({ error: "No user or customer found for pricing/cart" }, { status: 404 });
    }

    // ---------- Build objects ----------
    const pricingData = pricingSnap.data();
    const customer = customerSnapCompany ? customerSnapCompany.data() : null; // strictly companyCode doc

    // ---------- Cart maths ----------
    const cart = pricingData.cart || [];
    let subtotalExclVAT = 0;
    let returnableSubtotal = 0;
    let totalItems = 0;
    const cartDetails = [];

    cart.forEach((item) => {
      const quantity = Number(item.in_cart) || 0;
      const priceExclVAT = item.on_sale && item.sale_price
        ? parseFloat(item.sale_price)
        : parseFloat(item.price_excl) || 0;

      const returnablePrice =
        item.assigned_returnable?.price_excl
          ? parseFloat(item.assigned_returnable.price_excl)
          : 0;

      const totalPrice = priceExclVAT * quantity;

      subtotalExclVAT += totalPrice;
      returnableSubtotal += returnablePrice * quantity;
      totalItems += quantity;

      cartDetails.push({
        ...item,
        quantity,
        total_price: parseFloat(totalPrice.toFixed(2)),
        returnable_item_price: parseFloat(returnablePrice.toFixed(2)),
      });
    });

    const rebatePercentage = calculateRebate(subtotalExclVAT);
    const rebateAmount = parseFloat(((subtotalExclVAT * rebatePercentage) / 100).toFixed(2));
    const subtotalAfterRebate = subtotalExclVAT - rebateAmount;
    const subtotalIncludingReturnables = subtotalAfterRebate + returnableSubtotal;
    const vat = parseFloat((subtotalIncludingReturnables * 0.15).toFixed(2));

    // ---------- Delivery / Distance ----------
    let delivery = null;
    let deliveryFeeFinal = Number(deliveryFeeInput) || 0;

    if (useDistanceCalc) {
      // FROM: infer ONLY from users/{userId} profile unless explicitly provided
      const fromFromUserProfile =
        userIdSnap?.data()?.defaultFromPostal ??
        userIdSnap?.data()?.warehousePostalCode ??
        userIdSnap?.data()?.businessPostalCode ??
        userIdSnap?.data()?.postalCode ??
        userIdSnap?.data()?.postal_code ??
        userIdSnap?.data()?.deliveryPostalCode ??
        null;

      const resolvedFromPostal = fromPostal ?? fromFromUserProfile;

      // ----- toPostal fallback chain (your requested order) -----
      // 1) explicit toPostal
      // 2) defaultLocations.defaultLocation === true/"true" -> postal_code
      // 3) customer.postal_code
      // 4) "" (empty string)
      let resolvedToPostal = toPostal ?? null;

      if (!resolvedToPostal) {
        const defaultLocPostal = await resolveDefaultDeliveryPostalFromLocations(companyCode);
        resolvedToPostal = defaultLocPostal || null;
      }

      if (!resolvedToPostal) {
        resolvedToPostal = (customer?.postal_code ?? "").toString().trim();
      }

      if (!resolvedToPostal) {
        resolvedToPostal = ""; // short-circuit to fee 0
      }

      if (!resolvedFromPostal) {
        return NextResponse.json(
          { error: "Missing fromPostal. Provide userId with a postal in their profile or pass fromPostal explicitly." },
          { status: 400 }
        );
      }

      try {
        delivery = await getDistanceAndFee({
          fromPostal: resolvedFromPostal,
          toPostal: resolvedToPostal,
        });
        deliveryFeeFinal = delivery.deliveryFee ?? 0;
      } catch (err) {
        console.error("⚠️ Distance calc failed, falling back to provided deliveryFee:", err.message);
      }
    }

    // ---------- Credit ----------
    const grossTotal = parseFloat((subtotalIncludingReturnables + vat + deliveryFeeFinal).toFixed(2));

    let appliedCredit = 0;
    let remainingCredit = 0;

    if (useCredit && companyCode) {
      try {
        const creditRes = await axios.get(
          `${process.env.BASE_URL}/api/accounting/payments/capturePayment`,
          { params: { companyCode } }
        );
        const availableCredit = creditRes.data?.creditSummary?.availableCredit || 0;
        appliedCredit = Math.min(availableCredit, grossTotal);
        remainingCredit = availableCredit - appliedCredit;
      } catch (err) {
        console.error("⚠️ Failed to fetch credit summary:", err.message);
      }
    } else {
      appliedCredit = Math.min(Number(creditApplied) || 0, grossTotal);
      remainingCredit = (Number(creditApplied) || 0) - appliedCredit;
    }

    const orderTotalAfterCredit = parseFloat((grossTotal - appliedCredit).toFixed(2));

    // ---------- Response ----------
    return NextResponse.json(
      {
        // Totals
        subtotal: parseFloat(subtotalExclVAT.toFixed(2)),
        rebatePercentage,
        rebateAmount,
        subtotalAfterRebate: parseFloat(subtotalAfterRebate.toFixed(2)),
        subtotalIncludingReturnables: parseFloat(subtotalIncludingReturnables.toFixed(2)),
        returnableSubtotal: parseFloat(returnableSubtotal.toFixed(2)),
        vat,
        deliveryFee: parseFloat(deliveryFeeFinal.toFixed(2)),
        grossTotal,
        total: orderTotalAfterCredit,
        appliedCredit,
        remainingCredit: remainingCredit > 0 ? parseFloat(remainingCredit.toFixed(2)) : 0,
        totalItems,
        cartDetails,

        // Always from companyCode doc
        customer,

        // Include distance payload when used
        ...(delivery ? { delivery } : {}),

        // Debug flags/sources
        flags: {
          usedDistanceCalc: !!delivery,
          fromPostalSource: delivery ? (fromPostal ? "explicit fromPostal" : "userId profile") : "manual deliveryFee",
          toPostalSource: delivery
            ? (toPostal
                ? "explicit toPostal"
                : (delivery?.toPostal === (customer?.postal_code ?? "").toString().trim()
                    ? "customer.postal_code"
                    : "deliveryLocations.default"))
            : "manual deliveryFee",
          pricingSource: userIdSnap ? "users/{userId}" : "companyCode doc",
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error calculating cart totals:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
