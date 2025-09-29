import { db } from "@/lib/firebaseConfig";
import {
  collection,
  addDoc,
  query,
  where,
  getDocs,
  orderBy,
  doc,
  updateDoc,
  getDoc
} from "firebase/firestore";
import { NextResponse } from "next/server";

// 🔹 Utility: derive payment status
function computePaymentStatus(p) {
  if (p.deleted) return "Deleted";
  if ((p.allocated || 0) > 0 && (p.unallocated || 0) > 0) return "Partially Allocated";
  if ((p.unallocated || 0) === 0 && (p.allocated || 0) > 0) return "Fully Allocated";
  return "Unallocated";
}

// 🔹 Utility: calculate available credit
async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const q = query(paymentsRef, where("companyCode", "==", companyCode));
  const snap = await getDocs(q);

  let totalCredit = 0;
  let totalAllocated = 0;

  snap.forEach((doc) => {
    const p = doc.data();
    if (p.deleted) return;
    totalCredit += Number(p.amount || 0);
    totalAllocated += Number(p.allocated || 0);
  });

  return {
    totalCredit,
    totalAllocated,
    availableCredit: totalCredit - totalAllocated
  };
}

// 🔹 Utility: generate unique 8-digit payment number
async function generateUniquePaymentNumber() {
  let unique = false;
  let paymentNumber;

  while (!unique) {
    paymentNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
    const existing = await getDocs(
      query(collection(db, "payments"), where("paymentNumber", "==", paymentNumber))
    );
    if (existing.empty) unique = true;
  }

  return paymentNumber;
}

/**
 * POST - Create new payment
 */
export async function POST(req) {
  try {
    const body = await req.json();
    const { companyCode, amount, method, reference, createdBy, paymentDate } = body;

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

    const now = new Date().toISOString();
    const paymentNumber = await generateUniquePaymentNumber();

    // Insert payment
    const paymentsRef = collection(db, "payments");
    const docRef = await addDoc(paymentsRef, {
      companyCode,
      paymentNumber,
      amount: Number(amount),
      method,
      reference: finalReference,
      paymentDate: paymentDate || now, // ⬅️ bank/payment date
      createdBy: createdBy || "system",
      allocated: 0,
      unallocated: Number(amount),
      createdAt: now,
      date: now, // capture timestamp
      deleted: false
    });

    const creditSummary = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: "Payment captured successfully",
      paymentId: docRef.id,
      paymentNumber,
      status: "Unallocated",
      creditSummary
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to capture payment" },
      { status: 500 }
    );
  }
}

/**
 * GET - List payments (lightweight, no allocations, with companyName enrichment)
 */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    let companyCode = searchParams.get("companyCode");
    const isAdmin = searchParams.get("isAdmin") === "true";

    // 🔹 If admin, ignore companyCode (global view)
    if (isAdmin) {
      companyCode = null;
    }

    if (!isAdmin && !companyCode) {
      return NextResponse.json(
        { error: "companyCode is required when isAdmin=false" },
        { status: 400 }
      );
    }

    const paymentsRef = collection(db, "payments");
    let q;

    if (!isAdmin && companyCode) {
      q = query(
        paymentsRef,
        where("companyCode", "==", companyCode),
        orderBy("date", "desc")
      );
    } else {
      // Admin: ignore companyCode, return all payments
      q = query(paymentsRef, orderBy("date", "desc"));
    }

    const snap = await getDocs(q);
    const paymentsRaw = [];
    const companyCodes = [];

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      if (data.deleted) continue;

      paymentsRaw.push({ paymentId: docSnap.id, ...data });
      if (data.companyCode) companyCodes.push(data.companyCode);
    }

    // 🔹 Deduplicate companyCodes and fetch names in batch
    const uniqueCodes = [...new Set(companyCodes)];
    const companyNames = {};

    await Promise.all(
      uniqueCodes.map(async (code) => {
        try {
          const res = await fetch("https://bevgo-client.vercel.app/api/getUser", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ companyCode: code }),
          });

          if (res.ok) {
            const json = await res.json();
            companyNames[code] = json?.data?.companyName || null;
          } else {
            companyNames[code] = null;
          }
        } catch (err) {
          console.error(`Failed to fetch companyName for ${code}:`, err.message);
          companyNames[code] = null;
        }
      })
    );

    // 🔹 Attach companyName + status
    const payments = paymentsRaw.map((p) => ({
      ...p,
      status: computePaymentStatus(p),
      companyName: companyNames[p.companyCode] || "Unknown",
    }));

    const creditSummary = !isAdmin && companyCode
      ? await getAvailableCredit(companyCode)
      : null;

    return NextResponse.json({
      message: "Payments retrieved successfully",
      payments,
      creditSummary,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to fetch payments" },
      { status: 500 }
    );
  }
}






/**
 * PUT - Edit payment (only if unallocated)
 */
export async function PUT(req) {
  try {
    const { paymentId, companyCode, amount, method, reference, paymentDate, updatedBy } =
      await req.json();

    if (!paymentId || !companyCode) {
      return NextResponse.json(
        { error: "Missing required fields: paymentId, companyCode" },
        { status: 400 }
      );
    }

    const paymentRef = doc(db, "payments", paymentId);
    const paymentSnap = await getDoc(paymentRef);

    if (!paymentSnap.exists()) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    const payment = paymentSnap.data();

    if (payment.deleted) {
      return NextResponse.json(
        { error: "Cannot edit a deleted payment" },
        { status: 400 }
      );
    }

    if ((payment.allocated || 0) > 0) {
      return NextResponse.json(
        { error: "Cannot edit a payment that has already been allocated" },
        { status: 400 }
      );
    }

    const updates = {};
    if (amount !== undefined) {
      updates.amount = Number(amount);
      updates.unallocated = Number(amount);
      updates.allocated = 0;
    }
    if (method !== undefined) updates.method = method;
    if (reference !== undefined) updates.reference = reference;
    if (paymentDate !== undefined) updates.paymentDate = paymentDate; // ✅ allow editing paymentDate
    updates.updatedAt = new Date().toISOString();
    updates.updatedBy = updatedBy || "system";

    await updateDoc(paymentRef, updates);

    const creditSummary = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: "Payment updated successfully",
      paymentId,
      updatedFields: updates,
      status: computePaymentStatus({ ...payment, ...updates }),
      creditSummary
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to update payment" },
      { status: 500 }
    );
  }
}


/**
 * DELETE - Soft delete payment (via query params)
 * Example: DELETE /api/accounting/payments/capturePayment?paymentId=123&companyCode=DC2070&deletedBy=info@bevgo.co.za
 */
export async function DELETE(req) {
  try {
    const { searchParams } = new URL(req.url);
    const paymentId = searchParams.get("paymentId");
    const companyCode = searchParams.get("companyCode");
    const deletedBy = searchParams.get("deletedBy");

    if (!paymentId || !companyCode) {
      return NextResponse.json(
        { error: "Missing required query params: paymentId, companyCode" },
        { status: 400 }
      );
    }

    const paymentRef = doc(db, "payments", paymentId);
    const paymentSnap = await getDoc(paymentRef);

    if (!paymentSnap.exists()) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    const payment = paymentSnap.data();

    // 🚫 Prevent deletion if already allocated
    if (payment.allocated > 0) {
      return NextResponse.json(
        { error: "Cannot delete a payment that has already been allocated to an invoice" },
        { status: 400 }
      );
    }

    // ✅ Soft delete
    await updateDoc(paymentRef, {
      deleted: true,
      deletedAt: new Date().toISOString(),
      deletedBy: deletedBy || "system",
    });

    const creditSummary = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: "Payment deleted successfully (soft-delete)",
      paymentId,
      status: "Deleted",
      creditSummary,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to delete payment" },
      { status: 500 }
    );
  }
}
