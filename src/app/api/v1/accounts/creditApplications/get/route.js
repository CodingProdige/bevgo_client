export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";

/* ───────── HELPERS ───────── */

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const PAGE_SIZE = 50;

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && Object.keys(value).length === 0) return true;
  return false;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNumber(value) {
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function matchesFilters(application, filters) {
  if (!filters) return true;

  const businessInfo = application?.businessInfo || {};
  const requestedCredit = application?.requestedCredit || {};
  const submittedAt = parseDate(
    application?.timestamps?.submittedAt ||
    application?.timestamps?.createdAt ||
    application?.timestamps?.updatedAt
  );

  if (filters.status && application?.status !== filters.status) return false;
  if (
    filters.businessName &&
    businessInfo.businessName !== filters.businessName
  )
    return false;
  if (
    filters.businessType &&
    businessInfo.businessType !== filters.businessType
  )
    return false;
  if (filters.vatNumber && businessInfo.vatNumber !== filters.vatNumber)
    return false;
  if (
    filters.liquorLicenseNumber &&
    businessInfo.liquorLicenseNumber !== filters.liquorLicenseNumber
  )
    return false;

  const requiredCredit = parseNumber(requestedCredit?.requiredCredit);
  const minRequiredCredit = parseNumber(filters.requiredCreditMin);
  const maxRequiredCredit = parseNumber(filters.requiredCreditMax);

  if (minRequiredCredit != null && (requiredCredit == null || requiredCredit < minRequiredCredit))
    return false;
  if (maxRequiredCredit != null && (requiredCredit == null || requiredCredit > maxRequiredCredit))
    return false;

  if (filters.createdFrom) {
    const from = parseDate(filters.createdFrom);
    if (from && (!submittedAt || submittedAt < from)) return false;
  }

  if (filters.createdTo) {
    const to = parseDate(filters.createdTo);
    if (to && (!submittedAt || submittedAt > to)) return false;
  }

  return true;
}

/* ───────── ENDPOINT ───────── */

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      creditApplicationId: rawCreditApplicationId,
      uid: rawUid,
      status: rawStatus,
      filters: rawFilters,
      page: rawPage,
      sortOrder: rawSortOrder
    } = body || {};

    const creditApplicationId = isEmpty(rawCreditApplicationId)
      ? null
      : rawCreditApplicationId;
    const uid = isEmpty(rawUid) ? null : rawUid;
    const status = isEmpty(rawStatus) ? null : rawStatus;
    const filters = isEmpty(rawFilters) ? null : rawFilters;
    const paginate = !isEmpty(rawPage);
    const page = paginate ? rawPage : 1;
    const sortOrder = isEmpty(rawSortOrder) ? "desc" : rawSortOrder;

    if (creditApplicationId) {
      const ref = doc(db, "creditApplications", creditApplicationId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        return ok({ data: { docId: snap.id, ...snap.data() } });
      }
    }

    const snap = await getDocs(collection(db, "creditApplications"));
    const applications = snap.docs.map(doc => ({
      docId: doc.id,
      ...doc.data()
    }));

    if (creditApplicationId) {
      const match = applications.find(a => a?.docId === creditApplicationId);
      if (!match) {
        return err(
          404,
          "Credit Application Not Found",
          `No credit application found with id: ${creditApplicationId}`
        );
      }
      return ok({ data: match });
    }

    let filtered = applications.filter(a => {
      if (uid && a?.uid !== uid) return false;
      if (status && a?.status !== status) return false;
      return true;
    });

    if ((uid || status) && filtered.length === 0) {
      return err(
        404,
        "Credit Application Not Found",
        "No credit applications found with the provided reference."
      );
    }

    if (filters) {
      filtered = filtered.filter(a => matchesFilters(a, filters));
    }

    filtered.sort((a, b) => {
      const aTime = parseDate(a?.timestamps?.submittedAt)?.getTime() || 0;
      const bTime = parseDate(b?.timestamps?.submittedAt)?.getTime() || 0;
      return sortOrder === "asc" ? aTime - bTime : bTime - aTime;
    });

    const safePage = Number(page) > 0 ? Number(page) : 1;
    const total = filtered.length;
    const pageSize = paginate ? PAGE_SIZE : total;
    const totalPages = total > 0 ? (paginate ? Math.ceil(total / PAGE_SIZE) : 1) : 0;
    const start = paginate ? (safePage - 1) * PAGE_SIZE : 0;
    const end = paginate ? start + PAGE_SIZE : total;
    const pageApplications = start < total ? filtered.slice(start, end) : [];
    const pageApplicationsWithIndex = pageApplications.map((application, i) => ({
      ...application,
      credit_application_index: start + i + 1
    }));

    const pages = totalPages > 0
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : [];

    const windowStart = Math.max(1, safePage - 3);
    const windowEnd = Math.min(totalPages, safePage + 3);
    const pageWindow = totalPages > 0
      ? Array.from({ length: windowEnd - windowStart + 1 }, (_, i) => windowStart + i)
      : [];
    const moreBefore = Math.max(0, windowStart - 1);
    const moreAfter = Math.max(0, totalPages - windowEnd);

    const totals = filtered.reduce(
      (acc, application) => {
        acc.totalApplications += 1;
        const appStatus = application?.status || "unknown";
        acc.statusCounts[appStatus] = (acc.statusCounts[appStatus] || 0) + 1;
        const requiredCredit = parseNumber(
          application?.requestedCredit?.requiredCredit
        );
        if (requiredCredit != null) {
          acc.sumRequiredCredit = Number(
            (acc.sumRequiredCredit + requiredCredit).toFixed(2)
          );
        }
        return acc;
      },
      { totalApplications: 0, statusCounts: {}, sumRequiredCredit: 0 }
    );

    return ok({
      data: pageApplicationsWithIndex,
      totals,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
        pages,
        pageWindow,
        moreBefore,
        moreAfter
      }
    });
  } catch (e) {
    return err(
      500,
      "Fetch Credit Applications Failed",
      e?.message || "Unexpected error fetching credit applications."
    );
  }
}
