import { db, auth } from "@/lib/firebaseConfig";
import { collection, doc, setDoc, query, where, getDocs } from "firebase/firestore";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { sendEmail } from "@/lib/emailService";
import { registerTemplate } from "@/lib/emailTemplates/registerTemplate";
import { NextResponse } from "next/server";

// Function to generate a unique company code
async function generateUniqueCompanyCode(companyName) {
  let isUnique = false;
  let generatedCode = "";

  while (!isUnique) {
    const randomNumber = Math.floor(1000 + Math.random() * 9000);
    const sanitizedCompanyName = companyName.replace(/\s+/g, "").toUpperCase().slice(0, 6);
    generatedCode = `${sanitizedCompanyName}${randomNumber}`;

    // Check if companyCode already exists
    const companyQuery = query(collection(db, "users"), where("companyCode", "==", generatedCode));
    const existingCompanies = await getDocs(companyQuery);

    if (existingCompanies.empty) {
      isUnique = true;
    }
  }

  return generatedCode;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { email, password, companyName, companyAddress, companyVAT, companyContact } = body;

    if (!email || !password || !companyName || !companyAddress || !companyContact) {
      return NextResponse.json({ error: "All fields are required" }, { status: 400 });
    }

    // Check if the email is already registered
    const usersRef = collection(db, "users");
    const emailQuery = query(usersRef, where("email", "==", email));
    const existingUsers = await getDocs(emailQuery);

    if (!existingUsers.empty) {
      return NextResponse.json({ error: "Email is already registered" }, { status: 409 });
    }

    // Generate Unique Company Code
    const companyCode = await generateUniqueCompanyCode(companyName);

    // Create User in Firebase Authentication
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const userId = userCredential.user.uid; // Use this as the Firestore doc ID


    // Save user data in Firestore using setDoc (with userId as the document ID)
    const newUser = {
      userId,
      email,
      companyName,
      companyCode,
      companyAddress,
      companyVAT: companyVAT || "", // Optional
      companyContact,
      createdAt: new Date().toISOString(), // Store timestamp as ISO string
      payment_terms: 0, // ✅ Added default payment terms options are 0, 7, 30 (indicating days)
    };

    await setDoc(doc(db, "users", userId), newUser); // 🔥 Ensure the document is tied to the userId

    // Generate the email content
    const emailContent = registerTemplate({
      companyName,
      email,
      password,
      companyCode,
      companyAddress,
      companyVAT,
      companyContact,
    });

    // Send email
    await sendEmail(email, "Welcome to Bevgo! 🚀", emailContent);

    return NextResponse.json({ message: "User registered successfully, email sent.", companyCode }, { status: 201 });

  } catch (error) {
    console.error("❌ Error in register API:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
