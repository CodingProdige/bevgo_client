export const runtime = "nodejs";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where
} from "firebase/firestore";
import { NextResponse } from "next/server";

const ok = (p = {}, s = 200) =>
  NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && Object.keys(value).length === 0) return true;
  return false;
}

function parseNumber(value) {
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

async function resolveUserRef(uid) {
  if (!uid) return null;
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return { ref, data: snap.data() };

  const q = query(collection(db, "users"), where("uid", "==", uid));
  const match = await getDocs(q);
  if (match.empty) return null;
  const docSnap = match.docs[0];
  return { ref: docSnap.ref, data: docSnap.data() };
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      uid: rawUid,
      creditApplicationId: rawCreditApplicationId,
      approvedTerms: rawApprovedTerms,
      approvedBy: rawApprovedBy,
      application: rawApplication,
      data: rawData,
      creditApplication: rawCreditApplication
    } = body || {};

    const uid = isEmpty(rawUid) ? null : rawUid;
    const creditApplicationId = isEmpty(rawCreditApplicationId)
      ? null
      : rawCreditApplicationId;
    const approvedTerms = isEmpty(rawApprovedTerms) ? null : rawApprovedTerms;
    const approvedBy = isEmpty(rawApprovedBy) ? null : rawApprovedBy;

    if (!uid) {
      return err(400, "Missing Fields", "uid is required.");
    }

    let application =
      rawApplication ||
      rawData ||
      rawCreditApplication ||
      null;

    if (creditApplicationId && !application) {
      const appSnap = await getDoc(
        doc(db, "creditApplications", creditApplicationId)
      );
      if (!appSnap.exists()) {
        return err(
          404,
          "Credit Application Not Found",
          `No credit application found with id: ${creditApplicationId}`
        );
      }
      application = { docId: appSnap.id, ...appSnap.data() };
    }

    if (!application) {
      return err(
        400,
        "Missing Credit Application",
        "Provide a credit application payload or creditApplicationId."
      );
    }

    if (application?.uid && application.uid !== uid) {
      return err(
        400,
        "UID Mismatch",
        "Provided uid does not match credit application uid."
      );
    }

    const approvedCreditLimit = parseNumber(
      approvedTerms?.approvedCreditLimit ||
      application?.approvedTerms?.approvedCreditLimit ||
      application?.requestedCredit?.requiredCredit
    );

    if (approvedCreditLimit === null) {
      return err(
        400,
        "Missing Approved Credit Limit",
        "approvedCreditLimit or requestedCredit.requiredCredit is required."
      );
    }

    const approvedPaymentTerms =
      approvedTerms?.approvedPaymentTerms ??
      application?.approvedTerms?.approvedPaymentTerms ??
      null;

    const now = new Date().toISOString();
    const userRecord = await resolveUserRef(uid);

    if (!userRecord) {
      return err(404, "User Not Found", `No user found with uid: ${uid}`);
    }

    const applicationDocId =
      creditApplicationId ||
      application?.docId ||
      application?.creditApplicationId ||
      null;

    const updatePayload = {
      "credit.creditApproved": true,
      "credit.creditLimit": approvedCreditLimit,
      "credit.availableCredit": approvedCreditLimit,
      "credit.paymentTerms": approvedPaymentTerms,
      "credit.creditStatus": "approved",
      "credit.approvedAt": now,
      "credit.approvedBy": approvedBy,
      "credit.creditApplicationId": applicationDocId,
      "system.updatedAt": now
    };

    if (approvedPaymentTerms !== null && approvedPaymentTerms !== undefined) {
      updatePayload["account.payment_terms"] = String(approvedPaymentTerms);
      updatePayload.payment_terms = String(approvedPaymentTerms);
    }

    updatePayload.creditLimit = approvedCreditLimit;
    updatePayload.availableCredit = approvedCreditLimit;

    await updateDoc(userRecord.ref, updatePayload);

    if (applicationDocId) {
      await updateDoc(doc(db, "creditApplications", applicationDocId), {
        status: "approved",
        approvedTerms: {
          approvedPaymentTerms: approvedPaymentTerms ?? null,
          approvedCreditLimit
        },
        "timestamps.updatedAt": now,
        "timestamps.approvedAt": now
      });
    }

    return ok({
      message: "Credit application accepted.",
      creditApplicationId: applicationDocId,
      approvedTerms: {
        approvedPaymentTerms: approvedPaymentTerms ?? null,
        approvedCreditLimit
      }
    });
  } catch (e) {
    return err(500, "Credit Application Accept Failed", e?.message || "Unexpected error.");
  }
}
