// app/api/overdueInvoices/route.js

// Firestore
import { db } from "@/lib/firebaseConfig";
import { collection, getDocs, query, where, addDoc } from "firebase/firestore";

// Slack
import { sendSlackMessage } from "@/lib/slackService";

// Next.js
import { NextResponse } from "next/server";

// SendGrid
import sgMail from "@sendgrid/mail";
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// -------------------- Utilities --------------------

function normalizeRecipients(input) {
  if (!input) return undefined;
  return Array.isArray(input) ? input : [input];
}

function toPlainText(htmlOrText) {
  if (typeof htmlOrText !== "string") return "";
  return htmlOrText.replace(/<[^>]+>/g, "").replace(/\s+\n/g, "\n").trim();
}

function formatDateReadable(date) {
  return date.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatCurrencyZAR(value) {
  const n = Number(value || 0);
  return `R${n.toFixed(2)}`;
}

/**
 * daysBetween(a, b) = whole-day difference from 'a' to 'b' (b - a)
 * Normalizes both dates to local midnight to avoid time-of-day drift.
 * Returns negative if b is earlier than a (i.e., overdue), zero if same day.
 */
function daysBetween(a, b) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((end - start) / MS_PER_DAY);
}

function getOverdueBucket(daysOverdue) {
  // expects integer >= 1
  if (daysOverdue <= 7) return "1–7 days";
  if (daysOverdue <= 30) return "8–30 days";
  if (daysOverdue <= 60) return "31–60 days";
  return "60+ days";
}

// ---------- Customer email HTML ----------

function buildInvoiceTable(rows) {
  if (!rows || rows.length === 0) return "";
  const body = rows
    .map(
      (inv) => `
      <tr>
        <td style="padding:6px 8px;border:1px solid #eee;">${inv.orderNumber || "-"}</td>
        <td style="padding:6px 8px;border:1px solid #eee;">${inv.dueDateStr || "-"}</td>
        <td style="padding:6px 8px;border:1px solid #eee;">${inv.itemCount ?? 0}</td>
        <td style="padding:6px 8px;border:1px solid #eee;">${formatCurrencyZAR(inv.total)}</td>
        <td style="padding:6px 8px;border:1px solid #eee;"><a href="${inv.invoicePDFURL ||
        "#"}" target="_blank">PDF</a></td>
      </tr>`
    )
    .join("");

  return `
    <table style="border-collapse: collapse; width: 100%; margin-bottom: 12px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Invoice/Order #</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Due Date</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Items</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Total</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Link</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
}

function buildOverdueBucketsSection(buckets) {
  const sections = [];
  const order = ["1–7 days", "8–30 days", "31–60 days", "60+ days"];
  for (const label of order) {
    const list = buckets[label] || [];
    if (list.length) {
      sections.push(`
        <h4 style="margin:12px 0 6px;">${label}</h4>
        ${buildInvoiceTable(list)}
      `);
    }
  }
  return sections.join("");
}

function buildCustomerHtmlEmail({ subject, companyCode, overdueBuckets, pendingList, unsubscribeUrl }) {
  const hasAnyOverdue =
    Object.values(overdueBuckets).reduce((acc, list) => acc + (list?.length || 0), 0) > 0;
  const hasPending = (pendingList?.length || 0) > 0;

  return `
  <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
    <h2 style="margin: 0 0 12px;">${subject}</h2>
    <p style="margin: 0 0 12px;">Company Code: <strong>${companyCode || "-"}</strong></p>
    <p style="margin: 0 16px 16px 0;">
      Below is a summary of your <strong>overdue</strong> and <strong>pending</strong> EFT invoices.
    </p>

    ${
      hasAnyOverdue
        ? `
      <h3 style="margin:16px 0 8px;">🔴 Overdue (action required)</h3>
      ${buildOverdueBucketsSection(overdueBuckets)}
      `
        : `<p style="margin:12px 0;"><strong>No overdue invoices 🎉</strong></p>`
    }

    ${
      hasPending
        ? `
      <h3 style="margin:16px 0 8px;">🟡 Pending (not yet overdue)</h3>
      ${buildInvoiceTable(
        pendingList.map((p) => ({
          ...p,
          dueDateStr: `${p.dueDateStr} (in ${p.daysUntilDue} day${p.daysUntilDue === 1 ? "" : "s"})`,
        }))
      )}
      `
        : ""
    }

    <p style="font-size:12px;color:#666;margin-top:12px;">
      This is an automated message from Bevgo. Please do not reply to this email.
    </p>
    ${
      unsubscribeUrl
        ? `<p style="font-size:12px;margin-top:8px;">
            <a href="${unsubscribeUrl}" target="_blank">Unsubscribe</a>
           </p>`
        : ""
    }
  </div>`;
}

// ---------- Internal summary HTML ----------

function buildInternalHtmlEmail({ subject, reportDate, perCustomer }) {
  // Grand totals
  let grandOverdueCount = 0;
  let grandOverdueTotal = 0;
  let grandPendingCount = 0;
  let grandPendingTotal = 0;

  const rows = perCustomer
    .map(({ email, companyCode, overdue = [], pending = [] }) => {
      const countOverdue = overdue.length;
      const totalOverdue = overdue.reduce((sum, i) => sum + (Number(i.total) || 0), 0);
      const countPending = pending.length;
      const totalPending = pending.reduce((sum, i) => sum + (Number(i.total) || 0), 0);

      grandOverdueCount += countOverdue;
      grandOverdueTotal += totalOverdue;
      grandPendingCount += countPending;
      grandPendingTotal += totalPending;

      return `
        <tr>
          <td style="padding:6px 8px;border:1px solid #eee;">${email}</td>
          <td style="padding:6px 8px;border:1px solid #eee;">${companyCode || "-"}</td>
          <td style="padding:6px 8px;border:1px solid #eee;">${countOverdue}</td>
          <td style="padding:6px 8px;border:1px solid #eee;">${formatCurrencyZAR(totalOverdue)}</td>
          <td style="padding:6px 8px;border:1px solid #eee;">${countPending}</td>
          <td style="padding:6px 8px;border:1px solid #eee;">${formatCurrencyZAR(totalPending)}</td>
        </tr>`;
    })
    .join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
      <h2 style="margin: 0 0 12px;">${subject}</h2>
      <p style="margin: 0 0 16px;">Report date: <strong>${reportDate}</strong></p>

      <div style="background:#fafafa;border:1px solid #eee;padding:10px 12px;margin-bottom:12px;">
        <strong>Grand totals:</strong><br/>
        Overdue: ${grandOverdueCount} (${formatCurrencyZAR(grandOverdueTotal)})<br/>
        Pending: ${grandPendingCount} (${formatCurrencyZAR(grandPendingTotal)})
      </div>

      <table style="border-collapse: collapse; width: 100%;">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Customer Email</th>
            <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Company Code</th>
            <th style="text-align:left;padding:6px 8px;border:1px solid #eee;"># Overdue</th>
            <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Overdue Total</th>
            <th style="text-align:left;padding:6px 8px;border:1px solid #eee;"># Pending</th>
            <th style="text-align:left;padding:6px 8px;border:1px solid #eee;">Pending Total</th>
          </tr>
        </thead>
        <tbody>${rows || "<tr><td colspan='6' style='padding:8px;border:1px solid #eee;'>No data</td></tr>"}</tbody>
      </table>

      <p style="font-size:12px;color:#666;margin-top:12px;">Automated internal summary.</p>
    </div>
  `;
}

// ---------- CSV (row per invoice) ----------

function buildInternalCSV(perCustomer, runDateISO) {
  const header = [
    "run_date_iso",
    "customer_email",
    "company_code",
    "status",        // Overdue or Pending
    "aging_bucket",  // 1–7, 8–30, 31–60, 60+ or empty for Pending
    "order_number",
    "due_date_iso",
    "due_date_display",
    "days_overdue_or_until_due",
    "item_count",
    "total_amount",
    "pdf_url",
  ].join(",");

  const rows = [];

  perCustomer.forEach(({ email, companyCode, overdue = [], pending = [] }) => {
    overdue.forEach((inv) => {
      rows.push([
        runDateISO,
        email,
        companyCode || "",
        "Overdue",
        inv.agingBucket || "",
        inv.orderNumber || "",
        inv.dueDateISO || "",
        inv.dueDateStr || "",
        inv.daysOverdue ?? "",
        inv.itemCount ?? 0,
        Number(inv.total || 0),
        inv.invoicePDFURL || "",
      ]);
    });
    pending.forEach((inv) => {
      rows.push([
        runDateISO,
        email,
        companyCode || "",
        "Pending",
        "",
        inv.orderNumber || "",
        inv.dueDateISO || "",
        inv.dueDateStr || "",
        inv.daysUntilDue ?? "",
        inv.itemCount ?? 0,
        Number(inv.total || 0),
        inv.invoicePDFURL || "",
      ]);
    });
  });

  const csvBody = rows
    .map((cols) =>
      cols
        .map((c) => {
          const s = String(c ?? "");
          if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        })
        .join(",")
    )
    .join("\n");

  return `${header}\n${csvBody}`;
}

// -------------------- Handler --------------------

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const isTest = url.searchParams.get("test") === "true";
    // testRecipient intentionally ignored for sending
    const unsubscribeUrl = "https://client-portal.bevgo.co.za/unsubscribe";

    const today = new Date();
    const todayReadable = formatDateReadable(today);
    const todayISO = today.toISOString();

    // 1) Pull EFT + Pending invoices
    const invoicesRef = collection(db, "invoices");
    const snapshot = await getDocs(query(invoicesRef, where("payment_status", "==", "Pending")));

    // Build: { [email]: { companyCode, overdueBuckets, pendingList, overdueFlat, pendingFlat } }
    const customerMap = {};

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const customerEmail = data?.customer?.email;
      if (!customerEmail) return;

      const isEFT = data?.paymentMethod === "EFT";
      if (!isEFT) return;

      const dueDateISO = data?.dueDate;
      const dueDate = dueDateISO ? new Date(dueDateISO) : null;
      if (!dueDate || Number.isNaN(dueDate.valueOf())) return;

      // Decide status using day-level diff:
      // diff < 0 => overdue by -diff days; diff = 0 => due today (pending); diff > 0 => pending
      const diffDays = daysBetween(today, dueDate);

      const companyCode = data?.customer?.companyCode || "";
      const total =
        data.finalTotals?.finalTotal ??
        data.finalTotals?.subtotalAfterRebate ??
        data.orderDetails?.total ??
        0;

      const baseInv = {
        orderNumber: data.orderNumber,
        dueDateISO,
        dueDateStr: dueDate.toLocaleDateString("en-ZA"),
        invoicePDFURL: data.invoicePDFURL,
        total: Number(total || 0),
        itemCount: data.orderDetails?.totalItems ?? 0,
      };

      if (!customerMap[customerEmail]) {
        customerMap[customerEmail] = {
          companyCode,
          overdueBuckets: { "1–7 days": [], "8–30 days": [], "31–60 days": [], "60+ days": [] },
          pendingList: [],
          overdueFlat: [],
          pendingFlat: [],
        };
      }

      if (diffDays < 0) {
        const daysOverdue = Math.abs(diffDays); // >= 1
        const bucket = getOverdueBucket(daysOverdue) || "1–7 days";
        const inv = { ...baseInv, daysOverdue, agingBucket: bucket };
        customerMap[customerEmail].overdueBuckets[bucket].push(inv);
        customerMap[customerEmail].overdueFlat.push(inv);
      } else {
        // diffDays >= 0 => pending (0 = due today)
        const inv = { ...baseInv, daysUntilDue: diffDays };
        customerMap[customerEmail].pendingList.push(inv);
        customerMap[customerEmail].pendingFlat.push(inv);
      }
    });

    // Convert to entries
    const entries = Object.entries(customerMap).map(([email, v]) => ({
      email,
      companyCode: v.companyCode,
      overdueBuckets: v.overdueBuckets,
      overdueFlat: v.overdueFlat,
      pendingList: v.pendingList,
      pendingFlat: v.pendingFlat,
    }));

    // If none found at all:
    if (entries.length === 0) {
      await addDoc(collection(db, "emailLogs"), {
        type: "invoice_status_notice",
        timestamp: new Date(),
        testMode: isTest,
        customers: [],
      });
      await sendSlackMessage(
        `📢 *${isTest ? "TEST" : "PRODUCTION"} Invoice Status Report:* 0 customer(s) found.`
      );
      return NextResponse.json({
        message: "No EFT Pending invoices found.",
        customersNotified: 0,
        customers: [],
        testMode: isTest,
      });
    }

    const subject = `Invoice Notice — Overdue & Pending — ${todayReadable}`;
    const internalSubject = `Internal Summary — Overdue & Pending (EFT) — ${todayReadable}`;

    const emailLogs = [];
    const customersEmailed = [];

    // 2) Customer sends (skip in test mode)
    for (const entry of entries) {
      const hasAny =
        (entry.overdueFlat?.length || 0) + (entry.pendingFlat?.length || 0) > 0;
      if (!hasAny) continue;

      const htmlBody = buildCustomerHtmlEmail({
        subject,
        companyCode: entry.companyCode,
        overdueBuckets: entry.overdueBuckets,
        pendingList: entry.pendingList,
        unsubscribeUrl,
      });

      const msg = {
        to: normalizeRecipients(entry.email),
        from: "no-reply@bevgo.co.za",
        subject,
        html: htmlBody,
        text: toPlainText(htmlBody),
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };

      if (!isTest) {
        try {
          await sgMail.send(msg);
          customersEmailed.push(entry.email);
        } catch (err) {
          console.error(`❌ SendGrid failed for ${entry.email}:`, err?.response?.body || err.message);
        }
      } else {
        console.log(`🧪 Test mode — would have sent to ${entry.email}`);
      }

      emailLogs.push({
        email: entry.email,
        companyCode: entry.companyCode,
        overdue: entry.overdueFlat,
        pending: entry.pendingFlat,
        sent: !isTest,
      });
    }

    // 3) Internal summary (PRODUCTION only) + CSV attachment (every invoice row)
    if (!isTest) {
      const internalHtml = buildInternalHtmlEmail({
        subject: internalSubject,
        reportDate: todayReadable,
        perCustomer: emailLogs,
      });

      const csv = buildInternalCSV(emailLogs, todayISO);
      const internalMsg = {
        to: ["info@bevgo.co.za"],
        from: "no-reply@bevgo.co.za",
        subject: internalSubject,
        html: internalHtml,
        text: toPlainText(internalHtml),
        attachments: [
          {
            content: Buffer.from(csv, "utf8").toString("base64"),
            filename: `overdue_pending_${todayISO.substring(0, 10)}.csv`,
            type: "text/csv",
            disposition: "attachment",
          },
        ],
      };

      try {
        await sgMail.send(internalMsg);
      } catch (err) {
        console.error("❌ SendGrid failed for internal summary:", err?.response?.body || err.message);
      }
    } else {
      console.log("🧪 Test mode — would have sent internal summary to info@bevgo.co.za");
    }

    // 4) Firestore log + Slack
    await addDoc(collection(db, "emailLogs"), {
      type: "invoice_status_notice",
      timestamp: new Date(),
      testMode: isTest,
      customers: emailLogs,
    });

    await sendSlackMessage(
      `📢 *${
        isTest ? "TEST" : "PRODUCTION"
      } Invoice Status Report:* ${customersEmailed.length} customer(s) emailed.\n${customersEmailed
        .map((e) => `• ${e}`)
        .join("\n")}`
    );

    return NextResponse.json({
      message: isTest
        ? "🧪 Test mode: scanned invoices and logged results (no emails sent)."
        : "✅ Production: customer notices sent; internal summary delivered.",
      customersNotified: customersEmailed.length,
      customers: customersEmailed,
      testMode: isTest,
    });
  } catch (error) {
    console.error("❌ Cronjob Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
