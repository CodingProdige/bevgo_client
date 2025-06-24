import { db } from "@/lib/firebaseConfig";
import {
  collection,
  query,
  where,
  getDocs,
  addDoc
} from "firebase/firestore";
import { NextResponse } from "next/server";

// ✅ Transaction types
export const TRANSACTION_TYPES = [
  "Invoice",
  "Payment",
  "Credit",
  "Adjustment",
  "Refund"
];

// ✅ Generate unique 10-digit transaction ID
async function generateUniqueTransactionId() {
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    const id = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const existing = await getDocs(
      query(collection(db, "accountTransactions"), where("transactionId", "==", id))
    );
    if (existing.empty) return id;
  }
  throw new Error("Failed to generate unique transaction ID after multiple attempts.");
}

// ✅ Generate fallback note (only used if `note` not supplied)
function generateNote(type, invoiceNumber = null, reference = null, reason = null) {
  switch (type) {
    case "Invoice":
      return `Invoice #${invoiceNumber} issued`;
    case "Payment":
      return `POP${reference ? ` #${reference}` : ""}${invoiceNumber ? ` - EFT received for Invoice #${invoiceNumber}` : " - EFT received"}`;
    case "Credit":
      return `Manual credit issued${reason ? ` - ${reason}` : ""}${invoiceNumber ? ` - Ref INV #${invoiceNumber}` : ""}`;
    case "Adjustment":
      return `Admin adjustment${reason ? ` to ${reason}` : ""}${invoiceNumber ? ` on Invoice #${invoiceNumber}` : ""}`;
    case "Refund":
      return `Refund processed${reason ? ` - ${reason}` : ""}${invoiceNumber ? ` for Invoice #${invoiceNumber}` : ""}`;
    default:
      return "";
  }
}

export async function POST(req) {
  try {
    const {
      companyCode,
      type,
      amount,
      note = null,
      linkedInvoice = null,
      reference = null,
      reason = null,
      createdBy = "system",
      previewOnly = false,
      dateCreated = null
    } = await req.json();

    if (!companyCode || !type || typeof amount !== "number") {
      return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
    }

    if (!TRANSACTION_TYPES.includes(type)) {
      return NextResponse.json({ error: "Invalid transaction type" }, { status: 400 });
    }

    // Fetch invoices and transactions
    const [invoicesSnap, transactionsSnap] = await Promise.all([
      getDocs(query(collection(db, "invoices"), where("customer.companyCode", "==", companyCode))),
      getDocs(query(collection(db, "accountTransactions"), where("companyCode", "==", companyCode)))
    ]);

    const existingLinkedInvoices = new Set();
    let lastBalance = 0;
    let latestDate = null;

    transactionsSnap.forEach(doc => {
      const tx = doc.data();
      if (tx.linkedInvoice) existingLinkedInvoices.add(tx.linkedInvoice);
      if (!latestDate || new Date(tx.dateCreated) > new Date(latestDate)) {
        latestDate = tx.dateCreated;
        lastBalance = tx.updated_balance;
      }
    });

    const simulatedEntries = [];

    // Backfill missing invoices
    const missingInvoices = invoicesSnap.docs
      .map(doc => doc.data())
      .filter(inv => {
        const total = parseFloat(inv.finalTotals?.finalTotal || 0);
        return inv.orderNumber && !existingLinkedInvoices.has(inv.orderNumber) && !isNaN(total);
      })
      .sort((a, b) => new Date(a.invoiceDate) - new Date(b.invoiceDate));

    for (const inv of missingInvoices) {
      const invoiceTotal = parseFloat(inv.finalTotals?.finalTotal || 0);
      const invoiceDate = new Date(inv.invoiceDate);
      const orderNumber = inv.orderNumber;

      // 1. Invoice entry
      const invoiceTx = {
        companyCode,
        type: "Invoice",
        amount: -invoiceTotal,
        starting_balance: lastBalance,
        updated_balance: lastBalance - invoiceTotal,
        note: generateNote("Invoice", orderNumber),
        linkedInvoice: orderNumber,
        dateCreated: invoiceDate.toISOString(),
        createdBy: "system-backfill",
        transactionId: await generateUniqueTransactionId(),
        reversed: false
      };
      lastBalance = invoiceTx.updated_balance;
      simulatedEntries.push(invoiceTx);
      if (!previewOnly) await addDoc(collection(db, "accountTransactions"), invoiceTx);

      // 2. Payment (if invoice is settled)
      const isPaid = inv.payment_status?.toLowerCase() === "paid";
      if (isPaid) {
        const paymentDate = inv.paymentDate
          ? new Date(inv.paymentDate)
          : new Date(invoiceDate.getTime() + 1000);
        const paymentTx = {
          companyCode,
          type: "Payment",
          amount: invoiceTotal,
          starting_balance: lastBalance,
          updated_balance: lastBalance + invoiceTotal,
          note: generateNote("Payment", orderNumber),
          linkedInvoice: orderNumber,
          dateCreated: paymentDate.toISOString(),
          createdBy: "system-backfill",
          transactionId: await generateUniqueTransactionId(),
          reversed: false
        };
        lastBalance = paymentTx.updated_balance;
        simulatedEntries.push(paymentTx);
        if (!previewOnly) await addDoc(collection(db, "accountTransactions"), paymentTx);
      }
    }

    // Main user-supplied transaction
    const userTx = {
      companyCode,
      type,
      amount,
      starting_balance: lastBalance,
      updated_balance: lastBalance + amount,
      note: note || generateNote(type, linkedInvoice, reference, reason),
      linkedInvoice,
      dateCreated: dateCreated || new Date().toISOString(),
      createdBy,
      transactionId: await generateUniqueTransactionId(),
      reversed: false
    };

    simulatedEntries.push(userTx);
    if (!previewOnly) await addDoc(collection(db, "accountTransactions"), userTx);

    return NextResponse.json({
      message: previewOnly
        ? "Preview of transactions that would be created"
        : `Transaction created. ${missingInvoices.length} invoices backfilled.`,
      transactions: simulatedEntries
    });

  } catch (err) {
    console.error("❌ Error:", err);
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}
