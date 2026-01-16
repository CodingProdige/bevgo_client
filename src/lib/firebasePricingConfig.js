import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const pricingConfig = {
  apiKey: process.env.PRICING_FIREBASE_API_KEY,
  authDomain: process.env.PRICING_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.PRICING_FIREBASE_PROJECT_ID,
  storageBucket: process.env.PRICING_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.PRICING_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.PRICING_FIREBASE_APP_ID
};

const appName = "pricing";
const existing = getApps().find((app) => app.name === appName);
const pricingApp = existing || initializeApp(pricingConfig, appName);

const pricingDb = getFirestore(pricingApp);

export { pricingDb };
