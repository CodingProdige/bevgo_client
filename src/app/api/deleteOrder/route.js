import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, deleteDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { orderNumber, only } = await req.json();

    if (!orderNumber) {
      return NextResponse.json({ error: "Missing orderNumber" }, { status: 400 });
    }

    // Determine which collections to delete from
    let collections = ["orders", "invoices", "deliveryNotes"];
    if (only === "invoice") {
      collections = ["invoices"];
    } else if (only === "deliveryNote") {
      collections = ["deliveryNotes"];
    }

    const deleted = [];

    for (const collectionName of collections) {
      const docRef = doc(db, collectionName, orderNumber);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        await deleteDoc(docRef);
        deleted.push(collectionName);
        console.log(`🗑️ Deleted ${collectionName}/${orderNumber}`);
      }
    }

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: `No matching documents found for orderNumber ${orderNumber}.` },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { message: `Deleted from: ${deleted.join(", ")}`, deleted },
      { status: 200 }
    );

  } catch (error) {
    console.error("❌ Failed to delete documents:", error);
    return NextResponse.json(
      { error: "Failed to delete documents", details: error.message },
      { status: 500 }
    );
  }
}
