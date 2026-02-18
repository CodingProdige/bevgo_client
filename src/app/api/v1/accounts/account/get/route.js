export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebaseConfig";
import {
  collection,
  doc,
  getDoc,
  getDocs
} from "firebase/firestore";
import { NextResponse } from "next/server";

const ok = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

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

function normalizeMedia(user) {
  if (!user || typeof user !== "object") return user;
  const media = user.media;
  if (!media || typeof media !== "object") return user;

  const normalizedMedia = Object.fromEntries(
    Object.entries(media).map(([key, value]) => {
      if (typeof value === "string" && value.trim() === "") {
        return [key, null];
      }
      return [key, value];
    })
  );

  return {
    ...user,
    media: normalizedMedia
  };
}

function matchesFilters(user, filters) {
  if (!filters) return true;

  const account = user?.account || {};
  const credit = user?.credit || {};
  const violations = user?.violations || {};
  const system = user?.system || {};
  const createdAt = parseDate(user?.created_time);

  if (filters.accountType && account.accountType !== filters.accountType)
    return false;

  if (typeof filters.accountActive === "boolean" &&
      account.accountActive !== filters.accountActive)
    return false;

  if (typeof filters.onboardingComplete === "boolean" &&
      account.onboardingComplete !== filters.onboardingComplete)
    return false;

  if (filters.accessType && system.accessType !== filters.accessType)
    return false;

  if (typeof filters.creditApproved === "boolean" &&
      credit.creditApproved !== filters.creditApproved)
    return false;

  if (filters.creditStatus && credit.creditStatus !== filters.creditStatus)
    return false;

  if (typeof filters.hasActiveViolation === "boolean" &&
      violations.hasActiveViolation !== filters.hasActiveViolation)
    return false;

  if (typeof filters.isBlocked === "boolean" &&
      violations.isBlocked !== filters.isBlocked)
    return false;

  if (typeof filters.newSchemaOnly === "boolean" && filters.newSchemaOnly) {
    const schemaVersion = account?.schemaVersion || null;
    const isNewSchema =
      (typeof schemaVersion === "number" && schemaVersion >= 2) ||
      Boolean(account?.accountType);
    if (!isNewSchema) return false;
  }

  if (filters.createdFrom) {
    const from = parseDate(filters.createdFrom);
    if (from && (!createdAt || createdAt < from)) return false;
  }

  if (filters.createdTo) {
    const to = parseDate(filters.createdTo);
    if (to && (!createdAt || createdAt > to)) return false;
  }

  return true;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      uid: rawUid,
      customerCode: rawCustomerCode,
      filters: rawFilters,
      page: rawPage,
      sortOrder: rawSortOrder
    } = body || {};

    const uid = isEmpty(rawUid) ? null : rawUid;
    const customerCode = isEmpty(rawCustomerCode) ? null : rawCustomerCode;
    const filters = isEmpty(rawFilters)
      ? { newSchemaOnly: true }
      : rawFilters;
    const paginate = !isEmpty(rawPage);
    const page = paginate ? rawPage : 1;
    const sortOrder = isEmpty(rawSortOrder) ? "desc" : rawSortOrder;

    if (uid) {
      const ref = doc(db, "users", uid);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        return err(404, "User Not Found", `No user found with uid: ${uid}`);
      }

      const data = normalizeMedia(snap.data());
      const schemaVersion = data?.account?.schemaVersion || null;
      const isNewSchema =
        (typeof schemaVersion === "number" && schemaVersion >= 2) ||
        Boolean(data?.account?.accountType);

      return ok({
        data: isNewSchema ? data : null,
        meta: {
          schemaVersion,
          isNewSchema
        }
      });
    }

    const snap = await getDocs(collection(db, "users"));
    const users = snap.docs.map(d => d.data());

    if (customerCode) {
      const match = users.find(
        u => u?.account?.customerCode === customerCode
      );

      if (!match) {
        return err(
          404,
          "User Not Found",
          `No user found with customerCode: ${customerCode}`
        );
      }

      const normalizedMatch = normalizeMedia(match);
      const schemaVersion = normalizedMatch?.account?.schemaVersion || null;
      const isNewSchema =
        (typeof schemaVersion === "number" && schemaVersion >= 2) ||
        Boolean(normalizedMatch?.account?.accountType);

      return ok({
        data: isNewSchema ? normalizedMatch : null,
        meta: {
          schemaVersion,
          isNewSchema
        }
      });
    }

    const filtered = users.filter(u => matchesFilters(u, filters));

    filtered.sort((a, b) => {
      const aTime = parseDate(a?.created_time)?.getTime() || 0;
      const bTime = parseDate(b?.created_time)?.getTime() || 0;
      return sortOrder === "asc" ? aTime - bTime : bTime - aTime;
    });

    const safePage = Number(page) > 0 ? Number(page) : 1;
    const total = filtered.length;
    const pageSize = paginate ? PAGE_SIZE : total;
    const totalPages = total > 0 ? (paginate ? Math.ceil(total / PAGE_SIZE) : 1) : 0;
    const start = paginate ? (safePage - 1) * PAGE_SIZE : 0;
    const end = paginate ? start + PAGE_SIZE : total;
    const pageUsers = start < total ? filtered.slice(start, end) : [];
    const pageUsersWithIndex = pageUsers.map((user, i) => ({
      ...normalizeMedia(user),
      account_index: start + i + 1
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

    return ok({
      data: pageUsersWithIndex,
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
    return err(500, "Failed To Retrieve User", e.message);
  }
}
