import { storage } from "@/lib/firebaseConfig"; // ✅ Firebase Client SDK
import QRCode from "qrcode";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

export async function POST(req) {
  try {
    const { value } = await req.json();

    if (!value) {
      return NextResponse.json({ error: "Missing value for QR code" }, { status: 400 });
    }

    // ✅ Generate QR Code as a Buffer
    const qrBuffer = await QRCode.toBuffer(value);

    // ✅ Generate a unique file name
    const fileName = `qrcodes/${uuidv4()}.png`;

    // ✅ Log storage instance
    console.log("✅ Firebase Storage Instance:", storage);

    // ✅ Upload the QR code buffer directly to Firebase Storage
    const fileRef = ref(storage, fileName);
    console.log(`📤 Uploading QR Code to Firebase Storage: ${fileName}`);

    const uploadResult = await uploadBytes(fileRef, qrBuffer, { contentType: "image/png" });
    console.log(`✅ Upload successful:`, uploadResult);

    // ✅ Get the public download URL
    const qrCodeURL = await getDownloadURL(fileRef);
    console.log(`🔗 QR Code URL: ${qrCodeURL}`);

    return NextResponse.json({ qrCodeURL }, { status: 200 });

  } catch (error) {
    console.error("❌ Failed to generate QR code:", error);
    return NextResponse.json(
      { error: "Failed to generate QR code", details: error.message },
      { status: 500 }
    );
  }
}
