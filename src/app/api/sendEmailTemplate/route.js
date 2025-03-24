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

    // ✅ Send the email
    const result = await sendEmail(to, subject, emailContent);

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
