export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import axios from "axios";
import { smsTemplates } from "./messages.js";

/* -----------------------------------------
   RESPONSE HELPERS
----------------------------------------- */
const ok = (p={},s=200)=> NextResponse.json({ ok:true, ...p }, { status:s });
const err = (s,t,m,e={})=> NextResponse.json({ ok:false, title:t, message:m, ...e }, { status:s });

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function resolveNotificationName(input = {}) {
  const snapshot = input?.customer_snapshot || {};
  const account = input?.account || snapshot?.account || {};
  const business = input?.business || snapshot?.business || {};
  const personal = input?.personal || snapshot?.personal || {};

  return firstNonEmptyString(
    account?.accountName,
    business?.companyName,
    personal?.fullName,
    input?.customerName,
    input?.companyName,
    input?.name
  );
}

/* -----------------------------------------
   POST: SEND SMS
----------------------------------------- */
export async function POST(req) {
  try {
    const body = await req.json();
    const { type="custom", to, message, data={} } = body;
    const resolvedName = resolveNotificationName(data || {});
    const safeData = {
      ...(data || {}),
      ...(resolvedName ? {
        name: resolvedName,
        customerName: resolvedName,
        companyName: resolvedName
      } : {})
    };

    if (!to) {
      return err(400, "Missing Number", "Field 'to' is required.");
    }

    /* -----------------------------------------
       Custom message mode
    ----------------------------------------- */
    if (type === "custom") {
      const smsPayload = {
        messages: [
          {
            content: message || "",
            destination: to
          }
        ]
      };

      const response = await axios.post(
        "https://rest.smsportal.com/bulkmessages",
        smsPayload,
        {
          headers: {
            "Authorization":
              "Basic " +
              Buffer.from(
                process.env.SMSPORTAL_CLIENT_ID + ":" + process.env.SMSPORTAL_API_SECRET
              ).toString("base64"),
            "Content-Type": "application/json"
          }
        }
      );

      return ok({ providerResponse: response.data });
    }

    /* -----------------------------------------
       Template mode
    ----------------------------------------- */
    const template = smsTemplates[type];
    if (!template) {
      return err(
        400,
        "Invalid Template",
        `No SMS template exists for type '${type}'`
      );
    }

    // Merge variables {{key}}
    let resolvedMessage = template.message;
    for (const key of Object.keys(safeData)) {
      resolvedMessage = resolvedMessage.replace(
        new RegExp(`{{${key}}}`, "g"),
        safeData[key]
      );
    }

    const smsPayload = {
      messages: [
        {
          content: resolvedMessage,
          destination: to
        }
      ]
    };

    const response = await axios.post(
      "https://rest.smsportal.com/bulkmessages",
      smsPayload,
      {
        headers: {
          "Authorization":
            "Basic " +
            Buffer.from(
              process.env.SMSPORTAL_CLIENT_ID + ":" + process.env.SMSPORTAL_API_SECRET
            ).toString("base64"),
          "Content-Type": "application/json"
        }
      }
    );

    return ok({
      sent: true,
      to,
      resolvedMessage,
      providerResponse: response.data
    });

  } catch (e) {
    return err(500, "SMS Sending Failed", e.message, {
      providerError: e.response?.data || null
    });
  }
}
