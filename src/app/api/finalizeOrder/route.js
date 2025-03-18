import path from "path";
import { promises as fs } from "fs";
import ejs from "ejs";
import { sendEmail } from "@/lib/emailService";
import { db } from "@/lib/firebaseConfig";
import { doc, setDoc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const CART_TOTALS_API_URL = "https://bevgo-client.vercel.app/api/cartTotals";

// ✅ Function to generate an 8-digit unique order number
async function generateUniqueOrderNumber() {
  let orderNumber;
  let exists = true;

  while (exists) {
    orderNumber = `${Math.floor(10000000 + Math.random() * 90000000)}`;
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      exists = false; 
    }
  }
  return orderNumber;
}

// ✅ Function to determine rebate percentage based on subtotal (excluding VAT & returnables)
function calculateRebate(subtotal) {
  if (subtotal > 10000) return 2.0;
  if (subtotal > 5000) return 1.5;
  return 1.0;
}

export async function POST(req) {
  try {
    const { userId, payment_terms } = await req.json();

    if (!userId) {
      return NextResponse.json({ error: "Missing userId or payment_terms" }, { status: 400 });
    }

    // ✅ Fetch user details to get companyCode
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { companyCode, email } = userSnap.data();
    if (!companyCode) {
      return NextResponse.json({ error: "Company code not found" }, { status: 400 });
    }

    // ✅ Fetch cart totals
    const response = await fetch(CART_TOTALS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Failed to fetch cart totals" }, { status: 500 });
    }

    const cartData = await response.json();
    if (cartData.totalItems === 0) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    // ✅ Calculate rebate
    const rebatePercentage = calculateRebate(cartData.subtotal);
    const rebateAmount = (cartData.subtotal * rebatePercentage) / 100;

    // ✅ Generate unique order number
    const orderNumber = await generateUniqueOrderNumber();

    // ✅ Save order to Firestore
    const orderDetails = {
      orderNumber,
      userId,
      companyCode,
      payment_terms,
      order_status: "Pending",
      createdAt: new Date().toISOString(),
      pickingSlipPDF: null,
      invoicePDF: null,
      deliveryNotePDF: null,
      order_details: cartData,
      rebatePercentage,
      rebateAmount,
      order_canceled: false,
      payment_status: "Payment Pending",
    };

    const orderRef = doc(db, "orders", orderNumber);
    await setDoc(orderRef, orderDetails);

    // ✅ Clear user's cart
    await updateDoc(userRef, { cart: [] });

    // 📧 ✅ Send Order Confirmation Email
    const templatePath = path.join(process.cwd(), "src", "lib", "emailTemplates", "orderConfirmation.ejs");

    try {
      const templateContent = await fs.readFile(templatePath, "utf-8");
      const emailHTML = ejs.render(templateContent, {
        companyName: userSnap.data().companyName, // ✅ Ensure company name is passed
        orderNumber,
        companyCode,
        email,
        orderDetails: cartData,
        rebateAmount,
        rebatePercentage,
        orderDate: new Date().toLocaleString(), // ✅ Fix for missing `orderDate`
      });

      await sendEmail(email, `Your Order Confirmation - ${orderNumber}`, emailHTML);
      console.log(`📧 Order confirmation sent to ${email}`);
    } catch (emailError) {
      console.error("❌ Failed to send order confirmation email:", emailError);
    }

    return NextResponse.json({
      message: "Order finalized successfully",
      orderNumber,
      rebatePercentage,
      rebateAmount,
    }, { status: 201 });

  } catch (error) {
    console.error("❌ Error finalizing order:", error);
    return NextResponse.json({ error: "Something went wrong", details: error.message }, { status: 500 });
  }
}
