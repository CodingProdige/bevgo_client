import { db } from "@/lib/firebaseConfig";
import { collection, addDoc, query, where, getDocs, orderBy } from "firebase/firestore";
import { NextResponse } from "next/server";

// Utility: calculate available credit
async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const q = query(paymentsRef, where("companyCode", "==", companyCode));
  const snap = await getDocs(q);

  let totalCredit = 0;
  let totalAllocated = 0;

  snap.forEach((doc) => {
    const p = doc.data();
    totalCredit += Number(p.amount || 0);
    totalAllocated += Number(p.allocated || 0);
  });

  return {
    totalCredit,
    totalAllocated,
    availableCredit: totalCredit - totalAllocated
  };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { companyCode, amount, method, reference, createdBy } = body;

    if (!companyCode || !amount || !method) {
      return NextResponse.json(
        { error: "Missing required fields: companyCode, amount, method" },
        { status: 400 }
      );
    }

    const validMethods = ["Payfast", "EFT", "Card", "Cash"];
    if (!validMethods.includes(method)) {
      return NextResponse.json(
        { error: `Invalid method. Must be one of: ${validMethods.join(", ")}` },
        { status: 400 }
      );
    }

    // Default references
    let finalReference;
    if (method === "EFT") {
      if (!reference) {
        return NextResponse.json(
          { error: "Reference required for EFT payments" },
          { status: 400 }
        );
      }
      finalReference = reference;
    } else if (method === "Card") {
      finalReference = "Card Payment";
    } else if (method === "Cash") {
      finalReference = "Cash Payment";
    } else if (method === "Payfast") {
      finalReference = "Payfast Payment";
    }

    // Insert payment
    const paymentsRef = collection(db, "payments");
    const docRef = await addDoc(paymentsRef, {
      companyCode,
      amount: Number(amount),
      method,
      date: new Date().toISOString(),
      reference: finalReference,
      createdBy: createdBy || "system",
      allocated: 0,
      unallocated: Number(amount),
      createdAt: new Date().toISOString()
    });

    const creditSummary = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: "Payment captured successfully",
      paymentId: docRef.id,
      creditSummary
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to capture payment" },
      { status: 500 }
    );
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const companyCode = searchParams.get("companyCode");

    if (!companyCode) {
      return NextResponse.json(
        { error: "Missing companyCode query param" },
        { status: 400 }
      );
    }

    const paymentsRef = collection(db, "payments");
    // 🔥 Sort payments newest → oldest
    const q = query(
      paymentsRef,
      where("companyCode", "==", companyCode),
      orderBy("date", "desc")
    );

    const snap = await getDocs(q);
    const payments = [];
    snap.forEach((doc) => payments.push({ id: doc.id, ...doc.data() }));

    const creditSummary = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: "Payments retrieved successfully",
      payments,
      creditSummary
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to fetch payments" },
      { status: 500 }
    );
  }
}
