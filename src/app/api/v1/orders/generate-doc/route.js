export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import axios from "axios";

/* ───────────────── HELPERS ───────────────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status, title, message, extra = {}) =>
  NextResponse.json(
    { ok: false, title, message, ...extra },
    { status }
  );

const now = () => new Date().toISOString();

const COMPANY = {
  name: "Bevgo Distributions",
  address: "6 Christelle Str, Denneburg, Paarl, Western Cape, South Africa, 7646",
  contact: "021 818 6153",
  email: "info@bevgo.co.za",
  vat: "4760314296",
  logoURL:
    "https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo%20Header%20Banner.png?alt=media&token=fb6ef880-b618-46c5-a1c3-e9bc1dd3690e"
};

const DOCS = {
  picking_slip: {
    label: "Picking Slip",
    template: "orderPickingSlip.ejs",
    filePrefix: "ps"
  },
  delivery_note: {
    label: "Delivery Note",
    template: "orderDeliveryNote.ejs",
    filePrefix: "dn"
  },
  invoice: {
    label: "Invoice",
    template: "orderInvoice.ejs",
    filePrefix: "inv"
  },
  outstanding_invoice_report: {
    label: "Outstanding Invoice Report",
    template: "outstandingInvoiceReport.ejs",
    filePrefix: "outstanding"
  },
  age_analysis_report: {
    label: "Age Analysis Report",
    template: "ageAnalysisReport.ejs",
    filePrefix: "age-analysis"
  },
  account_statement: {
    label: "Account Statement",
    template: "accountStatementReport.ejs",
    filePrefix: "account-statement"
  }
};

async function resolveOrderRef({ orderId, orderNumber, merchantTransactionId }) {
  if (orderId) return doc(db, "orders_v2", orderId);

  const field = orderNumber
    ? "order.orderNumber"
    : "order.merchantTransactionId";
  const value = orderNumber || merchantTransactionId;

  const snap = await getDocs(
    query(collection(db, "orders_v2"), where(field, "==", value))
  );

  if (snap.empty) return null;
  if (snap.size > 1) {
    throw {
      code: 409,
      title: "Multiple Orders Found",
      message: "Multiple orders match this reference."
    };
  }

  return snap.docs[0].ref;
}

function formatAddress(address) {
  if (!address) return "";
  if (typeof address === "string") return address.trim();
  if (typeof address !== "object") return "";

  const parts = [
    address.streetAddress,
    address.line1,
    address.line2,
    address.street,
    address.suburb,
    address.city,
    address.province,
    address.postalCode,
    address.postal_code,
    address.zip,
    address.country
  ].filter(Boolean);

  return parts.join(", ");
}

function getCustomerSnapshot(order) {
  const customer = order?.customer_snapshot || {};
  const account = customer?.account || {};
  const accountType = account.accountType || account.type || "";
  const isBusiness = accountType === "business";
  const customerTypeLabel = isBusiness ? "Business" : "Personal";

  const business = customer?.business || {};
  const personal = customer?.personal || {};
  const defaultLocation = (customer?.deliveryLocations || []).find(
    loc => loc && loc.is_default === true
  );

  const resolvedName = isBusiness
    ? business?.companyName || personal?.fullName || "Customer"
    : personal?.fullName || business?.companyName || "Customer";
  const resolvedPhone = isBusiness
    ? business?.phoneNumber || personal?.phoneNumber || ""
    : personal?.phoneNumber || business?.phoneNumber || "";

  return {
    name: resolvedName,
    email: customer?.email || "",
    phone: resolvedPhone,
    customerCode: account.customerCode || customer.customerCode || "",
    vat: business?.vatNumber || account.vatNumber || "",
    payment_terms: customer?.credit?.paymentTerms || account.payment_terms || "",
    fallbackAddress: defaultLocation || personal.address || "",
    customerTypeLabel,
    business,
    personal
  };
}

function buildOrderSummary(totals = {}) {
  const pricingAdjustment = Number(
    totals?.pricing_adjustment?.amount_excl ??
      totals?.pricing_adjustment?.amountExcl ??
      0
  );
  const creditApplied = Number(totals?.credit?.applied ?? 0);

  return {
    subtotal_excl: Number(totals?.subtotal_excl || 0),
    delivery_fee_excl: Number(totals?.delivery_fee_excl || 0),
    vat_total: Number(totals?.vat_total || 0),
    pricing_adjustment_excl: pricingAdjustment,
    credit_applied_incl: creditApplied,
    final_incl: Number(totals?.final_incl || 0)
  };
}

function normalizeItems(items = []) {
  return items.map((item, index) => {
    const product = item?.product_snapshot || {};
    const variant = item?.selected_variant_snapshot || {};
    const media = product?.media || product?.product?.media || {};
    const lineTotals = item?.line_totals || {};
    const returnable = variant?.returnable || {};
    const returnableTitle =
      returnable?.returnable?.title ||
      returnable?.title ||
      "";

    const title =
      product?.product?.title ||
      product?.title ||
      product?.name ||
      "Item";

    const qty = Number(item?.quantity ?? 0);
    const unitPrice = Number(
      lineTotals.unit_price_excl ??
        variant?.pricing?.selling_price_excl ??
        0
    );
    const lineSubtotal = Number(
      lineTotals.line_subtotal_excl ?? lineTotals.final_excl ?? 0
    );
    const lineTotalIncl = Number(
      lineTotals.final_incl ??
        lineTotals.final_excl ??
        lineTotals.line_subtotal_excl ??
        0
    );
    const returnableTotal = Number(lineTotals.returnable_excl ?? 0);

    return {
      index: index + 1,
      title,
      variantName: variant?.label || "",
      sku:
        variant?.sku ||
        variant?.variant_sku ||
        variant?.variantId ||
        variant?.variant_id ||
        "",
      qty,
      unitPriceExcl: unitPrice,
      returnableTotalExcl: returnableTotal,
      lineTotalExcl: lineSubtotal,
      lineTotalIncl,
      imageUrl:
        media?.images?.[0]?.imageUrl ||
        media?.hero?.url ||
        media?.image?.url ||
        null,
      returnableTitle,
      returnableQty: returnableTitle ? qty : 0
    };
  });
}

function parseDateInput(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const match = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]) - 1;
      const year = Number(match[3]);
      const d = new Date(year, month, day);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "object") {
    if (typeof value.seconds === "number") {
      const d = new Date(value.seconds * 1000);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value.milliseconds === "number") {
      const d = new Date(value.milliseconds);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

function clampDateRange(fromInput, toInput) {
  const from = parseDateInput(fromInput);
  const to = parseDateInput(toInput);
  if (from) from.setHours(0, 0, 0, 0);
  if (to) to.setHours(23, 59, 59, 999);

  if (!from && !to) {
    const end = new Date();
    const start = new Date(end);
    start.setMonth(start.getMonth() - 3);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { from: start, to: end };
  }

  return { from, to };
}

/* ───────────────── ENDPOINT ───────────────── */

export async function POST(req) {
  try {
    const {
      orderId,
      orderNumber,
      merchantTransactionId,
      docType,
      force = true,
      accountScope,
      customerId,
      allAccounts,
      currentUser,
      fromDate,
      toDate
    } = await req.json();

    if (!docType || !DOCS[docType]) {
      return err(
        400,
        "Invalid Document Type",
        "docType must be 'picking_slip', 'delivery_note', 'invoice', 'outstanding_invoice_report', 'age_analysis_report', or 'account_statement'."
      );
    }

    if (
      docType === "outstanding_invoice_report" ||
      docType === "age_analysis_report" ||
      docType === "account_statement"
    ) {
      const scope = allAccounts
        ? "all"
        : currentUser
          ? "current"
          : (accountScope || "current");

      if (scope !== "all" && !customerId) {
        return err(
          400,
          "Missing Input",
          "customerId is required when accountScope is 'current'."
        );
      }

      const reportSnap = await getDocs(collection(db, "orders_v2"));
      const orders = reportSnap.docs.map(doc => ({ docId: doc.id, ...doc.data() }));

      const { from, to } = clampDateRange(fromDate, toDate);
      const scoped = orders.filter(order => {
        if (scope !== "all" && order?.order?.customerId !== customerId) {
          return false;
        }
        return true;
      });

      const outstanding = scoped.filter(order => {
        const paymentStatus =
          order?.payment?.status || order?.order?.status?.payment || null;
        return paymentStatus === "unpaid" || paymentStatus === "partial";
      });

      if (docType === "account_statement") {
        const ledgerEntries = [];
        const paymentEntryKeys = new Set();

        for (const order of scoped) {
          const customer = getCustomerSnapshot(order);
          const required = Number(order?.payment?.required_amount_incl || 0);
          const createdAt = parseDateInput(order?.timestamps?.createdAt);

          ledgerEntries.push({
            date: createdAt,
            docType: "Invoice",
            reference: order?.order?.orderNumber || order?.docId || "",
            debit: required,
            credit: 0,
            customerName: customer.name || "",
            customerCode: customer.customerCode || ""
          });

          const creditNotes = order?.credit_notes;
          const creditAmount = Number(creditNotes?.totals?.incl || 0);
          if (creditAmount > 0) {
            const creditDate =
              parseDateInput(creditNotes?.updatedAt) ||
              parseDateInput(order?.timestamps?.updatedAt) ||
              createdAt;
            ledgerEntries.push({
              date: creditDate,
              docType: "Credit Note",
              reference: `CN-${order?.order?.orderNumber || order?.docId || ""}`,
              debit: 0,
              credit: creditAmount,
              customerName: customer.name || "",
              customerCode: customer.customerCode || ""
            });
          }

          const attempts = Array.isArray(order?.payment?.attempts)
            ? order.payment.attempts
            : [];
          const refundAttempts = attempts.filter(a =>
            a?.type === "refund" || a?.status === "refunded"
          );
          const refundTotal = refundAttempts.reduce(
            (sum, a) => sum + Number(a?.amount_incl || 0),
            0
          );
          const hasRefund = refundTotal > 0;

          for (const attempt of attempts) {
            const isRefund =
              attempt?.type === "refund" ||
              attempt?.status === "refunded";
            const isCharged = attempt?.status === "charged";

            if (!isRefund && !isCharged) continue;

            const amountIncl = Number(attempt?.amount_incl || 0);
            if (amountIncl <= 0) continue;

            const ref = attempt?.peachTransactionId || attempt?.merchantTransactionId || "CARD";
            const key = `${order?.order?.orderNumber || ""}_${amountIncl}_${attempt?.createdAt || ""}`;

            const paidAmountIncl = Number(order?.payment?.paid_amount_incl || 0);
            const refundLabel =
              isRefund && amountIncl > 0 && amountIncl < paidAmountIncl
                ? "Partial Refund"
                : "Full Refund";

            ledgerEntries.push({
              date: parseDateInput(attempt?.createdAt),
              docType: isRefund ? "Refund" : "Payment",
              reference: order?.order?.orderNumber
                ? `${isRefund ? refundLabel : "Payment"} on ${order.order.orderNumber}${!isRefund && hasRefund ? ` (refunded R${amountIncl.toFixed(2)})` : ""}`
                : (isRefund ? refundLabel : "Payment"),
              debit: 0,
              credit: isRefund ? amountIncl : (hasRefund ? 0 : amountIncl),
              customerName: customer.name || "",
              customerCode: customer.customerCode || ""
            });

            paymentEntryKeys.add(key);
          }

          const manualPayments = Array.isArray(order?.payment?.manual_payments)
            ? order.payment.manual_payments
            : [];

          for (const payment of manualPayments) {
            const amountIncl = Number(payment?.amount_incl || 0);
            if (amountIncl <= 0) continue;

            const key = `${order?.order?.orderNumber || ""}_${amountIncl}_${payment?.allocatedAt || ""}`;
            if (paymentEntryKeys.has(key)) continue;

            ledgerEntries.push({
              date: parseDateInput(payment?.allocatedAt),
              docType: "Payment",
              reference: order?.order?.orderNumber
                ? `Payment on ${order.order.orderNumber}${hasRefund ? ` (refunded R${amountIncl.toFixed(2)})` : ""}`
                : "Payment",
              debit: 0,
              credit: hasRefund ? 0 : amountIncl,
              customerName: customer.name || "",
              customerCode: customer.customerCode || ""
            });

            paymentEntryKeys.add(key);
          }
        }

        const paymentsSnap = scope === "all"
          ? await getDocs(collection(db, "payments_v2"))
          : await getDocs(
              query(
                collection(db, "payments_v2"),
                where("customer.customerId", "==", customerId)
              )
            );

        const payments = paymentsSnap.docs.map(doc => ({ docId: doc.id, ...doc.data() }));

        for (const payment of payments) {
          const paymentRef =
            payment?.payment?.reference ||
            payment?.docId ||
            "PAYMENT";

          const allocations = Array.isArray(payment?.allocations)
            ? payment.allocations
            : [];

          for (const alloc of allocations) {
            const allocDate = parseDateInput(alloc?.allocatedAt);
            const allocAmount = Number(alloc?.amount_incl || 0);
            const key = `${alloc?.orderNumber || ""}_${allocAmount}_${alloc?.allocatedAt || ""}`;
            if (paymentEntryKeys.has(key)) continue;
            ledgerEntries.push({
              date: allocDate,
              docType: "Payment",
              reference: alloc?.orderNumber
                ? `Payment on ${alloc.orderNumber}`
                : "Payment",
              debit: 0,
              credit: allocAmount,
              customerName: payment?.customer?.customerName || "",
              customerCode: payment?.customer?.customerCode || ""
            });
          }
        }

        const entriesBefore = ledgerEntries.filter(entry => {
          if (!from) return false;
          const date = entry.date ? new Date(entry.date) : null;
          return date && date < from;
        });

        const openingBalance = entriesBefore.reduce(
          (sum, entry) => sum + (entry.debit || 0) - (entry.credit || 0),
          0
        );

        const rows = ledgerEntries
          .filter(entry => {
            const date = entry.date ? new Date(entry.date) : null;
            if (from && (!date || date < from)) return false;
            if (to && (!date || date > to)) return false;
            return true;
          })
          .sort((a, b) => {
            const aTime = a.date ? new Date(a.date).getTime() : 0;
            const bTime = b.date ? new Date(b.date).getTime() : 0;
            return aTime - bTime;
          })
          .map(entry => ({
            ...entry,
            date: entry.date ? new Date(entry.date).toISOString() : null
          }));

        let runningBalance = Number(openingBalance.toFixed(2));
        const ledgerRows = [
          {
            date: from ? from.toISOString() : now(),
            docType: "Opening Balance",
            reference: "-",
            debit: 0,
            credit: 0,
            balance: runningBalance,
            customerName: scope === "all" ? "-" : "",
            customerCode: scope === "all" ? "-" : ""
          }
        ];

        for (const entry of rows) {
          runningBalance = Number(
            (runningBalance + (entry.debit || 0) - (entry.credit || 0)).toFixed(2)
          );
          ledgerRows.push({
            ...entry,
            balance: runningBalance
          });
        }

        const totals = ledgerRows.reduce(
          (acc, row) => {
            acc.debit += row.debit || 0;
            acc.credit += row.credit || 0;
            acc.balance = row.balance || acc.balance;
            return acc;
          },
          { debit: 0, credit: 0, balance: openingBalance }
        );

        const templatePath = path.join(
          process.cwd(),
          "src/lib/emailTemplates",
          DOCS[docType].template
        );
        const templateContent = fs.readFileSync(templatePath, "utf-8");
        const formatMoney = value => Number(value || 0).toFixed(2);

        const renderedHTML = ejs.render(templateContent, {
          company: COMPANY,
          rows: ledgerRows,
          totals,
          formatMoney,
          generatedAt: now(),
          scope,
          fromDate: from ? from.toISOString() : null,
          toDate: to ? to.toISOString() : null
        });

        const pdfFileName = `${DOCS[docType].filePrefix}-${Date.now()}`;
        const cloudFunctionUrl = "https://generatepdf-th2kiymgaa-uc.a.run.app";
        const response = await axios.post(cloudFunctionUrl, {
          htmlContent: renderedHTML,
          fileName: pdfFileName
        });

        if (!response.data?.pdfUrl) {
          throw new Error("PDF generation failed.");
        }

        return ok({
          docType,
          url: response.data.pdfUrl,
          generatedAt: now(),
          totals: {
            debit: Number(totals.debit.toFixed(2)),
            credit: Number(totals.credit.toFixed(2)),
            balance: Number(totals.balance.toFixed(2))
          }
        });
      }

      if (docType === "age_analysis_report") {
        const today = new Date();
        const buckets = [
          { label: "0-30", min: 0, max: 30, total: 0 },
          { label: "31-60", min: 31, max: 60, total: 0 },
          { label: "61-90", min: 61, max: 90, total: 0 },
          { label: "90+", min: 91, max: Number.POSITIVE_INFINITY, total: 0 }
        ];

        const rows = outstanding.map(order => {
          const customer = getCustomerSnapshot(order);
          const required = Number(order?.payment?.required_amount_incl || 0);
          const paid = Number(order?.payment?.paid_amount_incl || 0);
          const balance = Number((required - paid).toFixed(2));
          const createdAt = order?.timestamps?.createdAt || null;
          const ageDays = createdAt
            ? Math.max(
                0,
                Math.floor((today.getTime() - new Date(createdAt).getTime()) / 86400000)
              )
            : 0;

          const bucket = buckets.find(b => ageDays >= b.min && ageDays <= b.max) || buckets[buckets.length - 1];
          if (bucket) bucket.total += balance;

          return {
            orderNumber: order?.order?.orderNumber || order?.docId || "",
            customerName: customer.name || "",
            customerCode: customer.customerCode || "",
            createdAt,
            ageDays,
            balance,
            bucket: bucket?.label || "90+"
          };
        }).sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));

        const totals = rows.reduce(
          (acc, row) => {
            acc.balance += row.balance || 0;
            return acc;
          },
          { balance: 0 }
        );

        const templatePath = path.join(
          process.cwd(),
          "src/lib/emailTemplates",
          DOCS[docType].template
        );
        const templateContent = fs.readFileSync(templatePath, "utf-8");
        const formatMoney = value => Number(value || 0).toFixed(2);

        const renderedHTML = ejs.render(templateContent, {
          company: COMPANY,
          rows,
          buckets,
          totals,
          formatMoney,
          generatedAt: now(),
          scope
        });

        const pdfFileName = `${DOCS[docType].filePrefix}-${Date.now()}`;
        const cloudFunctionUrl = "https://generatepdf-th2kiymgaa-uc.a.run.app";
        const response = await axios.post(cloudFunctionUrl, {
          htmlContent: renderedHTML,
          fileName: pdfFileName
        });

        if (!response.data?.pdfUrl) {
          throw new Error("PDF generation failed.");
        }

        return ok({
          docType,
          url: response.data.pdfUrl,
          generatedAt: now(),
          totals: {
            balance: Number(totals.balance.toFixed(2))
          }
        });
      }

      const rows = outstanding.map(order => {
        const customer = getCustomerSnapshot(order);
        const required = Number(order?.payment?.required_amount_incl || 0);
        const paid = Number(order?.payment?.paid_amount_incl || 0);
        const balance = Number((required - paid).toFixed(2));

        return {
          orderNumber: order?.order?.orderNumber || order?.docId || "",
          customerName: customer.name || "",
          customerCode: customer.customerCode || "",
          createdAt: order?.timestamps?.createdAt || "",
          paymentStatus:
            order?.payment?.status || order?.order?.status?.payment || "",
          required,
          paid,
          balance
        };
      }).sort((a, b) => {
        const aTime = new Date(a.createdAt || 0).getTime();
        const bTime = new Date(b.createdAt || 0).getTime();
        return bTime - aTime;
      });

      const totals = rows.reduce(
        (acc, row) => {
          acc.required += row.required || 0;
          acc.paid += row.paid || 0;
          acc.balance += row.balance || 0;
          return acc;
        },
        { required: 0, paid: 0, balance: 0 }
      );

      const templatePath = path.join(
        process.cwd(),
        "src/lib/emailTemplates",
        DOCS[docType].template
      );
      const templateContent = fs.readFileSync(templatePath, "utf-8");
      const formatMoney = value => Number(value || 0).toFixed(2);

      const renderedHTML = ejs.render(templateContent, {
        company: COMPANY,
        rows,
        totals,
        formatMoney,
        generatedAt: now(),
        scope
      });

      const pdfFileName = `${DOCS[docType].filePrefix}-${Date.now()}`;
      const cloudFunctionUrl = "https://generatepdf-th2kiymgaa-uc.a.run.app";
      const response = await axios.post(cloudFunctionUrl, {
        htmlContent: renderedHTML,
        fileName: pdfFileName
      });

      if (!response.data?.pdfUrl) {
        throw new Error("PDF generation failed.");
      }

      return ok({
        docType,
        url: response.data.pdfUrl,
        generatedAt: now(),
        totals: {
          required: Number(totals.required.toFixed(2)),
          paid: Number(totals.paid.toFixed(2)),
          balance: Number(totals.balance.toFixed(2))
        }
      });
    }

    if (!orderId && !orderNumber && !merchantTransactionId) {
      return err(
        400,
        "Missing Order Reference",
        "orderId, orderNumber, or merchantTransactionId is required."
      );
    }

    const ref = await resolveOrderRef({
      orderId,
      orderNumber,
      merchantTransactionId
    });

    if (!ref) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const order = snap.data();
    const deliveryDocs = order?.delivery_docs || {};
    const existing = deliveryDocs?.[docType] || null;

    if (existing?.url && !force) {
      return ok({
        orderId: snap.id,
        orderNumber: order?.order?.orderNumber || null,
        docType,
        status: "already_generated",
        url: existing.url,
        generatedAt: existing.generatedAt || existing.uploadedAt || null
      });
    }

    let qrCodeURL = null;
    if (docType === "picking_slip" || docType === "delivery_note") {
      const qrValue =
        order?.order?.orderNumber ||
        order?.order?.merchantTransactionId ||
        snap.id;

      const qrResponse = await axios.post(
        "https://bevgo-client.vercel.app/api/generateQRCode",
        { value: qrValue }
      );

      if (!qrResponse.data?.qrCodeURL) {
        throw new Error("QR code generation failed.");
      }

      qrCodeURL = qrResponse.data.qrCodeURL;
    }

    const templatePath = path.join(
      process.cwd(),
      "src/lib/emailTemplates",
      DOCS[docType].template
    );
    const templateContent = fs.readFileSync(templatePath, "utf-8");

    const customer = getCustomerSnapshot(order);
    const deliveryAddress =
      formatAddress(order?.delivery?.address_snapshot) ||
      customer.fallbackAddress ||
      "";

    const items = normalizeItems(order?.items || []);

    const collectedReturnsIncl = Number(
      order?.returns?.totals?.incl || order?.totals?.collected_returns_incl || 0
    );
    const totalDueIncl = Number(order?.totals?.final_incl || 0) - collectedReturnsIncl;

    const totals = {
      subtotal_excl: Number(order?.totals?.subtotal_excl || 0),
      sale_savings_excl: Number(order?.totals?.sale_savings_excl || 0),
      deposit_total_excl: Number(order?.totals?.deposit_total_excl || 0),
      delivery_fee_excl: Number(order?.totals?.delivery_fee_excl || 0),
      delivery_fee_incl: Number(order?.totals?.delivery_fee_incl || 0),
      vat_total: Number(order?.totals?.vat_total || 0),
      final_excl: Number(order?.totals?.final_excl || 0),
      final_incl: Number(order?.totals?.final_incl || 0)
    };
    const summary = buildOrderSummary(order?.totals || {});

    const formatMoney = value => Number(value || 0).toFixed(2);

    const returnsList = Array.isArray(order?.returns?.returnables)
      ? order.returns.returnables
      : [];

    const renderedHTML = ejs.render(templateContent, {
      docTitle: DOCS[docType].label,
      company: COMPANY,
      order: {
        orderId: snap.id,
        orderNumber: order?.order?.orderNumber || "",
        merchantTransactionId: order?.order?.merchantTransactionId || "",
        createdAt: order?.timestamps?.createdAt || now()
      },
      customer,
      delivery: {
        address: deliveryAddress,
        instructions:
          order?.delivery?.address_snapshot?.instructions ||
          order?.delivery?.notes ||
          "",
        inStoreCollection: order?.delivery?.method === "collection",
        speed: order?.delivery?.speed?.type || ""
      },
      items,
      totals,
      summary,
      qrCodeURL,
      formatMoney,
      generatedAt: now(),
      returns: returnsList,
      payment: {
        method: order?.payment?.method || null,
        status: order?.payment?.status || null,
        required_amount_incl: Number(order?.payment?.required_amount_incl || 0),
        paid_amount_incl: Number(order?.payment?.paid_amount_incl || 0)
      },
      customerVat:
        order?.customer_snapshot?.account?.vatNumber ||
        order?.customer_snapshot?.account?.vat ||
        order?.customer_snapshot?.account?.vat_number ||
        "",
      orderNumber: order?.order?.orderNumber || snap.id,
      invoiceNumber: order?.order?.orderNumber || snap.id,
      invoiceDate: new Date(order?.timestamps?.updatedAt || now()).toLocaleDateString(),
      collectedReturnsIncl,
      totalDueIncl
    });

    const pdfFileName = `${DOCS[docType].filePrefix}-${order?.order?.orderNumber || snap.id}`;
    const cloudFunctionUrl = "https://generatepdf-th2kiymgaa-uc.a.run.app";

    const response = await axios.post(cloudFunctionUrl, {
      htmlContent: renderedHTML,
      fileName: pdfFileName
    });

    if (!response.data?.pdfUrl) {
      throw new Error("PDF generation failed.");
    }

    const pdfUrl = response.data.pdfUrl;
    const generatedAt = now();
    const timestampField = docType === "invoice" ? "uploadedAt" : "generatedAt";

    await updateDoc(ref, {
      [`delivery_docs.${docType}.url`]: pdfUrl,
      [`delivery_docs.${docType}.${timestampField}`]: generatedAt,
      "timestamps.updatedAt": generatedAt
    });

    return ok({
      orderId: snap.id,
      orderNumber: order?.order?.orderNumber || null,
      docType,
      url: pdfUrl,
      generatedAt
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Document Generation Failed",
      e?.message ?? "Unexpected error generating document."
    );
  }
}
