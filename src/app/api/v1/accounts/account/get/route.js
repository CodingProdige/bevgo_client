export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc } from "firebase/firestore";
import { NextResponse } from "next/server";

const ok = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

export async function POST(req) {
  try {
    const body = await req.json();
    const { uid } = body;

    if (!uid) {
      return err(400, "Missing Fields", "uid is required to fetch a user.");
    }

    const ref = doc(db, "users", uid);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      return err(404, "User Not Found", `No user found with uid: ${uid}`);
    }

    // Return user doc EXACTLY as stored
    return ok({ data: snap.data() });

  } catch (e) {
    return err(500, "Failed To Retrieve User", e.message);
  }
}
