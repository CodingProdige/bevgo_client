export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const companyCode = searchParams.get("companyCode");
    const action = searchParams.get("action");
    const fromDate = searchParams.get("fromDate");
    const toDate = searchParams.get("toDate");

    let logsRef = collection(db, "accounting_logs");
    let constraints = [];

    if (companyCode) constraints.push(where("companyCode", "==", companyCode));
    if (action) constraints.push(where("action", "==", action));
    if (fromDate) constraints.push(where("timestamp", ">=", fromDate));
    if (toDate) constraints.push(where("timestamp", "<=", toDate));

    let q = query(logsRef, ...constraints, orderBy("timestamp", "desc"));
    const snap = await getDocs(q);

    const logs = [];
    snap.forEach((doc) => logs.push({ id: doc.id, ...doc.data() }));

    return NextResponse.json({
      message: "Accounting logs retrieved successfully",
      count: logs.length,
      filters: { companyCode, action, fromDate, toDate },
      logs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to fetch logs" },
      { status: 500 }
    );
  }
}
