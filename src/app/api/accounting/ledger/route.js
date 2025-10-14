export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";

// 🔹 Utility: apply date filters AFTER running balance
function isInRange(entryDate, fromDate, toDate) {
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
      generatePdf = false,
    } = await req.json();

    if (!companyCode && !returnAll) {
      return NextResponse.json(
        { error: "Missing companyCode (or set returnAll=true)" },
        { status: 400 }
      );
    }

    // 🔹 Helper to fetch docs (supports nested field)
    const fetchDocs = async (coll, fieldPath) => {
      let qRef = collection(db, coll);
      if (!returnAll && companyCode) {
        qRef = query(qRef, where(fieldPath, "==", companyCode));
      }
      // NOTE: we intentionally do NOT filter out deleted payments here,
      // because we want to *show* them (but zero them out in math).
      const snap = await getDocs(qRef);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    };

    const [invoices, payments] = await Promise.all([
      fetchDocs("invoices", "customer.companyCode"),
      fetchDocs("payments", "companyCode"),
    ]);

    const ledger = [];

    // 🔹 Invoices → Debit
    invoices.forEach((inv) => {
      const settledDate = inv.date_settled || inv.invoiceDate;
      ledger.push({
        type: "Invoice",
        id: inv.orderNumber || inv.id,
        companyCode: inv?.customer?.companyCode || null,
        date: settledDate,
        debit: Number(inv.finalTotals?.finalTotal || 0),
        credit: 0,
        status: inv.payment_status || "Pending",
      });
    });

    // 🔹 Payments → Credit (show deleted but zero them out so totals/balance exclude them)
    payments.forEach((p) => {
      const effectiveDate = p.paymentDate || p.date;
      const isDeleted = p.deleted === true;

      ledger.push({
        type: "Payment",
        id: p.id,
        companyCode: p.companyCode || null,
        date: effectiveDate,
        debit: 0,
        // Deleted payments are visible but excluded from math
        credit: isDeleted ? 0 : Number(p.amount || 0),
        method: p.method,
        reference: p.reference,
        allocated: isDeleted ? 0 : (p.allocated || 0),
        unallocated: isDeleted ? 0 : (p.unallocated || 0),
        status: isDeleted ? "Deleted" : (p.status || "Captured"),
        // Optional UI helpers:
        note: isDeleted ? `Deleted${p.deletedAt ? ` on ${p.deletedAt}` : ""}` : undefined,
        originalCredit: isDeleted ? Number(p.amount || 0) : undefined,
      });
    });

    // 🔹 Sort ALL entries chronologically
    ledger.sort((a, b) => new Date(a.date) - new Date(b.date));

    // 🔹 Running balance across ALL history
    let balance = 0;
    const fullLedger = ledger.map((entry) => {
      balance += entry.debit - entry.credit;
      return { ...entry, balanceAfter: balance };
    });

    // 🔹 Slice by requested date range
    const filteredLedger = fullLedger.filter((entry) =>
      isInRange(entry.date, fromDate, toDate)
    );

    // 🔹 Opening balance (balance carried before first in-range entry)
    const openingBalance =
      filteredLedger.length > 0
        ? fullLedger.find(
            (e) => new Date(e.date) < new Date(filteredLedger[0].date)
          )?.balanceAfter || 0
        : 0;

    // 🔹 Closing balance (last in-range balance)
    const closingBalance =
      filteredLedger.length > 0
        ? filteredLedger[filteredLedger.length - 1].balanceAfter
        : openingBalance;

    // 🔹 Totals
    const totals = filteredLedger.reduce(
      (acc, e) => {
        acc.debit += e.debit;
        acc.credit += e.credit;
        return acc;
      },
      { debit: 0, credit: 0 }
    );

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
        entries: filteredLedger,
        openingBalance,
        closingBalance,
        totals,
      });

      const pdfRes = await axios.post(
        "https://generatepdf-th2kiymgaa-uc.a.run.app/generatepdf",
        {
          htmlContent: renderedHTML,
          fileName: `ledger-${returnAll ? "ALL" : companyCode}-${Date.now()}`,
        }
      );

      if (!pdfRes.data?.pdfUrl) {
        throw new Error("PDF generation failed");
      }

      return NextResponse.json({
        message: "Ledger PDF generated successfully",
        pdfUrl: pdfRes.data.pdfUrl,
        ledger: filteredLedger,
        openingBalance,
        closingBalance,
        totals,
      });
    }

    return NextResponse.json({
      message: "Ledger retrieved successfully",
      companyCode: returnAll ? "ALL CUSTOMERS" : companyCode,
      ledger: filteredLedger,
      openingBalance,
      closingBalance,
      totals,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to fetch ledger" },
      { status: 500 }
    );
  }
}
