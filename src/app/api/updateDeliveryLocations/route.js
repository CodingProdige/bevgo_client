import { db } from "@/lib/firebaseConfig";
import { collection, query, where, getDocs, doc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { companyCode, documentId } = await req.json();

    if (!companyCode) {
      return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    }

    console.log(`📦 Fetching delivery locations for companyCode: ${companyCode}`);

    // 🔍 Fetch all delivery locations for this company
    const locationsQuery = query(
      collection(db, "deliveryLocations"),
      where("companyCode", "==", companyCode)
    );
    const snapshot = await getDocs(locationsQuery);

    if (snapshot.empty) {
      return NextResponse.json({ message: "No delivery locations found", locations: [] }, { status: 200 });
    }

    const locations = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));

    // 🧩 If documentId provided, update the defaultLocation flags
    if (documentId) {
      console.log(`🔄 Setting default location: ${documentId}`);

      const updatePromises = snapshot.docs.map(async (docSnap) => {
        const ref = doc(db, "deliveryLocations", docSnap.id);
        const isDefault = docSnap.id === documentId;

        await updateDoc(ref, { defaultLocation: isDefault });
      });

      await Promise.all(updatePromises);

      // 🔁 Re-fetch updated data
      const updatedSnapshot = await getDocs(locationsQuery);
      const updatedLocations = updatedSnapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      }));

      return NextResponse.json({
        message: `Default location updated to ${documentId}`,
        locations: updatedLocations,
      });
    }

    // 📤 Return locations if no update requested
    return NextResponse.json({
      message: "Delivery locations retrieved successfully",
      locations,
    });

  } catch (error) {
    console.error("❌ Error handling delivery locations:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
