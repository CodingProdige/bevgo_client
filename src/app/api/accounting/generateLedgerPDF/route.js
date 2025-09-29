export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const {
      companyCode,
      fromDate,
      toDate,
      includeExpenses = false,
      isAdmin = false,
      returnAll = false,
    } = await req.json();

    // 🔹 Validation
    if (!companyCode && !returnAll) {
      return NextResponse.json(
        { error: "Missing companyCode (or set returnAll=true)" },
        { status: 400 }
      );
    }

    // --- Fetch ledger data ---
    const ledgerUrl = `${process.env.BASE_URL}/api/accounting/ledger?companyCode=${companyCode || ""}&fromDate=${
      fromDate || ""
    }&toDate=${toDate || ""}&includeExpenses=${includeExpenses}&isAdmin=${isAdmin}&returnAll=${returnAll}`;

    const ledgerRes = await fetch(ledgerUrl, { cache: "no-store" });
    if (!ledgerRes.ok) {
      throw new Error(`Ledger API failed (${ledgerRes.status})`);
    }
    const ledgerData = await ledgerRes.json();

    if (!ledgerData.ledger || !Array.isArray(ledgerData.ledger)) {
      throw new Error("Ledger data missing or invalid");
    }

    // --- Load EJS template ---
    const templatePath = path.join(
      process.cwd(),
      "src/lib/templates/ledgerpdf.ejs"
    );
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    // --- Render HTML with debit/credit ledger ---
    const renderedHTML = ejs.render(templateContent, {
      companyCode: returnAll ? "ALL CUSTOMERS" : companyCode,
      fromDate,
      toDate,
      entries: ledgerData.ledger,
    });

    // --- Generate PDF via microservice ---
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
    });
  } catch (err) {
    console.error("generateLedgerPDF error:", err.message);
    return NextResponse.json(
      { error: err.message || "Failed to generate Ledger PDF" },
      { status: 500 }
    );
  }
}
