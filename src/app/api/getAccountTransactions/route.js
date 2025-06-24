import { db } from "@/lib/firebaseConfig";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs
} from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode } = await req.json();

    if (!companyCode || typeof companyCode !== "string") {
      return NextResponse.json({ error: "Missing or invalid companyCode" }, { status: 400 });
    }

    const q = query(
      collection(db, "accountTransactions"),
      where("companyCode", "==", companyCode.trim()),
      orderBy("dateCreated", "asc") // chronological order for statements
    );

    const snap = await getDocs(q);

    if (snap.empty) {
      return NextResponse.json({ statement: [], totalOutstanding: 0 });
    }

    let runningBalance = 0;
    const statement = [];

    for (const doc of snap.docs) {
      const data = doc.data();
      const amount = parseFloat(data.amount);
      const isDebit = amount < 0;
      const isCredit = amount > 0;

      runningBalance += amount;

      statement.push({
        date: data.dateCreated,
        type: data.type,
        reference: data.linkedInvoice || data.transactionId,
        description: data.note,
        debit: isDebit ? Math.abs(amount) : 0,
        credit: isCredit ? amount : 0,
        balance: parseFloat(runningBalance.toFixed(2))
      });
    }

    return NextResponse.json({
      companyCode,
      totalOutstanding: parseFloat(runningBalance.toFixed(2)),
      statement
    });

  } catch (err) {
    console.error("❌ Error generating statement:", err);
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}
