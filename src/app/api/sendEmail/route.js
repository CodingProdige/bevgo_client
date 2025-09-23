// app/api/email/route.js
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

function toPlainText(htmlOrText) {
  if (typeof htmlOrText !== "string") return "";
  // If it's HTML, strip tags; if it's plain text, this is harmless.
  return htmlOrText.replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n").trim();
}

export async function POST(req) {
  try {
    const {
      to,
      cc,
      bcc,
      subject,
      data = {},
      template,          // optional
      emailOptOut,
      unsubscribeUrl,    // optional (used by templates or headers)
    } = await req.json();

    if (emailOptOut === true) {
      return NextResponse.json({
        message: "Email not sent — user opted out.",
        skipped: true,
      });
    }

    // Require minimal fields: to + subject. Template is optional now.
    if (!to || !subject) {
      return NextResponse.json(
        { error: "Missing required fields: to, subject" },
        { status: 400 }
      );
    }

    let htmlBody;

    if (template && template.trim() !== "") {
      // --- Template mode (unchanged behavior) ---
      const templatePath = path.join(
        process.cwd(),
        "src/lib/templates",
        `${template}.ejs`
      );

      try {
        await fs.access(templatePath);
      } catch {
        return NextResponse.json({ error: "Template not found" }, { status: 404 });
      }

      htmlBody = await ejs.renderFile(templatePath, {
        ...data,
        subject,
        unsubscribeUrl,
      });
    } else {
      // --- No template provided: send data.message as-is ---
      const rawMessage = data?.message;
      if (!rawMessage || typeof rawMessage !== "string") {
        return NextResponse.json(
          { error: "Missing data.message when no template is provided" },
          { status: 400 }
        );
      }
      htmlBody = rawMessage; // Use exactly what you pass in
    }

    const msg = {
      to: normalizeRecipients(to),
      cc: normalizeRecipients(cc),
      bcc: normalizeRecipients(bcc),
      from: "no-reply@bevgo.co.za", // Verified sender
      subject,
      html: htmlBody,
      text: toPlainText(htmlBody),
      // Keep your existing field (if your EJS uses it), but also add standard headers.
      ...(unsubscribeUrl
        ? {
            headers: {
              "List-Unsubscribe": `<${unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }
        : {}),
      unsubscribeUrl, // non-standard; kept for backward compatibility with your templates   
    };

    await sgMail.send(msg);

    return NextResponse.json({ message: "Email sent successfully" });
  } catch (error) {
    console.error("Email send error:", error?.response?.body || error.message);
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
}
