import { db } from "@/lib/firebaseConfig";
import { collection, getDocs } from "firebase/firestore";
import { NextResponse } from "next/server";

// ✅ Renamed to avoid shadowing
function normalizeInputDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
  } catch {
    return null;
  }
}

function convertTimestampToDateString(timestamp) {
  try {
    if (!timestamp || typeof timestamp.seconds !== "number") return null;
    const d = new Date(timestamp.seconds * 1000);
    return d.toISOString().split("T")[0];
  } catch {
    console.error("Failed to convert timestamp:", timestamp);
    return null;
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { from, to, accountType } = body;

    const fromDate = normalizeInputDate(from);
    const toDate = normalizeInputDate(to);
    const filterAccountType = accountType && accountType.trim() !== "" ? accountType : null;

    const contractDeliveriesRef = collection(db, "contractDeliveries");
    const snapshot = await getDocs(contractDeliveriesRef);

    let results = [];
    let totalVatInclAll = 0;
    let totalVatExclAll = 0;
    let totalCommissionAll = 0;

    snapshot.forEach((doc) => {
      const data = doc.data();

      const deliveryDate = convertTimestampToDateString(data.deliveredDate);

      if (!deliveryDate) {
        console.warn("Skipping doc with invalid deliveredDate:", doc.id);
        return;
      }

      const matchesDateRange =
        (!fromDate || deliveryDate >= fromDate) &&
        (!toDate || deliveryDate <= toDate);

      const matchesAccountType =
        !filterAccountType || data.accountType === filterAccountType;

      if (matchesDateRange && matchesAccountType) {
        results.push({ id: doc.id, ...data });

        if (typeof data.totalVatIncl === "number") {
          totalVatInclAll += data.totalVatIncl;
        }

        if (typeof data.totalVatExcl === "number") {
          totalVatExclAll += data.totalVatExcl;
        }

        if (typeof data.totalCommission === "number") {
          totalCommissionAll += data.totalCommission;
        }
      }
    });

    // Sort by deliveredDate (newest first)
    results.sort((a, b) => {
      const aSec = a?.deliveredDate?.seconds || 0;
      const bSec = b?.deliveredDate?.seconds || 0;
      return bSec - aSec;
    });

    return NextResponse.json({
      data: results,
      totalVatInclAll: parseFloat(totalVatInclAll.toFixed(2)),
      totalVatExclAll: parseFloat(totalVatExclAll.toFixed(2)),
      totalCommissionAll: parseFloat(totalCommissionAll.toFixed(2))
    });
  } catch (error) {
    console.error("🔥 Fatal error in getContractDeliveries:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
