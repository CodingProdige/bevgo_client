export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from "firebase/firestore";
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

function buildStatus(uid, user) {
  const account = user?.account || {};
  const onboardingComplete = account?.onboardingComplete === true;
  const accountActive = account?.accountActive === true;

  return {
    uid,
    onboardingComplete,
    accountActive,
    accountType: account?.accountType || null,
    customerCode: account?.customerCode || null,
    schemaVersion: account?.schemaVersion || null
  };
}

async function findUserByCustomerCode(customerCode) {
  const usersRef = collection(db, "users");
  const q = query(usersRef, where("account.customerCode", "==", customerCode));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { uid: docSnap.id, data: docSnap.data() };
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const uid = isEmpty(body?.uid) ? null : String(body.uid).trim();
    const customerCode = isEmpty(body?.customerCode)
      ? null
      : String(body.customerCode).trim();

    if (!uid && !customerCode) {
      return err(
        400,
        "Missing Parameters",
        "uid or customerCode is required."
      );
    }

    if (uid) {
      const ref = doc(db, "users", uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        return err(404, "User Not Found", `No user found with uid: ${uid}`);
      }

      return ok({
        data: buildStatus(uid, snap.data())
      });
    }

    const match = await findUserByCustomerCode(customerCode);
    if (!match) {
      return err(
        404,
        "User Not Found",
        `No user found with customerCode: ${customerCode}`
      );
    }

    return ok({
      data: buildStatus(match.uid, match.data)
    });
  } catch (e) {
    return err(500, "Onboarding Status Check Failed", e?.message || "Unexpected error.");
  }
}
