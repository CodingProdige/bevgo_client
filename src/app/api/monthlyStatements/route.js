import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs, setDoc, doc } from "firebase/firestore";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/emailService";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const isTest = searchParams.get("test") === "true";

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const usersSnap = await getDocs(collection(db, "users"));
    const customersSnap = await getDocs(collection(db, "customers"));
    const allCustomers = [...usersSnap.docs, ...customersSnap.docs].map(doc => doc.data());

    const templatePath = path.join(process.cwd(), "src/lib/emailTemplates/accountStatementTemplate.ejs");
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    const formatCurrency = (value) => {
      return new Intl.NumberFormat("en-ZA", {
        style: "currency",
        currency: "ZAR"
      }).format(value);
    };

    let slackLog = [];

    for (const customer of allCustomers) {
      const companyCode = customer.companyCode;
      const invoicesSnap = await getDocs(query(collection(db, "invoices"), where("customer.companyCode", "==", companyCode)));

      if (invoicesSnap.empty) continue;

      const filteredInvoices = invoicesSnap.docs
        .map(doc => doc.data())
        .filter(inv => {
          const invDate = new Date(inv.invoiceDate);
          return invDate.getMonth() === currentMonth && invDate.getFullYear() === currentYear;
        });

      if (filteredInvoices.length === 0) continue;

      let totalOutstanding = 0;
      const invoices = filteredInvoices.map(inv => {
        const totalStr = inv.finalTotals?.finalTotal || inv.orderDetails?.total;
        const total = parseFloat(totalStr) || 0;
        if (inv.payment_status === "Pending") totalOutstanding += total;

        return {
          orderNumber: inv.orderNumber,
          invoiceDate: new Date(inv.invoiceDate).toLocaleDateString(),
          dueDate: inv.dueDate || "N/A",
          status: inv.payment_status || "N/A",
          total: formatCurrency(total),
          pdfURL: inv.invoicePDFURL
        };
      });

      const renderedHTML = ejs.render(templateContent, {
        customer,
        companyName: filteredInvoices[0].companyName,
        companyAddress: filteredInvoices[0].companyAddress,
        companyContact: filteredInvoices[0].companyContact,
        companyEmail: filteredInvoices[0].companyEmail,
        companyVAT: filteredInvoices[0].companyVAT,
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

      await setDoc(doc(db, "monthlyStatements", statementId), {
        customer,
        companyCode,
        pdfUrl,
        dateGenerated: now.toISOString(),
        totalOutstanding: totalOutstanding.toFixed(2)
      });

      slackLog.push(`✅ ${customer.name || companyCode} — ${invoices.length} invoices — ${formatCurrency(totalOutstanding)}`);

      if (!isTest && customer.email) {
        const subject = `Your Monthly Statement - ${now.toLocaleDateString()}`;
        const htmlMessage = `
          <p>Hi ${customer.name},</p>
          <p>Please find your monthly account statement attached. You can view or download it using the link below:</p>
          <p><a href="${pdfUrl}" target="_blank">View Statement</a></p>
          <p>If you have any questions, feel free to contact us.</p>
          <p>Warm regards,<br/>Bevgo Team</p>
        `;

        await sendEmail(customer.email, subject, htmlMessage);
      }
    }

    if (slackLog.length > 0) {
      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: `📄 Monthly Statements Summary (${now.toLocaleDateString()}):\n\n${slackLog.join("\n")}`
      });
    }

    return NextResponse.json({
      message: `Monthly statements ${isTest ? "simulated" : "sent"} successfully!`,
      customersProcessed: slackLog.length,
      log: slackLog
    });
  } catch (error) {
    console.error("❌ Failed to send monthly statements:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
