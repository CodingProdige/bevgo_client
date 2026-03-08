export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const PDF_FUNCTION_URL = "https://generatepdf-th2kiymgaa-uc.a.run.app";

const ok = (data = {}, status = 200) =>
  NextResponse.json({ ok: true, data }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error") =>
  NextResponse.json({ ok: false, title, message }, { status });

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sharedStyles() {
  return `
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: Arial, sans-serif;
      font-size: 12px;
      color: #111827;
      background: #ffffff;
    }
    h1, h2, h3, p { margin: 0; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      border-bottom: 2px solid #111827;
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .brand { font-size: 20px; font-weight: 700; letter-spacing: 0.6px; }
    .muted { color: #4b5563; }
    .title { font-size: 22px; font-weight: 700; line-height: 1.2; }
    .hero {
      border: 1px solid #111827;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 14px;
      background: linear-gradient(120deg, #06080f 0%, #0b1220 55%, #111827 100%);
      color: #f9fafb;
    }
    .hero p { margin-top: 8px; line-height: 1.5; color: #e5e7eb; }
    .section-title {
      margin-top: 16px;
      margin-bottom: 8px;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.6px;
      color: #6b7280;
      font-weight: 700;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    .card {
      border: 1px solid #d4af37;
      border-radius: 12px;
      padding: 12px;
      min-height: 250px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: #fffcf4;
    }
    .card.dark {
      background: linear-gradient(160deg, #0a0f1a 0%, #111827 100%);
      color: #f9fafb;
      border-color: #d4af37;
    }
    .tag {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #7a5f17;
      font-weight: 700;
    }
    .card h3 { font-size: 13px; line-height: 1.35; }
    .rate {
      font-size: 28px;
      font-weight: 800;
      color: #ca8a04;
      margin-top: 4px;
    }
    .subhead {
      margin-top: 6px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #6b7280;
      font-weight: 700;
    }
    .bullets {
      margin: 0;
      padding-left: 16px;
      line-height: 1.45;
    }
    .bullets li { margin: 2px 0; }
    .table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 11px;
    }
    .table th, .table td {
      border: 1px solid #111827;
      padding: 6px 8px;
      vertical-align: top;
      text-align: left;
    }
    .table th {
      background: #f3f4f6;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-size: 10px;
    }
    .footer {
      margin-top: 14px;
      border-top: 1px solid #d1d5db;
      padding-top: 8px;
      font-size: 10px;
      color: #6b7280;
      display: flex;
      justify-content: space-between;
    }
  `;
}

function buildMarketplaceHtml(context) {
  const nowLabel = new Date(context.generatedAt).toLocaleString("en-ZA");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Bevgo Marketplace Service</title>
    <style>${sharedStyles()}</style>
  </head>
  <body>
    <div class="header">
      <div>
        <div class="brand">BEVGO DISTRIBUTIONS</div>
        <p class="muted">${esc(context.region)}</p>
      </div>
      <div class="title">Marketplace Service Structure</div>
    </div>

    <div class="hero">
      <h2>One Platform. One Invoice. All Your Suppliers.</h2>
      <p>
        Bevgo Marketplace connects suppliers to active hospitality and residential demand.
        Bevgo captures customer orders, consolidates basket demand, and executes fulfillment.
      </p>
    </div>

    <div class="section-title">Commercial Structure</div>
    <div class="grid">
      <div class="card">
        <div class="tag">Option A</div>
        <h3>Option A: Marketplace Sales + Bevgo Delivery</h3>
        <div class="rate">15% on all sales</div>
        <div class="subhead">How It Works</div>
        <ul class="bullets">
          <li>Products listed on Bevgo marketplace</li>
          <li>Orders captured through Bevgo channels</li>
          <li>Supplier handles stock and prep</li>
          <li>Bevgo handles final delivery to customer</li>
        </ul>
        <div class="subhead">Notes</div>
        <ul class="bullets">
          <li>Collection fee may apply for long-route collections (up to R50).</li>
        </ul>
      </div>
      <div class="card">
        <div class="tag">Option B</div>
        <h3>Option B: List on Bevgo + Store in Bevgo Warehouse</h3>
        <div class="rate">12% on all sales</div>
        <div class="subhead">How It Works</div>
        <ul class="bullets">
          <li>Marketplace listing + order capture</li>
          <li>Inventory warehoused in Bevgo facility</li>
          <li>Bevgo handles pick, pack, dispatch</li>
        </ul>
        <div class="subhead">Storage</div>
        <ul class="bullets">
          <li>R200 - R350 per pallet / month (footprint dependent).</li>
        </ul>
      </div>
      <div class="card dark">
        <div class="tag">Option C (Preferred)</div>
        <h3>Option C: Marketplace + Warehouse + Full 3PL Logistics</h3>
        <div class="rate">10% on Bevgo sales</div>
        <div class="subhead">How It Works</div>
        <ul class="bullets">
          <li>Best for scale and operational outsourcing</li>
          <li>Includes regional delivery and scheduling</li>
          <li>Includes warehouse storage and inventory control</li>
          <li>Custom 3PL handling rates per client profile</li>
        </ul>
        <div class="subhead">Extended Logistics (3PL)</div>
        <ul class="bullets">
          <li>Distribution to your existing clients.</li>
          <li>Regional delivery and route scheduling.</li>
          <li>Warehouse + transport execution under one model.</li>
        </ul>
      </div>
    </div>

    <div class="section-title">Progression Strategy</div>
    <table class="table">
      <thead>
        <tr>
          <th style="width:52px;">Stage</th>
          <th>Model</th>
          <th>Commercial Structure</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>1</td>
          <td>Marketplace Option A</td>
          <td>15% on sales + possible collection fee up to R50 when far.</td>
        </tr>
        <tr>
          <td>2</td>
          <td>Marketplace Option B</td>
          <td>12% on sales + R200-R350/pallet/month storage.</td>
        </tr>
        <tr>
          <td>3</td>
          <td>Marketplace Option C</td>
          <td>10% on Bevgo sales + custom 3PL handling rates.</td>
        </tr>
      </tbody>
    </table>

    <div class="footer">
      <div>Generated: ${esc(nowLabel)}</div>
      <div>${esc(context.companyEmail)} | ${esc(context.companyPhone)}</div>
    </div>
  </body>
</html>`;
}

function buildThreePlHtml(context) {
  const nowLabel = new Date(context.generatedAt).toLocaleString("en-ZA");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Bevgo Pure 3PL Service</title>
    <style>${sharedStyles()}</style>
  </head>
  <body>
    <div class="header">
      <div>
        <div class="brand">BEVGO DISTRIBUTIONS</div>
        <p class="muted">${esc(context.region)}</p>
      </div>
      <div class="title">Pure 3PL Fulfillment Service</div>
    </div>

    <div class="hero">
      <h2>Pure 3PL Fulfillment Service.</h2>
      <p>
        Independent from marketplace demand. Clients keep their own sales channels,
        while Bevgo executes storage, pick-pack, dispatch, and delivery.
      </p>
    </div>

    <div class="section-title">Service Scope</div>
    <div class="grid">
      <div class="card">
        <div class="tag">Service Line</div>
        <h3>Warehouse Operations</h3>
        <ul class="bullets">
          <li>Inbound receiving and put-away</li>
          <li>Storage by pallet footprint</li>
          <li>Stock counts and inventory control</li>
          <li>Cycle count and discrepancy handling</li>
        </ul>
      </div>
      <div class="card">
        <div class="tag">Service Line</div>
        <h3>Fulfillment Operations</h3>
        <ul class="bullets">
          <li>Pick, pack, and order staging</li>
          <li>Dispatch planning and route prep</li>
          <li>POD flow and delivery confirmation</li>
          <li>Returns and exception handling</li>
        </ul>
      </div>
      <div class="card dark">
        <div class="tag">Commercial</div>
        <h3>Commercial Model</h3>
        <ul class="bullets">
          <li>No marketplace listing required</li>
          <li>Custom handling rates per client</li>
          <li>Storage and logistics billed per profile</li>
          <li>Structured for scale and service SLAs</li>
        </ul>
      </div>
    </div>

    <div class="section-title">Typical Pricing Components</div>
    <table class="table">
      <thead>
        <tr>
          <th>Cost Component</th>
          <th>Charging Basis</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Storage</td>
          <td>Pallet footprint / month</td>
          <td>Depends on average footprint and turnover profile.</td>
        </tr>
        <tr>
          <td>Handling</td>
          <td>Per order / per unit / per activity</td>
          <td>Configured to client operating model and volume.</td>
        </tr>
        <tr>
          <td>Transport</td>
          <td>Per route / zone / stop</td>
          <td>Regional delivery and scheduling included by agreement.</td>
        </tr>
      </tbody>
    </table>

    <div class="footer">
      <div>Generated: ${esc(nowLabel)}</div>
      <div>${esc(context.companyEmail)} | ${esc(context.companyPhone)}</div>
    </div>
  </body>
</html>`;
}

async function renderPdf(htmlContent, fileName) {
  const response = await fetch(PDF_FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ htmlContent, fileName })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`PDF generation failed (${response.status}) ${text}`.trim());
  }

  const json = await response.json();
  if (!json?.pdfUrl) {
    throw new Error("PDF generation failed: missing pdfUrl.");
  }
  return json.pdfUrl;
}

async function buildResponse(body = {}) {
  const now = new Date().toISOString();
  const context = {
    generatedAt: now,
    companyEmail: body?.companyEmail || "info@bevgo.co.za",
    companyPhone: body?.companyPhone || "021 818 6153",
    region: body?.region || "Western Cape, South Africa"
  };

  const ts = now.replace(/[:.]/g, "-");
  const marketplaceHtml = buildMarketplaceHtml(context);
  const threePlHtml = buildThreePlHtml(context);

  const [marketplacePdfUrl, threePlPdfUrl] = await Promise.all([
    renderPdf(marketplaceHtml, `bevgo-marketplace-service-${ts}`),
    renderPdf(threePlHtml, `bevgo-3pl-service-${ts}`)
  ]);

  return {
    generatedAt: now,
    documents: {
      marketplace: { pdfUrl: marketplacePdfUrl },
      threePl: { pdfUrl: threePlPdfUrl }
    }
  };
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const data = await buildResponse(body);
    return ok(data);
  } catch (e) {
    return err(500, "Service PDF Generation Failed", e?.message || "Unexpected error.");
  }
}

export async function GET() {
  try {
    const data = await buildResponse({});
    return ok(data);
  } catch (e) {
    return err(500, "Service PDF Generation Failed", e?.message || "Unexpected error.");
  }
}
