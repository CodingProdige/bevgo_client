import { NextResponse } from "next/server";
import puppeteer from "puppeteer";
import { storage } from "@/lib/firebaseAdmin"; 

export async function POST(req) {
  try {
    const invoiceData = await req.json();

    // 1. Generate dynamic HTML VAT Invoice
    const invoiceHTML = `
<html>
<head>
  <style>
    body {
      font-family: Arial, sans-serif;
      font-size: 10px;
      padding: 20px;
      margin: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 100vh;
    }
    
    .container {
      width: 90%;
      margin: auto;
      padding: 15px;
      border: 1px solid #ddd;
      display: flex;
      flex-direction: column;
      min-height: 90vh; /* Ensures content always takes full height */
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #ddd;
      padding-bottom: 10px;
    }

    .header img {
      max-width: 150px;
    }

    .company-details {
      font-size: 9px;
      max-width: 250px;
    }

    .content {
      flex-grow: 1; /* Pushes footer down */
    }

    .box {
      border: 1px solid #ddd;
      padding: 10px;
      margin-top: 10px;
    }

    .box h3 {
      margin: 0 0 5px 0;
      font-size: 11px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 9px;
    }

    th, td {
      border: 1px solid #ddd;
      padding: 6px;
      text-align: left;
    }

    th {
      background: #f4f4f4;
    }

    .total {
      text-align: right;
      font-size: 12px;
      font-weight: bold;
      margin-top: 10px;
    }

    .footer {
      margin-top: auto; /* Pushes to the bottom */
      font-size: 9px;
      text-align: center;
      color: #777;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="https://firebasestorage.googleapis.com/v0/b/bevgo-client-management-rckxs5.firebasestorage.app/o/Bevgo%20Media%2FBevgo_Main_Logo%20-%20Google%20Version%201000x500.png?alt=media&token=bf97d121-8a9b-4949-abd7-8d707f78d4a1" alt="Bevgo Logo">
      <div class="company-details">
        <p><strong>Bevgo</strong></p>
        <p>6 Christelle Str. Denneburg, Paarl, Western Cape, South Africa, 7646</p>
        <p><strong>VAT No:</strong> 4760314296</p>
        <p><strong>Company Reg No:</strong> 2023 / 779316 / 07</p>
        <p><strong>Email:</strong> info@bevgo.co.za</p>
        <p><strong>Phone:</strong> 071 619 1616</p>
      </div>
    </div>

    <div class="content">
      <div class="box">
        <h3>Client Details</h3>
        <p><strong>Customer Code:</strong> ${invoiceData.customerCode}</p>
        <p><strong>Client Name:</strong> ${invoiceData.clientName}</p>
        <p><strong>Address:</strong> ${invoiceData.clientAddress}</p>
        ${invoiceData.clientVatNo ? `<p><strong>VAT No:</strong> ${invoiceData.clientVatNo}</p>` : ""}
        <p><strong>Email:</strong> ${invoiceData.clientEmail}</p>
        <p><strong>Phone:</strong> ${invoiceData.clientPhone}</p>
      </div>

      <div class="box">
        <h3>Invoice Details</h3>
        <p><strong>Invoice No:</strong> ${invoiceData.invoiceNumber}</p>
        <p><strong>Date:</strong> ${invoiceData.invoiceDate}</p>
      </div>

      <table>
        <tr>
          <th>Product Code</th>
          <th>Product Title</th>
          <th>Pack Size</th>
          <th>QTY</th>
          <th>Unit Price Excl. VAT</th>
          <th>Unit Price Incl. VAT</th>
          <th>Total Incl. VAT</th>
        </tr>
        ${invoiceData.items.map(item => `
          <tr>
            <td>${item.productCode}</td>
            <td>${item.name}</td>
            <td>${item.packSize} units</td>
            <td>${item.quantity}</td>
            <td>R${item.price.toFixed(2)}</td>
            <td>R${(item.price * 1.15).toFixed(2)}</td>
            <td>R${(item.quantity * item.price * 1.15).toFixed(2)}</td>
          </tr>
        `).join("")}
      </table>

      <p class="total">
        Subtotal (Excl. VAT): R${invoiceData.subtotal.toFixed(2)}<br>
        VAT (15%): R${invoiceData.vatAmount.toFixed(2)}<br>
        <strong>Total (Incl. VAT): R${invoiceData.totalAmount.toFixed(2)}</strong>
      </p>
    </div>

    <div class="footer">
      <p>Thank you for your business!</p>
    </div>
  </div>
</body>
</html>

    `;

    // Generate PDF
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    await page.setContent(invoiceHTML, { waitUntil: "load" });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();

    // Upload PDF to Firebase Storage
    const fileName = `invoices/invoice-${invoiceData.invoiceNumber}.pdf`;
    const file = storage.file(fileName);
    await file.save(pdfBuffer, { metadata: { contentType: "application/pdf" } });

    // Generate Signed URL (Valid for 5 years)
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: "03-01-2030",
    });

    return NextResponse.json({ success: true, invoiceUrl: url });

  } catch (error) {
    console.error("Error generating invoice:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
