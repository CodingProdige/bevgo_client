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
 * Whole-day difference from 'a' to 'b' (b - a), normalized to local midnight.
 * Negative => overdue (by |diff| days). 0 => due today. Positive => days until due.
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

// Guard: only render valid absolute http(s) URLs
function isSafeHttpUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:";
  } catch {
    return false;
  }
}

function linkCell(u) {
  return isSafeHttpUrl(u)
    ? `<a href="${u}" target="_blank" rel="noopener noreferrer">PDF</a>`
    : "—";
}

// ---------- Customer email HTML (no emojis) ----------

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
        <td style="padding:6px 8px;border:1px solid #eee;">${linkCell(inv.invoicePDFURL)}</td>
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
      <h3 style="margin:16px 0 8px;">Overdue (action required)</h3>
      ${buildOverdueBucketsSection(overdueBuckets)}
      `
        : `<p style="margin:12px 0;"><strong>No overdue invoices.</strong></p>`
    }

    ${
      hasPending
        ? `
      <h3 style="margin:16px 0 8px;">Pending (not yet overdue)</h3>
      ${buildInvoiceTable(
        pendingList.map((p) => ({
          ...p,
          // Append "due in X days" hint
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
            <a href="${unsubscribeUrl}" target="_blank" rel="noopener noreferrer">Unsubscribe</a>
           </p>`
        : ""
    }
  </div>`;
}

// ---------- Internal summary HTML (no emojis) ----------

function buildInternalHtmlEmail({ subject, reportDate, perCustomer }) {
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
    "status",
    "aging_bucket",
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

    // Recipient override (selector). Legacy 'testRecipient' supported.
    const recipient = (url.searchParams.get("recipient") || url.searchParams.get("testRecipient") || "")
      .trim()
      .toLowerCase();

    // Internal-only switch (production): send only internal summary, no customer emails.
    const internalOnly = url.searchParams.get("internal") === "true";

    const unsubscribeUrl = "https://client-portal.bevgo.co.za/unsubscribe";

    const today = new Date();
    const todayReadable = formatDateReadable(today);
    const todayISO = today.toISOString();

    // 1) Pull EFT + Pending invoices
    const invoicesRef = collection(db, "invoices");
    const snapshot = await getDocs(query(invoicesRef, where("payment_status", "==", "Pending")));

    const customerMap = {};
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const email = (data?.customer?.email || "").trim();
      if (!email) return;

      const isEFT = data?.paymentMethod === "EFT";
      if (!isEFT) return;

      const dueDateISO = data?.dueDate;
      const dueDate = dueDateISO ? new Date(dueDateISO) : null;
      if (!dueDate || Number.isNaN(dueDate.valueOf())) return;

      const diffDays = daysBetween(today, dueDate); // <0 overdue; 0 today; >0 pending

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

      if (!customerMap[email]) {
        customerMap[email] = {
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
        customerMap[email].overdueBuckets[bucket].push(inv);
        customerMap[email].overdueFlat.push(inv);
      } else {
        // diffDays >= 0 => pending (0 = due today)
        const inv = { ...baseInv, daysUntilDue: diffDays };
        customerMap[email].pendingList.push(inv);
        customerMap[email].pendingFlat.push(inv);
      }
    });

    // 2) Build entries and apply recipient filter if provided
    let entries = Object.entries(customerMap).map(([email, v]) => ({
      email,
      emailKey: email.trim().toLowerCase(),
      companyCode: v.companyCode,
      overdueBuckets: v.overdueBuckets,
      overdueFlat: v.overdueFlat,
      pendingList: v.pendingList,
      pendingFlat: v.pendingFlat,
    }));

    if (recipient) {
      entries = entries.filter((e) => e.emailKey === recipient);
    }

    // None found?
    if (entries.length === 0) {
      await addDoc(collection(db, "emailLogs"), {
        type: "invoice_status_notice",
        timestamp: new Date(),
        testMode: isTest,
        internalOnly,
        recipientOverride: recipient || null,
        customers: [],
      });
      const scope = recipient ? `for ${recipient}` : "found";
      await sendSlackMessage(
        `📢 *${isTest ? "TEST" : "PRODUCTION"} Invoice Status Report:* 0 customer(s) ${scope}${
          internalOnly ? " (internal-only)" : ""
        }.`
      );
      return NextResponse.json({
        message: recipient
          ? `No matching customer with EFT Pending invoices for recipient: ${recipient}`
          : "No EFT Pending invoices found.",
        customersNotified: 0,
        customers: [],
        testMode: isTest,
        recipient: recipient || null,
        internalOnly,
      });
    }

    const subject = `Invoice Notice — Overdue & Pending — ${todayReadable}`;
    const internalSubject = `Internal Summary — Overdue & Pending (EFT) — ${todayReadable}`;

    const emailLogs = [];
    const customersEmailed = [];

    // 3) Customer sends
    // - Never in test mode
    // - Skip entirely if internalOnly=true
    if (!isTest && !internalOnly) {
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
          trackingSettings: {
            clickTracking: { enable: false, enableText: false }, // disable link wrapping
            openTracking: { enable: true },
          },
        };

        try {
          await sgMail.send(msg);
          customersEmailed.push(entry.email);
        } catch (err) {
          console.error(`SendGrid failed for ${entry.email}:`, err?.response?.body || err.message);
        }
      }
    } else if (isTest) {
      entries.forEach((e) => console.log(`Test mode — would have sent to ${e.email}`));
    } // else internalOnly=true → intentionally skip customer sends

    // Regardless of send mode, prepare logs for internal use
    entries.forEach((entry) => {
      emailLogs.push({
        email: entry.email,
        companyCode: entry.companyCode,
        overdue: entry.overdueFlat,
        pending: entry.pendingFlat,
        sent: !isTest && !internalOnly && customersEmailed.includes(entry.email),
      });
    });

    // 4) Internal summary
    // - In production: always send internal summary (including when internalOnly=true)
    // - In test: never send
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
        subject:
          internalSubject +
          (recipient ? ` (scope: ${recipient})` : "") +
          (internalOnly ? " [INTERNAL-ONLY]" : ""),
        html: internalHtml,
        text: toPlainText(internalHtml),
        attachments: [
          {
            content: Buffer.from(csv, "utf8").toString("base64"),
            filename: `overdue_pending_${todayISO.substring(0, 10)}${
              recipient ? `_${recipient.replace(/[^a-z0-9@.-]/gi, "_")}` : ""
            }.csv`,
            type: "text/csv",
            disposition: "attachment",
          },
        ],
        trackingSettings: {
          clickTracking: { enable: false, enableText: false }, // disable link wrapping
          openTracking: { enable: true },
        },
      };
      try {
        await sgMail.send(internalMsg);
      } catch (err) {
        console.error("SendGrid failed for internal summary:", err?.response?.body || err.message);
      }
    } else {
      console.log("Test mode — would have sent internal summary to info@bevgo.co.za");
    }

    // 5) Firestore log + Slack
    await addDoc(collection(db, "emailLogs"), {
      type: "invoice_status_notice",
      timestamp: new Date(),
      testMode: isTest,
      internalOnly,
      recipientOverride: recipient || null,
      customers: emailLogs,
    });

    await sendSlackMessage(
      `📢 *${isTest ? "TEST" : "PRODUCTION"} Invoice Status Report:* ${
        customersEmailed.length
      } customer(s) emailed${recipient ? ` (scope: ${recipient})` : ""}${
        internalOnly ? " (internal-only)" : ""
      }.\n${customersEmailed.map((e) => `• ${e}`).join("\n")}`
    );

    return NextResponse.json({
      message: isTest
        ? "Test mode: scanned invoices and logged results (no emails sent)."
        : internalOnly
        ? "Production: internal summary only (no customer emails)."
        : "Production: customer notices sent; internal summary delivered.",
      customersNotified: customersEmailed.length,
      customers: customersEmailed,
      testMode: isTest,
      recipient: recipient || null,
      internalOnly,
    });
  } catch (error) {
    console.error("Cronjob Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
