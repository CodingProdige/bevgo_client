export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

function hasCreditTerms(user) {
  const credit = user?.credit || {};
  const paymentTermsRaw = credit?.paymentTerms ?? null;
  const paymentTerms =
    typeof paymentTermsRaw === "string" ? paymentTermsRaw.trim() : "";

  if (!paymentTerms) return false;
  if (credit?.creditApproved !== true) return false;
  if (String(credit?.creditStatus || "").toLowerCase() !== "approved") return false;

  const normalized = paymentTerms.toLowerCase();
  const nonCreditTerms = new Set([
    "cash in advance",
    "cod",
    "immediate",
    "pay now",
    "prepaid",
    "none"
  ]);

  if (nonCreditTerms.has(normalized)) return false;

  return true;
}

/* ───────── ENDPOINT ───────── */

export async function POST() {
  try {
    const snap = await getDocs(collection(db, "users"));
    const businesses = snap.docs
      .map(doc => ({ uid: doc.id, ...doc.data() }))
      .filter(user => {
        const account = user?.account || {};
        return account?.onboardingComplete === true &&
          hasCreditTerms(user) && (
          typeof account?.accountName === "string" && account.accountName.trim() !== ""
        );
      })
      .map(user => ({
        uid: user.uid,
        customerCode: user?.account?.customerCode || null,
        accountType: user?.account?.accountType || null,
        companyName: user?.account?.accountName || null,
        phoneNumber: user?.account?.phoneNumber || null,
        paymentTerms: user?.credit?.paymentTerms ?? null
      }));

    return ok({ businesses });
  } catch (e) {
    return err(
      500,
      "Fetch Businesses Failed",
      e?.message || "Unexpected error fetching business accounts."
    );
  }
}
