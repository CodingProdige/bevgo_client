export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { fromDate, toDate, companyCode } = await req.json();

    // --- Fetch invoices (income) ---
    let invoicesQ = collection(db, "invoices");
    const invoiceConstraints = [];
    if (fromDate) invoiceConstraints.push(where("invoiceDate", ">=", fromDate));
    if (toDate) invoiceConstraints.push(where("invoiceDate", "<=", toDate));
    if (companyCode) invoiceConstraints.push(where("customer.companyCode", "==", companyCode));

    if (invoiceConstraints.length > 0) {
      invoicesQ = query(invoicesQ, ...invoiceConstraints);
    }

    const invoiceSnap = await getDocs(invoicesQ);
    let totalIncome = 0;
    invoiceSnap.forEach((doc) => {
      const inv = doc.data();
      if (inv.payment_status !== "Cancelled" && !inv.deleted) {
        totalIncome += Number(inv.finalTotals?.finalTotal || 0);
      }
    });

    // --- Fetch expenses ---
    let expensesQ = collection(db, "expenses");
    const expenseConstraints = [];
    if (fromDate) expenseConstraints.push(where("date", ">=", fromDate));
    if (toDate) expenseConstraints.push(where("date", "<=", toDate));

    // ⚠️ Note: expenses are global, not per-customer
    if (expenseConstraints.length > 0) {
      expensesQ = query(expensesQ, ...expenseConstraints);
    }

    const expenseSnap = await getDocs(expensesQ);
    const expenses = [];
    expenseSnap.forEach((doc) => {
      const e = doc.data();
      if (!e.deleted) expenses.push({ id: doc.id, ...e });
    });

    // --- Group expenses by category ---
    const expenseTotals = {};
    let totalExpenses = 0;

    expenses.forEach((e) => {
      const key = e.accountCode || e.category || "Uncategorized";
      if (!expenseTotals[key]) {
        expenseTotals[key] = {
          accountCode: e.accountCode || null,
          category: e.category || "Uncategorized",
          total: 0
        };
      }
      expenseTotals[key].total += Number(e.amount || 0);
      totalExpenses += Number(e.amount || 0);
    });

    const expensesByCategory = Object.values(expenseTotals);

    // --- Net profit ---
    const netProfit = totalIncome - totalExpenses;

    return NextResponse.json({
      message: "P&L report generated successfully",
      scope: companyCode ? `Company: ${companyCode}` : "Global",
      fromDate,
      toDate,
      totalIncome,
      totalExpenses,
      netProfit,
      expensesByCategory
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
