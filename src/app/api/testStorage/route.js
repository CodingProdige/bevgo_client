import { storage } from "@/lib/firebaseConfig";
import { ref, getDownloadURL } from "firebase/storage";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    console.log("✅ Testing Firebase Storage Access:", storage);

    // Test if we can access storage
    const testRef = ref(storage, "qrcodes/8038a31a-87b0-4e51-852d-3c6fb55ba65d.png");
    const url = await getDownloadURL(testRef);

    return NextResponse.json({ success: true, url }, { status: 200 });

  } catch (error) {
    console.error("❌ Firebase Storage Access Failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
