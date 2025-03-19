import admin from "firebase-admin";
import serviceAccount from "./serviceAccountKey.json"; // ✅ Import JSON file directly

// ✅ Ensure Firebase Admin is initialized only once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.FIREBASE_STORAGE_BUCKET, // ✅ Make sure bucket name is correct
  });
}

const db = admin.firestore();
const storage = admin.storage().bucket(); // ✅ Use Firebase Storage

export { db, storage };
