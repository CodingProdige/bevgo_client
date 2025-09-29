// app/api/accounting/payments/backfill/route.js
import { db } from "@/lib/firebaseConfig";
import {
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  doc
} from "firebase/firestore";
import { NextResponse } from "next/server";

/**
 * 🔹 Utility: generate unique 8-digit payment number
 */
async function generateUniquePaymentNumber() {
  let unique = false;
  let paymentNumber;

  while (!unique) {
    paymentNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
    const existing = await getDocs(
      query(collection(db, "payments"), where("paymentNumber", "==", paymentNumber))
    );
    if (existing.empty) unique = true;
  }

  return paymentNumber;
}

/**
 * POST - Backfill endpoint
 * Creates synthetic payments + allocations for all invoices with payment_status === "Paid"
 * Skips invoices already covered by allocations
 * Supports dryRun mode
 */
export async function POST(req) {
  try {
    const { dryRun = false } = await req.json();

    // Fetch all invoices marked as Paid
    const invoicesSnap = await getDocs(
      query(collection(db, "invoices"), where("payment_status", "==", "Paid"))
    );

    if (invoicesSnap.empty) {
      return NextResponse.json({
        message: "No paid invoices found",
        count: 0,
        results: []
      });
    }

    const allocationsRef = collection(db, "allocations");
    const paymentsRef = collection(db, "payments");

    const batch = writeBatch(db);
    const results = [];

    for (const invDoc of invoicesSnap.docs) {
      const invoice = invDoc.data();
      const invoiceId = invDoc.id || invoice.orderNumber;

      // 🔎 Check if this invoice already has an allocation
      const existingAllocSnap = await getDocs(
        query(allocationsRef, where("invoiceId", "==", invoiceId))
      );
      if (!existingAllocSnap.empty) {
        continue; // Skip already processed invoices
      }

      const companyCode = invoice.customer?.companyCode;
      const invoiceTotal = Number(invoice.finalTotals?.finalTotal || 0);

      // Derive payment method from invoice (fallbacks included)
      const invoiceMethod =
        invoice.paymentMethod ||
        invoice.finalTotals?.paymentMethod ||
        "Historical Backfill";

      // 🔹 Build synthetic payment doc
      const now = new Date().toISOString();
      const paymentNumber = await generateUniquePaymentNumber();

      const syntheticPayment = {
        companyCode,
        paymentNumber,
        amount: invoiceTotal,
        method: invoiceMethod, // 👈 use invoice's own method
        reference: `Backfill for invoice ${invoiceId}`,
        paymentDate: invoice.date_settled || invoice.invoiceDate || now,
        createdBy: "bootstrap-system",
        allocated: invoiceTotal,
        unallocated: 0,
        createdAt: now,
        date: now,
        deleted: false
      };

      // 🔹 Build allocation doc (points back to synthetic payment)
      const allocation = {
        companyCode,
        invoiceId,
        amount: invoiceTotal,
        fromPayments: [
          {
            paymentId: "synthetic", // replaced with actual ID later
            amount: invoiceTotal
          }
        ],
        date: now,
        createdBy: "bootstrap-system",
        status: "Applied"
      };

      results.push({
        companyCode,
        invoiceId,
        invoiceTotal,
        syntheticPayment,
        allocation
      });

      if (!dryRun) {
        // Create payment doc
        const paymentDocRef = doc(paymentsRef);
        batch.set(paymentDocRef, syntheticPayment);

        // Link allocation to paymentId
        allocation.fromPayments[0].paymentId = paymentDocRef.id;

        // Create allocation doc
        const allocDocRef = doc(allocationsRef);
        batch.set(allocDocRef, allocation);
      }
    }

    if (!dryRun && results.length > 0) {
      await batch.commit();
    }

    return NextResponse.json({
      message: dryRun
        ? "Dry run — no data written"
        : "Backfill completed successfully",
      count: results.length,
      results
    });
  } catch (err) {
    console.error("Backfill error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to backfill payments and allocations" },
      { status: 500 }
    );
  }
}
