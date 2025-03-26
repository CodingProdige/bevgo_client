import { db } from "@/lib/firebaseConfig"; // Firestore
import { doc, getDoc, collection, query, where, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode } = await req.json();

    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode parameter" }, { status: 400 });
    }

    console.log(`📌 Searching for company with code: ${companyCode}`);

    // ✅ Check Users Collection
    const usersRef = collection(db, "users");
    const userQuery = query(usersRef, where("companyCode", "==", companyCode));
    const userSnapshot = await getDocs(userQuery);

    if (!userSnapshot.empty) {
      const userData = userSnapshot.docs[0].data();
      console.log("✅ User found:", userData);
      return NextResponse.json({ message: "User found", data: userData }, { status: 200 });
    }

    // ✅ Check Customers Collection if not found in Users
    const customersRef = collection(db, "customers");
    const customerQuery = query(customersRef, where("companyCode", "==", companyCode));
    const customerSnapshot = await getDocs(customerQuery);

    if (!customerSnapshot.empty) {
      const customerData = customerSnapshot.docs[0].data();
      console.log("✅ Customer found:", customerData);
      return NextResponse.json({ message: "Customer found", data: customerData }, { status: 200 });
    }

    // ❌ No user or customer found
    return NextResponse.json({ error: "No user or customer found with the given company code" }, { status: 404 });

  } catch (error) {
    console.error("❌ Failed to retrieve user or customer:", error.message);
    return NextResponse.json({ error: "Failed to retrieve user or customer", details: error.message }, { status: 500 });
  }
}
