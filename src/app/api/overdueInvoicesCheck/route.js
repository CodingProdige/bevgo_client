// app/api/overdueCheck/route.js
import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

/**
 * Parse various date formats safely:
 * - Firestore Timestamp (obj with toDate)
 * - ISO strings
 * - "dd/mm/yyyy" or "mm/dd/yyyy" (best-effort; SA default dd/mm)
 * - epoch millis (number)
 */
function parseDateFlexible(value) {
  if (!value) return null;

  // Firestore Timestamp
  if (typeof value === "object" && typeof value.toDate === "function") {
    return value.toDate();
  }

  // Epoch millis
  if (typeof value === "number") {
    const d = new Date(value);
    return isNaN(d) ? null : d;
  }

  // Strings
  if (typeof value === "string") {
    // Try native parse first (handles ISO well)
    const iso = new Date(value);
    if (!isNaN(iso)) return iso;

    // Try dd/mm/yyyy or mm/dd/yyyy
    const m = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      let y = parseInt(m[3].length === 2 ? `20${m[3]}` : m[3], 10);

      // Determine day/month order:
      // - If one part >12, that must be the day
      // - If both <=12, assume dd/mm (SA default)
      let day, month;
      if (a > 12 && b <= 12) {
        day = a; month = b;
      } else if (b > 12 && a <= 12) {
        day = b; month = a;
      } else {
        day = a; month = b; // assume dd/mm
      }
      const d = new Date(y, month - 1, day);
      return isNaN(d) ? null : d;
    }
  }

  return null;
}

/** Difference in whole days (UTC) between two dates: b - a */
function diffDays(a, b) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const aUTC = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bUTC = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.floor((bUTC - aUTC) / MS_PER_DAY);
}

export async function POST(req) {
  try {
    const { companyCode } = await req.json();

    if (!companyCode) {
      return NextResponse.json(
        { error: "companyCode is required" },
        { status: 400 }
      );
    }

    // 1) Pull pending invoices for this company
    const invoicesQuery = query(
      collection(db, "invoices"),
      where("customer.companyCode", "==", companyCode),
      where("payment_status", "==", "Pending")
    );

    const snap = await getDocs(invoicesQuery);

    const today = new Date();
    const overdue = [];

    snap.forEach((docSnap) => {
      const data = docSnap.data();

      const dueDateRaw = data?.dueDate; // e.g. "9/2/2025" (string) or Timestamp/ISO
      const paymentTermsRaw = data?.payment_terms; // e.g. "0" or 7/14/etc.
      const dueDate = parseDateFlexible(dueDateRaw);
      const paymentTermsDays = Number(paymentTermsRaw ?? 0);

      if (!dueDate || isNaN(paymentTermsDays)) {
        // If we can't parse due date or terms, skip this doc (or treat as not overdue)
        return;
      }

      // Days since due date (positive means past due date)
      const daysSinceDue = diffDays(dueDate, today);

      // Overdue when due date has passed AND it’s older than payment terms window
      // i.e., days since due > payment_terms
      if (daysSinceDue > paymentTermsDays) {
        overdue.push({
          id: docSnap.id,
          ...data,
          _computed: {
            daysSinceDue,
            paymentTermsDays,
          },
        });
      }
    });

    const response = {
      hasOverdue: overdue.length > 0,
      count: overdue.length,
      invoices: overdue,
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error("❌ Failed overdue check:", error?.message || error);
    return NextResponse.json(
      { error: "Failed overdue check", details: error?.message || String(error) },
      { status: 500 }
    );
  }
}
