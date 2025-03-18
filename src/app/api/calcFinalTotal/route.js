import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { orderTotal, cardOrCash, returnableTotal } = await req.json();

    if (!orderTotal) {
      return NextResponse.json({ error: "Missing orderTotal" }, { status: 400 });
    }

    const VAT_PERCENTAGE = 0.15; // 15% VAT
    const YOCO_PERCENTAGE = 0.0295; // 2.95% YOCO fee
    const YOCO_FIXED_FEE = 0.50; // Fixed R0.50 fee

    // ✅ Step 1: Extract the base subtotal (EXCLUDING VAT) from orderTotal
    let baseSubtotal = orderTotal * (1 - VAT_PERCENTAGE);

    // ✅ Step 2: Deduct returnableTotal (since it's already VAT exclusive)
    let newSubtotalExclVAT = baseSubtotal - (returnableTotal || 0);

    // ✅ Step 3: Recalculate VAT on the new subtotal
    let newVAT = newSubtotalExclVAT * VAT_PERCENTAGE;

    // ✅ Step 4: Compute new total including VAT
    let adjustedTotal = newSubtotalExclVAT + newVAT;

    let yocoFee = 0;

    // ✅ Step 5: Apply YOCO fees if payment is by card
    if (cardOrCash === "card") {
      yocoFee = adjustedTotal * YOCO_PERCENTAGE + YOCO_FIXED_FEE;
      adjustedTotal += yocoFee;
    }

    return NextResponse.json({
      originalTotal: orderTotal.toFixed(2),
      subtotalBeforeVAT: baseSubtotal.toFixed(2),
      returnablesDeducted: (returnableTotal || 0).toFixed(2),
      newSubtotalExclVAT: newSubtotalExclVAT.toFixed(2),
      recalculatedVAT: newVAT.toFixed(2),
      yocoFee: yocoFee.toFixed(2),
      finalTotal: adjustedTotal.toFixed(2),
      paymentMethod: cardOrCash || "N/A",
    }, { status: 200 });

  } catch (error) {
    console.error("❌ Error adjusting total:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
