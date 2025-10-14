export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";
import crypto from "crypto";

export async function GET() {
  try {
    const paymentsSnap = await getDocs(collection(db, "payments"));
    const allocationsSnap = await getDocs(collection(db, "allocations"));

    const payments = [];
    const allocations = [];
    const issues = [];
    const paymentMap = new Map();

    // 🧾 Build payment index
    paymentsSnap.forEach((docSnap) => {
      const p = docSnap.data();
      payments.push({ id: docSnap.id, ...p });

      const key = `${p.companyCode}_${p.amount}_${p.paymentDate?.slice(0, 10)}`;
      if (!paymentMap.has(key)) paymentMap.set(key, []);
      paymentMap.get(key).push(docSnap.id);
    });

    // 🔍 Find duplicate payments
    paymentMap.forEach((ids, key) => {
      if (ids.length > 1) {
        const [companyCode, amount, date] = key.split("_");
        issues.push({
          type: "DuplicatePayment",
          companyCode,
          hashKey: key,
          paymentIds: ids,
          recommendation:
            "These appear to be identical payments. Merge one and delete duplicates.",
        });
      }
    });

    // 🔗 Build allocation map
    const invoicePaymentPairs = {};
    allocationsSnap.forEach((docSnap) => {
      const alloc = docSnap.data();
      allocations.push({ id: docSnap.id, ...alloc });
      const invoiceId = alloc.invoiceId;
      (alloc.fromPayments || []).forEach((fp) => {
        const key = `${invoiceId}_${fp.paymentId}`;
        if (!invoicePaymentPairs[key]) invoicePaymentPairs[key] = [];
        invoicePaymentPairs[key].push(docSnap.id);
      });
    });

    // 🧩 Detect duplicate invoice–payment links
    for (const key in invoicePaymentPairs) {
      if (invoicePaymentPairs[key].length > 1) {
        const [invoiceId, paymentId] = key.split("_");
        issues.push({
          type: "DuplicateAllocation",
          invoiceId,
          paymentId,
          occurrences: invoicePaymentPairs[key].length,
          allocationIds: invoicePaymentPairs[key],
          recommendation: "Keep one allocation; delete other duplicates.",
        });
      }
    }

    // 💰 Validate payment totals
    payments.forEach((p) => {
      const allocated = Number(p.allocated || 0);
      const amount = Number(p.amount || 0);
      const unallocated = Number(p.unallocated || 0);

      if (allocated + unallocated !== amount) {
        issues.push({
          type: "UnallocatedMismatch",
          companyCode: p.companyCode,
          paymentId: p.id,
          amount,
          allocated,
          unallocated,
          recommendation:
            "Adjust allocation or unallocated values so that allocated + unallocated = amount.",
        });
      }
    });

    return NextResponse.json({
      summary: {
        paymentsChecked: payments.length,
        allocationsChecked: allocations.length,
        issuesFound: issues.length,
      },
      issues,
    });
  } catch (err) {
    console.error("❌ Integrity check failed:", err);
    return NextResponse.json(
      { error: err.message || "Failed to check accounting integrity" },
      { status: 500 }
    );
  }
}
