import { db } from "@/lib/firebaseConfig";
import {
  collection,
  getDocs,
} from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyName, deliveryAddress } = await req.json();

    if (!companyName && !deliveryAddress) {
      return NextResponse.json(
        { error: "At least one of companyName or deliveryAddress must be provided." },
        { status: 400 }
      );
    }

    const collectionsToSearch = ["users", "customers"];

    let nameMatch = false;
    let addressMatch = false;

    for (const col of collectionsToSearch) {
      const snapshot = await getDocs(collection(db, col));

      snapshot.forEach((doc) => {
        const data = doc.data();

        if (
          companyName &&
          typeof data.companyName === "string" &&
          data.companyName.toLowerCase() === companyName.toLowerCase()
        ) {
          nameMatch = true;
        }

        if (
          deliveryAddress &&
          typeof data.deliveryAddress === "string" &&
          data.deliveryAddress.toLowerCase() === deliveryAddress.toLowerCase()
        ) {
          addressMatch = true;
        }
      });

      // Exit early if both matches are found
      if (nameMatch && addressMatch) break;
    }

    const result = {};
    if (nameMatch) result.name = companyName;
    if (addressMatch) result.address = deliveryAddress;

    return NextResponse.json({ match: result }, { status: 200 });

  } catch (error) {
    console.error("❌ Error checking for duplicates:", error);
    return NextResponse.json(
      { error: "Failed to check for duplicates", details: error.message },
      { status: 500 }
    );
  }
}
