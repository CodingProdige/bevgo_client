import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs, updateDoc, doc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { invoiceTotal, cashTotal, companyCode } = await req.json();

    if (!invoiceTotal || !cashTotal || !companyCode) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    const invoice = parseFloat(invoiceTotal);
    const cash = parseFloat(cashTotal);

    if (isNaN(invoice) || isNaN(cash)) {
      return NextResponse.json({ error: "Invalid numeric values" }, { status: 400 });
    }

    const overpaidAmount = parseFloat((cash - invoice).toFixed(2));
    if (overpaidAmount <= 0) {
      return NextResponse.json({ message: "No overpayment detected." }, { status: 200 });
    }

    const collectionsToSearch = ["users", "customers"];
    let updated = false;

    for (const collectionName of collectionsToSearch) {
      const colRef = collection(db, collectionName);
      const q = query(colRef, where("companyCode", "==", companyCode));
      const snapshot = await getDocs(q);

      if (!snapshot.empty) {
        const docRef = doc(db, collectionName, snapshot.docs[0].id);
        await updateDoc(docRef, { account_credit: overpaidAmount });
        updated = true;
        break;
      }
    }

    if (!updated) {
      return NextResponse.json({ error: "Company not found in users or customers." }, { status: 404 });
    }

    return NextResponse.json({ message: "Account credit updated", overpaidAmount }, { status: 200 });

  } catch (error) {
    console.error("Error updating account credit:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
