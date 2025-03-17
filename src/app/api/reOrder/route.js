import { db } from "@/lib/firebaseConfig"; // Firestore instance
import { doc, getDoc, setDoc } from "firebase/firestore";
import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/emailService";
import ejs from "ejs";
import fs from "fs/promises";
import path from "path";

// ✅ Function to generate an 8-digit unique order number
async function generateUniqueOrderNumber() {
  let orderNumber;
  let exists = true;

  while (exists) {
    orderNumber = `${Math.floor(10000000 + Math.random() * 90000000)}`; // e.g., 12345678
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      exists = false; // Ensures uniqueness
    }
  }

  return orderNumber;
}

export async function POST(req) {
  try {
    const { orderNumber } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    console.log(`🔎 Fetching original order: ${orderNumber}`);

    // ✅ Fetch the existing order document
    const existingOrderRef = doc(db, "orders", orderNumber);
    const existingOrderSnap = await getDoc(existingOrderRef);

    if (!existingOrderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const existingOrderData = existingOrderSnap.data();
    const { userId, companyCode, order_details, rebatePercentage, rebateAmount } = existingOrderData;

    console.log(`✅ Order found for company: ${companyCode}`);

    // ✅ Fetch the user's email from Firestore
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userData = userSnap.data();
    const email = userData.email;

    console.log(`📧 Found user email: ${email}`);

    // ✅ Generate a new unique order number
    const newOrderNumber = await generateUniqueOrderNumber();

    // ✅ Create a new order document with the duplicated data
    const newOrderData = {
      ...existingOrderData,
      orderNumber: newOrderNumber, // ✅ Assign a new unique order number
      createdAt: new Date().toISOString(), // ✅ Update the creation date
      order_status: "Pending", // ✅ Reset order status
      pickingSlipPDF: null,
      invoicePDF: null,
      deliveryNotePDF: null,
      order_canceled: false, // ✅ Reset order cancellation status
      payment_status: "Payment Pending",
    };

    // ✅ Save the duplicated order in Firestore
    const newOrderRef = doc(db, "orders", newOrderNumber);
    await setDoc(newOrderRef, newOrderData);

    console.log(`✅ Order duplicated successfully: ${newOrderNumber}`);

    // ✅ Send order confirmation email
    try {
      const templatePath = path.join(process.cwd(), "src/lib/emailTemplates/orderConfirmation.ejs");
      const templateContent = await fs.readFile(templatePath, "utf-8");
      const emailHTML = ejs.render(templateContent, {
        companyName: companyCode,
        orderNumber: newOrderNumber,
        orderDate: newOrderData.createdAt,
        orderDetails: order_details,
        rebatePercentage, // ✅ Pass rebatePercentage explicitly
        rebateAmount, // ✅ Pass rebateAmount explicitly
      });

      console.log(`📧 Sending order confirmation email to ${email}`);
      await sendEmail(email, `Order Confirmation - ${newOrderNumber}`, emailHTML);
      console.log("✅ Order confirmation email sent successfully!");
    } catch (emailError) {
      console.error("❌ Failed to send email:", emailError);
    }

    return NextResponse.json({
      message: "Order duplicated successfully and email sent",
      newOrderNumber,
    }, { status: 201 });

  } catch (error) {
    console.error("❌ Error duplicating order:", error);
    return NextResponse.json({ error: `Something went wrong: ${error.message}` }, { status: 500 });
  }
}
