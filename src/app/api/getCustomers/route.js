import { db } from "@/lib/firebaseConfig"; // Firestore
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // ✅ Reference to the customers collection
    const customersRef = collection(db, "customers");
    const snapshot = await getDocs(customersRef);

    // ✅ Check if the collection is empty
    if (snapshot.empty) {
      return NextResponse.json({ message: "No customers found" }, { status: 404 });
    }

    // ✅ Extract customer data
    const customers = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    console.log(`✅ Retrieved ${customers.length} customers successfully.`);

    return NextResponse.json({ customers }, { status: 200 });
  } catch (error) {
    console.error("❌ Failed to retrieve customers:", error.message);
    return NextResponse.json({ error: "Failed to retrieve customers", details: error.message }, { status: 500 });
  }
}
