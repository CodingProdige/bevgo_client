import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where, addDoc } from "firebase/firestore";
import { sendSlackMessage } from "@/lib/slackService";
import { NextResponse } from "next/server";

// Format: "1 July 2025"
function formatDateReadable(date) {
  return date.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const isTest = url.searchParams.get("test") === "true";
    const testRecipient = url.searchParams.get("testRecipient");

    const invoicesRef = collection(db, "invoices");
    const snapshot = await getDocs(query(invoicesRef, where("payment_status", "==", "Pending")));

    const overdueMap = {};
    const today = new Date();

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const dueDate = new Date(data.dueDate);
      const customerEmail = data.customer?.email;

      const isEFT = data.paymentMethod === "EFT";
      const isOverdue = isEFT && dueDate < today;

      if (customerEmail && isOverdue) {
        if (!overdueMap[customerEmail]) {
          overdueMap[customerEmail] = [];
        }

        overdueMap[customerEmail].push({
          orderNumber: data.orderNumber,
          dueDate: dueDate.toLocaleDateString("en-ZA"),
          invoicePDFURL: data.invoicePDFURL,
          total: data.finalTotals?.finalTotal || data.orderDetails?.total || "N/A",
          itemCount: data.orderDetails?.totalItems || 0,
          companyCode: data.customer?.companyCode || "",
        });
      }
    });

    const emailLogs = [];

    let recipientsToProcess = [];

    if (isTest && testRecipient) {
      // Bundle all invoices into one test email
      const allInvoices = Object.values(overdueMap).flat();
      if (allInvoices.length > 0) {
        recipientsToProcess.push({
          email: testRecipient,
          invoices: allInvoices,
        });
      }
    } else {
      // One real email per customer
      recipientsToProcess = Object.entries(overdueMap).map(([email, invoices]) => ({
        email,
        invoices,
      }));
    }

    for (const { email, invoices } of recipientsToProcess) {
      if (invoices.length === 0) continue;

      const payload = {
        to: email,
        subject: `Overdue Invoice Notice — ${formatDateReadable(new Date())}`,
        template: "overdueinvoice",
        data: {
          invoices,
          companyCode: invoices[0].companyCode || "TESTCODE",
        },
        emailOptOut: false,
        unsubscribeUrl: `https://client-portal.bevgo.co.za/unsubscribe`,
      };

      const res = await fetch(`${process.env.BASE_URL}/api/sendEmail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        emailLogs.push({ email, invoices });
      } else {
        const errorBody = await res.json();
        console.error(`❌ Failed to email ${email}:`, errorBody);
      }
    }

    await addDoc(collection(db, "emailLogs"), {
      type: "overdue_invoice_notification",
      timestamp: new Date(),
      testMode: isTest,
      customers: emailLogs.map((entry) => ({
        email: entry.email,
        invoices: entry.invoices,
      })),
    });

    await sendSlackMessage(
      `📢 *${isTest ? "TEST" : "PRODUCTION"} Overdue Invoice Report:* ${emailLogs.length} customer(s) processed.\n${emailLogs.map(e => `• ${e.email}`).join("\n")}`
    );

    return NextResponse.json({
      message: isTest
        ? testRecipient
          ? `✅ Test mode: Email sent to test recipient (${testRecipient}).`
          : "✅ Test mode: No testRecipient specified — no emails sent."
        : "✅ Notifications sent to all customers with overdue invoices.",
      customersNotified: emailLogs.length,
      customers: emailLogs.map((e) => e.email),
    });

  } catch (error) {
    console.error("❌ Cronjob Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
