import { db } from "@/lib/firebaseConfig";
import {
  collection,
  getDocs,
  query,
  where,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { NextResponse } from "next/server";

const COLLECTIONS = ["deliveryNotes", "invoices", "orders"];

export async function POST(req) {
  try {
    const { companyCode } = await req.json();

    if (!companyCode) {
      return NextResponse.json(
        { error: "Missing required parameter: companyCode" },
        { status: 400 }
      );
    }

    const deletedCounts = {};

    for (const colName of COLLECTIONS) {
      const colRef = collection(db, colName);

      // 🔎 Query for root-level companyCode
      const rootQuery = query(colRef, where("companyCode", "==", companyCode));
      const rootSnap = await getDocs(rootQuery);

      // 🔎 Query for nested customer.companyCode
      const nestedQuery = query(colRef, where("customer.companyCode", "==", companyCode));
      const nestedSnap = await getDocs(nestedQuery);

      const seenDocIds = new Set();
      const deletes = [];

      // 🗑️ Add root-level matches
      for (const docSnap of rootSnap.docs) {
        if (!seenDocIds.has(docSnap.id)) {
          seenDocIds.add(docSnap.id);
          deletes.push(deleteDoc(doc(colRef, docSnap.id)));
        }
      }

      // 🗑️ Add nested matches
      for (const docSnap of nestedSnap.docs) {
        if (!seenDocIds.has(docSnap.id)) {
          seenDocIds.add(docSnap.id);
          deletes.push(deleteDoc(doc(colRef, docSnap.id)));
        }
      }

      await Promise.all(deletes);
      deletedCounts[colName] = seenDocIds.size;
    }

    return NextResponse.json(
      {
        message: "Documents deleted successfully",
        deleted: deletedCounts,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Failed to delete documents by companyCode:", error);
    return NextResponse.json(
      { error: "Something went wrong", details: error.message },
      { status: 500 }
    );
  }
}
