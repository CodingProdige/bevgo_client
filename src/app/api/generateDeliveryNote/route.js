import { db, storage } from "@/lib/firebaseConfig"; // Firestore & Storage instance
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { NextResponse } from "next/server";
import fetch from "node-fetch"; // Ensure node-fetch is available
import ejs from "ejs";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { v4 as uuidv4 } from "uuid"; // Generate unique file names

const QR_CODE_API_URL = "https://bevgo-client.vercel.app/api/generateQRCode";

export async function POST(req) {
  try {
    const { orderNumber } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    console.log(`📌 Fetching order details for Order: ${orderNumber}`);

    // ✅ Fetch the order document from Firestore
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const orderData = orderSnap.data();
    console.log("✅ Order details retrieved successfully.");

    // ✅ Generate QR Code for this order
    console.log("⏳ Generating QR Code...");
    const qrResponse = await fetch(QR_CODE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: orderNumber }),
    });

    if (!qrResponse.ok) {
      const qrText = await qrResponse.text();
      console.error("❌ QR Code API request failed:", qrText);
      return NextResponse.json({ error: "QR Code API request failed", details: qrText }, { status: 500 });
    }

    const qrJson = await qrResponse.json();
    const qrCodeURL = qrJson.qrCodeURL;
    console.log(`✅ QR Code Generated Successfully: ${qrCodeURL}`);

    // ✅ Update Firestore order document with QR Code URL
    await updateDoc(orderRef, { qrCodeURL });
    console.log(`📤 Order updated with QR Code: ${qrCodeURL}`);

    // ✅ Extract order details
    const {
      cartDetails = [], // Default empty array
      subtotal = 0,
      rebatePercentage = 0,
      rebateAmount = 0,
      vat = 0,
      total = 0,
    } = orderData.order_details || {};

    // ✅ Load the EJS template
    const templatePath = path.join(process.cwd(), "src/lib/emailTemplates/deliveryNote.ejs");
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    // ✅ Render the HTML with EJS
    const renderedHTML = ejs.render(templateContent, {
      logoUrl: "https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo_Main_Logo%20-%20Google%20Version%201000x500.png?alt=media&token=bf97d121-8a9b-4949-abd7-8d707f78d4a1",
      qrCodePath: qrCodeURL,
      orderNumber,
      orderDate: new Date(orderData.createdAt).toLocaleDateString(), // ✅ Format date
      companyCode: orderData.companyCode || "N/A",
      paymentStatus: orderData.payment_status || "N/A",
      cartItems: cartDetails, // ✅ Ensures the product list is passed
      subtotal,
      rebatePercentage,
      rebateAmount,
      vat,
      total,
    });

    console.log("✅ Delivery note HTML rendered successfully.");

    // ✅ Convert HTML to PDF using Puppeteer
    const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] }); // ✅ Fix Vercel issue
    const page = await browser.newPage();
    await page.setContent(renderedHTML, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({ format: "A4" });

    await browser.close();
    console.log("✅ Delivery note PDF generated successfully.");

    // ✅ Upload PDF to Firebase Storage
    const pdfFileName = `deliveryNotes/${orderNumber}-${uuidv4()}.pdf`;
    const storageRef = ref(storage, pdfFileName);
    await uploadBytes(storageRef, pdfBuffer, { contentType: "application/pdf" });

    // ✅ Get the public URL of the uploaded PDF
    const deliveryNotePDF = await getDownloadURL(storageRef);
    console.log(`✅ Delivery Note PDF uploaded successfully: ${deliveryNotePDF}`);

    // ✅ Update Firestore with the delivery note URL
    await updateDoc(orderRef, { deliveryNotePDF });
    console.log(`📤 Order updated with Delivery Note PDF: ${deliveryNotePDF}`);

    // ✅ Respond with success
    return NextResponse.json({
      message: "Delivery note generated successfully",
      qrCodeURL,
      deliveryNotePDF, // ✅ Return the PDF URL
      orderNumber,
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Failed to generate delivery note:", error.message);
    return NextResponse.json({ error: "Failed to generate delivery note", details: error.message }, { status: 500 });
  }
}
