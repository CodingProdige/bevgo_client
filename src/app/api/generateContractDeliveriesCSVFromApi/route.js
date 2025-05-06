// app/api/generateContractDeliveriesCSVFromApi/route.js
import { NextResponse } from "next/server";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "@/lib/firebaseConfig";
import { format } from "date-fns";
import { v4 as uuidv4 } from "uuid";

export async function POST(req) {
  try {
    const body = await req.json();

    // Step 1: Fetch from your own API
    const response = await fetch("https://bevgo-client.vercel.app/api/getContractDeliveries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error("Failed to fetch contract deliveries");
    const { data } = await response.json();

    // Step 2: Build CSV
    const headers = [
      "id", "customerName", "accountType", "contractor", "invoiceNumber",
      "deliveredDate", "totalVatIncl", "totalVatExcl", "totalCommission"
    ];

    const rows = data.map((item) => {
      const dateStr = item?.deliveredDate?.seconds
        ? new Date(item.deliveredDate.seconds * 1000).toISOString().split("T")[0]
        : "";

      return [
        item.id || "",
        item.customerName || "",
        item.accountType || "",
        item.contractor || "",
        item.invoiceNumber || "",
        dateStr,
        (item.totalVatIncl ?? 0).toFixed(2),
        (item.totalVatExcl ?? 0).toFixed(2),
        (item.totalCommission ?? 0).toFixed(2)
      ];
    });

    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${v}"`).join(","))
      .join("\n");

    // Step 3: Upload CSV to Firebase
    const fileName = `exports/contract-deliveries-${format(new Date(), "yyyyMMdd-HHmmss")}.csv`;
    const fileRef = ref(storage, fileName);
    const buffer = Buffer.from(csv, "utf-8");

    await uploadBytes(fileRef, buffer, { contentType: "text/csv" });
    const downloadURL = await getDownloadURL(fileRef);

    return NextResponse.json({ downloadURL }, { status: 200 });

  } catch (error) {
    console.error("❌ Error generating CSV from contract deliveries API:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
