export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const ok = (p = {}, s = 200) => NextResponse.json({ ok: true, ...p }, { status: s });
const err = (s, t, m, e = {}) =>
  NextResponse.json({ ok: false, title: t, message: m, ...e }, { status: s });

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && Object.keys(value).length === 0) return true;
  return false;
}

function toTargetType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "personal" || normalized === "business") return normalized;
  return null;
}

function normalizePersonal(existing, incoming) {
  return {
    fullName:
      !isEmpty(incoming?.fullName) ? incoming.fullName : existing?.fullName || "",
    phoneNumber:
      !isEmpty(incoming?.phoneNumber)
        ? incoming.phoneNumber
        : existing?.phoneNumber || "",
    idData: !isEmpty(incoming?.idData)
      ? incoming.idData
      : existing?.idData || null
  };
}

function normalizeBusiness(existing, incoming) {
  return {
    companyName:
      !isEmpty(incoming?.companyName)
        ? incoming.companyName
        : existing?.companyName || "",
    phoneNumber:
      !isEmpty(incoming?.phoneNumber)
        ? incoming.phoneNumber
        : existing?.phoneNumber || "",
    vatNumber:
      !isEmpty(incoming?.vatNumber) ? incoming.vatNumber : existing?.vatNumber || "",
    registrationNumber:
      !isEmpty(incoming?.registrationNumber)
        ? incoming.registrationNumber
        : existing?.registrationNumber || "",
    liquorLicenseNumber:
      !isEmpty(incoming?.liquorLicenseNumber)
        ? incoming.liquorLicenseNumber
        : existing?.liquorLicenseNumber || "",
    businessType:
      !isEmpty(incoming?.businessType)
        ? incoming.businessType
        : existing?.businessType || ""
  };
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      uid,
      targetAccountType: rawTargetAccountType,
      data = {}
    } = body || {};

    if (isEmpty(uid)) {
      return err(400, "Missing Fields", "uid is required.");
    }

    const targetAccountType = toTargetType(rawTargetAccountType);
    if (!targetAccountType) {
      return err(
        400,
        "Invalid Account Type",
        "targetAccountType must be 'personal' or 'business'."
      );
    }

    const ref = doc(db, "users", String(uid).trim());
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "User Not Found", "Cannot convert a non-existing user.");
    }

    const existing = snap.data() || {};
    const currentAccountType = String(existing?.account?.accountType || "")
      .trim()
      .toLowerCase();

    if (currentAccountType === targetAccountType) {
      return ok({
        data: {
          uid: String(uid).trim(),
          accountType: targetAccountType,
          unchanged: true
        }
      });
    }

    const now = new Date().toISOString();
    const nextPersonal = normalizePersonal(existing?.personal, data?.personal);
    const nextBusiness = normalizeBusiness(existing?.business, data?.business);

    if (targetAccountType === "business") {
      if (isEmpty(nextBusiness.companyName) || isEmpty(nextBusiness.phoneNumber)) {
        return err(
          400,
          "Missing Business Fields",
          "business.companyName and business.phoneNumber are required to convert to business."
        );
      }
    }

    if (targetAccountType === "personal") {
      if (isEmpty(nextPersonal.fullName) || isEmpty(nextPersonal.phoneNumber)) {
        return err(
          400,
          "Missing Personal Fields",
          "personal.fullName and personal.phoneNumber are required to convert to personal."
        );
      }
    }

    const payload = {
      account: {
        ...(existing?.account || {}),
        accountType: targetAccountType,
        accountActive: true,
        onboardingComplete: true
      },
      personal: targetAccountType === "personal" ? nextPersonal : null,
      business: targetAccountType === "business" ? nextBusiness : null,
      system: {
        ...(existing?.system || {}),
        updatedAt: now
      }
    };

    await updateDoc(ref, payload);

    return ok({
      data: {
        uid: String(uid).trim(),
        previousAccountType: currentAccountType || null,
        accountType: targetAccountType,
        accountActive: true,
        convertedAt: now
      }
    });
  } catch (e) {
    return err(500, "Conversion Failed", e?.message || "Unexpected error.");
  }
}

