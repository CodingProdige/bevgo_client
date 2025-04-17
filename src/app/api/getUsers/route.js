import { db } from "@/lib/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const usersRef = collection(db, "users");
    const customersRef = collection(db, "customers");

    const [userSnap, customerSnap] = await Promise.all([
      getDocs(usersRef),
      getDocs(customersRef),
    ]);

    const users = userSnap.docs.map(doc => ({
      id: doc.id,
      type: "user",
      ...doc.data(),
    }));

    const customers = customerSnap.docs.map(doc => ({
      id: doc.id,
      type: "customer",
      ...doc.data(),
    }));

    const allUsers = [...users, ...customers];

    return NextResponse.json({ users: allUsers }, { status: 200 });

  } catch (error) {
    console.error("❌ Error fetching users and customers:", error);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
