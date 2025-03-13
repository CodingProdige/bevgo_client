import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyANvMSPK3eX8mJkAWwN5oVJNTNoatjlfUw",
  authDomain: "bevgo-client-management-rckxs5.firebaseapp.com",
  projectId: "bevgo-client-management-rckxs5",
  storageBucket: "bevgo-client-management-rckxs5.firebasestorage.app",
  messagingSenderId: "265219789103",
  appId: "1:265219789103:web:14bbe9c82d480912ef11da",
};

// Ensure Firebase app is only initialized once
let app;
if (getApps().length === 0) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

const db = getFirestore(app);
const auth = getAuth(app);

export { db, auth };
