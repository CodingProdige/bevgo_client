import { db, storage } from "@/lib/firebaseConfig"; // Firestore & Storage
import { doc, setDoc, getDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { NextResponse } from "next/server";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

export async function POST(req) {
  try {
    const {
      orderNumber,
      matchedReturnables,
      companyName,
      companyAddress,
      companyContact,
      companyEmail,
      companyVAT,
      logoURL,
      paymentMethod,
    } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    console.log(`📌 Fetching order details for Order Number: ${orderNumber}`);

    // ✅ Fetch the order document
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const orderData = orderSnap.data();
    console.log("✅ Order details retrieved successfully.");

    // ✅ Fetch the user document based on companyCode
    const userRef = doc(db, "users", orderData.userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userData = userSnap.data();
    console.log("✅ Customer details retrieved successfully.");

    // ✅ Load the EJS template
    const templatePath = path.join(process.cwd(), "src/lib/emailTemplates/invoiceTemplate.ejs");
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    // ✅ Render the HTML with EJS
    const renderedHTML = ejs.render(templateContent, {
      logoURL,
      companyName,
      companyAddress,
      companyContact,
      companyEmail,
      companyVAT,
      invoiceNumber: orderNumber,
      invoiceDate: new Date(orderData.createdAt).toLocaleDateString(),
      dueDate: "Due on Delivery",
      customer: {
        name: userData.companyName,
        address: userData.companyAddress,
        contact: userData.companyContact,
        email: userData.email,
        vat: userData.companyVAT
      },
      orderDetails: orderData.order_details,
      matchedReturnables,
      finalTotals: orderData.calcFinalTotal,
      paymentMethod,
    });

    console.log("✅ Invoice HTML rendered successfully.");

    // ✅ Generate PDF via Cloud Function
    const pdfFileName = `inv-${orderNumber}`;
    const cloudFunctionUrl = "https://generatepdf-th2kiymgaa-uc.a.run.app";

    const response = await axios.post(cloudFunctionUrl, {
      htmlContent: renderedHTML,
      fileName: pdfFileName
    });

    if (!response.data.pdfUrl) {
      throw new Error("PDF generation failed");
    }

    const invoicePDFURL = response.data.pdfUrl;
    console.log(`✅ PDF generated successfully: ${invoicePDFURL}`);

    // ✅ Save invoice data to Firestore in the "invoices" collection
    const invoiceData = {
      orderNumber,
      invoicePDFURL,
      invoiceDate: new Date().toISOString(),
      companyName,
      companyAddress,
      companyContact,
      companyEmail,
      companyVAT,
      customer: {
        name: userData.companyName,
        address: userData.companyAddress,
        contact: userData.companyContact,
        email: userData.email,
        vat: userData.companyVAT
      },
      orderDetails: orderData.order_details,
      matchedReturnables,
      finalTotals: orderData.calcFinalTotal,
      payment_terms: userData.payment_terms,
      paymentMethod,
      payment_status: "Pending",
    };

    const invoiceRef = doc(db, "invoices", orderNumber);
    await setDoc(invoiceRef, invoiceData);
    console.log("✅ Invoice data saved to Firestore.");

    // ✅ Update Firestore order document with invoice PDF URL
    await updateDoc(orderRef, { 
      invoicePDF: invoicePDFURL,
      payment_terms: userData.payment_terms,
      paymentMethod,
    });
    console.log(`📤 Order updated with Invoice URL: ${invoicePDFURL}`);

    // ✅ Send the invoice email to the customer
    try {
      const emailResponse = await axios.post(`https://bevgo-client.vercel.app/api/sendEmailTemplate`, {
        to: userData.email,
        subject: `Invoice for Order #${orderNumber}`,
        templateName: "sendInvoiceEmail",
        data: {
          orderNumber,
          invoicePDFURL: invoicePDFURL,
        },
      });

      if (emailResponse.data.error) {
        console.error("❌ Failed to send invoice email:", emailResponse.data.error);
      } else {
        console.log("✅ Invoice email sent successfully!");
      }
    } catch (emailError) {
      console.error("❌ Failed to send invoice email:", emailError.message);
    }

    return NextResponse.json({
      message: "Invoice generated and saved successfully",
      invoicePDFURL,
      orderNumber
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Failed to generate invoice:", error.message);
    return NextResponse.json({ error: "Failed to generate invoice", details: error.message }, { status: 500 });
  }
}
