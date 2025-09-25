export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const companyCode = searchParams.get("companyCode");
    const fromDate = searchParams.get("fromDate");
    const toDate = searchParams.get("toDate");
    const includeExpenses = searchParams.get("includeExpenses") === "true";

    const constraints = [];
    if (fromDate) constraints.push({ field: "date", op: ">=", value: fromDate });
    if (toDate) constraints.push({ field: "date", op: "<=", value: toDate });

    // Helper function for querying collections
    const fetchDocs = async (coll, filters) => {
      let q = collection(db, coll);
      if (companyCode && coll !== "expenses") {
        q = query(q, where("companyCode", "==", companyCode));
      }
      const snap = await getDocs(q);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    };

    // Fetch collections
    const [invoices, payments, allocations, expenses] = await Promise.all([
      fetchDocs("invoices", constraints),
      fetchDocs("payments", constraints),
      fetchDocs("allocations", constraints),
      includeExpenses ? fetchDocs("expenses", constraints) : Promise.resolve([])
    ]);

    const ledger = [];

    // Invoices → Debit
    invoices.forEach((inv) => {
      if (companyCode && inv?.customer?.companyCode !== companyCode) return;
      ledger.push({
        type: "Invoice",
        id: inv.orderNumber || inv.id,
        date: inv.invoiceDate,
        amount: Number(inv.finalTotals?.finalTotal || 0),
        status: inv.payment_status || "Pending"
      });
    });

    // Payments → Credit
    payments.forEach((p) => {
      ledger.push({
        type: "Payment",
        id: p.id,
        date: p.date,
        amount: Number(p.amount || 0),
        method: p.method,
        reference: p.reference,
        allocated: p.allocated || 0,
        unallocated: p.unallocated || 0
      });
    });

    // Allocations
    allocations.forEach((a) => {
      ledger.push({
        type: "Allocation",
        id: a.id,
        date: a.date,
        invoiceId: a.invoiceId,
        amount: Number(a.amount || 0),
        fromPayments: a.fromPayments || [],
        status: a.status || "Applied",
        reversedAt: a.reversedAt || null,
        reversalReason: a.reversalReason || null
      });
    });

    // Expenses (if enabled)
    expenses.forEach((e) => {
      ledger.push({
        type: "Expense",
        id: e.id,
        date: e.date,
        vendor: e.vendor,
        category: e.category,
        accountCode: e.accountCode,
        reference: e.reference,
        amount: Number(e.amount || 0),
        status: e.status || "Pending"
      });
    });

    // Sort by date ascending (traceable story)
    ledger.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Running balance
    let balance = 0;
    const ledgerWithBalance = ledger.map((entry) => {
      if (entry.type === "Invoice") balance += entry.amount;        // debit
      if (entry.type === "Payment") balance -= entry.amount;        // credit
      if (entry.type === "Allocation") balance -= entry.amount;     // settlement
      if (entry.type === "Expense") balance += entry.amount;        // expense = debit
      if (entry.status === "Reversed") balance += entry.amount;     // reversal puts balance back
      return { ...entry, balanceAfter: balance };
    });

    return NextResponse.json({
      message: "Ledger retrieved successfully",
      ledger: ledgerWithBalance
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
