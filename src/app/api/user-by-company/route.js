import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET(req) {
  try {
    // Extract companyName from the query parameters
    const { searchParams } = new URL(req.url);
    const companyName = searchParams.get("companyName");

    if (!companyName) {
      return NextResponse.json({ error: "companyName is required" }, { status: 400 });
    }

    // Query Firestore for the customer with the specified companyName
    const customersRef = collection(db, "users");
    const q = query(customersRef, where("companyName", "==", companyName));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return NextResponse.json({ error: "No customer found" }, { status: 404 });
    }

    // Extract customer data
    const customers = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return NextResponse.json({ customers }, { status: 200 });
  } catch (error) {
    console.error("Error fetching customer:", error);
    return NextResponse.json({ error: "Failed to fetch customer" }, { status: 500 });
  }
}