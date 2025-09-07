/**
 * ✅ Check Cart Stock Endpoint (via remote /api/isInStock)
 *
 * Input:
 * { companyCode: string }
 *
 * Output (primary):
 * { hasOutOfStock: boolean }
 *
 * Extras (helpful, non-breaking):
 * { outOfStock: string[], checked: number, total: number }
 */

import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

const STOCK_CHECK_URL = "https://bevgo-pricelist.vercel.app/api/isInStock";

// Small helper to add a timeout to fetch calls (prevents hanging requests)
async function fetchWithTimeout(resource, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(resource, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// Check a list of unique_codes against the remote /api/isInStock
async function checkStockForCodes(uniqueCodes = []) {
  if (!uniqueCodes.length) return { outOfStock: [], results: [] };

  const requests = uniqueCodes.map((code) =>
    fetchWithTimeout(
      STOCK_CHECK_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unique_code: code }),
      },
      6000
    )
      .then(async (res) => {
        // Any non-2xx or JSON parse issue will be treated as out-of-stock (fail-safe)
        if (!res.ok) {
          // 404 (not found) = treat as OOS so users can't proceed unknowingly
          return { code, in_stock: false, error: `status_${res.status}` };
        }
        const data = await res.json().catch(() => ({}));
        const in_stock = data?.in_stock === true;
        return { code, in_stock };
      })
      .catch((err) => ({ code, in_stock: false, error: err?.message || "fetch_error" }))
  );

  const results = await Promise.all(requests);
  const outOfStock = results.filter((r) => r.in_stock === false).map((r) => r.code);
  return { outOfStock, results };
}

export async function POST(req) {
  try {
    console.log("🔍 Incoming request to /api/checkCartStock (remote validation)");

    // Parse JSON safely
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Malformed JSON in request body" },
        { status: 400 }
      );
    }

    const { companyCode } = body || {};
    if (!companyCode?.trim()) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    // Find user/customer by companyCode
    console.log("🔎 Searching by companyCode:", companyCode);

    let userSnap = null;

    const usersQuery = query(collection(db, "users"), where("companyCode", "==", companyCode));
    const userResults = await getDocs(usersQuery);

    if (!userResults.empty) {
      userSnap = userResults.docs[0];
      console.log("✅ Found user in 'users'");
    } else {
      const customersQuery = query(collection(db, "customers"), where("companyCode", "==", companyCode));
      const customerResults = await getDocs(customersQuery);

      if (!customerResults.empty) {
        userSnap = customerResults.docs[0];
        console.log("✅ Found user in 'customers'");
      } else {
        return NextResponse.json(
          { error: "No user/customer found for provided companyCode" },
          { status: 404 }
        );
      }
    }

    const userData = userSnap.data();
    const cart = Array.isArray(userData?.cart) ? userData.cart : [];
    console.log(`🛒 Cart items found: ${cart.length}`);

    if (cart.length === 0) {
      // Empty cart = nothing out of stock
      return NextResponse.json(
        { hasOutOfStock: false, outOfStock: [], checked: 0, total: 0 },
        { status: 200 }
      );
    }

    // Extract and dedupe unique_codes; skip items without a unique_code
    const codes = [
      ...new Set(
        cart
          .map((item) => item?.unique_code || item?.uniqueCode || item?.code)
          .filter((v) => typeof v === "string" && v.trim().length > 0)
      ),
    ];

    if (codes.length === 0) {
      // If no codes are present, we can't verify; fail-safe to TRUE so you can block checkout safely
      console.warn("⚠️ No unique_code values found in cart items. Failing safe (treat as OOS).");
      return NextResponse.json(
        { hasOutOfStock: true, outOfStock: [], checked: 0, total: cart.length },
        { status: 200 }
      );
    }

    // Call remote stock checker in parallel
    const { outOfStock } = await checkStockForCodes(codes);
    const hasOutOfStock = outOfStock.length > 0;

    return NextResponse.json(
      {
        hasOutOfStock,
        outOfStock, // list of unique_codes that are OOS or failed checks
        checked: codes.length,
        total: cart.length,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Unexpected error:", error);
    return NextResponse.json(
      { error: "Something went wrong", details: error?.message || String(error) },
      { status: 500 }
    );
  }
}
