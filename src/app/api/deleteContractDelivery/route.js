import { db } from "@/lib/firebaseConfig";
import { doc, deleteDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const body = await req.json();
    const { id } = body;

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Invalid or missing document ID" }, { status: 400 });
    }

    const docRef = doc(db, "contractDeliveries", id);
    await deleteDoc(docRef);

    return NextResponse.json({ success: true, message: `Document ${id} deleted.` });
  } catch (error) {
    console.error("Error deleting contract delivery:", error);
    return NextResponse.json({ error: "Failed to delete document" }, { status: 500 });
  }
}
