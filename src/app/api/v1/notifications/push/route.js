import { NextResponse } from "next/server";
import admin from "firebase-admin";

/* ---------------------------------------------
   LOAD SERVICE ACCOUNT FROM ENV
--------------------------------------------- */
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  console.log("🧪 SERVICE ACCOUNT OK:", serviceAccount.client_email);
} catch (e) {
  console.error("❌ SERVICE ACCOUNT JSON ERROR:", e);
  throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON");
}

/* ---------------------------------------------
   INIT ADMIN SDK (only once)
--------------------------------------------- */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const messaging = admin.messaging();

/* ---------------------------------------------
   FETCH USER TOKENS (Admin SDK syntax)
--------------------------------------------- */
async function getUserTokens(uid) {
  try {
    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("fcm_tokens")
      .get();

    const tokens = [];
    snap.forEach(doc => {
      const data = doc.data();
      if (data?.fcm_token) tokens.push(data.fcm_token);
    });

    console.log("🧪 REAL TOKENS:", tokens);
    return tokens;
  } catch (e) {
    console.error("❌ TOKEN FETCH ERROR:", e);
    return [];
  }
}

/* ---------------------------------------------
   MESSAGE TEMPLATES
--------------------------------------------- */
function buildMessage(type, vars) {
  if (type === "order-dispatched") {
    return {
      title: "Your Order Is On The Way 🚚",
      body: `Order ${vars.orderId} has been dispatched and is on route.`
    };
  }

  return {
    title: "Bevgo Notification",
    body: "You have a new message."
  };
}

/* ---------------------------------------------
   SEND PUSH
--------------------------------------------- */
async function sendPush(tokens, message) {
  try {
    const payload = {
      notification: message,
      data: {
        link: message.link ?? ""
      }
    };

    const res = await messaging.sendEachForMulticast({
      tokens,
      ...payload
    });

    console.log("📨 FCM RESPONSE:", res);
    return res;
  } catch (e) {
    console.error("❌ PUSH SEND ERROR:", e);
    throw e;
  }
}

/* ---------------------------------------------
   MAIN HANDLER
--------------------------------------------- */
export async function POST(req) {
  console.log("🟡 PUSH ROUTE LOADED");

  const body = await req.json();
  const { uid, type, variables } = body;

  console.log("📩 PUSH REQUEST:", body);

  const tokens = await getUserTokens(uid);

  if (!tokens.length) {
    return NextResponse.json({
      ok: false,
      title: "No Device Tokens",
      message: "User has no registered device tokens."
    });
  }

  const msg = buildMessage(type, variables);
  const providerResp = await sendPush(tokens, msg);

  return NextResponse.json({
    ok: true,
    uid,
    tokensSent: tokens.length,
    tokens,
    message: msg,
    providerResp,
    sentAt: new Date().toISOString()
  });
}
