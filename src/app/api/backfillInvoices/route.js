// This endpoint will backfill all missing invoice and payment transactions across all users and customers
// Plain JavaScript version using Firebase Admin SDK

import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where, doc, setDoc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

function generateTransactionId(existingIds) {
  let id;
  do {
    id = Math.floor(1000000000 + Math.random() * 9000000000).toString();
  } while (existingIds.has(id));
  existingIds.add(id);
  return id;
}

export async function POST() {
  try {
    const customersSnap = await getDocs(collection(db, "customers"));
    const usersSnap = await getDocs(collection(db, "users"));
    const customerDocs = [...customersSnap.docs, ...usersSnap.docs];

    const allResults = [];
    const usedTransactionIds = new Set();

    for (const customerDoc of customerDocs) {
      const customerData = customerDoc.data();
      const companyCode = customerData.companyCode;
      if (!companyCode) continue;

      const invoiceSnap = await getDocs(
        query(collection(db, "invoices"), where("customer.companyCode", "==", companyCode))
      );
      if (invoiceSnap.empty) continue;

      const invoices = invoiceSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      invoices.sort((a, b) => new Date(a.invoiceDate) - new Date(b.invoiceDate));

      const transactionsSnap = await getDocs(
        query(collection(db, "accountTransactions"), where("companyCode", "==", companyCode))
      );

      const existingInvoiceRefs = new Set(
        transactionsSnap.docs.map(t => t.data().linkedInvoice)
      );

      let balance = 0;
      transactionsSnap.docs
        .sort((a, b) => new Date(a.data().dateCreated) - new Date(b.data().dateCreated))
        .forEach(t => {
          balance = t.data().updated_balance;
        });

      const newTransactions = [];
      let creditCount = 0;

      for (const invoice of invoices) {
        const orderNumber = invoice.orderNumber;
        const total = parseFloat(
          invoice.finalTotals?.finalTotal || invoice.orderDetails?.total || 0
        );
        const debit = -Math.abs(total);
        const invoiceDate = invoice.invoiceDate || new Date().toISOString();
        const settledDate = invoice.settledDate || invoiceDate;

        const alreadyExists = transactionsSnap.docs.find(t => t.data().linkedInvoice === orderNumber);
        if (!alreadyExists) {
          const invoiceTransaction = {
            companyCode,
            type: "Invoice",
            amount: debit,
            starting_balance: balance,
            updated_balance: balance + debit,
            note: `Backfilled invoice #${orderNumber}`,
            linkedInvoice: orderNumber,
            dateCreated: invoiceDate,
            createdBy: "system-backfill",
            transactionId: generateTransactionId(usedTransactionIds),
            reversed: false
          };
          balance = invoiceTransaction.updated_balance;
          newTransactions.push(invoiceTransaction);
        }

        const isSettled = invoice.paymentStatus === "Paid" || invoice.settled === true;
        const hasPaymentTransaction = transactionsSnap.docs.some(t => t.data().linkedInvoice === orderNumber && t.data().type === "Payment");

        if (isSettled && !hasPaymentTransaction) {
          const paymentTransaction = {
            companyCode,
            type: "Payment",
            amount: Math.abs(total),
            starting_balance: balance,
            updated_balance: balance + Math.abs(total),
            note: `Backfilled payment for invoice #${orderNumber}`,
            linkedInvoice: orderNumber,
            dateCreated: settledDate,
            createdBy: "system-backfill",
            transactionId: generateTransactionId(usedTransactionIds),
            reversed: false
          };
          balance = paymentTransaction.updated_balance;
          newTransactions.push(paymentTransaction);
          creditCount++;
        }
      }

      for (const t of newTransactions) {
        await setDoc(doc(db, "accountTransactions", t.transactionId), t);
      }

      allResults.push({ companyCode, created: newTransactions.length, creditsAdded: creditCount });
    }

    return NextResponse.json({ message: "All invoices and payments backfilled", results: allResults });
  } catch (error) {
    console.error("❌ Error in backfill:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
