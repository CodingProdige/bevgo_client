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

    const shouldUpdateAccount = !isEmpty(data.account);
    if (shouldUpdateAccount) {
      payload.account = {
        ...(existing.account || {}),
        ...(isEmpty(data.account) ? {} : data.account)
      };
    }

    if (!isEmpty(data.personal)) {
      const personalPayload = {
        ...(existing.personal || {}),
        ...data.personal
      };
      delete personalPayload.idData;
      payload.personal = personalPayload;
    }

    if (!isEmpty(data.business)) {
      payload.business = {
        ...(existing.business || {}),
        ...data.business
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
