import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, initializeFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
    apiKey: "AIzaSyANvMSPK3eX8mJkAWwN5oVJNTNoatjlfUw",
    authDomain: "bevgo-client-management-rckxs5.firebaseapp.com",
    projectId: "bevgo-client-management-rckxs5",
    storageBucket: "bevgo-client-management-rckxs5.firebasestorage.app",  // ✅ Ensure this is correct
    messagingSenderId: "265219789103",
    appId: "1:265219789103:web:14bbe9c82d480912ef11da"
};

// ✅ Ensure Firebase App is initialized only once
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// ✅ Initialize Firestore
const db = initializeFirestore(app, {});

// ✅ Initialize Firebase Authentication
const auth = getAuth(app);

// ✅ Initialize Firebase Storage
const storage = getStorage(app);  // 🔹 Ensure Storage is initialized

export { db, auth, storage };
