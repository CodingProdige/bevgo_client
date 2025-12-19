export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { collection, addDoc } from "firebase/firestore";

const ok = (p={},s=200)=>NextResponse.json({ok:true, ...p}, {status:s});
const err = (s,t,m,e={})=>NextResponse.json({ok:false, title:t, message:m, ...e}, {status:s});

// Flags
const countryFlags = {
  "ZA": "🇿🇦",
  "DEFAULT": "🌍"
};

// --------------------------------------
// Basic Date check (YYMMDD)
// --------------------------------------
function isValidYYMMDD(str) {
  const yy = parseInt(str.substring(0, 2), 10);
  const mm = parseInt(str.substring(2, 4), 10);
  const dd = parseInt(str.substring(4, 6), 10);
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

// --------------------------------------
// Country Detection
// --------------------------------------
function detectCountry(idNumber) {
  if (/^\d{13}$/.test(idNumber)) return "ZA";
  if (/^[A-Z]{1}[0-9]{6,9}$/i.test(idNumber)) return "PASSPORT";
  return "UNKNOWN";
}

// --------------------------------------
// SA ID Checksum (correct)
// --------------------------------------
function validateSouthAfricanID(idNumber) {
  if (!/^\d{13}$/.test(idNumber)) return false;
  const birth = idNumber.substring(0, 6);
  if (!isValidYYMMDD(birth)) return false;

  let step1 = 0;
  for (let i = 0; i < 12; i += 2) step1 += parseInt(idNumber[i], 10);

  let even = "";
  for (let i = 1; i < 12; i += 2) even += idNumber[i];
  const doubled = (parseInt(even, 10) * 2).toString();

  let step3 = 0;
  for (let digit of doubled) step3 += parseInt(digit, 10);

  const checksum = (10 - ((step1 + step3) % 10)) % 10;
  return checksum === parseInt(idNumber[12],10);
}

// --------------------------------------
// Derive Age (SA + foreign)
// --------------------------------------
function deriveAgeFromBirthString(birth) {
  if (!birth || birth.length !== 6) return null;

  const yy = parseInt(birth.substring(0,2),10);
  const mm = parseInt(birth.substring(2,4),10);
  const dd = parseInt(birth.substring(4,6),10);

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  // Convert YY → YYYY
  const year = yy < 30 ? 2000 + yy : 1900 + yy;

  const today = new Date();
  let age = today.getFullYear() - year;

  if (
    today.getMonth() + 1 < mm ||
    (today.getMonth() + 1 === mm && today.getDate() < dd)
  ) {
    age--;
  }

  return isNaN(age) || age < 0 || age > 120 ? null : age;
}

// --------------------------------------
// Confidence scoring
// --------------------------------------
function computeConfidence(isSA, valid) {
  if (isSA && valid) return 98;
  if (isSA && !valid) return 25;
  return 60;
}

// --------------------------------------
// MAIN ENDPOINT
// --------------------------------------
export async function POST(req) {
  try {
    const body = await req.json();
    const { idNumber, userUid=null, ipAddress=null, dateOfBirth=null } = body;

    if (!idNumber) return err(400,"Missing Field","idNumber required");

    const country = detectCountry(idNumber);

    // --------------------
    // SOUTH AFRICAN ID
    // --------------------
    if (country === "ZA") {
      const valid = validateSouthAfricanID(idNumber);
      const birth = idNumber.substring(0,6);

      const age = deriveAgeFromBirthString(birth);
      if (age === null) {
        return err(400, "Invalid ID", "Unable to derive age from ID number.");
      }

      const genderBlock = parseInt(idNumber.substring(6,10));
      const gender = genderBlock >= 5000 ? "male" : "female";

      const response = {
        type: "SOUTH_AFRICAN_ID",
        isValid: valid,
        suspectedFraud: !valid,
        country,
        countryName: "South Africa",
        flag: countryFlags["ZA"],
        dateOfBirth: birth,
        age,
        isAdult: age >= 18,
        gender,
        confidence: computeConfidence(true, valid)
      };

      await addDoc(collection(db,"id_validation_logs"),{
        idNumber,
        userUid,
        timestamp: new Date().toISOString(),
        response,
        ipAddress
      });

      return ok({ data: response });
    }

    // -----------------------------------------
    // FOREIGN / PASSPORT — MUST PROVIDE DOB
    // -----------------------------------------
    if (!dateOfBirth || dateOfBirth.length !== 6) {
      return err(
        400,
        "DOB Required",
        "Foreign IDs must include dateOfBirth in 'YYMMDD' format."
      );
    }

    const age = deriveAgeFromBirthString(dateOfBirth);
    if (age === null) {
      return err(400, "Invalid DOB", "Unable to derive age from the provided dateOfBirth.");
    }

    const response = {
      type: "FOREIGN_ID",
      isValid: true,
      suspectedFraud: false,
      country: "UNKNOWN",
      countryName: "Unknown",
      flag: countryFlags["DEFAULT"],
      dateOfBirth,
      age,
      isAdult: age >= 18,
      confidence: computeConfidence(false, true)
    };

    await addDoc(collection(db,"id_validation_logs"),{
      idNumber,
      userUid,
      timestamp: new Date().toISOString(),
      response,
      ipAddress
    });

    return ok({ data: response });

  } catch (e) {
    return err(500,"Validation Error",e.message);
  }
}
