import { db, storage } from "@/lib/firebaseConfig"; // Firestore & Storage
import { doc, setDoc, getDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { NextResponse } from "next/server";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
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
      logoURL
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
      finalTotals: orderData.calcFinalTotal
    });

    console.log("✅ Invoice HTML rendered successfully.");

    // ✅ Convert HTML to PDF using Puppeteer
    const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(renderedHTML, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({ format: "A4" });

    await browser.close();
    console.log("✅ Invoice PDF generated successfully.");

    // ✅ Upload PDF to Firebase Storage
    const fileName = `invoices/${orderNumber}.pdf`;
    const fileRef = ref(storage, fileName);
    await uploadBytes(fileRef, pdfBuffer, { contentType: "application/pdf" });

    // ✅ Get the public download URL
    const invoicePDFURL = await getDownloadURL(fileRef);
    console.log(`✅ Invoice uploaded successfully: ${invoicePDFURL}`);

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
      finalTotals: orderData.calcFinalTotal
    };

    const invoiceRef = doc(db, "invoices", orderNumber);
    await setDoc(invoiceRef, invoiceData);
    console.log("✅ Invoice data saved to Firestore.");

    // ✅ Update Firestore order document with invoice PDF URL
    await updateDoc(orderRef, { invoicePDF: invoicePDFURL });
    console.log(`📤 Order updated with Invoice URL: ${invoicePDFURL}`);

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
