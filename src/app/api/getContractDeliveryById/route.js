import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const body = await req.json();
    const { id } = body;

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Invalid or missing document ID" }, { status: 400 });
    }

    const docRef = doc(db, "contractDeliveries", id);
    const snapshot = await getDoc(docRef);

    if (!snapshot.exists()) {
      return NextResponse.json({ error: `Document ${id} not found.` }, { status: 404 });
    }

    const data = snapshot.data();

    // If 'uid' field is missing, update the document to add it
    if (!Object.prototype.hasOwnProperty.call(data, "uid")) {
      await updateDoc(docRef, { uid: id });
      data.uid = id; // Reflect the change in the response
    }

    return NextResponse.json({ id: snapshot.id, ...data });
  } catch (error) {
    console.error("Error fetching contract delivery by ID:", error);
    return NextResponse.json({ error: "Failed to fetch document" }, { status: 500 });
  }
}
