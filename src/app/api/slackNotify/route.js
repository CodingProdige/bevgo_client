import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { message } = await req.json();

    if (!message) {
      return NextResponse.json({ error: "Missing 'message' in request body" }, { status: 400 });
    }

    const webhookUrl = process.env.SLACK_WEBHOOK_URL;

    if (!webhookUrl) {
      return NextResponse.json({ error: "SLACK_WEBHOOK_URL not configured" }, { status: 500 });
    }

    const payload = {
      text: message, // Slack will post this in #invoices-notifications
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json({ error: "Slack webhook failed", detail: errorText }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Slack Notify Error:", err);
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
