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

    // Query Firestore for the user in the users collection
    const usersRef = collection(db, "users");
    const userQuery = query(usersRef, where("companyCode", "==", companyCode));
    const userSnapshot = await getDocs(userQuery);

    if (!userSnapshot.empty) {
      const users = userSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));
      return NextResponse.json({ users }, { status: 200 });
    }

    // If not found in users, check the customers collection
    const customersRef = collection(db, "customers");
    const customerQuery = query(customersRef, where("companyCode", "==", companyCode));
    const customerSnapshot = await getDocs(customerQuery);

    if (!customerSnapshot.empty) {
      const users = customerSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));
      return NextResponse.json({ users }, { status: 200 });
    }

    return NextResponse.json({ error: "No user or customer found with this companyCode" }, { status: 404 });
  } catch (error) {
    console.error("❌ Error fetching user or customer by companyCode:", error);
    return NextResponse.json({ error: "Failed to fetch user" }, { status: 500 });
  }
}
