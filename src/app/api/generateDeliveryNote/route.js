import { db } from "@/lib/firebaseConfig"; // Firestore
import { doc, setDoc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

export async function POST(req) {
  try {
    const { orderNumber } = await req.json();

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

    // ✅ Generate QR Code
    const qrResponse = await axios.post("https://bevgo-client.vercel.app/api/generateQRCode", {
      value: orderNumber,
    });

    if (!qrResponse.data.qrCodeURL) {
      throw new Error("QR Code generation failed");
    }

    const qrCodeURL = qrResponse.data.qrCodeURL;
    console.log(`✅ QR Code generated successfully: ${qrCodeURL}`);

    // ✅ Load the EJS template
    const templatePath = path.join(process.cwd(), "src/lib/emailTemplates/deliveryNote.ejs");
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    // ✅ Render the HTML with EJS
    const renderedHTML = ejs.render(templateContent, {
      qrCodeURL: qrCodeURL,
      logoURL: "https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo%20Header%20Banner.png?alt=media&token=fb6ef880-b618-46c5-a1c3-e9bc1dd3690e",
      companyName: "Bevgo Distributions",
      companyAddress: "6 Christelle Str, Denneburg, Paarl, Western Cape, South Africa, 7646",
      companyContact: "071 619 1616",
      companyEmail: "info@bevgo.co.za",
      companyVAT: "4760314296",
      deliveryNoteNumber: orderNumber,
      deliveryNoteDate: new Date(orderData.createdAt).toLocaleDateString(),
      customer: {
        name: userData.companyName,
        address: userData.companyAddress,
        contact: userData.companyContact,
        email: userData.email,
        vat: userData.companyVAT
      },
      cartDetails: orderData.order_details.cartDetails,
      subtotal: orderData.order_details.subtotal,
      total: orderData.order_details.total,
      vat: orderData.order_details.vat,
      rebatePercentage: orderData.order_details.rebatePercentage,
      returnableSubtotal: orderData.order_details.returnableSubtotal,
      subtotalAfterRebate: orderData.order_details.subtotalAfterRebate,
      subtotalIncludingReturnables: orderData.order_details.subtotalIncludingReturnables,
      totalItems: orderData.order_details.totalItems,
      rebateAmount: orderData.order_details.rebateAmount,
    });

    console.log("✅ Delivery Note HTML rendered successfully.");

    // ✅ Generate PDF via Cloud Function
    const pdfFileName = `dn-${orderNumber}`;
    const cloudFunctionUrl = "https://generatepdf-th2kiymgaa-uc.a.run.app";

    const response = await axios.post(cloudFunctionUrl, {
      htmlContent: renderedHTML,
      fileName: pdfFileName,
    });

    if (!response.data.pdfUrl) {
      throw new Error("PDF generation failed");
    }

    const deliveryNotePDFURL = response.data.pdfUrl;
    console.log(`✅ PDF generated successfully: ${deliveryNotePDFURL}`);

    // ✅ Save delivery note data to Firestore in the "deliveryNotes" collection
    const deliveryNoteData = {
      qrCodeURL: qrCodeURL,
      logoURL: "https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo%20Header%20Banner.png?alt=media&token=fb6ef880-b618-46c5-a1c3-e9bc1dd3690e",
      companyName: "Bevgo Distributions",
      companyAddress: "6 Christelle Str, Denneburg, Paarl, Western Cape, South Africa, 7646",
      companyContact: "071 619 1616",
      companyEmail: "info@bevgo.co.za",
      companyVAT: "4760314296",
      deliveryNoteNumber: orderNumber,
      deliveryNoteDate: new Date(orderData.createdAt).toLocaleDateString(),
      customer: {
        name: userData.companyName,
        address: userData.companyAddress,
        contact: userData.companyContact,
        email: userData.email,
        vat: userData.companyVAT
      },
      cartDetails: orderData.order_details.cartDetails,
      subtotal: orderData.order_details.subtotal,
      total: orderData.order_details.total,
      vat: orderData.order_details.vat,
      rebatePercentage: orderData.order_details.rebatePercentage,
      returnableSubtotal: orderData.order_details.returnableSubtotal,
      subtotalAfterRebate: orderData.order_details.subtotalAfterRebate,
      subtotalIncludingReturnables: orderData.order_details.subtotalIncludingReturnables,
      totalItems: orderData.order_details.totalItems,
      rebateAmount: orderData.order_details.rebateAmount,
    };

    const deliveryNoteRef = doc(db, "deliveryNotes", orderNumber);
    await setDoc(deliveryNoteRef, deliveryNoteData);
    console.log("✅ Delivery Note data saved to Firestore.");

    // ✅ Update Firestore order document with delivery note PDF URL
    await updateDoc(orderRef, {
      deliveryNotePDF: deliveryNotePDFURL,
    });
    console.log(`📤 Order updated with Delivery Note URL: ${deliveryNotePDFURL}`);

    return NextResponse.json({
      message: "Delivery note generated and saved successfully",
      deliveryNotePDFURL,
      orderNumber,
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Failed to generate delivery note:", error.message);
    return NextResponse.json({ error: "Failed to generate delivery note", details: error.message }, { status: 500 });
  }
}
