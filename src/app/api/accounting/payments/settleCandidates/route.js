export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

// Utility: calculate available credit for a single customer
async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const q = query(paymentsRef, where("companyCode", "==", companyCode));
  const snap = await getDocs(q);

  let totalCredit = 0;
  let totalAllocated = 0;

  snap.forEach((doc) => {
    const p = doc.data();
    if (p.deleted) return;
    totalCredit += Number(p.amount || 0);
    totalAllocated += Number(p.allocated || 0);
  });

  return totalCredit - totalAllocated;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const companyCode = searchParams.get("companyCode");
    const isAdmin = searchParams.get("isAdmin") === "true";

    // 🔹 Enforce rules
    if (!isAdmin && !companyCode) {
      return NextResponse.json(
        { error: "companyCode is required when isAdmin=false" },
        { status: 400 }
      );
    }

    // Helper: fetch invoices
    const fetchInvoices = async (cc) => {
      const invoicesRef = collection(db, "invoices");
      const q = query(
        invoicesRef,
        where("customer.companyCode", "==", cc),
        where("payment_status", "==", "Pending")
      );
      const snap = await getDocs(q);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    };

    let customers = [];

    if (isAdmin) {
      // Get all distinct customers with pending invoices
      const invoicesRef = collection(db, "invoices");
      const snap = await getDocs(query(invoicesRef, where("payment_status", "==", "Pending")));
      const grouped = {};

      snap.forEach((docSnap) => {
        const inv = docSnap.data();
        const cc = inv?.customer?.companyCode;
        if (!cc) return;
        if (!grouped[cc]) grouped[cc] = [];
        grouped[cc].push({ id: docSnap.id, ...inv });
      });

      // For each customer → calculate credit and filter invoices
      for (const cc of Object.keys(grouped)) {
        const availableCredit = await getAvailableCredit(cc);
        const invoices = grouped[cc].filter(
          (inv) => Number(inv.finalTotals?.finalTotal || 0) <= availableCredit
        );
        if (invoices.length > 0) {
          customers.push({
            companyCode: cc,
            availableCredit,
            invoices: invoices.map((inv) => ({
              orderNumber: inv.orderNumber,
              invoiceDate: inv.invoiceDate,
              finalTotal: Number(inv.finalTotals?.finalTotal || 0),
              payment_status: inv.payment_status
            }))
          });
        }
      }
    } else {
      // Single customer
      const availableCredit = await getAvailableCredit(companyCode);
      const invoices = await fetchInvoices(companyCode);
      const matchable = invoices.filter(
        (inv) => Number(inv.finalTotals?.finalTotal || 0) <= availableCredit
      );

      if (matchable.length > 0) {
        customers.push({
          companyCode,
          availableCredit,
          invoices: matchable.map((inv) => ({
            orderNumber: inv.orderNumber,
            invoiceDate: inv.invoiceDate,
            finalTotal: Number(inv.finalTotals?.finalTotal || 0),
            payment_status: inv.payment_status
          }))
        });
      }
    }

    return NextResponse.json({
      message: "Settle candidates retrieved successfully",
      isAdmin,
      customers
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to fetch settle candidates" },
      { status: 500 }
    );
  }
}
