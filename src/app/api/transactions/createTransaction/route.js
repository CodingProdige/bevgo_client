// app/api/initTransaction/route.js
export const runtime = "nodejs";

import { db } from "@/lib/firebaseConfig";
import {
  doc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { NextResponse } from "next/server";

const MAX_ATTEMPTS = 12;

// 8-digit numeric ID (no leading zeros). For leading zeros, see note below.
function generateTransactionNumber() {
  const n = Math.floor(10000000 + Math.random() * 90000000);
  return String(n);
}

export async function POST(req) {
  try {
    const { orderNumber = null, companyCode = null } =
      (await req.json().catch(() => ({}))) || {};

    // (Optional) enforce companyCode if you want it required:
    // if (!companyCode) {
    //   return NextResponse.json({ error: "Missing companyCode" }, { status: 400 });
    // }

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const transactionNumber = generateTransactionNumber();
      const txRef = doc(db, "initTransactions", transactionNumber);

      try {
        await runTransaction(db, async (tx) => {
          const existing = await tx.get(txRef);
          if (existing.exists()) {
            throw new Error("COLLISION"); // retry with a new number
          }

          tx.set(txRef, {
            transactionNumber,        // duplicate inside the doc for convenience
            paymentStatus: "Pending", // initial status
            orderNumber,              // can be updated later
            companyCode,              // 👈 newly added field
            createdAt: serverTimestamp(),
          });
        });

        return NextResponse.json(
          {
            message: "Init transaction created",
            transaction: {
              id: transactionNumber,
              transactionNumber,
              paymentStatus: "Pending",
              orderNumber,
              companyCode,
              createdAt: new Date().toISOString(), // client hint; Firestore stores serverTimestamp
            },
          },
          { status: 201 }
        );
      } catch (err) {
        if (err?.message !== "COLLISION") {
          lastError = err;
          break;
        }
        lastError = err; // keep retrying on collision
      }
    }

    throw lastError ?? new Error("Failed to create init transaction after retries");
  } catch (error) {
    console.error("initTransaction error:", error);
    return NextResponse.json({ error: error.message || "Unknown error" }, { status: 500 });
  }
}
