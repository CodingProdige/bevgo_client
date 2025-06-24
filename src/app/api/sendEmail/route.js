import { NextResponse } from "next/server";
import sgMail from "@sendgrid/mail";
import ejs from "ejs";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Handle __dirname in App Router (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set SendGrid API key from env
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Normalize single or multiple recipients into array
function normalizeRecipients(input) {
  if (!input) return undefined;
  return Array.isArray(input) ? input : [input];
}

export async function POST(req) {
  try {
    const { to, cc, bcc, subject, data, template, emailOptOut, unsubscribeUrl } = await req.json();

    if (emailOptOut === true) {
      return NextResponse.json({
        message: "Email not sent — user opted out.",
        skipped: true,
      });
    }

    if (!to || !subject || !template) {
      return NextResponse.json(
        { error: "Missing required fields: to, subject, template" },
        { status: 400 }
      );
    }

    // Path to template under src/app/lib/templates
    const templatePath = path.join(process.cwd(), "src/lib/templates", `${template}.ejs`);

    try {
      await fs.access(templatePath);
    } catch {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const html = await ejs.renderFile(templatePath, {
        ...data,
        subject,
        unsubscribeUrl,
      });
      
    const msg = {
      to: normalizeRecipients(to),
      cc: normalizeRecipients(cc),
      bcc: normalizeRecipients(bcc),
      from: "no-reply@bevgo.co.za", // Use your verified sender
      subject,
      html,
      unsubscribeUrl,
    };

    await sgMail.send(msg);

    return NextResponse.json({ message: "Email sent successfully" });
  } catch (error) {
    console.error("Email send error:", error?.response?.body || error.message);
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
}
