export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

/* -----------------------------------------
   Response Helpers
----------------------------------------- */
const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && Object.keys(value).length === 0) return true;
  return false;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (!isEmpty(value)) return value;
  }
  return undefined;
}

/* -----------------------------------------
   UPDATE ENDPOINT
----------------------------------------- */
export async function POST(req) {
  try {
    const body = await req.json();
    const { uid, data } = body;

    if (!uid || !data)
      return err(400, "Missing Fields", "uid and data are required.");

    const ref = doc(db, "users", uid);
    const snap = await getDoc(ref);

    if (!snap.exists())
      return err(404, "User Not Found", "Cannot update a non-existing user document.");

    const existing = snap.data();
    const now = new Date().toISOString();

    /* -----------------------------------------
       Build Update Payload (only modules provided)
    ----------------------------------------- */
    const payload = {};

    const shouldUpdateAccount =
      !isEmpty(data.account) ||
      !isEmpty(data.personal) ||
      !isEmpty(data.business);
    if (shouldUpdateAccount) {
      payload.account = {
        ...(existing.account || {}),
        ...(isEmpty(data.account) ? {} : data.account)
      };
      const mappedAccount = {
        accountName: firstNonEmpty(
          data?.account?.accountName,
          data?.business?.companyName,
          data?.personal?.fullName,
          payload.account.accountName
        ),
        phoneNumber: firstNonEmpty(
          data?.account?.phoneNumber,
          data?.business?.phoneNumber,
          data?.personal?.phoneNumber,
          payload.account.phoneNumber
        ),
        vatNumber: firstNonEmpty(
          data?.account?.vatNumber,
          data?.business?.vatNumber,
          payload.account.vatNumber
        ),
        registrationNumber: firstNonEmpty(
          data?.account?.registrationNumber,
          data?.business?.registrationNumber,
          payload.account.registrationNumber
        ),
        liquorLicenseNumber: firstNonEmpty(
          data?.account?.liquorLicenseNumber,
          data?.business?.liquorLicenseNumber,
          payload.account.liquorLicenseNumber
        ),
        businessType: firstNonEmpty(
          data?.account?.businessType,
          data?.business?.businessType,
          payload.account.businessType
        )
      };
      payload.account = {
        ...payload.account,
        ...Object.fromEntries(
          Object.entries(mappedAccount).filter(([, value]) => value !== undefined)
        )
      };
    }

    if (!isEmpty(data.media)) {
      payload.media = {
        ...(existing.media || {}),
        ...data.media
      };
    }

    if (!isEmpty(data.pricing)) {
      payload.pricing = {
        ...(existing.pricing || {}),
        ...data.pricing
      };
    }

    if (!isEmpty(data.credit)) {
      payload.credit = {
        ...(existing.credit || {}),
        ...data.credit
      };
    }

    payload.system = {
      ...(existing.system || {}),
      ...(isEmpty(data.system) ? {} : data.system),
      updatedAt: now
    };

    if (Object.keys(payload).length === 0) {
      return err(400, "No Updates", "No valid fields provided to update.");
    }

    /* -----------------------------------------
       Commit DB Update
    ----------------------------------------- */
    await updateDoc(ref, payload);

    return ok({ data: payload });

  } catch (e) {
    return err(500, "Update Failed", e.message);
  }
}
