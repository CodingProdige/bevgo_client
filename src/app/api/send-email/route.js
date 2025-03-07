import { sendEmail } from "@/lib/emailService";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const body = await req.json();
    const { to } = body;

    if (!to) {
      return NextResponse.json({ error: "Recipient email is required" }, { status: 400 });
    }

    const emailContent = `
      <h2>Hello World from Bevgo! 🌍</h2>
      <p>This is a test email sent from our system.</p>
      <p>Enjoy your day! 🚀</p>
    `;

    const result = await sendEmail(to, emailContent);

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
