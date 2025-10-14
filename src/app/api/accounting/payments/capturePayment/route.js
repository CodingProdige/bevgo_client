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
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";


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

/* -------------------------------- POST -------------------------------- */

export async function POST(req) {
  try {
    const body = await req.json();
    let {
      companyCode,
      amount,
      method,
      reference,
      createdBy,
      paymentDate,
      grossPaid,
      fee,
      creditApplied,          // optional immediate allocation (webhook sets this for ORDER/PREORDER)
      orderNumber,            // optional link to order
      transactionNumber,      // for idempotency from webhook
      paymentContext,         // optional: ORDER | PREORDER | INVOICE (audit)
      invoiceNumber,          // optional: link to invoice
      referenceRaw            // optional: raw reference value from webhook
    } = body;

    if (!companyCode || amount === undefined || !method) {
      return NextResponse.json(
        { error: "Missing required fields: companyCode, amount, method" },
        { status: 400 }
      );
    }

    // ✅ Idempotency guard on transactionNumber
    if (transactionNumber) {
      const existing = await getDocs(
        query(collection(db, "payments"), where("transactionNumber", "==", String(transactionNumber)))
      );
      if (!existing.empty) {
        return NextResponse.json({
          message: "Payment already captured for this transactionNumber",
          paymentId: existing.docs[0].id,
          status: "DuplicateSkipped"
        }, { status: 200 });
      }
    }

    // Negative amount → treat as Credit (unchanged)
    if (amount < 0) {
      amount = Math.abs(amount);
      method = "Credit";
      reference = reference || `Returnables Credit for Order #${orderNumber || "N/A"}`;
    }

    const validMethods = ["Payfast", "EFT", "Card", "Cash", "Credit"];
    if (!validMethods.includes(method)) {
      return NextResponse.json(
        { error: `Invalid method. Must be one of: ${validMethods.join(", ")}` },
        { status: 400 }
      );
    }

    // Default reference
    let finalReference = reference;
    if (!finalReference) {
      if (method === "EFT") finalReference = "EFT Payment";
      if (method === "Card") finalReference = "Card Payment";
      if (method === "Cash") finalReference = "Cash Payment";
      if (method === "Payfast") finalReference = "Payfast Payment";
      if (method === "Credit") finalReference = "Returnables Credit";
    }

    const now = new Date().toISOString();
    const paymentNumber = await generateUniquePaymentNumber();

    // Ensure appliedCredit never exceeds amount
    const appliedCredit = creditApplied
      ? Math.min(Number(creditApplied), Number(amount))
      : 0;

    const paymentDoc = {
      companyCode,
      paymentNumber,
      amount: Number(amount),
      grossPaid: grossPaid ? Number(grossPaid) : null,
      fee: fee ? Number(fee) : null,
      method,
      reference: finalReference,
      paymentDate: paymentDate || now,
      createdBy: createdBy || "system",
      allocated: appliedCredit,
      unallocated: Number(amount) - appliedCredit,
      creditAllocations: appliedCredit > 0 ? [
        {
          orderNumber: orderNumber || null,
          invoiceNumber: invoiceNumber || null,
          amount: appliedCredit,
          date: now,
          createdBy: createdBy || "system"
        }
      ] : [],
      createdAt: now,
      date: now,
      deleted: false,
      // 🔎 new fields for audit/idempotency
      transactionNumber: transactionNumber ? String(transactionNumber) : null,
      payfastContext: paymentContext || null,
      referenceRaw: referenceRaw || null,
      orderNumber: orderNumber || null,
      invoiceNumber: invoiceNumber || null,
    };

    const paymentsRef = collection(db, "payments");
    const docRef = await addDoc(paymentsRef, paymentDoc);

    const creditSummary = await getAvailableCredit(companyCode);

    return NextResponse.json({
      message: "Payment captured successfully",
      paymentId: docRef.id,
      paymentNumber,
      status: appliedCredit > 0
        ? (appliedCredit === Number(amount) ? "Fully Allocated" : "Partially Allocated")
        : "Unallocated",
      creditSummary,
      paymentDoc
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to capture payment" },
      { status: 500 }
    );
  }
}




/**
 * GET - List payments (with optional PDF export, date filtering, and companyName enrichment)
 */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    let companyCode = searchParams.get("companyCode");
    const isAdmin = searchParams.get("isAdmin") === "true";
    const generatePdf = searchParams.get("generatePdf") === "true";
    const fromDate = searchParams.get("fromDate")
      ? new Date(searchParams.get("fromDate"))
      : null;
    const toDate = searchParams.get("toDate")
      ? new Date(searchParams.get("toDate"))
      : null;

    // 🔹 If toDate exists, push to end of day
    if (toDate) {
      toDate.setHours(23, 59, 59, 999);
    }

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

    // 🔹 Build query (filter by company if not admin)
    if (!isAdmin && companyCode) {
      q = query(
        paymentsRef,
        where("companyCode", "==", companyCode),
        orderBy("paymentDate", "desc")
      );
    } else {
      q = query(paymentsRef, orderBy("paymentDate", "desc"));
    }

    const snap = await getDocs(q);
    let paymentsRaw = [];
    const companyCodes = [];

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      if (data.deleted) continue;

      // 🔹 Normalize payment date (fallback to `date`)
      const paymentDate = data.paymentDate || data.date;
      if (!paymentDate) continue;

      const ts = new Date(paymentDate);
      // 🔹 Apply date range filtering if provided
      if (fromDate && ts < fromDate) continue;
      if (toDate && ts > toDate) continue;

      paymentsRaw.push({ paymentId: docSnap.id, ...data, paymentDate: ts });
      if (data.companyCode) companyCodes.push(data.companyCode);
    }

    // 🔹 Sort payments again in JS just in case
    paymentsRaw.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));

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

    const creditSummary =
      !isAdmin && companyCode ? await getAvailableCredit(companyCode) : null;

    // --- If PDF requested ---
    if (generatePdf) {
      const templatePath = path.join(
        process.cwd(),
        "src/lib/templates/paymentspdf.ejs"
      );
      const templateContent = fs.readFileSync(templatePath, "utf-8");

      const renderedHTML = ejs.render(templateContent, {
        payments,
        companyCode: companyCode || "ALL CUSTOMERS",
        isAdmin,
        creditSummary,
        fromDate,
        toDate,
      });

      const pdfRes = await axios.post(
        "https://generatepdf-th2kiymgaa-uc.a.run.app/generatepdf",
        {
          htmlContent: renderedHTML,
          fileName: `payments-${companyCode || "ALL"}-${Date.now()}`,
        }
      );

      if (!pdfRes.data?.pdfUrl) {
        throw new Error("PDF generation failed");
      }

      return NextResponse.json({
        message: "Payments PDF generated successfully",
        pdfUrl: pdfRes.data.pdfUrl,
        payments,
        creditSummary,
      });
    }

    // --- Default JSON response ---
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
 * Example: DELETE /api/accounting/payments/capturePayment?paymentNumber=123&companyCode=DC2070&deletedBy=info@bevgo.co.za
 */
export async function DELETE(req) {
  try {
    const { searchParams } = new URL(req.url);
    const paymentNumber = searchParams.get("paymentNumber");
    const companyCode = searchParams.get("companyCode");
    const deletedBy = searchParams.get("deletedBy");

    if (!paymentNumber || !companyCode) {
      return NextResponse.json(
        { error: "Missing required query params: paymentNumber, companyCode" },
        { status: 400 }
      );
    }

    // 🔎 Find payment doc by paymentNumber + companyCode
    const paymentsRef = collection(db, "payments");
    const q = query(
      paymentsRef,
      where("paymentNumber", "==", paymentNumber),
      where("companyCode", "==", companyCode)
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    const paymentDoc = snap.docs[0];
    const paymentRef = paymentDoc.ref;
    const payment = paymentDoc.data();

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
      paymentNumber,
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

