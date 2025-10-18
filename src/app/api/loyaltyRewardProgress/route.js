import { db } from "@/lib/firebaseConfig";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  doc,
  getDoc,
} from "firebase/firestore";
import { NextResponse } from "next/server";

/* ----------------------------- config ----------------------------- */
// 👉 Update this to change the loyalty milestone (in ZAR)
const REWARD_THRESHOLD_ZAR = 10000;

/* ----------------------------- money helpers ----------------------------- */
const toCents = (n) => Math.round(Number(n || 0) * 100);
const fromCents = (c) => Number((c / 100).toFixed(2));

/* ----------------------------- spend helper ----------------------------- */
// Prefer order_details.subtotalAfterRebate; then calcFinalTotal.subtotalAfterRebate; then calcFinalTotal.finalTotal; then order_details.total
const extractSpendNumber = (ord) => {
  const od = ord?.order_details || {};
  const cf = ord?.calcFinalTotal || {};
  return Number(
    od.subtotalAfterRebate ??
    cf.subtotalAfterRebate ??
    cf.finalTotal ??
    od.total ??
    0
  );
};

/* ----------------------------- cart helper ------------------------------ */
async function hasFreeItemInCartByUserId(userId) {
  try {
    if (!userId) return false;
    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);
    if (!snap.exists()) return false;
    const cart = Array.isArray(snap.data()?.cart) ? snap.data().cart : [];
    return cart.some((it) => it?.freeItem === true && Number(it?.in_cart || 0) > 0);
  } catch {
    return false; // fail-safe
  }
}

/**
 * POST /api/loyalty/progress (orders-based)
 * Body: { companyCode: string, userId: string }
 *
 * Logic:
 * - Look at ORDERS where:
 *   - customer/company code matches
 *   - order_status IN ["Pending","Delivered"]
 *   - order_canceled !== true
 * - Find the latest order that contains a free item (any cartDetails[x].freeItem === true)
 * - Sum spend strictly AFTER that order (or from the start if none)
 * - Return remaining to next threshold, reached flag, and whether the user currently has a free item in cart
 */
export async function POST(req) {
  try {
    const { companyCode, userId } = await req.json() || {};
    if (!companyCode) {
      return NextResponse.json({ error: "companyCode is required" }, { status: 400 });
    }

    const thresholdC = toCents(REWARD_THRESHOLD_ZAR);

    // Fetch all qualifying orders for this company (ascending by createdAt for clean passes)
    // NOTE: Firestore may require a composite index for these where/orderBy combos.
    const qAll = query(
      collection(db, "orders"),
      where("companyCode", "==", companyCode),
      where("order_canceled", "==", false),
      where("order_status", "in", ["Pending", "Delivered"]),
      orderBy("createdAt", "asc")
    );
    const snap = await getDocs(qAll);

    let lastRewardISO = null;     // latest createdAt with a freeItem in cartDetails
    let lastRewardOrder = null;   // orderNumber of that order
    let redemptionsTotal = 0;     // total count of orders that contain a free item
    const all = [];

    // Pass 1: find latest redemption + count all redemptions
    snap.forEach((d) => {
      const ord = d.data();
      all.push(ord);

      const lines = ord?.order_details?.cartDetails || [];
      const hadFree = Array.isArray(lines) && lines.some((it) => it?.freeItem === true);

      if (hadFree) {
        redemptionsTotal += 1;
        const iso = ord?.createdAt ? new Date(ord.createdAt).toISOString() : null;
        if (iso && (!lastRewardISO || iso > lastRewardISO)) {
          lastRewardISO = iso;
          lastRewardOrder = ord?.orderNumber ?? d.id;
        }
      }
    });

    // Pass 2: sum spend strictly AFTER last redemption (or from start if none)
    let spendCents = 0;
    if (lastRewardISO) {
      for (const ord of all) {
        const iso = ord?.createdAt ? new Date(ord.createdAt).toISOString() : null;
        if (iso && iso > lastRewardISO) {
          spendCents += toCents(extractSpendNumber(ord));
        }
      }
    } else {
      for (const ord of all) {
        spendCents += toCents(extractSpendNumber(ord));
      }
    }

    // Spend milestone math
    const remainderC = thresholdC > 0 ? (spendCents % thresholdC) : 0;
    const reachedNextReward = spendCents >= thresholdC;
    const remainingToNextRewardC = reachedNextReward ? 0 : (thresholdC - remainderC);

    // Check current cart (by userId) for an already-added free item to avoid infinite loop
    const hasFreeItemInCart = await hasFreeItemInCartByUserId(userId);

    return NextResponse.json(
      {
        message: "OK",
        companyCode,
        threshold: REWARD_THRESHOLD_ZAR,
        lastRewardOrder: lastRewardISO
          ? { orderNumber: lastRewardOrder, createdAt: lastRewardISO }
          : null,

        // Count of actual redemption orders (orders that contained a free item)
        rewardsEarnedSinceLast: redemptionsTotal,
        rewardsRedeemedTotal: redemptionsTotal,

        // Spend progress since last redemption
        spendSinceLastReward: fromCents(spendCents),
        remainingToNextReward: fromCents(remainingToNextRewardC),
        reachedNextReward,

        // Prevent infinite add loop
        hasFreeItemInCart,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("❌ Loyalty (orders-based) progress failed:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to calculate loyalty progress (orders)" },
      { status: 500 }
    );
  }
}
