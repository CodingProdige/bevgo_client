import { db } from "@/lib/firebaseConfig";
import { doc, setDoc, getDoc, updateDoc, collection, query, where, getDocs } from "firebase/firestore";
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

    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const orderData = orderSnap.data();
    console.log("✅ Order details retrieved successfully.");

    let userData = null;

    const usersRef = collection(db, "users");
    const userQuery = query(usersRef, where("companyCode", "==", orderData.companyCode));
    const userSnap = await getDocs(userQuery);

    if (!userSnap.empty) {
      userData = userSnap.docs[0].data();
      console.log("✅ User details retrieved successfully.");
    } else {
      console.log("❌ User not found, checking customers collection...");

      const customersRef = collection(db, "customers");
      const customerQuery = query(customersRef, where("companyCode", "==", orderData.companyCode));
      const customerSnap = await getDocs(customerQuery);

      if (!customerSnap.empty) {
        userData = customerSnap.docs[0].data();
        console.log("✅ Customer details retrieved successfully from customers collection.");
      } else {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }
    }

    console.log("✅ Final userData used in delivery note:", userData);

    const qrResponse = await axios.post("https://bevgo-client.vercel.app/api/generateQRCode", {
      value: orderNumber,
    });

    if (!qrResponse.data.qrCodeURL) {
      throw new Error("QR Code generation failed");
    }

    const qrCodeURL = qrResponse.data.qrCodeURL;

    const templatePath = path.join(process.cwd(), "src/lib/emailTemplates/deliveryNote.ejs");
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    const orderDetails = orderData?.order_details ?? {};

    // 🆕 Include the new delivery fields
    const renderedHTML = ejs.render(templateContent, {
      qrCodeURL,
      logoURL: "https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo%20Header%20Banner.png?alt=media&token=fb6ef880-b618-46c5-a1c3-e9bc1dd3690e",
      companyName: "Bevgo Distributions",
      companyAddress: "6 Christelle Str, Denneburg, Paarl, Western Cape, South Africa, 7646",
      companyContact: "071 619 1616",
      companyEmail: "info@bevgo.co.za",
      companyVAT: "4760314296",
      deliveryNoteNumber: orderNumber,
      deliveryNoteDate: new Date(orderData.createdAt).toLocaleDateString(),
      customer: {
        name: userData?.companyName || "",
        address: userData?.deliveryAddress || "",
        contact: userData?.phone_number || "",
        email: userData?.email || "",
        vat: (typeof userData?.vatNumber === "number" || /^\d+$/.test(userData?.vatNumber)) ? userData.vatNumber : "",
        payment_terms: userData?.payment_terms || "",
        companyCode: userData?.companyCode || "",
      },
      cartDetails: orderDetails.cartDetails || [],
      subtotal: orderDetails.subtotal || 0,
      total: orderDetails.total || 0,
      vat: orderDetails.vat || 0,
      rebatePercentage: orderDetails.rebatePercentage || 0,
      returnableSubtotal: orderDetails.returnableSubtotal || 0,
      subtotalAfterRebate: orderDetails.subtotalAfterRebate || 0,
      subtotalIncludingReturnables: orderDetails.subtotalIncludingReturnables || 0,
      totalItems: orderDetails.totalItems || 0,
      rebateAmount: orderDetails.rebateAmount || 0,
      deliveryInstructions: orderData.deliveryInstructions || "",
      deliveryAddress: orderData.deliveryAddress || "",        // 🆕 Added
      deliveryPostalCode: orderData.deliveryPostalCode || ""   // 🆕 Added
    });

    console.log("✅ Delivery Note HTML rendered successfully.");

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

    // 🆕 Store deliveryAddress + postalCode in Firestore too
    const deliveryNoteData = {
      qrCodeURL,
      logoURL: "https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo%20Header%20Banner.png?alt=media&token=fb6ef880-b618-46c5-a1c3-e9bc1dd3690e",
      companyName: "Bevgo Distributions",
      companyAddress: "6 Christelle Str, Denneburg, Paarl, Western Cape, South Africa, 7646",
      companyContact: "071 619 1616",
      companyEmail: "info@bevgo.co.za",
      companyVAT: "4760314296",
      deliveryNoteNumber: orderNumber,
      deliveryNoteDate: new Date(orderData.createdAt).toLocaleDateString(),
      customer: {
        name: userData?.companyName || "",
        address: userData?.deliveryAddress || "",
        contact: userData?.phone_number || "",
        email: userData?.email || "",
        vat: (typeof userData?.vatNumber === "number" || /^\d+$/.test(userData?.vatNumber)) ? userData.vatNumber : "",
        payment_terms: userData?.payment_terms || "",
        companyCode: userData?.companyCode || "",
      },
      cartDetails: orderDetails.cartDetails || [],
      subtotal: orderDetails.subtotal || 0,
      total: orderDetails.total || 0,
      vat: orderDetails.vat || 0,
      rebatePercentage: orderDetails.rebatePercentage || 0,
      returnableSubtotal: orderDetails.returnableSubtotal || 0,
      subtotalAfterRebate: orderDetails.subtotalAfterRebate || 0,
      subtotalIncludingReturnables: orderDetails.subtotalIncludingReturnables || 0,
      totalItems: orderDetails.totalItems || 0,
      rebateAmount: orderDetails.rebateAmount || 0,
      deliveryInstructions: orderData.deliveryInstructions || "",
      deliveryAddress: orderData.deliveryAddress || "",        // 🆕 Added
      deliveryPostalCode: orderData.deliveryPostalCode || ""   // 🆕 Added
    };

    const deliveryNoteRef = doc(db, "deliveryNotes", orderNumber);
    await setDoc(deliveryNoteRef, deliveryNoteData);

    await updateDoc(orderRef, {
      deliveryNotePDF: deliveryNotePDFURL,
    });

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
