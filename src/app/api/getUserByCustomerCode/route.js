import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET(req) {
  try {
    // Extract companyCode from the query parameters
    const { searchParams } = new URL(req.url);
    const companyCode = searchParams.get("companyCode");

    if (!companyCode) {
      return NextResponse.json({ error: "companyCode is required" }, { status: 400 });
    }

    // Query Firestore for the user with the specified companyCode
    const usersRef = collection(db, "users");
    const q = query(usersRef, where("companyCode", "==", companyCode));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return NextResponse.json({ error: "No user found with this companyCode" }, { status: 404 });
    }

    // Extract user data
    const users = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json({ users }, { status: 200 });
  } catch (error) {
    console.error("❌ Error fetching user by companyCode:", error);
    return NextResponse.json({ error: "Failed to fetch user" }, { status: 500 });
  }
}
