import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs, setDoc, doc } from "firebase/firestore";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/emailService";

export async function POST(req) {
  try {
    const { companyCode, sendToCustomer, alternativeEmail, fromDate, toDate, overDueOnly } = await req.json();

    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    const now = new Date();
    const invoicesRef = collection(db, "invoices");
    const q = query(invoicesRef, where("customer.companyCode", "==", companyCode));
    const invoicesSnap = await getDocs(q);

    if (invoicesSnap.empty) {
      return NextResponse.json({ error: "No invoices found for this company" }, { status: 404 });
    }

    let rawInvoices = invoicesSnap.docs.map(doc => doc.data());

    // Optional filtering by date range with safety checks
    const validFromDate = fromDate && fromDate !== "null" ? new Date(fromDate) : null;
    const validToDate = toDate && toDate !== "null" ? new Date(toDate) : null;

    if (validFromDate || validToDate) {
      rawInvoices = rawInvoices.filter(inv => {
        const invDate = new Date(inv.invoiceDate);

        if (validFromDate) validFromDate.setHours(0, 0, 0, 0);
        if (validToDate) validToDate.setHours(23, 59, 59, 999);

        return (!validFromDate || invDate >= validFromDate) && (!validToDate || invDate <= validToDate);
      });
    }

    // Optional filtering by overdue only
    if (overDueOnly) {
      rawInvoices = rawInvoices.filter(inv => inv.payment_status === "Pending");
    }

    if (rawInvoices.length === 0) {
      return NextResponse.json({ error: "No matching invoices found" }, { status: 404 });
    }

    const customer = rawInvoices[0].customer;
    let totalOutstanding = 0;

    const formatCurrency = (value) => {
      return new Intl.NumberFormat("en-ZA", {
        style: "currency",
        currency: "ZAR"
      }).format(value);
    };

    const invoices = rawInvoices.map(inv => {
      const totalStr = inv.finalTotals?.finalTotal || inv.orderDetails?.total;
      const total = parseFloat(totalStr) || 0;
      if (inv.payment_status === "Pending") {
        totalOutstanding += total;
      }
      return {
        orderNumber: inv.orderNumber,
        invoiceDate: new Date(inv.invoiceDate).toLocaleDateString(),
        dueDate: inv.dueDate || "N/A",
        status: inv.payment_status || "N/A",
        total: formatCurrency(total),
        pdfURL: inv.invoicePDFURL
      };
    });

    const templatePath = path.join(process.cwd(), "src/lib/emailTemplates/accountStatementTemplate.ejs");
    const templateContent = fs.readFileSync(templatePath, "utf-8");
    const renderedHTML = ejs.render(templateContent, {
      customer,
      companyName: rawInvoices[0].companyName,
      companyAddress: rawInvoices[0].companyAddress,
      companyContact: rawInvoices[0].companyContact,
      companyEmail: rawInvoices[0].companyEmail,
      companyVAT: rawInvoices[0].companyVAT,
      invoices,
      totalOutstanding: formatCurrency(totalOutstanding),
      statementDate: now.toLocaleDateString()
    });

    const statementId = uuidv4();
    const response = await axios.post("https://generatepdf-th2kiymgaa-uc.a.run.app", {
      htmlContent: renderedHTML,
      fileName: `statement-${companyCode}`
    });

    const pdfUrl = response.data.pdfUrl;

    await setDoc(doc(db, "accountStatements", statementId), {
      customer,
      companyCode,
      pdfUrl,
      dateGenerated: now.toISOString(),
      totalOutstanding: totalOutstanding.toFixed(2)
    });

    if (sendToCustomer || alternativeEmail) {
      const toAddress = alternativeEmail || customer.email;
      const subject = `Requested Account Statement - ${now.toLocaleDateString()}`;
      const htmlMessage = `
        <p>Hi ${customer.name},</p>
        <p>Here is your requested account statement. You can view or download it using the link below:</p>
        <p><a href="${pdfUrl}" target="_blank">View Statement</a></p>
        <p>If you have any questions, feel free to contact us.</p>
        <p>Best regards,<br/>Bevgo Team</p>
      `;

      const emailResult = await sendEmail(toAddress, subject, htmlMessage);
      if (!emailResult.success) {
        throw new Error("Email failed: " + emailResult.error);
      }
    }

    return NextResponse.json({
      message: "Account statement generated successfully",
      companyCode,
      pdfUrl,
      totalOutstanding: totalOutstanding.toFixed(2)
    });
  } catch (error) {
    console.error("❌ Failed to generate statement:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}