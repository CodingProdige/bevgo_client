// app/api/creditCheck/route.js
import { db } from "@/lib/firebaseConfig";
import {
  collection,
  query,
  where,
  getDocs,
} from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode, cartValue } = await req.json();

    if (!companyCode) {
      return NextResponse.json(
        { error: "companyCode is required" },
        { status: 400 }
      );
    }

    /* ---------- 1. Look in users collection by field ---------- */
    let creditLimit = 0;
    let snap = await getDocs(
      query(collection(db, "users"), where("companyCode", "==", companyCode))
    );

    /* ---------- 2. Fallback to customers collection by field ---------- */
    if (snap.empty) {
      snap = await getDocs(
        query(collection(db, "customers"), where("companyCode", "==", companyCode))
      );
    }

    if (snap.empty) {
      return NextResponse.json(
        { error: "Customer / User record not found" },
        { status: 404 }
      );
    }

    creditLimit = Number(snap.docs[0].data().creditLimit || 0);

    /* ---------- 3. Fetch pending invoices ---------- */
    const qInvoices = query(
      collection(db, "invoices"),
      where("customer.companyCode", "==", companyCode),
      where("payment_status", "==", "Pending")
    );

    const snapshot = await getDocs(qInvoices);
    let outstanding = 0;
    const invoices = [];

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const invoiceTotal = Number(data.finalTotals?.finalTotal || 0);
      outstanding += invoiceTotal;

      invoices.push({
        orderNumber: docSnap.id,
        finalTotal: invoiceTotal,
        dueDate: data.dueDate,
        customerName: data.customer?.name,
      });
    });

    const remainingCredit = creditLimit - outstanding;

    /* ---------- 4. Checkout eligibility ---------- */
    const cart = Number(cartValue || 0);
    const projected = outstanding + cart;
    const willExceed = projected > creditLimit;
    const canCheckout = !willExceed;
    const overBy = willExceed ? projected - creditLimit : 0;

    const response = {
      message: "Pending invoices retrieved",
      invoices,
      outstanding,
      creditLimit,
      remainingCredit,
      canCheckout,
      overBy,
    };

    if (cartValue !== undefined) {
      response.cartValue = cart;
    }

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error("❌ Failed to retrieve pending invoices:", error.message);
    return NextResponse.json(
      { error: "Failed to retrieve pending invoices", details: error.message },
      { status: 500 }
    );
  }
}