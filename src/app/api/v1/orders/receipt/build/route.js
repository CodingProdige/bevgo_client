export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from "firebase/firestore";
import { db } from "@/lib/firebaseConfig";
import { PNG } from "pngjs";

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

const LOGO_URL =
  "https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo_Main_Logo%20-%20Google%20Version%201000x500.png?alt=media&token=bf97d121-8a9b-4949-abd7-8d707f78d4a1";
const COMPANY_DETAILS = {
  name: "Bevgo Distributions",
  address: "6 Christelle Str, Denneburg, Paarl, Western Cape, South Africa, 7646",
  contact: "021 818 6153",
  email: "info@bevgo.co.za",
  vat: "4760314296",
  registration: "2023/779316/07"
};

function getLineWidth(printSize) {
  if (printSize === "80") return 48;
  if (printSize === "58") return 32;
  return 32;
}

function padLine(left, right, width) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  const spaceCount = Math.max(1, width - leftText.length - rightText.length);
  return `${leftText}${" ".repeat(spaceCount)}${rightText}`;
}

function wrapLine(text, width) {
  const words = String(text || "").split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function resolveOrderId(orderNumber) {
  if (!orderNumber) return null;

  const matchSnap = await getDocs(
    query(
      collection(db, "orders_v2"),
      where("order.orderNumber", "==", orderNumber)
    )
  );

  if (matchSnap.size > 1) {
    throw {
      code: 409,
      title: "Multiple Orders Found",
      message: "Multiple orders match this orderNumber."
    };
  }

  if (matchSnap.empty) return null;
  return matchSnap.docs[0].id;
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function formatOrderDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

function formatColumns(values, widths, aligns) {
  return values.map((value, i) => {
    const text = String(value ?? "");
    const width = widths[i];
    const trimmed = text.length > width ? text.slice(0, width) : text;
    if (aligns[i] === "right") {
      return trimmed.padStart(width, " ");
    }
    return trimmed.padEnd(width, " ");
  }).join("");
}

function buildWrappedRow(label, otherCols, widths, aligns) {
  const itemWidth = widths[0];
  const itemLines = wrapLine(label, itemWidth);
  const rows = [];
  itemLines.forEach((line, index) => {
    const cols = [line, ...otherCols.map(col => (index === 0 ? col : ""))];
    rows.push(formatColumns(cols, widths, aligns));
  });
  return rows;
}

function getItemColumns(width) {
  if (width >= 48) {
    return { widths: [26, 5, 8, 9], aligns: ["left", "right", "right", "right"] };
  }
  return { widths: [16, 4, 6, 6], aligns: ["left", "right", "right", "right"] };
}

function getReturnColumns(width) {
  if (width >= 48) {
    return { widths: [26, 6, 4, 12], aligns: ["left", "left", "right", "right"] };
  }
  return { widths: [16, 5, 3, 8], aligns: ["left", "left", "right", "right"] };
}

function buildReceiptText(order, width) {
  const lines = [];
  const orderNumber = order?.order?.orderNumber || order?.order?.orderId || "";
  const createdAt = order?.timestamps?.createdAt || new Date().toISOString();
  const customerName =
    order?.customer_snapshot?.account?.companyName ||
    order?.customer_snapshot?.personal?.fullName ||
    order?.customer_snapshot?.customerName ||
    "";

  wrapLine(
    "Formal invoice is available in the app order view.",
    width
  ).forEach(line => lines.push(line));
  lines.push("");
  wrapLine(COMPANY_DETAILS.name, width).forEach(line => lines.push(line));
  wrapLine(COMPANY_DETAILS.address, width).forEach(line => lines.push(line));
  wrapLine(`${COMPANY_DETAILS.contact} | ${COMPANY_DETAILS.email}`, width)
    .forEach(line => lines.push(line));
  wrapLine(`VAT No: ${COMPANY_DETAILS.vat}`, width).forEach(line => lines.push(line));
  wrapLine(`Reg No: ${COMPANY_DETAILS.registration}`, width)
    .forEach(line => lines.push(line));
  lines.push("");
  lines.push(padLine("Order", orderNumber, width));
  lines.push(padLine("Order Date (UTC)", formatOrderDate(createdAt), width));
  if (customerName) lines.push(padLine("Customer", customerName, width));
  lines.push("-".repeat(width));

  const itemColumns = getItemColumns(width);
  lines.push(formatColumns(
    ["VARIANT", "QTY", "UNIT", "TOTAL"],
    itemColumns.widths,
    itemColumns.aligns
  ));
  lines.push("-".repeat(width));

  const items = Array.isArray(order?.items) ? order.items : [];
  for (const item of items) {
    const title =
      item?.product_snapshot?.product?.title ||
      item?.product_snapshot?.title ||
      item?.product_snapshot?.name ||
      "Item";
    const variant =
      item?.selected_variant_snapshot ||
      item?.selected_variant ||
      item?.variant ||
      {};
    const variantLabel = variant?.label || "";
    const qty = Number(item?.quantity ?? item?.qty ?? 0);
    const unitExcl = Number(item?.line_totals?.unit_price_excl || 0);
    const lineIncl = Number(item?.line_totals?.final_incl || 0);
    const itemLabel = variantLabel || "Standard";

    wrapLine(`Product: ${title}`, width).forEach(line => lines.push(line));
    buildWrappedRow(
      `Variant: ${itemLabel}`,
      [qty, `R${formatMoney(unitExcl)}`, `R${formatMoney(lineIncl)}`],
      itemColumns.widths,
      itemColumns.aligns
    ).forEach(line => lines.push(line));
    lines.push("");
  }

  const returnsList = Array.isArray(order?.returns?.returnables)
    ? order.returns.returnables
    : [];

  if (returnsList.length > 0) {
    lines.push("-".repeat(width));
    lines.push("COLLECTED RETURNS");
    const returnColumns = getReturnColumns(width);
    lines.push(formatColumns(
      ["ITEM", "STATE", "QTY", "TOTAL"],
      returnColumns.widths,
      returnColumns.aligns
    ));
    lines.push("-".repeat(width));
    for (const ret of returnsList) {
      const label =
        ret?.snapshot?.returnable?.title ||
        ret?.snapshot?.returnable?.slug ||
        ret?.returnableId ||
        "Returnable";
      const qty = Number(ret?.quantity || 0);
      const state = (ret?.state || ret?.snapshot_state || "full").toString();
      const lineIncl = Number(ret?.line_total_incl || 0);

      buildWrappedRow(
        label,
        [state, qty, `R${formatMoney(lineIncl)}`],
        returnColumns.widths,
        returnColumns.aligns
      ).forEach(line => lines.push(line));
      lines.push("");
    }
  }

  lines.push("-".repeat(width));

  const totals = order?.totals || {};
  const collectedReturnsIncl = Number(
    order?.returns?.totals?.incl || totals?.collected_returns_incl || 0
  );
  const totalDueIncl = Number(totals?.final_incl || 0) - collectedReturnsIncl;

  lines.push(padLine("Total", `R${formatMoney(totals?.final_incl || 0)}`, width));

  if (collectedReturnsIncl > 0) {
    lines.push(
      padLine("Collected Returns", `-R${formatMoney(collectedReturnsIncl)}`, width)
    );
    lines.push(padLine("Total Due", `R${formatMoney(totalDueIncl)}`, width));
  }

  const payment = order?.payment || {};
  const paid = Number(payment?.paid_amount_incl || 0);
  if (totalDueIncl < 0) {
    lines.push(padLine("Credited", `R${formatMoney(Math.abs(totalDueIncl))}`, width));
  } else {
    lines.push(padLine("Paid", `R${formatMoney(paid)}`, width));
    lines.push(
      padLine(
        "Required",
        `R${formatMoney(Number(payment?.required_amount_incl || 0))}`,
        width
      )
    );
  }

  lines.push("");
  lines.push("BANK DETAILS");
  wrapLine("Account holder: BEVGO (PTY) LTD", width).forEach(line => lines.push(line));
  wrapLine("Account number: 1318880823", width).forEach(line => lines.push(line));
  wrapLine("Account type: Current account", width).forEach(line => lines.push(line));
  wrapLine("Branch code: 198765", width).forEach(line => lines.push(line));

  lines.push("");
  lines.push("THANK YOU");
  lines.push("");

  return lines.join("\n");
}

function buildEscPosQr(qrValue) {
  const data = Buffer.from(String(qrValue || ""), "utf8");
  const storeLen = data.length + 3;
  const pL = storeLen % 256;
  const pH = Math.floor(storeLen / 256);

  const selectModel = Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
  const setSize = Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x05]);
  const setError = Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]);
  const storeData = Buffer.concat([
    Buffer.from([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
    data
  ]);
  const printQr = Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);

  return Buffer.concat([selectModel, setSize, setError, storeData, printQr]);
}

function buildRasterEscPos(width, height, raster) {
  const widthBytes = Math.ceil(width / 8);
  const xL = widthBytes % 256;
  const xH = Math.floor(widthBytes / 256);
  const yL = height % 256;
  const yH = Math.floor(height / 256);
  return Buffer.concat([
    Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]),
    raster
  ]);
}

function rasterizePngToMono(pngBuffer, targetWidth) {
  const png = PNG.sync.read(pngBuffer);
  const scale = targetWidth / png.width;
  const width = Math.max(1, Math.round(png.width * scale));
  const height = Math.max(1, Math.round(png.height * scale));
  const widthBytes = Math.ceil(width / 8);
  const raster = Buffer.alloc(widthBytes * height);

  for (let y = 0; y < height; y += 1) {
    const srcY = Math.min(png.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(png.width - 1, Math.floor(x / scale));
      const idx = (srcY * png.width + srcX) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b);
      const isBlack = a > 32 && lum < 200;
      if (isBlack) {
        const byteIndex = y * widthBytes + Math.floor(x / 8);
        const bit = 7 - (x % 8);
        raster[byteIndex] |= 1 << bit;
      }
    }
  }

  return { width, height, raster };
}

function buildEscPosBuffer(text, qrValue, logoRaster) {
  const init = Buffer.from([0x1b, 0x40]);
  const alignCenter = Buffer.from([0x1b, 0x61, 0x01]);
  const alignLeft = Buffer.from([0x1b, 0x61, 0x00]);
  const boldOn = Buffer.from([0x1b, 0x45, 0x01]);
  const boldOff = Buffer.from([0x1b, 0x45, 0x00]);
  const cut = Buffer.from([0x1d, 0x56, 0x00]);

  const lines = text.split("\n");
  const content = [];

  content.push(init);
  if (logoRaster) {
    content.push(alignCenter);
    content.push(buildRasterEscPos(logoRaster.width, logoRaster.height, logoRaster.raster));
    content.push(Buffer.from("\n"));
  }
  content.push(alignCenter, boldOn, Buffer.from("BEVGO\n"), boldOff);
  content.push(Buffer.from("TAX INVOICE\n"));
  content.push(alignLeft);

  for (const line of lines) {
    content.push(Buffer.from(`${line}\n`));
  }

  if (qrValue) {
    content.push(Buffer.from("\n"));
    content.push(alignCenter, Buffer.from("SCAN TO VIEW ORDER\n"));
    content.push(buildEscPosQr(qrValue));
    content.push(Buffer.from("\n"));
    content.push(alignLeft);
  }

  content.push(Buffer.from("\n"));
  content.push(cut);

  return Buffer.concat(content);
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      orderNumber: rawOrderNumber,
      printSize: rawPrintSize
    } = body || {};
    const orderNumber = rawOrderNumber ? String(rawOrderNumber).trim() : null;
    const printSize = rawPrintSize ? String(rawPrintSize).trim() : "58";
    const lineWidth = getLineWidth(printSize);

    if (!orderNumber) {
      return err(400, "Missing Input", "orderNumber is required.");
    }

    const resolvedOrderId = await resolveOrderId(orderNumber);
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const ref = doc(db, "orders_v2", resolvedOrderId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    const order = snap.data();
    const receiptText = buildReceiptText(order, lineWidth);
    let logoRaster = null;
    try {
      const targetWidth = printSize === "80" ? 576 : 384;
      const logoRes = await fetch(LOGO_URL);
      if (logoRes.ok) {
        const logoBuffer = Buffer.from(await logoRes.arrayBuffer());
        logoRaster = rasterizePngToMono(logoBuffer, targetWidth);
      }
    } catch {
      logoRaster = null;
    }

    const receiptBuffer = buildEscPosBuffer(
      receiptText,
      order?.order?.orderNumber || orderNumber,
      logoRaster
    );

    return ok({
      orderId: resolvedOrderId,
      orderNumber: order?.order?.orderNumber || orderNumber,
      printSize,
      lineWidth,
      logoUrl: LOGO_URL,
      qrValue: order?.order?.orderNumber || orderNumber,
      receiptText,
      receiptBase64: receiptBuffer.toString("base64")
    });
  } catch (e) {
    return err(
      e?.code ?? 500,
      e?.title ?? "Receipt Build Failed",
      e?.message ?? "Unexpected error building receipt."
    );
  }
}
