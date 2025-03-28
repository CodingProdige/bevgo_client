import { sendEmail } from "@/lib/emailService";
import { NextResponse } from "next/server";
import ejs from "ejs";
import path from "path";
import fs from "fs/promises";

export async function POST(req) {
  try {
    const body = await req.json();
    const { to, subject, templateName, data } = body;

    if (!to || !subject || !templateName || !data) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // ✅ Support for multiple email addresses
    const recipients = Array.isArray(to) ? to : [to];

    // ✅ Construct the correct path for the email templates
    const templatePath = path.join(process.cwd(), "src", "lib", "emailTemplates", `${templateName}.ejs`);

    // ✅ Check if the template file exists
    try {
      await fs.access(templatePath);
    } catch (err) {
      return NextResponse.json({ error: "Template file not found" }, { status: 404 });
    }

    // ✅ Read and render the EJS template
    const templateContent = await fs.readFile(templatePath, "utf-8");
    const emailContent = ejs.render(templateContent, data);

    // ✅ Send the email to all recipients
    const results = await Promise.all(
      recipients.map(async (recipient) => {
        return await sendEmail(recipient, subject, emailContent);
      })
    );

    const failedEmails = results
      .map((result, index) => (result.success ? null : recipients[index]))
      .filter((email) => email !== null);

    if (failedEmails.length > 0) {
      return NextResponse.json(
        { error: "Failed to send email to some recipients", failedEmails },
        { status: 500 }
      );
    }

    return NextResponse.json({ message: "Email sent successfully to all recipients!" }, { status: 200 });
  } catch (error) {
    console.error("❌ Error in send-email API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
