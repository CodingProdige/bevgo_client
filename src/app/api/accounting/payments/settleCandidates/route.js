export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

/* ----------------------------- money helpers ----------------------------- */
// 🔧 cents-safe
const toCents = (n) => Math.round(Number(n || 0) * 100);
const fromCents = (c) => Number((c / 100).toFixed(2));

/* ------------------------------ credit utils ----------------------------- */

// 🧮 Utility: calculate available credit (ignores deleted) — cents-safe
async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const q = query(paymentsRef, where("companyCode", "==", companyCode));
  const snap = await getDocs(q);

  let totalCreditC = 0;
  let totalAllocatedC = 0;

  snap.forEach((docSnap) => {
    const p = docSnap.data();
    if (p.deleted) return;
    totalCreditC    += toCents(p.amount);
    totalAllocatedC += toCents(p.allocated);
  });

  // Return a 2dp number
  return fromCents(totalCreditC - totalAllocatedC);
}

// 👤 Utility: fetch user/customer details (unchanged)
async function getCustomerDetails(companyCode) {
  let detailDoc = null;

  // Try users collection
  const usersQuery = query(collection(db, "users"), where("companyCode", "==", companyCode));
  const usersSnap = await getDocs(usersQuery);
  if (!usersSnap.empty) {
    detailDoc = usersSnap.docs[0].data();
  } else {
    // Fallback: customers collection
    const custQuery = query(collection(db, "customers"), where("companyCode", "==", companyCode));
    const custSnap = await getDocs(custQuery);
    if (!custSnap.empty) {
      detailDoc = custSnap.docs[0].data();
    }
  }

  if (!detailDoc) return null;

  return {
    companyName: detailDoc.companyName || null,
    email: detailDoc.email || null,
    phone: detailDoc.phone_number || null,
    address: detailDoc.deliveryAddress || null,
    postalCode: detailDoc.postal_code || null,
    vatNumber: detailDoc.vatNumber || null
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const companyCode = searchParams.get("companyCode");
    const isAdmin = searchParams.get("isAdmin") === "true";

    if (!isAdmin && !companyCode) {
      return NextResponse.json(
        { error: "companyCode is required when isAdmin=false" },
        { status: 400 }
      );
    }

    // Helper: fetch pending invoices for company (unchanged)
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
      // Get all pending invoices grouped by companyCode
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

      // Build enriched customer list
      for (const cc of Object.keys(grouped)) {
        const availableCredit = await getAvailableCredit(cc);          // 2dp number
        const availableC = toCents(availableCredit);                    // 🔧 compare in cents

        const invoices = grouped[cc].filter((inv) => {
          const totalC = toCents(inv?.finalTotals?.finalTotal || 0);    // 🔧 convert to cents
          return totalC <= availableC;
        });

        if (invoices.length > 0) {
          const userDetails = await getCustomerDetails(cc);

          customers.push({
            companyCode: cc,
            availableCredit, // 2dp number
            userDetails,
            invoices: invoices.map((inv) => ({
              orderNumber: inv.orderNumber,
              invoiceDate: inv.invoiceDate,
              finalTotal: Number(inv.finalTotals?.finalTotal || 0), // leave as your 2dp number
              payment_status: inv.payment_status,
            })),
          });
        }
      }
    } else {
      // Single customer view
      const availableCredit = await getAvailableCredit(companyCode);    // 2dp number
      const availableC = toCents(availableCredit);                      // 🔧 compare in cents

      const invoices = await fetchInvoices(companyCode);
      const matchable = invoices.filter((inv) => {
        const totalC = toCents(inv?.finalTotals?.finalTotal || 0);      // 🔧 convert to cents
        return totalC <= availableC;
      });

      if (matchable.length > 0) {
        const userDetails = await getCustomerDetails(companyCode);

        customers.push({
          companyCode,
          availableCredit, // 2dp number
          userDetails,
          invoices: matchable.map((inv) => ({
            orderNumber: inv.orderNumber,
            invoiceDate: inv.invoiceDate,
            finalTotal: Number(inv.finalTotals?.finalTotal || 0),
            payment_status: inv.payment_status,
          })),
        });
      }
    }

    return NextResponse.json({
      message: "Settle candidates retrieved successfully",
      isAdmin,
      customers,
    });
  } catch (err) {
    console.error("❌ Error fetching settle candidates:", err);
    return NextResponse.json(
      { error: err.message || "Failed to fetch settle candidates" },
      { status: 500 }
    );
  }
}
