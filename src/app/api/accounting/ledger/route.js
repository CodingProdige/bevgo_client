export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";

// 🔹 Utility: apply date filters
function inDateRange(entryDate, fromDate, toDate) {
  const ts = new Date(entryDate).getTime();
  if (fromDate && ts < new Date(fromDate).getTime()) return false;
  if (toDate && ts > new Date(toDate).getTime()) return false;
  return true;
}

export async function POST(req) {
  try {
    const {
      companyCode,
      fromDate,
      toDate,
      isAdmin = false,
      returnAll = false,
      generatePdf = false
    } = await req.json();

    // 🔹 Validation
    if (!companyCode && !returnAll) {
      return NextResponse.json(
        { error: "Missing companyCode (or set returnAll=true)" },
        { status: 400 }
      );
    }

    // 🔹 Helper to fetch docs (supports nested field)
    const fetchDocs = async (coll, fieldPath) => {
      let q = collection(db, coll);
      if (!returnAll && companyCode) {
        q = query(q, where(fieldPath, "==", companyCode));
      }
      const snap = await getDocs(q);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    };

    // --- Fetch invoices + payments ---
    const [invoices, payments] = await Promise.all([
      fetchDocs("invoices", "customer.companyCode"), // ✅ nested field path
      fetchDocs("payments", "companyCode")
    ]);

    const ledger = [];

    // 🔹 Invoices → Debit
    invoices.forEach((inv) => {
      const settledDate = inv.date_settled || inv.invoiceDate;
      if (!inDateRange(settledDate, fromDate, toDate)) return;

      // double-check companyCode match
      if (!returnAll && companyCode && inv?.customer?.companyCode !== companyCode) return;

      ledger.push({
        type: "Invoice",
        id: inv.orderNumber || inv.id,
        companyCode: inv?.customer?.companyCode || null,
        date: settledDate,
        debit: Number(inv.finalTotals?.finalTotal || 0),
        credit: 0,
        status: inv.payment_status || "Pending"
      });
    });

    // 🔹 Payments → Credit
    payments.forEach((p) => {
      const effectiveDate = p.paymentDate || p.date;
      if (!inDateRange(effectiveDate, fromDate, toDate)) return;

      ledger.push({
        type: "Payment",
        id: p.id,
        companyCode: p.companyCode || null,
        date: effectiveDate,
        debit: 0,
        credit: Number(p.amount || 0),
        method: p.method,
        reference: p.reference,
        allocated: p.allocated || 0,
        unallocated: p.unallocated || 0,
        status: p.deleted ? "Deleted" : p.status || "Captured"
      });
    });

    // 🔹 Sort chronologically
    ledger.sort((a, b) => new Date(a.date) - new Date(b.date));

    // 🔹 Running balance
    let balance = 0;
    const ledgerWithBalance = ledger.map((entry) => {
      balance += entry.debit - entry.credit; // debit increases, credit decreases
      return { ...entry, balanceAfter: balance };
    });

    // --- If PDF requested ---
    if (generatePdf) {
      const templatePath = path.join(
        process.cwd(),
        "src/lib/templates/ledgerpdf.ejs"
      );
      const templateContent = fs.readFileSync(templatePath, "utf-8");

      const renderedHTML = ejs.render(templateContent, {
        companyCode: returnAll ? "ALL CUSTOMERS" : companyCode,
        fromDate,
        toDate,
        entries: ledgerWithBalance
      });

      const pdfRes = await axios.post(
        "https://generatepdf-th2kiymgaa-uc.a.run.app/generatepdf",
        {
          htmlContent: renderedHTML,
          fileName: `ledger-${returnAll ? "ALL" : companyCode}-${Date.now()}`
        }
      );

      if (!pdfRes.data?.pdfUrl) {
        throw new Error("PDF generation failed");
      }

      return NextResponse.json({
        message: "Ledger PDF generated successfully",
        pdfUrl: pdfRes.data.pdfUrl,
        ledger: ledgerWithBalance
      });
    }

    // --- Default JSON response ---
    return NextResponse.json({
      message: "Ledger retrieved successfully",
      companyCode: returnAll ? "ALL CUSTOMERS" : companyCode,
      ledger: ledgerWithBalance
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to fetch ledger" },
      { status: 500 }
    );
  }
}
