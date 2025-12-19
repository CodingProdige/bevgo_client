export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { collection, addDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const ok = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req) {
  try {
    const body = await req.json();
    const { uid, data } = body;

    if (!uid || !data) {
      return err(400, "Missing Fields", "uid and data are required.");
    }

    /* -----------------------------------------
       VALIDATION
    ----------------------------------------- */
    if (!data.businessInfo || typeof data.businessInfo !== "object") {
      return err(400, "Missing Business Info", "businessInfo is required.");
    }

    if (!data.documents || typeof data.documents !== "object") {
      return err(400, "Missing Documents", "Supporting documents must be uploaded.");
    }

    if (!data.requestedCredit || !data.requestedCredit.requiredCredit) {
      return err(400, "Missing Credit Amount", "requestedCredit.requiredCredit is required.");
    }

    if (!data.tradeAgreement || data.tradeAgreement.agreed !== true) {
      return err(
        400,
        "Trade Agreement Required",
        "You must accept the Bevgo Master Credit Agreement to apply for credit."
      );
    }

    /* -----------------------------------------
       BUILD FINAL PAYLOAD
    ----------------------------------------- */
    const now = new Date().toISOString();

    const payload = {
      uid, // Root-level reference to the user ID

      status: "pending",

      businessInfo: {
        uid, // Secondary reference inside schema
        businessName: data.businessInfo.businessName || "",
        businessType: data.businessInfo.businessType || "",
        vatNumber: data.businessInfo.vatNumber || "",
        liquorLicenseNumber: data.businessInfo.liquorLicenseNumber || "",
        averageMonthlySpend: data.businessInfo.averageMonthlySpend || "",
        orderFrequency: data.businessInfo.orderFrequency || ""
      },

      documents: {
        bankConfirmationLetterUrl: data.documents.bankConfirmationLetterUrl || "",
        ownerDirectorIdUrl: data.documents.ownerDirectorIdUrl || ""
      },

      requestedCredit: {
        requiredCredit: data.requestedCredit.requiredCredit || ""
      },

      tradeAgreement: {
        agreed: true,
        agreedAt: now
      },

      approvedTerms: {
        approvedPaymentTerms: null,
        approvedCreditLimit: null
      },

      timestamps: {
        submittedAt: now,
        updatedAt: now
      }
    };

    /* -----------------------------------------
       SAVE NEW APPLICATION
    ----------------------------------------- */
    const ref = await addDoc(collection(db, "creditApplications"), payload);

    return ok({
      message: "Credit application submitted successfully.",
      creditApplicationId: ref.id,
      data: payload
    });

  } catch (e) {
    return err(500, "Credit Application Failed", e.message);
  }
}
