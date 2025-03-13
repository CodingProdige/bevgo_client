import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, persistentLocalCache, persistentMultipleTabManager, initializeFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
    apiKey: "AIzaSyANvMSPK3eX8mJkAWwN5oVJNTNoatjlfUw",
    authDomain: "bevgo-client-management-rckxs5.firebaseapp.com",
    projectId: "bevgo-client-management-rckxs5",
    storageBucket: "bevgo-client-management-rckxs5.firebasestorage.app",
    messagingSenderId: "265219789103",
    appId: "1:265219789103:web:14bbe9c82d480912ef11da"
};

// ✅ Prevent multiple Firebase app instances
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// ✅ Initialize Firestore with caching
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// ✅ Initialize Firebase Authentication
const auth = getAuth(app);

export { db, auth };
