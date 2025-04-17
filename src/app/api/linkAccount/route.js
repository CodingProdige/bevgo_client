// /app/api/updateCustomerCompanyCode/route.js
import { db } from "@/lib/firebaseConfig";
import {
  collection,
  getDocs,
  query,
  where,
  updateDoc,
  doc,
} from "firebase/firestore";
import { NextResponse } from "next/server";

const COLLECTIONS = ["orders", "invoices", "deliveryNotes"];

export async function POST(req) {
  try {
    const { oldCompanyCode, newCompanyCode } = await req.json();

    if (!oldCompanyCode || !newCompanyCode) {
      return NextResponse.json(
        { error: "Both oldCompanyCode and newCompanyCode are required." },
        { status: 400 }
      );
    }

    const results = {};

    for (const collectionName of COLLECTIONS) {
      const colRef = collection(db, collectionName);

      // Query by root-level companyCode
      const rootQuery = query(colRef, where("companyCode", "==", oldCompanyCode));
      const rootSnap = await getDocs(rootQuery);

      // Query by nested customer.companyCode
      const nestedQuery = query(colRef, where("customer.companyCode", "==", oldCompanyCode));
      const nestedSnap = await getDocs(nestedQuery);

      const updatedDocs = new Set();

      const updates = [];

      // Update root-level companyCode
      rootSnap.forEach((docSnap) => {
        if (!updatedDocs.has(docSnap.id)) {
          updates.push(updateDoc(doc(colRef, docSnap.id), { companyCode: newCompanyCode }));
          updatedDocs.add(docSnap.id);
        }
      });

      // Update nested customer.companyCode
      nestedSnap.forEach((docSnap) => {
        if (!updatedDocs.has(docSnap.id)) {
          updates.push(
            updateDoc(doc(colRef, docSnap.id), {
              "customer.companyCode": newCompanyCode,
            })
          );
          updatedDocs.add(docSnap.id);
        }
      });

      await Promise.all(updates);
      results[collectionName] = updatedDocs.size;
    }

    return NextResponse.json(
      {
        message: "Company codes updated successfully",
        updated: results,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Failed to update company codes:", error);
    return NextResponse.json(
      { error: "Something went wrong", details: error.message },
      { status: 500 }
    );
  }
}
