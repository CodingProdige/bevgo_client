// app/api/sendPendingInvoices/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, updateDoc, doc } from "firebase/firestore";
import { NextResponse } from "next/server";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";

// 🛠 Core processing logic
async function processPendingInvoices({ skipEmailsForTest = true }) {
  const invoicesRef = collection(db, "invoices");
  const snap = await getDocs(invoicesRef);

  const results = [];
  let totalIncl = 0;

  for (const d of snap.docs) {
    const invoice = d.data();
    if (invoice.payment_status !== "Pending" || !invoice.type || invoice.type !== "Cylinder Rental") continue;

    try {
      // Always regenerate PDF
      const templatePath = path.join(process.cwd(), "src/lib/emailTemplates/cylinderRentalInvoice.ejs");
      const templateContent = fs.readFileSync(templatePath, "utf-8");

      const renderedHTML = ejs.render(templateContent, {
        ...invoice,
        cylinders: invoice.orderDetails.cartDetails.map(c => ({
          product: c.product_title,
          serial: c.unique_code,
          rental_fee: c.price_excl
        })),
        totals: {
          excl: invoice.finalTotals.subtotalBeforeVAT,
          vat: invoice.finalTotals.recalculatedVAT,
          incl: invoice.finalTotals.finalTotal
        }
      });

      const pdfRes = await axios.post("https://generatepdf-th2kiymgaa-uc.a.run.app/generatepdf", {
        htmlContent: renderedHTML,
        fileName: `rental-inv-${invoice.invoiceNumber}`
      });

      if (!pdfRes.data?.pdfUrl) throw new Error("PDF generation failed");
      const invoicePDFURL = pdfRes.data.pdfUrl;

      // Update invoice doc with fresh PDF
      await updateDoc(doc(db, "invoices", invoice.invoiceNumber), { invoicePDFURL });

      // Send email unless flagged as test
      if (!(skipEmailsForTest && invoice.is_test_invoice)) {
        await axios.post("https://bevgo-client.vercel.app/api/sendEmail", {
          to: invoice.customer.email,
          subject: `Cylinder Rental Invoice - #${invoice.invoiceNumber}`,
          template: "sendRentalInvoiceEmail",
          data: {
            invoiceNumber: invoice.invoiceNumber,
            invoicePDFURL,
            invoiceDate: invoice.invoiceDate,
            invoiceTotal: invoice.finalTotals.finalTotal,
            companyName: invoice.customer.name
          },
          emailOptOut: false,
          unsubscribeUrl: "https://client-portal.bevgo.co.za/unsubscribe"
        });
      }

      results.push({ invoiceNumber: invoice.invoiceNumber, status: "success", total: invoice.finalTotals.finalTotal });
      totalIncl += parseFloat(invoice.finalTotals.finalTotal);
    } catch (err) {
      results.push({ invoiceNumber: invoice.invoiceNumber, status: "error", error: err.message });
    }
  }

  return { results, totalIncl };
}

// POST for testing
export async function POST(req) {
  const body = await req.json();
  const { results, totalIncl } = await processPendingInvoices(body);
  return NextResponse.json({ message: "Pending invoices processed", results, totalIncl });
}

// GET for cron (every few minutes)
export async function GET() {
  const { results, totalIncl } = await processPendingInvoices({ skipEmailsForTest: true });
  return NextResponse.json({ message: "Pending invoices processed", results, totalIncl });
}
