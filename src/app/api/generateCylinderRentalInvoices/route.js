// app/api/generateCylinderRentalInvoices/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, doc, setDoc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";
import axios from "axios";

// 🔎 Date helpers
function getLastMonthRange() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  return { firstDay, lastDay };
}

// 🔎 Unique invoice number generator
async function generateUniqueInvoiceNumber() {
  let unique = false;
  let invoiceNumber;
  while (!unique) {
    invoiceNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
    const existing = await getDoc(doc(db, "invoices", invoiceNumber));
    if (!existing.exists()) unique = true;
  }
  return invoiceNumber;
}

// 🛠 Core invoice processing logic
async function processInvoices({ testRun = false, testEmail, testCompanyCode, firebaseWrite = true }) {
  const { firstDay, lastDay } = getLastMonthRange();
  const results = [];
  let companyCodes = [];

  // Determine companies to process
  if (testRun && testCompanyCode) {
    companyCodes = [testCompanyCode];
  } else {
    const usersRef = collection(db, "users");
    const snap = await getDocs(usersRef);
    companyCodes = snap.docs.map(doc => doc.data().companyCode).filter(Boolean);
  }

  for (const companyCode of companyCodes) {
    try {
      // 🗃 Fetch rentals
      let rentals;
      if (testRun && !testCompanyCode) {
        rentals = [
          {
            cylinder_serial: "TEST123",
            product_details: { product_title: "Suremix 100 Small", rental_fee_excl: 260, product_image: "" },
            customer_details: {
              companyName: "Demo Company",
              deliveryAddress: "123 Test Street, Paarl",
              phone_number: "0710001111",
              email: testEmail || "demo@example.com",
              vat: "123456789",
              companyCode: "TEST001",
              payment_terms: "7",
            }
          }
        ];
      } else {
        const cylRes = await axios.post(
          "https://bevgo-pricelist.vercel.app/api/suremixTracking/getCylinders",
          { companyCode, isAdmin: false }
        );
        rentals = cylRes.data.cylinders.filter(cyl => {
          if (!cyl.rental_start) return false;
          const start = new Date(cyl.rental_start);
          return start >= firstDay && start <= lastDay;
        });
      }

      if (rentals.length === 0) {
        results.push({ companyCode, status: "skipped", reason: "No rentals last month" });
        continue;
      }

      // 🧮 Totals
      const subtotal = rentals.reduce((s, c) => s + (c.product_details?.rental_fee_excl || 0), 0);
      const vat = subtotal * 0.15;
      const finalTotal = subtotal + vat;

      // 🧾 Customer
      const customerRaw = rentals[0].customer_details || { companyCode, email: testEmail };
      const safeCustomer = {
        name: customerRaw.companyName || "",
        address: customerRaw.deliveryAddress || "",
        contact: customerRaw.phone_number || "",
        email: testRun && testEmail ? testEmail : customerRaw.email || "",
        vat: customerRaw.vat || "",
        companyCode: customerRaw.companyCode || "",
        payment_terms: customerRaw.payment_terms || "0"
      };

      const invoiceNumber = await generateUniqueInvoiceNumber();
      const invoiceDate = new Date().toISOString();
      const dueDate = new Date(invoiceDate);
      dueDate.setDate(dueDate.getDate() + parseInt(safeCustomer.payment_terms || "0"));

      // 🛒 Cart
      const cartDetails = rentals.map(c => ({
        product_title: c.product_details.product_title,
        product_image: c.product_details.product_image || "",
        unique_code: c.cylinder_serial,
        quantity: 1, // each cylinder is unique
        price_excl: c.product_details.rental_fee_excl,
        total_price: c.product_details.rental_fee_excl
      }));

      const finalTotals = {
        subtotalBeforeVAT: subtotal.toFixed(2),
        rebatePercentage: 0,
        paymentMethod: "EFT",
        subtotalIncludingReturnables: subtotal.toFixed(2),
        rebateAmount: "0.00",
        subtotalAfterRebate: subtotal.toFixed(2),
        recalculatedVAT: vat.toFixed(2),
        returnablesAdded: "0.00",
        yocoFee: "0.00",
        finalTotal: finalTotal.toFixed(2),
        returnablesDeducted: "0.00"
      };

      const invoiceData = {
        orderNumber: invoiceNumber,
        invoiceNumber,
        companyName: "Bevgo Distributions",
        companyAddress: "Unit 2, 4 EK Green Str. Charleston Hill, Paarl, Western Cape, South Africa, 7646",
        companyContact: "071 619 1616",
        companyEmail: "info@bevgo.co.za",
        companyVAT: 4760314296,
        invoiceDate,
        dueDate: dueDate.toISOString(),
        customer: safeCustomer,
        orderDetails: {
          cartDetails,
          subtotal: subtotal.toFixed(2),
          vat: vat.toFixed(2),
          total: finalTotal.toFixed(2),
          subtotalIncludingReturnables: subtotal.toFixed(2),
          subtotalAfterRebate: subtotal.toFixed(2),
          rebatePercentage: 0,
          rebateAmount: 0,
          returnableSubtotal: 0,
          totalItems: cartDetails.length
        },
        finalTotals,
        returns: [],
        paymentMethod: "EFT",
        invoicePDFURL: null,
        payment_status: "Pending",
        type: "Rental",
        createdAt: new Date().toISOString(),
        is_test_invoice: testRun ? true : false
      };

      if (firebaseWrite) {
        await setDoc(doc(db, "invoices", invoiceNumber), invoiceData);
      }

      results.push({ companyCode, status: "success", invoiceNumber, finalTotal });
    } catch (err) {
      results.push({ companyCode, status: "error", error: err.message });
    }
  }

  return results;
}

// POST for testing / manual
export async function POST(req) {
  const body = await req.json();
  const results = await processInvoices(body);
  return NextResponse.json({ message: "Cylinder rental invoices processed", results });
}

// GET for cron (monthly)
export async function GET() {
  const results = await processInvoices({ testRun: false, firebaseWrite: true });
  return NextResponse.json({ message: "Cylinder rental invoices processed", results });
}
