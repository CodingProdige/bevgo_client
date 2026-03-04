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

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      uid,
      targetAccountType,
      data = {}
    } = body || {};

    if (isEmpty(uid)) {
      return err(400, "Missing Fields", "uid is required.");
    }

    if (isEmpty(targetAccountType)) {
      return err(400, "Missing Account Type", "targetAccountType is required.");
    }

    const ref = doc(db, "users", String(uid).trim());
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "User Not Found", "Cannot convert a non-existing user.");
    }

    const existing = snap.data() || {};
    const previousAccountType = existing?.account?.accountType || null;
    const nextAccountType = String(targetAccountType).trim();
    const now = new Date().toISOString();

    const payload = {
      account: {
        ...(existing?.account || {}),
        ...(isEmpty(data?.account) ? {} : data.account),
        accountType: nextAccountType,
        accountActive: true,
        onboardingComplete: true
      },
      system: {
        ...(existing?.system || {}),
        updatedAt: now
      }
    };

    await updateDoc(ref, payload);

    return ok({
      data: {
        uid: String(uid).trim(),
        previousAccountType,
        accountType: nextAccountType,
        accountActive: true,
        convertedAt: now
      }
    });
  } catch (e) {
    return err(500, "Conversion Failed", e?.message || "Unexpected error.");
  }
}

