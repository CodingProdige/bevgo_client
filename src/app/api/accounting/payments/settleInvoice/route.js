export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
  addDoc,
  writeBatch,
  getDoc,
} from "firebase/firestore";
import { NextResponse } from "next/server";

// 🔹 Utility: calculate available credit (ignores deleted)
async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const q = query(paymentsRef, where("companyCode", "==", companyCode));
  const snap = await getDocs(q);

  let totalCredit = 0;
  let totalAllocated = 0;

  snap.forEach((doc) => {
    const p = doc.data();
    if (p.deleted) return; // 🚫 skip deleted
    totalCredit += Number(p.amount || 0);
    totalAllocated += Number(p.allocated || 0);
  });

  return {
    totalCredit,
    totalAllocated,
    availableCredit: totalCredit - totalAllocated,
  };
}

// 🔹 Utility: log accounting actions
async function logAccountingAction(action) {
  try {
    await addDoc(collection(db, "accountingLogs"), {
      ...action,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Failed to log accounting action:", err.message);
  }
}

/**
 * POST - Settle Invoice(s)
 *
 * Modes:
 * 1. Direct Invoice Settlement
 *    → Pass { orderNumber: "123" } OR { orderNumbers: ["123", "456"] }
 *    → Settles explicitly listed invoices if enough credit.
 *
 * 2. Auto Settle Specific Customer
 *    → Pass { companyCode: "DC2070", autoSettle: true }
 *    → Checks available credit & settles invoices (FIFO) for that customer only.
 *
 * 3. Admin Multi-Customer Auto Settle
 *    → Pass { autoSettle: true, isAdmin: true }
 *    → Runs across ALL customers, settling what can be settled (FIFO per customer).
 */
export async function POST(req) {
  try {
    const {
      orderNumber,   // 👈 NEW support for single invoice
      orderNumbers,  // 👈 existing support for multiple
      companyCode,
      autoSettle = false,
      isAdmin = false,
    } = await req.json();

    const results = [];

    // Helper: process a single invoice settlement
    const processInvoice = async (invoiceDoc) => {
      const invoice = invoiceDoc.data();
      const companyCode = invoice?.customer?.companyCode;
      if (!companyCode) return { error: "Invoice missing companyCode" };

      const invoiceTotal = Number(invoice.finalTotals?.finalTotal || 0);

      // 🔎 Check linked order
      const orderRef = doc(db, "orders", invoice.orderNumber);
      const orderSnap = await getDoc(orderRef);

      if (orderSnap.exists()) {
        const order = orderSnap.data();
        const orderTotal = Number(order?.order_details?.total || 0);

        if (order.prePaid === true || orderTotal === 0) {
          // ✅ Mark invoice + order as Paid without allocations
          const now = new Date().toISOString();
          await updateDoc(doc(db, "invoices", invoice.orderNumber), {
            payment_status: "Paid",
            date_settled: now,
            allocationId: null, // no allocation doc
          });
          await updateDoc(orderRef, {
            payment_status: "Paid",
            date_settled: now,
            allocationId: null,
          });

          await logAccountingAction({
            action: "SETTLE_INVOICE",
            companyCode,
            orderNumber: invoice.orderNumber,
            amount: invoiceTotal,
            performedBy: "system",
            details: { skippedAllocation: true },
          });

          return {
            orderNumber: invoice.orderNumber,
            message: "Invoice settled (prepaid/credit). No allocation doc created.",
            skippedAllocation: true,
          };
        }
      }

      // 🔎 Otherwise continue with normal allocation flow
      const creditSummary = await getAvailableCredit(companyCode);
      if (creditSummary.availableCredit < invoiceTotal) {
        return {
          orderNumber: invoice.orderNumber,
          error: "Insufficient credit",
          creditSummary,
        };
      }

      // Fetch unallocated payments (FIFO)
      const paymentsRef = collection(db, "payments");
      const paymentsSnap = await getDocs(
        query(paymentsRef, where("companyCode", "==", companyCode))
      );

      let remaining = invoiceTotal;
      const batch = writeBatch(db);
      const fromPayments = [];

      paymentsSnap.forEach((pDoc) => {
        if (remaining <= 0) return;
        const p = pDoc.data();
        if (p.deleted) return;

        const unallocated = Number(p.unallocated || 0);
        if (unallocated > 0) {
          const allocateAmt = Math.min(remaining, unallocated);
          fromPayments.push({ paymentId: pDoc.id, amount: allocateAmt });

          batch.update(pDoc.ref, {
            allocated: (p.allocated || 0) + allocateAmt,
            unallocated: unallocated - allocateAmt,
          });

          remaining -= allocateAmt;
        }
      });

      if (remaining > 0) {
        return {
          orderNumber: invoice.orderNumber,
          error: "Allocation failed — not enough unallocated payments",
          fromPayments,
        };
      }

      // Create allocation doc
      const allocationRef = await addDoc(collection(db, "allocations"), {
        companyCode,
        invoiceId: invoice.orderNumber,
        amount: invoiceTotal,
        fromPayments,
        date: new Date().toISOString(),
        createdBy: "system",
      });

      const now = new Date().toISOString();
      const invoiceRef = doc(db, "invoices", invoice.orderNumber);

      batch.update(invoiceRef, {
        payment_status: "Paid",
        date_settled: now,
        allocationId: allocationRef.id,
      });
      batch.update(orderRef, {
        payment_status: "Paid",
        date_settled: now,
        allocationId: allocationRef.id,
      });

      await batch.commit();

      await logAccountingAction({
        action: "SETTLE_INVOICE",
        companyCode,
        orderNumber: invoice.orderNumber,
        amount: invoiceTotal,
        performedBy: "system",
        details: { fromPayments, allocationId: allocationRef.id },
      });

      const updatedCredit = await getAvailableCredit(companyCode);
      return {
        message: `Invoice ${invoice.orderNumber} settled successfully`,
        allocationId: allocationRef.id,
        fromPayments,
        creditSummary: updatedCredit,
      };
    };

    // Mode 1: Explicit orderNumber(s)
    if (
      (orderNumbers && Array.isArray(orderNumbers) && orderNumbers.length > 0) ||
      orderNumber
    ) {
      const numbers = orderNumbers || [orderNumber]; // normalize to array
      for (const num of numbers) {
        const snap = await getDocs(
          query(collection(db, "invoices"), where("orderNumber", "==", num))
        );
        if (snap.empty) {
          results.push({ orderNumber: num, error: "Invoice not found" });
        } else {
          results.push(await processInvoice(snap.docs[0]));
        }
      }
    }

    // Mode 2: Auto settle for specific customer
    else if (autoSettle && companyCode) {
      const snap = await getDocs(
        query(
          collection(db, "invoices"),
          where("customer.companyCode", "==", companyCode),
          where("payment_status", "==", "Pending")
        )
      );
      for (const docSnap of snap.docs) {
        results.push(await processInvoice(docSnap));
      }
    }

    // Mode 3: Admin auto settle all customers
    else if (autoSettle && isAdmin) {
      const snap = await getDocs(
        query(collection(db, "invoices"), where("payment_status", "==", "Pending"))
      );
      for (const docSnap of snap.docs) {
        results.push(await processInvoice(docSnap));
      }
    }

    else {
      return NextResponse.json(
        { error: "Invalid request. Provide orderNumber/orderNumbers, or autoSettle with companyCode/isAdmin." },
        { status: 400 }
      );
    }

    return NextResponse.json({
      message: "Settlement process complete",
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to settle invoices" },
      { status: 500 }
    );
  }
}
