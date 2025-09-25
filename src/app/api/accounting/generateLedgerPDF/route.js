export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode, fromDate, toDate, includeExpenses = false } = await req.json();

    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    // --- Fetch ledger data from your existing ledger API ---
    const ledgerRes = await fetch(
      `${process.env.BASE_URL}/api/accounting/ledger?companyCode=${companyCode}&fromDate=${fromDate || ""}&toDate=${toDate || ""}&includeExpenses=${includeExpenses}`,
      { cache: "no-store" }
    );
    const ledgerData = await ledgerRes.json();

    if (!ledgerData.ledger) {
      throw new Error("Ledger data missing");
    }

    // --- Load EJS template ---
    const templatePath = path.join(process.cwd(), "src/lib/templates/ledgerpdf.ejs");
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    const renderedHTML = ejs.render(templateContent, {
      companyCode,
      fromDate,
      toDate,
      entries: ledgerData.ledger
    });

    // --- Call PDF microservice ---
    const pdfRes = await axios.post("https://generatepdf-th2kiymgaa-uc.a.run.app/generatepdf", {
      htmlContent: renderedHTML,
      fileName: `ledger-${companyCode}-${Date.now()}`
    });

    if (!pdfRes.data?.pdfUrl) {
      throw new Error("PDF generation failed");
    }

    return NextResponse.json({
      message: "Ledger PDF generated successfully",
      pdfUrl: pdfRes.data.pdfUrl
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
