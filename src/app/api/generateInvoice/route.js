import { db, storage } from "@/lib/firebaseConfig"; // Firestore & Storage
import { doc, setDoc, getDoc, updateDoc, collection, query, where, getDocs } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { NextResponse } from "next/server";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

// 🆕 Helper function to calculate due date
const calculateDueDate = (paymentTerms) => {
  const daysToAdd = parseInt(paymentTerms, 10);
  const due = new Date();
  due.setDate(due.getDate() + (isNaN(daysToAdd) ? 0 : daysToAdd));
  return due.toLocaleDateString();
};


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
      sendEmail, // ✅ New parameter
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

    // ✅ Try to fetch the user document based on companyCode
    let userData = null;
    const usersRef = collection(db, "users");
    const usersQuery = query(usersRef, where("companyCode", "==", orderData.companyCode));
    const usersSnapshot = await getDocs(usersQuery);

    if (!usersSnapshot.empty) {
      userData = usersSnapshot.docs[0].data();
      console.log("✅ User document retrieved successfully.");
    } else {
      // ✅ If no user found, check the customers collection
      const customersRef = collection(db, "customers");
      const customersQuery = query(customersRef, where("companyCode", "==", orderData.companyCode));
      const customersSnapshot = await getDocs(customersQuery);

      if (!customersSnapshot.empty) {
        userData = customersSnapshot.docs[0].data();
        console.log("✅ Customer document retrieved successfully.");
      } else {
        return NextResponse.json({ error: "User or Customer not found" }, { status: 404 });
      }
    }

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
      dueDate: calculateDueDate(userData.payment_terms), // ✅ dynamically calculated
      customer: {
        name: userData.companyName,
        address: userData.deliveryAddress,
        contact: userData.phone_number,
        email: userData.email,
        vat: userData.vatNumber,
        payment_terms: userData.payment_terms,
        companyCode: userData.companyCode,
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
      fileName: pdfFileName,
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
        address: userData.deliveryAddress,
        contact: userData.phone_number,
        email: userData.email,
        vat: userData.vatNumber,
        payment_terms: userData.payment_terms,
        companyCode: userData.companyCode,
      },
      orderDetails: orderData.order_details,
      matchedReturnables,
      finalTotals: orderData.calcFinalTotal,
      payment_terms: userData.payment_terms,
      dueDate: calculateDueDate(userData.payment_terms), // ✅ dynamically calculated
      paymentMethod,
      payment_status: "Pending",
    };

    const invoiceRef = doc(db, "invoices", orderNumber);
    await setDoc(invoiceRef, invoiceData);
    console.log("✅ Invoice data saved to Firestore.");

    // ✅ Update Firestore order document with invoice PDF URL
    await updateDoc(orderRef, {
      invoicePDF: invoicePDFURL,
    });

    console.log(`📤 Order updated with Invoice URL: ${invoicePDFURL}`);

    // ✅ Conditionally send the invoice email if sendEmail is true
    if (sendEmail) {
      try {
        const emailAddresses = [
          companyEmail,
          userData.email,
          userData.ccEmail01,
          userData.ccEmail02,
          userData.ccEmail03,
        ].filter((email) => email); // Filter out falsy values

        const emailResponse = await axios.post(`https://bevgo-client.vercel.app/api/sendEmailTemplate`, {
          to: emailAddresses,
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
    } else {
      console.log("📧 Email sending skipped as sendEmail is false.");
    }

    return NextResponse.json({
      message: "Invoice generated and saved successfully",
      invoicePDFURL,
      orderNumber,
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Failed to generate invoice:", error.message);
    return NextResponse.json({ error: "Failed to generate invoice", details: error.message }, { status: 500 });
  }
}
