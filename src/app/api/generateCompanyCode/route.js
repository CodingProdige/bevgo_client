import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where } from "firebase/firestore";
import { NextResponse } from "next/server";

function generateCompanyCode(companyName) {
  const words = companyName.trim().split(/\s+/);
  const abbreviation = words.map(word => word[0].toUpperCase()).join("").slice(0, 3); // Up to 3 letters
  const randomNumber = Math.floor(1000 + Math.random() * 9000); // Random 4-digit number
  return `${abbreviation}${randomNumber}`;
}

export async function POST(req) {
  try {
    const { companyName } = await req.json();

    if (!companyName) {
      return NextResponse.json(
        { error: "Missing companyName parameter" },
        { status: 400 }
      );
    }

    let isUnique = false;
    let companyCode = "";

    while (!isUnique) {
      companyCode = generateCompanyCode(companyName);
      const usersRef = collection(db, "users");
      const q = query(usersRef, where("companyCode", "==", companyCode));
      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        isUnique = true;
      }
    }

    console.log("✅ Unique company code generated:", companyCode);

    return NextResponse.json(
      { message: "Unique company code generated successfully", companyCode },
      { status: 200 }
    );
  } catch (error) {
    console.error("❌ Failed to generate company code:", error.message);
    return NextResponse.json(
      { error: "Failed to generate company code", details: error.message },
      { status: 500 }
    );
  }
}
