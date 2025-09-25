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
  if (!input) return [];
  return Array.isArray(input) ? input : [input];
}

function toPlainText(htmlOrText) {
  if (typeof htmlOrText !== "string") return "";
  return htmlOrText.replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n").trim();
}

// --- Internal monitoring emails ---
const INTERNAL_EMAILS = [
  "monique@bevgo.co.za",
  "dillon@bevgo.co.za",
  "stephen@bevgo.co.za",
];

// --- Templates that should always BCC internal emails ---
const TEMPLATES_WITH_INTERNAL_BCC = [
  "orderreceived",
  "newuseralert",
  "reorderreceived",
  // add more template names as needed
];

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

    if (!to || !subject) {
      return NextResponse.json(
        { error: "Missing required fields: to, subject" },
        { status: 400 }
      );
    }

    let htmlBody;

    if (template && template.trim() !== "") {
      // --- Template mode ---
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
      // --- Raw message mode ---
      const rawMessage = data?.message;
      if (!rawMessage || typeof rawMessage !== "string") {
        return NextResponse.json(
          { error: "Missing data.message when no template is provided" },
          { status: 400 }
        );
      }
      htmlBody = rawMessage;
    }

    // Base recipients
    const finalTo = normalizeRecipients(to);
    const finalCc = normalizeRecipients(cc);
    let finalBcc = normalizeRecipients(bcc);

    // If template matches, add internal emails to BCC
    if (template && TEMPLATES_WITH_INTERNAL_BCC.includes(template)) {
      finalBcc = [...new Set([...finalBcc, ...INTERNAL_EMAILS])];
    }

    const msg = {
      to: finalTo,
      cc: finalCc.length > 0 ? finalCc : undefined,
      bcc: finalBcc.length > 0 ? finalBcc : undefined,
      from: "no-reply@bevgo.co.za", // Verified sender
      subject,
      html: htmlBody,
      text: toPlainText(htmlBody),
      ...(unsubscribeUrl
        ? {
            headers: {
              "List-Unsubscribe": `<${unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }
        : {}),
      unsubscribeUrl,
    };

    await sgMail.send(msg);

    return NextResponse.json({ message: "Email sent successfully" });
  } catch (error) {
    console.error("Email send error:", error?.response?.body || error.message);
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
}
