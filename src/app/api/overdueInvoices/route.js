// app/api/overdueInvoices/route.js

// Firestore
import { db } from "@/lib/firebaseConfig";
import {
  collection,
  getDocs,
  query,
  where,
  addDoc,
  limit,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";

// Slack
import { sendSlackMessage } from "@/lib/slackService";

// Next.js
import { NextResponse } from "next/server";

// SendGrid
import sgMail from "@sendgrid/mail";
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/* -------------------- Constants -------------------- */

const EMAIL_FIELDS = [
  "email",
  "accountingEmail",
  "billingEmail",
  "accountsEmail",
  "primaryEmail",
  "contactEmail",
];

/* -------------------- Utilities -------------------- */

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

/** Robust date parser for ISO and ZA-style D/M/Y or M/D/Y */
function parseDueDateFlexible(input) {
  if (!input) return null;

  // ISO fast path
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(input)) {
    const d = new Date(input);
    return Number.isNaN(d.valueOf()) ? null : d;
  }

  // D/M/Y or M/D/Y (1–2 digit day/month)
  const m = String(input).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    let day, month;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      day = b;
      month = a;
    } else {
      // Default to ZA-style D/M/Y
      day = a;
      month = b;
    }
    const d = new Date(y, month - 1, day);
    return Number.isNaN(d.valueOf()) ? null : d;
  }

  // Fallback
  const d = new Date(input);
  return Number.isNaN(d.valueOf()) ? null : d;
}

// Only render valid absolute http(s) URLs
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

/* ---------- Customer email HTML (no emojis) ---------- */

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
          dueDateStr: `${p.dueDateStr} (in ${p.dueDateStrNote ?? p.daysUntilDue} day${p.daysUntilDue === 1 ? "" : "s"})`,
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

/* ---------- Internal summary HTML (no emojis) ---------- */

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

/* ---------- CSV (row per invoice) ---------- */

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

/* -------------------- Email lookups (STRICT casing; no lowercasing) -------------------- */

const companyPrimaryEmailCache = new Map(); // first valid email we find
const companyAllEmailsCache = new Map();     // set of all possible emails
const emailToCompanyCodesCache = new Map();  // email -> Set(companyCode)

/** Return FIRST valid email for a companyCode (used for backfill). */
async function lookupEmailByCompanyCode(companyCode) {
  if (!companyCode) return null;
  const key = String(companyCode).trim();
  if (!key) return null;

  if (companyPrimaryEmailCache.has(key)) {
    return companyPrimaryEmailCache.get(key);
  }

  const collectionsToCheck = ["users", "customers"];

  for (const colName of collectionsToCheck) {
    try {
      const ref = collection(db, colName);
      const snap = await getDocs(query(ref, where("companyCode", "==", key), limit(5)));
      if (!snap.empty) {
        for (const d of snap.docs) {
          const data = d.data() || {};
          for (const f of EMAIL_FIELDS) {
            const v = (data?.[f] || "").trim();
            if (v && v.includes("@")) {
              companyPrimaryEmailCache.set(key, v);
              return v;
            }
          }
        }
      }
    } catch (e) {
      console.error(`lookupEmailByCompanyCode(${key}) ${colName} error:`, e?.message || e);
    }
  }

  companyPrimaryEmailCache.set(key, null);
  return null;
}

/** Return ALL candidate emails for a companyCode (used for recipient scoping). */
async function lookupAllEmailsByCompanyCode(companyCode) {
  if (!companyCode) return [];
  const key = String(companyCode).trim();
  if (!key) return [];

  if (companyAllEmailsCache.has(key)) {
    return companyAllEmailsCache.get(key);
  }

  const collectionsToCheck = ["users", "customers"];
  const out = new Set();

  for (const colName of collectionsToCheck) {
    try {
      const ref = collection(db, colName);
      const snap = await getDocs(query(ref, where("companyCode", "==", key), limit(10)));
      if (!snap.empty) {
        for (const d of snap.docs) {
          const data = d.data() || {};
          for (const f of EMAIL_FIELDS) {
            const v = (data?.[f] || "").trim();
            if (v && v.includes("@")) out.add(v);
          }
        }
      }
    } catch (e) {
      console.error(`lookupAllEmailsByCompanyCode(${key}) ${colName} error:`, e?.message || e);
    }
  }

  const arr = Array.from(out);
  companyAllEmailsCache.set(key, arr);
  return arr;
}

/** Given an exact email, find ALL companyCodes that have that email in any known field. */
async function lookupCompanyCodesByEmail(email) {
  if (!email) return [];
  const key = String(email).trim();
  if (!key) return [];

  if (emailToCompanyCodesCache.has(key)) {
    return Array.from(emailToCompanyCodesCache.get(key));
  }

  const collectionsToCheck = ["users", "customers"];
  const codes = new Set();

  for (const colName of collectionsToCheck) {
    for (const field of EMAIL_FIELDS) {
      try {
        const ref = collection(db, colName);
        const snap = await getDocs(query(ref, where(field, "==", key), limit(10)));
        snap.forEach((doc) => {
          const data = doc.data() || {};
          const cc = (data?.companyCode || "").trim();
          if (cc) codes.add(cc);
        });
      } catch (e) {
        // If a field doesn't exist or no index, just skip
        // (consider creating necessary composite indexes in production)
      }
    }
  }

  emailToCompanyCodesCache.set(key, codes);
  return Array.from(codes);
}

/* -------------------- Handler -------------------- */

export async function GET(req) {
  try {
    const url = new URL(req.url);

    const isTest = url.searchParams.get("test") === "true";

    // Recipient override (selector). Legacy 'testRecipient' supported.
    const recipientRaw = (url.searchParams.get("recipient") || url.searchParams.get("testRecipient") || "").trim();

    // Internal-only switch (production): send only internal summary, no customer emails.
    const internalOnly = url.searchParams.get("internal") === "true";

    const unsubscribeUrl = "https://client-portal.bevgo.co.za/unsubscribe";

    const today = new Date();
    const todayReadable = formatDateReadable(today);
    const todayISO = today.toISOString();

    // 1) Pull EFT + Pending invoices
    const invoicesRef = collection(db, "invoices");
    const snapshot = await getDocs(query(invoicesRef, where("payment_status", "==", "Pending")));

    const customerMap = {}; // key by EXACT email (no lowercasing)

    // Use for..of to allow await for backfill/lookup
    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();

      const companyCode = data?.customer?.companyCode || data?.companyCode || "";

      // Resolve recipient email: invoice customer.email OR lookup by companyCode
      let emailRaw = (data?.customer?.email || "").trim();
      const hadBlankEmail = !emailRaw;

      if (!emailRaw && companyCode) {
        emailRaw = (await lookupEmailByCompanyCode(companyCode)) || "";
      }
      if (!emailRaw) {
        // still no email anywhere → skip emailing this invoice
        continue;
      }

      // Always backfill when original invoice was missing an email (STRICT: keep casing as-is)
      if (hadBlankEmail) {
        try {
          await updateDoc(docSnap.ref, {
            "customer.email": emailRaw,
            "meta.emailBackfill": {
              at: serverTimestamp(),
              source: "overdueInvoices:companyCodeLookup",
              companyCode: companyCode || null,
            },
          });
        } catch (e) {
          console.error(
            `Backfill failed for invoice ${data?.orderNumber || docSnap.id}:`,
            e?.message || e
          );
          // non-fatal; continue processing
        }
      }

      const isEFT = data?.paymentMethod === "EFT";
      if (!isEFT) continue;

      const dueDateRaw = data?.dueDate;
      const dueDate = parseDueDateFlexible(dueDateRaw);
      if (!dueDate) continue;

      const diffDays = daysBetween(today, dueDate); // <0 overdue; 0 today; >0 pending

      const total =
        data?.finalTotals?.finalTotal ??
        data?.finalTotals?.subtotalAfterRebate ??
        data?.orderDetails?.total ??
        data?.total ??
        0;

      const baseInv = {
        orderNumber: data?.orderNumber,
        dueDateISO: dueDateRaw,
        dueDateStr: dueDate.toLocaleDateString("en-ZA"),
        invoicePDFURL: data?.invoicePDFURL,
        total: Number(total || 0),
        itemCount: data?.orderDetails?.totalItems ?? data?.totalItems ?? 0,
      };

      if (!customerMap[emailRaw]) {
        customerMap[emailRaw] = {
          email: emailRaw, // exact casing
          companyCode,
          overdueBuckets: { "1–7 days": [], "8–30 days": [], "31–60 days": [], "60+ days": [] },
          pendingList: [],
          overdueFlat: [],
          pendingFlat: [],
        };
      }

      if (diffDays < 0) {
        const daysOverdue = Math.abs(diffDays);
        const bucket =
          daysOverdue <= 7 ? "1–7 days" : daysOverdue <= 30 ? "8–30 days" : daysOverdue <= 60 ? "31–60 days" : "60+ days";
        const inv = { ...baseInv, daysOverdue, agingBucket: bucket };
        customerMap[emailRaw].overdueBuckets[bucket].push(inv);
        customerMap[emailRaw].overdueFlat.push(inv);
      } else {
        const inv = { ...baseInv, daysUntilDue: diffDays };
        customerMap[emailRaw].pendingList.push(inv);
        customerMap[emailRaw].pendingFlat.push(inv);
      }
    }

    // 2) Build entries (no case normalization)
    let entries = Object.values(customerMap);

    /* 2b) Build symmetric recipient scope: whether you pass EMAIL or COMPANYCODE, we check BOTH. */
    if (recipientRaw) {
      const allowedEmails = new Set();
      const allowedCodes = new Set();

      const looksLikeEmail = recipientRaw.includes("@");

      if (looksLikeEmail) {
        // Given an email → allow that email…
        allowedEmails.add(recipientRaw);

        // …and ALSO all companyCodes that have that exact email, then all emails for those codes.
        const codesForEmail = await lookupCompanyCodesByEmail(recipientRaw);
        codesForEmail.forEach((cc) => allowedCodes.add(cc));
        for (const cc of codesForEmail) {
          const emailsForCode = await lookupAllEmailsByCompanyCode(cc);
          emailsForCode.forEach((e) => allowedEmails.add(e));
        }
      } else {
        // Given a companyCode → allow that code…
        allowedCodes.add(recipientRaw);

        // …and ALSO all emails tied to that code, and then for each of those emails, any other codes that reference them.
        const emailsForCode = await lookupAllEmailsByCompanyCode(recipientRaw);
        emailsForCode.forEach((e) => allowedEmails.add(e));
        for (const em of emailsForCode) {
          const codesForEmail = await lookupCompanyCodesByEmail(em);
          codesForEmail.forEach((cc) => allowedCodes.add(cc));
        }
      }

      // Final symmetric filter: keep if (companyCode in allowedCodes) OR (email in allowedEmails)
      entries = entries.filter(
        (e) => allowedCodes.has((e.companyCode || "").trim()) || allowedEmails.has((e.email || "").trim())
      );
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
    }

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

    /* 4) Internal summary — ALWAYS in production (even if no entries) */
    if (!isTest) {
      const noMatches = entries.length === 0;
      const internalHtml = buildInternalHtmlEmail({
        subject:
          internalSubject +
          (recipientRaw ? ` (scope: ${recipientRaw})` : "") +
          (internalOnly ? " [INTERNAL-ONLY]" : "") +
          (noMatches ? " [NO MATCHES]" : ""),
        reportDate: todayReadable,
        perCustomer: emailLogs, // may be empty
      });

      const csv = buildInternalCSV(emailLogs, todayISO); // header-only when empty
      const internalMsg = {
        to: ["info@bevgo.co.za"],
        from: "no-reply@bevgo.co.za",
        subject:
          internalSubject +
          (recipientRaw ? ` (scope: ${recipientRaw})` : "") +
          (internalOnly ? " [INTERNAL-ONLY]" : "") +
          (noMatches ? " [NO MATCHES]" : ""),
        html: internalHtml,
        text: toPlainText(internalHtml),
        attachments: [
          {
            content: Buffer.from(csv, "utf8").toString("base64"),
            filename: `overdue_pending_${todayISO.substring(0, 10)}${
              recipientRaw ? `_${recipientRaw.replace(/[^a-zA-Z0-9@.\-]/g, "_")}` : ""
            }${noMatches ? "__no_matches" : ""}.csv`,
            type: "text/csv",
            disposition: "attachment",
          },
        ],
        headers: { "X-Overdue-Run": todayISO },
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
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
      recipientOverride: recipientRaw || null,
      customers: emailLogs,
    });

    await sendSlackMessage(
      `📢 *${isTest ? "TEST" : "PRODUCTION"} Invoice Status Report:* ${
        customersEmailed.length
      } customer(s) emailed${
        recipientRaw ? ` (scope: ${recipientRaw})` : ""
      }${internalOnly ? " (internal-only)" : ""}${
        entries.length === 0 ? " [NO MATCHES]" : ""
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
      recipient: recipientRaw || null,
      internalOnly,
    });
  } catch (error) {
    console.error("Cronjob Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
