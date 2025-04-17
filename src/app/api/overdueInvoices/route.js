import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where, addDoc } from "firebase/firestore";
import { sendEmail } from "@/lib/emailService";
import { sendSlackMessage } from "@/lib/slackService";
import { format } from "date-fns";
import { NextResponse } from "next/server";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const isTest = url.searchParams.get("test") === "true";

    const invoicesRef = collection(db, "invoices");
    const snapshot = await getDocs(
      query(invoicesRef, where("payment_status", "==", "Pending"))
    );

    const overdueMap = {};
    const today = new Date();

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const dueDate = new Date(data.dueDate);
      const customerEmail = data.customer?.email;

      if (customerEmail && dueDate < today) {
        if (!overdueMap[customerEmail]) {
          overdueMap[customerEmail] = [];
        }

        overdueMap[customerEmail].push({
          orderNumber: data.orderNumber,
          dueDate: format(dueDate, "yyyy-MM-dd"),
          invoicePDFURL: data.invoicePDFURL,
          total: data.finalTotals?.finalTotal || data.orderDetails?.total || "N/A",
          itemCount: data.orderDetails?.totalItems || 0,
          companyCode: data.customer?.companyCode || "",
        });
      }
    });

    const emailedCustomers = [];
    const emailLogs = [];

    for (const email in overdueMap) {
      const invoices = overdueMap[email];

      const htmlBody = `
        <h2>Overdue Invoice Reminder</h2>
        <p>The following invoices on your account are now overdue:</p>
        <ul>
          ${invoices.map(
            (inv) => `
              <li>
                <strong>Order #${inv.orderNumber}</strong> - Due: ${inv.dueDate} <br/>
                Total: R${inv.total} | Items: ${inv.itemCount} <br/>
                <a href="${inv.invoicePDFURL}">📄 View Invoice PDF</a>
              </li>`
          ).join("")}
        </ul>
        <p><strong>Note:</strong> If you're making a bulk payment, please use your customer number <strong>${invoices[0].companyCode}</strong> as your payment reference.</p>
        <p>Please arrange payment at your earliest convenience. If you've already settled, kindly disregard this email.</p>
        <p>Thank you, <br />Bevgo Finance Team</p>
      `;

      if (!isTest) {
        const result = await sendEmail(email, "Overdue Invoice Notice", htmlBody);
        if (result.success) {
          emailedCustomers.push(email);
          emailLogs.push({ email, invoices });
        }
      } else {
        // In test mode, just simulate
        emailLogs.push({ email, invoices });
      }
    }

    // Internal log summary
    const internalLogHtml = `
      <h2>🧾 Overdue Invoice Notification Summary - ${format(new Date(), "yyyy-MM-dd HH:mm")}</h2>
      <p>Mode: ${isTest ? "🧪 TEST" : "🚀 PRODUCTION"}</p>
      <p>Customers processed:</p>
      ${emailLogs.map(
        (entry) => `
          <h4>${entry.email}</h4>
          <ul>
            ${entry.invoices.map((inv) => `<li>#${inv.orderNumber} - Due: ${inv.dueDate} - R${inv.total}</li>`).join("")}
          </ul>
        `
      ).join("")}
    `;

    const internalRecipient = isTest ? "dillonjurgens@gmail.com" : "info@bevgo.co.za";
    await sendEmail(internalRecipient, "Overdue Invoice Log", internalLogHtml);

    // Slack summary
    const slackMsg = `📢 *${isTest ? "TEST" : "PRODUCTION"} Overdue Invoice Report:* ${emailLogs.length} customer(s) processed.\nEmails: ${emailLogs.map(e => e.email).join(", ")}`;
    await sendSlackMessage(slackMsg);

    // Firestore audit log
    await addDoc(collection(db, "emailLogs"), {
      type: "overdue_invoice_notification",
      timestamp: new Date(),
      testMode: isTest,
      customers: emailLogs.map((entry) => ({
        email: entry.email,
        invoices: entry.invoices,
      })),
    });

    return NextResponse.json({
      message: isTest ? "✅ Test mode: No client emails sent." : "✅ Notifications sent to customers.",
      customersNotified: emailedCustomers.length,
      customers: emailLogs.map((e) => e.email),
    });

  } catch (error) {
    console.error("❌ Cronjob Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
