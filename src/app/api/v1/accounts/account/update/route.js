export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { doc, getDoc, updateDoc, collection, getDocs, query } from "firebase/firestore";
import { NextResponse } from "next/server";

/* -----------------------------------------
   Response Helpers
----------------------------------------- */
const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

/* -----------------------------------------
   Customer Code Generator
----------------------------------------- */
function getInitials(name) {
  if (!name) return "";
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z\s]/g, "")
    .split(/\s+/)
    .map(w => w.charAt(0))
    .join("")
    .substring(0, 5);
}

function random4() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function generateCustomerCode(name) {
  const initials = getInitials(name);
  if (!initials) throw new Error("Invalid name for customer code generation.");

  const snap = await getDocs(query(collection(db, "users")));
  const existing = new Set();

  snap.forEach(d => {
    const cc = d.data().account?.customerCode;
    if (cc) existing.add(cc);
  });

  let attempts = 0;
  let code = "";

  do {
    code = `${initials}${random4()}`;
    attempts++;
    if (attempts > 25) throw new Error("Unique code generation failed.");
  } while (existing.has(code));

  return code;
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

    const isPersonal = existing.account.accountType === "personal";
    const isBusiness = existing.account.accountType === "business";

    /* -----------------------------------------
       Extract Old & New Names
    ----------------------------------------- */
    const oldName = isPersonal
      ? existing.personal?.fullName
      : existing.business?.companyName;

    const newName = isPersonal
      ? data.personal?.fullName
      : data.business?.companyName;

    /* -----------------------------------------
       Determine if Customer Code Should Regenerate
    ----------------------------------------- */
    let updatedCustomerCode = existing.account.customerCode;

    // Regenerate only if name changed AND new name is valid
    if (newName && newName.trim() !== "" && newName !== oldName) {
      updatedCustomerCode = await generateCustomerCode(newName);
    }

    /* -----------------------------------------
       Build Update Payload
       (Does NOT touch pricing, credit, violations, deliveryLocations)
    ----------------------------------------- */
    const payload = {
      account: {
        ...existing.account,
        customerCode: updatedCustomerCode
      },

      personal: isPersonal
        ? {
            fullName: data.personal?.fullName ?? existing.personal?.fullName,
            phoneNumber: data.personal?.phoneNumber ?? existing.personal?.phoneNumber,
            idData: data.personal?.idData ?? existing.personal?.idData
          }
        : null,

      business: isBusiness
        ? {
            companyName: data.business?.companyName ?? existing.business?.companyName,
            phoneNumber: data.business?.phoneNumber ?? existing.business?.phoneNumber,
            vatNumber: data.business?.vatNumber ?? existing.business?.vatNumber,
            registrationNumber:
              data.business?.registrationNumber ?? existing.business?.registrationNumber,
            liquorLicenseNumber:
              data.business?.liquorLicenseNumber ?? existing.business?.liquorLicenseNumber,
            businessType:
              data.business?.businessType ?? existing.business?.businessType
          }
        : null,

      system: {
        ...existing.system,
        updatedAt: now
      }
    };

    /* -----------------------------------------
       Commit DB Update
    ----------------------------------------- */
    await updateDoc(ref, payload);

    return ok({ data: payload });

  } catch (e) {
    return err(500, "Update Failed", e.message);
  }
}
