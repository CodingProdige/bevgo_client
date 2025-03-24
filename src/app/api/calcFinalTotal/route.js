import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";

export async function POST(req) {
  try {
    const { orderNumber, cardOrCash, returnsExclVat } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    const VAT_PERCENTAGE = 0.15; // 15% VAT
    const YOCO_PERCENTAGE = 0.0295; // 2.95% Yoco fee
    const YOCO_FIXED_FEE = 0.50; // Fixed R0.50 fee

    // ✅ Fetch order details from Firestore
    const orderRef = doc(db, "orders", orderNumber);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const orderData = orderSnap.data();
    const {
      subtotal,
      subtotalAfterRebate,
      subtotalIncludingReturnables,
      rebateAmount,
      rebatePercentage,
      vat,
      total,
      returnableSubtotal, // ✅ Use this as the "returnablesAdded"
    } = orderData.order_details;

    // ✅ Step 1: Calculate the VAT on the subtotal including returnables
    const recalculatedVAT = subtotalIncludingReturnables * VAT_PERCENTAGE;

    // ✅ Step 2: Calculate total including VAT
    let adjustedTotal = subtotalIncludingReturnables + recalculatedVAT;

    let yocoFee = 0;

    // ✅ Step 3: Apply Yoco fee only if payment method is Card
    if (cardOrCash === "Card") {
      yocoFee = adjustedTotal * YOCO_PERCENTAGE + YOCO_FIXED_FEE;
      adjustedTotal += yocoFee;
    }

    // ✅ Step 4: Deduct returnables (incl. VAT) at the end
    const returnablesInclVAT = (returnsExclVat || 0) * (1 + VAT_PERCENTAGE);
    adjustedTotal -= returnablesInclVAT;

    return NextResponse.json({
      subtotalBeforeVAT: subtotal.toFixed(2),
      subtotalAfterRebate: subtotalAfterRebate.toFixed(2),
      subtotalIncludingReturnables: subtotalIncludingReturnables.toFixed(2),
      returnablesAdded: returnableSubtotal.toFixed(2), // ✅ Show actual returnable subtotal from order
      returnablesDeducted: returnablesInclVAT.toFixed(2), // ✅ Deducted at the end with VAT included
      recalculatedVAT: recalculatedVAT.toFixed(2),
      yocoFee: yocoFee.toFixed(2),
      finalTotal: adjustedTotal.toFixed(2),
      rebateAmount: rebateAmount.toFixed(2),
      paymentMethod: cardOrCash || "N/A",
      rebatePercentage: rebatePercentage,
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Error adjusting total:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
