import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";

export async function POST(req) {
  try {
    const { orderNumber, cardOrCash, returnsExclVat } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    const VAT_PERCENTAGE = 0.15; 
    const YOCO_PERCENTAGE = 0.0295; 
    const YOCO_FIXED_FEE = 0.50; 

    // ✅ Fetch order details
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
      returnableSubtotal,
      appliedCredit = 0
    } = orderData.order_details;

    // ✅ Step 1: VAT
    const recalculatedVAT = subtotalIncludingReturnables * VAT_PERCENTAGE;

    // ✅ Step 2: Total incl VAT
    let adjustedTotal = subtotalIncludingReturnables + recalculatedVAT;

    let yocoFee = 0;
    if (cardOrCash === "Card") {
      yocoFee = adjustedTotal * YOCO_PERCENTAGE + YOCO_FIXED_FEE;
      adjustedTotal += yocoFee;
    }

    // ✅ Step 3: Deduct returnables (incl VAT)
    const returnablesInclVAT = (returnsExclVat || 0) * (1 + VAT_PERCENTAGE);
    adjustedTotal -= returnablesInclVAT;

    // ✅ Step 4: Deduct applied credit (can go negative, that’s fine)
    adjustedTotal -= appliedCredit;

    // ✅ Normalize -0.00 → 0.00
    if (Math.abs(adjustedTotal) < 0.005) {
      adjustedTotal = 0;
    }

    // ✅ Step 5: Decide payment method
    let paymentMethod = cardOrCash || "N/A";
    if (appliedCredit > 0 && adjustedTotal <= 0) {
      paymentMethod = "Available Credit";
    } else if (appliedCredit > 0 && adjustedTotal > 0) {
      paymentMethod = `Available Credit + ${cardOrCash || "N/A"}`;
    }

    return NextResponse.json({
      subtotalBeforeVAT: subtotal.toFixed(2),
      subtotalAfterRebate: subtotalAfterRebate.toFixed(2),
      subtotalIncludingReturnables: subtotalIncludingReturnables.toFixed(2),
      returnablesAdded: returnableSubtotal.toFixed(2),
      returnablesDeducted: returnablesInclVAT.toFixed(2),
      recalculatedVAT: recalculatedVAT.toFixed(2),
      yocoFee: yocoFee.toFixed(2),
      finalTotal: adjustedTotal.toFixed(2),   // ✅ reduced by appliedCredit
      rebateAmount: rebateAmount.toFixed(2),
      rebatePercentage,
      appliedCredit: appliedCredit.toFixed(2),
      paymentMethod
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Error adjusting total:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
