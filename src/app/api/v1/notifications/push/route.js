import { NextResponse } from "next/server";
import admin from "firebase-admin";
import { pushTemplates } from "./messages";

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
const FCM_BATCH_LIMIT = 500;

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

async function getAllTokens() {
  try {
    const snap = await db.collectionGroup("fcm_tokens").get();
    const tokens = [];
    snap.forEach(doc => {
      const data = doc.data() || {};
      const token = data.fcm_token || data.token || null;
      if (token) tokens.push(token);
    });
    return Array.from(new Set(tokens));
  } catch (e) {
    console.error("❌ GLOBAL TOKEN FETCH ERROR:", e);
    return [];
  }
}

async function getManyUserTokens(uids = []) {
  const results = await Promise.all(uids.map(uid => getUserTokens(uid)));
  const all = results.flat();
  return Array.from(new Set(all));
}

/* ---------------------------------------------
   MESSAGE TEMPLATES
--------------------------------------------- */
function interpolate(template = "", vars = {}) {
  return String(template).replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
    const value = vars?.[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function buildMessage(type, vars = {}) {
  const tpl = pushTemplates?.[type];
  if (tpl) {
    return {
      title: interpolate(tpl.title, vars),
      body: interpolate(tpl.body, vars),
      link: interpolate(tpl.link || "", vars)
    };
  }

  return {
    title: "Bevgo Notification",
    body: "You have a new message."
  };
}

function normalizeDataPayload(data = {}) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

/* ---------------------------------------------
   SEND PUSH
--------------------------------------------- */
async function sendPush(tokens, payload) {
  try {
    let successCount = 0;
    let failureCount = 0;
    const responses = [];

    for (let i = 0; i < tokens.length; i += FCM_BATCH_LIMIT) {
      const batch = tokens.slice(i, i + FCM_BATCH_LIMIT);
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        ...payload
      });
      successCount += res.successCount || 0;
      failureCount += res.failureCount || 0;
      responses.push({
        batchIndex: Math.floor(i / FCM_BATCH_LIMIT) + 1,
        tokenCount: batch.length,
        successCount: res.successCount || 0,
        failureCount: res.failureCount || 0
      });
    }

    const aggregate = {
      successCount,
      failureCount,
      responses
    };
    console.log("📨 FCM RESPONSE:", aggregate);
    return aggregate;
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

  const body = await req.json().catch(() => ({}));
  const {
    uid,
    uids,
    global = false,
    type,
    variables,
    notification,
    data,
    deeplink,
    link,
    includeTokens = false
  } = body || {};

  console.log("📩 PUSH REQUEST:", body);

  if (!global && !uid && !(Array.isArray(uids) && uids.length > 0)) {
    return NextResponse.json(
      {
        ok: false,
        title: "Missing Target",
        message: "Provide one of: uid, uids[], or global=true.",
        devicesReceived: 0,
        devicesFailed: 0
      },
      { status: 400 }
    );
  }

  let tokens = [];
  if (global) tokens = await getAllTokens();
  else if (uid) tokens = await getUserTokens(uid);
  else tokens = await getManyUserTokens(uids);

  if (!tokens.length) {
    return NextResponse.json({
      ok: false,
      title: "No Device Tokens",
      message: "No registered device tokens found for the requested target.",
      devicesReceived: 0,
      devicesFailed: 0
    });
  }

  const templateMsg = buildMessage(type, variables || {});
  const deepLink = deeplink || link || notification?.link || templateMsg?.link || "";
  const payloadData = normalizeDataPayload({
    ...(data || {}),
    ...(type ? { template: type } : {}),
    ...(deepLink ? { link: deepLink, deeplink: deepLink } : {})
  });
  const payloadNotification = {
    title: notification?.title || templateMsg.title,
    body: notification?.body || templateMsg.body
  };
  if (notification?.imageUrl) payloadNotification.imageUrl = notification.imageUrl;

  const payload = {
    notification: payloadNotification,
    data: payloadData
  };

  const providerResp = await sendPush(tokens, payload);

  return NextResponse.json({
    ok: true,
    uid,
    uids: Array.isArray(uids) ? uids : undefined,
    global,
    tokensSent: tokens.length,
    devicesReceived: providerResp?.successCount ?? 0,
    devicesFailed: providerResp?.failureCount ?? 0,
    ...(includeTokens ? { tokens } : {}),
    message: payloadNotification,
    deeplink: deepLink || null,
    data: payloadData,
    providerResp,
    sentAt: new Date().toISOString()
  });
}
