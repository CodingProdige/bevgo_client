export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
  addDoc,
  writeBatch,
  getDoc,
} from "firebase/firestore";
import { NextResponse } from "next/server";
import axios from "axios";

/* ----------------------------- money helpers ----------------------------- */
// 🔧 cents-safe
const toCents = (n) => Math.round(Number(n || 0) * 100);
const fromCents = (c) => Number((c / 100).toFixed(2));

/* ------------------------------ credit utils ----------------------------- */

// 🔹 Utility: calculate available credit (ignores deleted) — now cents-safe
async function getAvailableCredit(companyCode) {
  const paymentsRef = collection(db, "payments");
  const qy = query(paymentsRef, where("companyCode", "==", companyCode));
  const snap = await getDocs(qy);

  // 🔧 cents-safe
  let totalCreditC = 0;
  let totalAllocatedC = 0;

  snap.forEach((d) => {
    const p = d.data();
    if (p.deleted) return; // 🚫 skip deleted
    totalCreditC += toCents(p.amount);
    totalAllocatedC += toCents(p.allocated);
  });

  return {
    totalCredit: fromCents(totalCreditC),
    totalAllocated: fromCents(totalAllocatedC),
    availableCredit: fromCents(totalCreditC - totalAllocatedC),
  };
}

// 🔹 Utility: log accounting actions
async function logAccountingAction(action) {
  try {
    await addDoc(collection(db, "accountingLogs"), {
      ...action,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Failed to log accounting action:", err.message);
  }
}

/* ----------------------------- Email helpers ----------------------------- */

const INTERNAL_TO = ["info@bevgo.co.za"]; // always notify this address

const fmtR = (n) =>
  `R${(Number(n || 0)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

async function sendEmail({ to, subject, html }) {
  try {
    await axios.post(`${process.env.BASE_URL}/api/sendEmail`, {
      to,
      subject,
      data: { message: html }, // /api/sendEmail expects { data: { message } }
    });
    return { ok: true };
  } catch (err) {
    console.error("❌ sendEmail error:", err?.response?.status, err?.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

// Resolve customer name/email from invoice, falling back to your client API
async function resolveCustomerContact(inv, companyCode) {
  let name =
    inv?.customer?.companyName ||
    inv?.customer?.name ||
    null;
  let email =
    inv?.customer?.email ||
    null;

  if (!name || !email) {
    try {
      const res = await axios.post(
        `https://bevgo-client.vercel.app/api/getUser`,
        { companyCode },
        { timeout: 10000 }
      );
      if (res.status === 200 && res.data?.data) {
        name = name || res.data.data.companyName || null;
        email = email || res.data.data.email || null;
      }
    } catch (e) {
      console.warn("⚠️ getUser fallback failed:", e.message);
    }
  }
  return { companyName: name || "Customer", email: email || null };
}

// Local time for SA so humans reading it are happy
const tz = "Africa/Johannesburg";
function tsStamp() {
  const parts = new Intl.DateTimeFormat("en-ZA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value || "";
  // yyyy-mm-dd HH:MM:SS SAST
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} SAST`;
}

/* --------------------------------- POST --------------------------------- */
/**
 * POST - Settle Invoice(s)
 *
 * Modes:
 * 1. Direct Invoice Settlement
 *    → Pass { orderNumber: "123" } OR { orderNumbers: ["123", "456"] }
 *
 * 2. Auto Settle Specific Customer
 *    → Pass { companyCode: "DC2070", autoSettle: true }
 *
 * 3. Admin Multi-Customer Auto Settle
 *    → Pass { autoSettle: true, isAdmin: true }
 *
 * Emails:
 * - Always emails the customer for any invoices settled in this request
 * - Always emails an internal digest to info@bevgo.co.za
 */
export async function POST(req) {
  try {
    const body = await req.json();

    // ✅ Normalizer so "null"/"undefined"/""/whitespace become null
    const clean = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s) return null;
      const lower = s.toLowerCase();
      if (lower === "null" || lower === "undefined") return null;
      return s;
    };

    const orderNumberRaw   = body.orderNumber;
    const orderNumbersRaw  = body.orderNumbers;
    const companyCodeRaw   = body.companyCode;

    const orderNumber  = clean(orderNumberRaw);
    const orderNumbers = Array.isArray(orderNumbersRaw)
      ? orderNumbersRaw.map(clean).filter(Boolean)
      : [];
    const companyCode  = clean(companyCodeRaw);
    const autoSettle   = !!body.autoSettle;
    const isAdmin      = !!body.isAdmin;

    const results = [];

    // For email batching per company: companyCode -> { companyName, customerEmail, entries: [] }
    const settledByCompany = new Map();

    // 🧮 Helper: process a single invoice (keeps your original logic)
    const processInvoice = async (invoiceDoc) => {
      const invoice = invoiceDoc.data();
      const cc = invoice?.customer?.companyCode;
      if (!cc) return { error: "Invoice missing companyCode" };

      // 🔧 cents-safe
      const invoiceTotalC = toCents(invoice?.finalTotals?.finalTotal || 0);
      const invoiceTotal = fromCents(invoiceTotalC);
      const isRental = invoice?.type === "Rental";

      // 🔎 Check linked order (if it exists)
      const orderRef = doc(db, "orders", invoice.orderNumber);
      const orderSnap = await getDoc(orderRef);
      const orderExists = orderSnap.exists();

      let orderTotal = 0;
      let isPrePaidOrder = false;

      if (orderExists) {
        const order = orderSnap.data();
        orderTotal = Number(order?.order_details?.total || 0);
        isPrePaidOrder = order.prePaid === true || orderTotal === 0;
      }

      // ✅ If prepaid OR total = 0 → settle directly, no allocation
      if (isPrePaidOrder || invoiceTotalC === 0) {
        const now = new Date().toISOString();

        await updateDoc(doc(db, "invoices", invoice.orderNumber), {
          payment_status: "Paid",
          date_settled: now,
          allocationId: null,
        });

        if (orderExists) {
          await updateDoc(orderRef, {
            payment_status: "Paid",
            date_settled: now,
            allocationId: null,
          });
        } else {
          console.log(
            `⚠️ No order doc found for invoice ${invoice.orderNumber} (type: ${
              isRental ? "Rental" : "Standard"
            }). Skipping order update.`
          );
        }

        await logAccountingAction({
          action: "SETTLE_INVOICE",
          companyCode: cc,
          orderNumber: invoice.orderNumber,
          type: isRental ? "Rental" : "Standard",
          amount: invoiceTotal, // 🔧 use 2dp number
          performedBy: "system",
          details: {
            skippedAllocation: true,
            orderExists,
            prePaid: isPrePaidOrder,
          },
        });

        // collect for email
        const { companyName, email } = await resolveCustomerContact(invoice, cc);
        if (!settledByCompany.has(cc)) {
          settledByCompany.set(cc, {
            companyName,
            customerEmail: email,
            entries: [],
          });
        }
        settledByCompany.get(cc).entries.push({
          orderNumber: invoice.orderNumber,
          amount: invoiceTotal, // 🔧 2dp
          type: isRental ? "Rental" : "Standard",
          skippedAllocation: true,
          allocationId: null,
        });

        return {
          orderNumber: invoice.orderNumber,
          type: isRental ? "Rental" : "Standard",
          message: orderExists
            ? "Invoice settled (prepaid/credit)."
            : "Invoice settled (auto-generated, no order doc).",
          skippedAllocation: true,
        };
      }

      // 🔹 Continue with normal allocation flow
      const creditSummary = await getAvailableCredit(cc);
      // 🔧 compare in cents
      if (toCents(creditSummary.availableCredit) < invoiceTotalC) {
        return {
          orderNumber: invoice.orderNumber,
          error: "Insufficient credit",
          creditSummary,
        };
      }

      // Fetch unallocated payments (FIFO)
      const paymentsRef = collection(db, "payments");
      const paymentsSnap = await getDocs(
        query(paymentsRef, where("companyCode", "==", cc))
      );

      // 🔧 cents-safe running remainder
      let remainingC = invoiceTotalC;
      const batch = writeBatch(db);
      const fromPayments = [];

      paymentsSnap.forEach((pDoc) => {
        if (remainingC <= 0) return;
        const p = pDoc.data();
        if (p.deleted) return;

        // Prefer explicit unallocated; fall back to amount - allocated (both to cents)
        const unallocatedC = toCents(
          p.unallocated != null ? p.unallocated : (Number(p.amount || 0) - Number(p.allocated || 0))
        );
        if (unallocatedC > 0) {
          const allocateAmtC = Math.min(remainingC, unallocatedC);

          // Keep allocation doc amounts as 2dp numbers (unchanged schema)
          fromPayments.push({
            paymentId: pDoc.id,
            amount: fromCents(allocateAmtC), // 🔧 2dp number
          });

          // 🔧 write back allocated/unallocated as 2dp numbers
          const newAllocated = fromCents(toCents(p.allocated) + allocateAmtC);
          const newUnallocated = fromCents(unallocatedC - allocateAmtC);

          batch.update(pDoc.ref, {
            allocated: newAllocated,
            unallocated: newUnallocated,
          });

          remainingC -= allocateAmtC;
        }
      });

      if (remainingC > 0) {
        return {
          orderNumber: invoice.orderNumber,
          error: "Allocation failed — not enough unallocated payments",
          fromPayments,
        };
      }

      // 🧩 Prevent duplicate payment–invoice pairs
      const existingAllocSnap = await getDocs(
        query(collection(db, "allocations"), where("invoiceId", "==", invoice.orderNumber))
      );

      let usedPaymentIds = [];
      existingAllocSnap.forEach((aDoc) => {
        const alloc = aDoc.data();
        const ids = (alloc.fromPayments || []).map((p) => p.paymentId);
        usedPaymentIds.push(...ids);
      });

      const filteredFromPayments = fromPayments.filter(
        (fp) => !usedPaymentIds.includes(fp.paymentId)
      );

      if (filteredFromPayments.length === 0) {
        console.log(
          `⚠️ All payments already linked to invoice ${invoice.orderNumber}. Skipping allocation creation.`
        );

        await logAccountingAction({
          action: "SETTLE_INVOICE_SKIPPED_DUPLICATE_LINKS",
          companyCode: cc,
          orderNumber: invoice.orderNumber,
          performedBy: "system",
          details: { existingAllocations: existingAllocSnap.size },
        });

        return {
          orderNumber: invoice.orderNumber,
          message: "Skipped — all payment links already exist.",
          skipped: true,
        };
      }

      // Sum using regular numbers (already 2dp)
      const totalNewAmount = filteredFromPayments.reduce(
        (sum, fp) => sum + Number(fp.amount || 0),
        0
      );

      // Create allocation doc (unchanged schema)
      const allocationRef = await addDoc(collection(db, "allocations"), {
        companyCode: cc,
        invoiceId: invoice.orderNumber,
        amount: Number(totalNewAmount.toFixed(2)),
        fromPayments: filteredFromPayments,
        date: new Date().toISOString(),
        createdBy: "system",
      });

      const now = new Date().toISOString();
      const invoiceRef = doc(db, "invoices", invoice.orderNumber);

      batch.update(invoiceRef, {
        payment_status: "Paid",
        date_settled: now,
        allocationId: allocationRef.id,
      });

      // 🧾 Update order only if it exists
      if (orderExists) {
        batch.update(orderRef, {
          payment_status: "Paid",
          date_settled: now,
          allocationId: allocationRef.id,
        });
      } else {
        console.log(
          `⚠️ No order doc found for invoice ${invoice.orderNumber} (type: ${
            isRental ? "Rental" : "Standard"
          }). Skipping order update.`
        );
      }

      await batch.commit();

      await logAccountingAction({
        action: "SETTLE_INVOICE",
        companyCode: cc,
        orderNumber: invoice.orderNumber,
        type: isRental ? "Rental" : "Standard",
        amount: Number(totalNewAmount.toFixed(2)),
        performedBy: "system",
        details: {
          fromPayments: filteredFromPayments,
          allocationId: allocationRef.id,
          orderExists,
        },
      });

      // collect for email
      const { companyName, email } = await resolveCustomerContact(invoice, cc);
      if (!settledByCompany.has(cc)) {
        settledByCompany.set(cc, {
          companyName,
          customerEmail: email,
          entries: [],
        });
      }
      settledByCompany.get(cc).entries.push({
        orderNumber: invoice.orderNumber,
        amount: Number(totalNewAmount.toFixed(2)),
        type: isRental ? "Rental" : "Standard",
        skippedAllocation: false,
        allocationId: allocationRef.id,
      });

      const updatedCredit = await getAvailableCredit(cc);
      return {
        message: `Invoice ${invoice.orderNumber} settled successfully`,
        type: isRental ? "Rental" : "Standard",
        allocationId: allocationRef.id,
        fromPayments: filteredFromPayments,
        creditSummary: updatedCredit,
      };
    };

    // 🔹 Mode 1: Specific invoice(s)
    if (
      (orderNumbers && Array.isArray(orderNumbers) && orderNumbers.length > 0) ||
      orderNumber
    ) {
      const numbers = orderNumbers || [orderNumber];
      for (const num of numbers) {
        const snap = await getDocs(
          query(collection(db, "invoices"), where("orderNumber", "==", num))
        );
        if (snap.empty) {
          results.push({ orderNumber: num, error: "Invoice not found" });
        } else {
          results.push(await processInvoice(snap.docs[0]));
        }
      }
    }

    // 🔹 Mode 2: Auto settle for a specific customer
    else if (autoSettle && companyCode) {
      const snap = await getDocs(
        query(
          collection(db, "invoices"),
          where("customer.companyCode", "==", companyCode),
          where("payment_status", "==", "Pending")
        )
      );
      for (const docSnap of snap.docs) {
        results.push(await processInvoice(docSnap));
      }
    }

    // 🔹 Mode 3: Admin global auto-settle
    else if (autoSettle && isAdmin) {
      const snap = await getDocs(
        query(collection(db, "invoices"), where("payment_status", "==", "Pending"))
      );
      for (const docSnap of snap.docs) {
        results.push(await processInvoice(docSnap));
      }
    }

    // ❌ Invalid request
    else {
      return NextResponse.json(
        {
          error:
            "Invalid request. Provide orderNumber/orderNumbers, or autoSettle with companyCode/isAdmin.",
        },
        { status: 400 }
      );
    }

    /* ----------------------------- Email sends ----------------------------- */

    // Customer emails — one per company with ≥1 settled invoice(s)
    for (const [cc, group] of settledByCompany.entries()) {
      const { companyName, customerEmail, entries } = group;
      if (!entries || entries.length === 0) continue;

      const total = entries.reduce((s, e) => s + Number(e.amount || 0), 0);
      const rows = entries.map((e) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">#${e.orderNumber}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${e.type}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${fmtR(e.amount)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${e.skippedAllocation ? "Prepaid/Zero" : e.allocationId}</td>
        </tr>
      `).join("");

      // Send to customer if we have an email on record
      if (customerEmail) {
        const subjectBase =
        entries.length === 1
          ? `Payment received — Invoice #${entries[0].orderNumber} settled`
          : `Payment received — ${entries.length} invoices settled`;
      const subject = `${subjectBase} — ${tsStamp()}`;

        const html = `
          <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;">
            <p>Hi ${companyName || "there"},</p>
            <p>Thank you — we’ve recorded your payment and settled the following invoice${entries.length>1?"s":""}:</p>
            <table style="border-collapse:collapse;width:100%;font-size:14px;">
              <thead>
                <tr>
                  <th align="left" style="padding:6px 8px;border-bottom:1px solid #ccc;">Invoice</th>
                  <th align="left" style="padding:6px 8px;border-bottom:1px solid #ccc;">Type</th>
                  <th align="left" style="padding:6px 8px;border-bottom:1px solid #ccc;">Amount</th>
                  <th align="left" style="padding:6px 8px;border-bottom:1px solid #ccc;">Allocation</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            <p style="margin-top:12px;">Total settled: <strong>${fmtR(total)}</strong></p>
            <p>If anything looks off, just reply to this email and we’ll help.</p>
            <p>— Bevgo Accounts</p>
          </div>
        `;
        await sendEmail({ to: customerEmail, subject, html });
      }
    }

    // Internal digest — ALWAYS send to info@bevgo.co.za
    const blocks = [];
    for (const [cc, group] of settledByCompany.entries()) {
      const { companyName, entries } = group;
      if (!entries || entries.length === 0) continue;
      const total = entries.reduce((s, e) => s + Number(e.amount || 0), 0);
      const list = entries
        .map(
          (e) =>
            `#${e.orderNumber} (${e.type}) — ${fmtR(e.amount)} — ${
              e.skippedAllocation ? "Prepaid/Zero" : `Alloc: ${e.allocationId}`
            }`
        )
        .join("<br/>");

      blocks.push(
        `<div style="margin-bottom:16px;">
           <div style="font-weight:600;">${companyName || cc} (${cc})</div>
           <div>${list}</div>
           <div style="margin-top:6px;">Subtotal: <strong>${fmtR(total)}</strong></div>
         </div>`
      );
    }

    if (blocks.length > 0) {
      const subject = `Invoice settlement — invoices marked Paid — ${tsStamp()}`;

      const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;">
          <p>These invoices were settled:</p>
          ${blocks.join("")}
          <p style="margin-top:8px;color:#666;font-size:12px;">(Source: settleInvoice)</p>
        </div>
      `;
      for (const to of INTERNAL_TO) {
        await sendEmail({ to, subject, html });
      }
    }

    // ✅ Final response
    return NextResponse.json({
      message: "Settlement process complete",
      results,
      emailedCompanies: Array.from(settledByCompany.keys()),
      internalNotified: true,
    });
  } catch (err) {
    console.error("❌ Settlement failed:", err);
    return NextResponse.json(
      { error: err.message || "Failed to settle invoices" },
      { status: 500 }
    );
  }
}
