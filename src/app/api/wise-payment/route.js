import { NextResponse } from "next/server";

export async function POST(req) {
    try {
        const body = await req.json();
        const { amount, currency, customerEmail, reference } = body;

        if (!amount || !currency || !customerEmail || !reference) {
            return NextResponse.json(
                { error: "Missing required fields: amount, currency, customerEmail, reference are needed" },
                { status: 400 }
            );
        }

        const WISE_API_KEY = process.env.WISE_API_KEY;
        const WISE_PROFILE_ID = process.env.WISE_PROFILE_ID;

        if (!WISE_API_KEY || !WISE_PROFILE_ID) {
            return NextResponse.json(
                { error: "Wise API credentials are not set. Please check your environment variables." },
                { status: 500 }
            );
        }

        // Step 1: Create Invoice
        const invoiceResponse = await fetch("https://api.wise.com/v1/invoices", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${WISE_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                profileId: WISE_PROFILE_ID,
                amount: {
                    value: amount.toFixed(2),
                    currency: currency,
                },
                description: `Invoice for ${reference}`,
                reference: reference,
                recipientEmail: customerEmail,
            }),
        });

        const invoiceData = await invoiceResponse.json();

        if (!invoiceResponse.ok) {
            return NextResponse.json(
                { error: "Failed to create invoice", details: invoiceData },
                { status: invoiceResponse.status }
            );
        }

        const invoiceId = invoiceData.id;

        // Step 2: Generate Payment Link for the Invoice
        const paymentLinkResponse = await fetch(`https://api.wise.com/v1/invoices/${invoiceId}/payment-link`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${WISE_API_KEY}`,
                "Content-Type": "application/json",
            },
        });

        const paymentLinkData = await paymentLinkResponse.json();

        if (!paymentLinkResponse.ok) {
            return NextResponse.json(
                { error: "Failed to generate payment link", details: paymentLinkData },
                { status: paymentLinkResponse.status }
            );
        }

        return NextResponse.json(
            { message: "Payment link created successfully", paymentLink: paymentLinkData.url },
            { status: 200 }
        );

    } catch (error) {
        return NextResponse.json(
            { error: "An unexpected server error occurred", details: error.message },
            { status: 500 }
        );
    }
}
