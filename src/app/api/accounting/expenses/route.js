export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  addDoc,
  doc,
  getDoc,
  updateDoc,
  getDocs,
  query,
  where,
  orderBy
} from "firebase/firestore";
import { NextResponse } from "next/server";

//
// 🔹 Utility: build Firestore constraints from query params
//
function buildConstraints(searchParams) {
  const constraints = [];

  if (searchParams.get("fromDate")) {
    constraints.push(where("date", ">=", searchParams.get("fromDate")));
  }
  if (searchParams.get("toDate")) {
    constraints.push(where("date", "<=", searchParams.get("toDate")));
  }
  if (searchParams.get("category")) {
    constraints.push(where("category", "==", searchParams.get("category")));
  }
  if (searchParams.get("accountCode")) {
    constraints.push(where("accountCode", "==", searchParams.get("accountCode")));
  }
  if (searchParams.get("status")) {
    constraints.push(where("status", "==", searchParams.get("status")));
  }
  if (searchParams.get("vendor")) {
    constraints.push(where("vendor", "==", searchParams.get("vendor")));
  }
  if (searchParams.get("createdBy")) {
    constraints.push(where("createdBy", "==", searchParams.get("createdBy")));
  }

  return constraints;
}

//
// 🔹 POST → Create a new expense
//
export async function POST(req) {
  try {
    const body = await req.json();
    const { vendor, reference, amount, status, category, accountCode, notes, createdBy } = body;

    if (!vendor || !amount || !category || !accountCode) {
      return NextResponse.json(
        { error: "Missing required fields: vendor, amount, category, accountCode" },
        { status: 400 }
      );
    }

    const docRef = await addDoc(collection(db, "expenses"), {
      vendor,
      reference: reference || null,
      amount: Number(amount),
      status: status || "Pending",
      category,
      accountCode,
      notes: notes || null,
      createdBy: createdBy || "system",
      date: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      deleted: false
    });

    return NextResponse.json({
      message: "Expense recorded successfully",
      expenseId: docRef.id
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

//
// 🔹 GET → Fetch expenses with filters + grouped totals
//
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    let q = collection(db, "expenses");

    const constraints = buildConstraints(searchParams);
    if (constraints.length > 0) {
      q = query(q, ...constraints, orderBy("date", "desc"));
    } else {
      q = query(q, orderBy("date", "desc"));
    }

    const snap = await getDocs(q);
    const expenses = [];
    snap.forEach((doc) => {
      const data = doc.data();
      if (!data.deleted) {
        expenses.push({ id: doc.id, ...data });
      }
    });

    // --- Group totals by accountCode + category ---
    const totalsMap = {};
    expenses.forEach((e) => {
      const key = e.accountCode || e.category || "Uncategorized";
      if (!totalsMap[key]) {
        totalsMap[key] = {
          accountCode: e.accountCode || null,
          category: e.category || "Uncategorized",
          total: 0
        };
      }
      totalsMap[key].total += Number(e.amount || 0);
    });

    const totalsByCategory = Object.values(totalsMap);

    return NextResponse.json({
      message: "Expenses retrieved successfully",
      expenses,
      totalsByCategory
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

//
// 🔹 PUT → Update an existing expense by ID
//
export async function PUT(req) {
  try {
    const { id, ...updates } = await req.json();

    if (!id) {
      return NextResponse.json({ error: "Missing expense ID" }, { status: 400 });
    }

    const expenseRef = doc(db, "expenses", id);
    const snap = await getDoc(expenseRef);

    if (!snap.exists() || snap.data().deleted) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    updates.updatedAt = new Date().toISOString();

    await updateDoc(expenseRef, updates);

    return NextResponse.json({ message: "Expense updated successfully" });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

//
// 🔹 DELETE → Soft-delete an expense by ID
//
export async function DELETE(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Missing expense ID" }, { status: 400 });
    }

    const expenseRef = doc(db, "expenses", id);
    const snap = await getDoc(expenseRef);

    if (!snap.exists() || snap.data().deleted) {
      return NextResponse.json({ error: "Expense not found or already deleted" }, { status: 404 });
    }

    await updateDoc(expenseRef, {
      deleted: true,
      deletedAt: new Date().toISOString()
    });

    return NextResponse.json({ message: "Expense deleted successfully" });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
