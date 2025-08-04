// app/api/bulkCreditLimit

import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, writeBatch } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const usersRef = collection(db, "users");
    const snapshot = await getDocs(usersRef);

    if (snapshot.empty) {
      return NextResponse.json(
        { message: "No users to update" },
        { status: 200 }
      );
    }

    const batch = writeBatch(db);

    snapshot.forEach((docSnap) => {
      const userRef = docSnap.ref;
      batch.update(userRef, { creditLimit: 10000 });
    });

    await batch.commit();

    return NextResponse.json(
      { message: `Updated ${snapshot.size} users with creditLimit = 10000` },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Bulk update failed:", error);
    return NextResponse.json(
      { error: "Bulk update failed", details: error.message },
      { status: 500 }
    );
  }
}