import { db } from "@/lib/firebaseConfig"; // Firestore
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const includeAll = searchParams.get("all") === "true";

    // Fetch customers (no filtering applied)
    const customersSnap = await getDocs(collection(db, "customers"));
    const customers = customersSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    let users = [];

    // Fetch and filter users only if `all=true`
    if (includeAll) {
      const usersSnap = await getDocs(collection(db, "users"));
      users = usersSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((user) => user.onboarding_complete === true);
    }

    if (customers.length === 0 && users.length === 0) {
      return NextResponse.json({ message: "No data found" }, { status: 404 });
    }

    console.log(
      `✅ Retrieved ${customers.length} customers` +
      (includeAll ? ` and ${users.length} users` : "") +
      " successfully."
    );

    return NextResponse.json({ customers, users }, { status: 200 });
  } catch (error) {
    console.error("❌ Failed to retrieve data:", error.message);
    return NextResponse.json({ error: "Failed to retrieve data", details: error.message }, { status: 500 });
  }
}
