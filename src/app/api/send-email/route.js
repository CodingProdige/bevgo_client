import { sendEmail } from "@/lib/emailService";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { to, subject, message, ccList } = await req.json();

    if (!to || !subject || !message) {
      return NextResponse.json(
        { error: "Required fields: to, subject, and message" },
        { status: 400 }
      );
    }

    const emailHTML = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <p>${message}</p>
      </div>
    `;

    const result = await sendEmail(to, subject, emailHTML, ccList || []);

    if (result.success) {
      return NextResponse.json({ message: "Email sent successfully!" }, { status: 200 });
    } else {
      return NextResponse.json({ error: "Failed to send email", details: result.error }, { status: 500 });
    }

  } catch (error) {
    console.error("❌ Error in send-email API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
