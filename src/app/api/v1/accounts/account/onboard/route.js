export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import { doc, setDoc, getDoc, collection, getDocs, query } from "firebase/firestore";
import { NextResponse } from "next/server";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

/* -----------------------------------------
   SAFE EMPTY CHECK
----------------------------------------- */
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && Object.keys(value).length === 0) return true;
  return false;
}

/* -----------------------------------------
   Customer Code Generator (Multi-word)
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
    if (attempts > 25) throw new Error("Unable to generate unique customer code.");
  } while (existing.has(code));

  return code;
}

/* -----------------------------------------
   ONBOARD ENDPOINT
----------------------------------------- */
export async function POST(req) {
  try {
    const body = await req.json();
    const { uid, data } = body;

    if (!uid || !data)
      return err(400, "Missing Fields", "uid and data are required for onboarding.");

    const accountType = data.accountType;
    if (!accountType)
      return err(400, "Missing Account Type", "data.accountType is required.");

    const ref = doc(db, "users", uid);
    const snap = await getDoc(ref);

    if (!snap.exists())
      return err(404, "User Not Found", "Cannot onboard a non-existing user.");

    const existing = snap.data();

    // ISO-normalized timestamp created here (safe)
    const now = new Date().toISOString();

    /* -----------------------------------------
       TRADE AGREEMENT
    ----------------------------------------- */
    if (!data.tradeAgreement || data.tradeAgreement.agreed !== true) {
      return err(
        400,
        "Trade Agreement Required",
        "You must agree to the Bevgo Master Trade Agreement to continue."
      );
    }

    /* -----------------------------------------
       ID VALIDATION — PERSONAL ONLY
    ----------------------------------------- */
    if (accountType === "personal") {
      if (isEmpty(data.idData) || !data.idData.isValid) {
        return err(
          400,
          "Invalid ID",
          "A valid South African ID or passport is required."
        );
      }
    }

    /* -----------------------------------------
       ACTIVE ACCOUNT LOGIC
    ----------------------------------------- */
    let accountActive = true;
    if (accountType === "business") {
      const payMethod = data.preferredPaymentMethod || "cod";
      accountActive = payMethod === "cod";
    }

    /* -----------------------------------------
       CUSTOMER CODE NAME SOURCE
    ----------------------------------------- */
    const nameForCode =
      accountType === "personal"
        ? data.personal?.fullName
        : data.business?.companyName;

    if (isEmpty(nameForCode)) {
      return err(400, "Missing Name", "Name is required to generate customer code.");
    }

    const customerCode =
      existing.account?.customerCode && existing.account.customerCode.trim() !== ""
        ? existing.account.customerCode
        : await generateCustomerCode(nameForCode);

    /* -----------------------------------------
       DEFAULT ID STRUCTURE
    ----------------------------------------- */
    const defaultIdData = {
      type: "",
      isValid: false,
      suspectedFraud: false,
      country: "",
      countryName: "",
      flag: "",
      dateOfBirth: "",
      age: null,
      isAdult: false,
      gender: "",
      confidence: 0
    };

    /* -----------------------------------------
       PERSONAL BLOCK (SAFE)
    ----------------------------------------- */
    const personalBlock =
      accountType === "personal"
        ? {
            fullName: !isEmpty(data.personal?.fullName)
              ? data.personal.fullName
              : existing.personal?.fullName || "",

            phoneNumber: !isEmpty(data.personal?.phoneNumber)
              ? data.personal.phoneNumber
              : existing.personal?.phoneNumber || "",

            idData: !isEmpty(data.idData)
              ? { ...defaultIdData, ...data.idData }
              : existing.personal?.idData || defaultIdData
          }
        : null;

    /* -----------------------------------------
       BUSINESS BLOCK (SAFE)
    ----------------------------------------- */
    const businessBlock =
      accountType === "business"
        ? {
            companyName: !isEmpty(data.business?.companyName)
              ? data.business.companyName
              : existing.business?.companyName || "",

            phoneNumber: !isEmpty(data.business?.phoneNumber)
              ? data.business.phoneNumber
              : existing.business?.phoneNumber || "",

            vatNumber: !isEmpty(data.business?.vatNumber)
              ? data.business.vatNumber
              : existing.business?.vatNumber || "",

            registrationNumber: !isEmpty(data.business?.registrationNumber)
              ? data.business.registrationNumber
              : existing.business?.registrationNumber || "",

            liquorLicenseNumber: !isEmpty(data.business?.liquorLicenseNumber)
              ? data.business.liquorLicenseNumber
              : existing.business?.liquorLicenseNumber || "",

            businessType: !isEmpty(data.business?.businessType)
              ? data.business.businessType
              : existing.business?.businessType || ""
          }
        : null;

    /* -----------------------------------------
       FINAL USER PAYLOAD
----------------------------------------- */
    const payload = {
      uid,
      email: existing.email || "",
      created_time: existing.created_time || now, // ISO

      account: {
        accountActive,
        onboardingComplete: true,
        accountType,
        customerCode,
        schemaVersion: 2,
        profileColor:
          data.account?.profileColor ??
          data.profileColor ??
          existing.account?.profileColor ??
          ""
      },

      personal: personalBlock,
      business: businessBlock,

      media: {
        photoUrl: !isEmpty(data.media?.photoUrl)
          ? data.media.photoUrl
          : existing.media?.photoUrl || "",
      
        blurHash: !isEmpty(data.media?.blurHash)
          ? data.media.blurHash
          : existing.media?.blurHash || ""
      },      

      deliveryLocations: existing.deliveryLocations || [],

      preferences: existing.preferences || {
        emailNotifications: true,
        smsNotifications: true,
        pushNotifications: true,
        favoriteProducts: []
      },

      pricing: existing.pricing || {
        discountType: "none",
        discountPercentage: 0,
        rebate: {
          tierLocked: false,
          tier: null,
          rebateEligible: false
        }
      },

      tradeAgreement: {
        agreed: true,
        agreedAt: now // ISO
      },

      credit: existing.credit || {
        creditApproved: false,
        creditLimit: null,
        availableCredit: null,
        paymentTerms: null,
        creditStatus: "none",
        approvedAt: null,
        approvedBy: null,
        creditApplicationId: null
      },

      violations: existing.violations || {
        hasActiveViolation: false,
        isBlocked: false,
        reasonCode: null,
        reasonMessage: null,
        blockedAt: null,
        blockedBy: null,
        history: []
      },

      system: {
        accessType: existing.system?.accessType || "customer",
        current_app_version: existing.system?.current_app_version || "",
        updatedAt: now // ISO
      }
    };

    await setDoc(ref, payload);

    return ok({ data: payload });

  } catch (e) {
    return err(500, "Onboarding Failed", e.message);
  }
}
