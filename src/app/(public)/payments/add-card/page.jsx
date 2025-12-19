"use client";

import { Suspense, useEffect } from "react";
import Script from "next/script";
import { useSearchParams, useRouter } from "next/navigation";

function AddCardInner() {
  const params = useSearchParams();
  const router = useRouter();

  const checkoutId = params.get("checkoutId");
  const userId = params.get("userId") || "";

  if (!checkoutId) {
    return (
      <div style={{ padding: 40 }}>
        <h2>Missing checkoutId</h2>
        <p>You must pass ?checkoutId=XXXXXX</p>
      </div>
    );
  }

  // Fetch final payment result from Peach
  const fetchPaymentResult = async (resultId) => {
    try {
      const url =
        `https://test.oppwa.com/v1/payments/${resultId}` +
        `?entityId=${process.env.NEXT_PUBLIC_PEACH_ENTITY_3DS}`;

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_PEACH_TOKEN}`,
        },
      });

      const data = await res.json();
      console.log("FINAL PEACH RESULT →", data);

      const registrationId = data.registrationId;
      const brand = data.card?.binBrand || "";
      const last4 = data.card?.last4Digits || "";
      const expiryMonth = data.card?.expiryMonth || "";
      const expiryYear = data.card?.expiryYear || "";
      const peachTransactionId = data.id;
      const merchantTransactionId = data.merchantTransactionId;

      const callbackParams =
        `token=${registrationId}` +
        `&brand=${brand}` +
        `&last4=${last4}` +
        `&expiryMonth=${expiryMonth}` +
        `&expiryYear=${expiryYear}` +
        `&peachTx=${peachTransactionId}` +
        `&merchantTx=${merchantTransactionId}` +
        `&userId=${userId}`;

      // Detect native FlutterFlow install
      const isMobileApp =
        /iPhone|iPad|Android/i.test(navigator.userAgent) &&
        window.matchMedia &&
        window.matchMedia("(display-mode: standalone)").matches;

      if (isMobileApp) {
        window.location.href = `bevgoclientportal://card-added?${callbackParams}`;
        return;
      }

      // Web fallback
      window.location.href = `https://client-portal.bevgo.co.za/card-callback?${callbackParams}`;

    } catch (err) {
      console.error("ERROR FETCHING PEACH RESULT:", err);
      alert("Failed to complete card registration.");
    }
  };

  // Expose success callback globally
  useEffect(() => {
    window.__BEVGO_PEACH_SUCCESS__ = function (response) {
      console.log("RAW PEACH RESPONSE →", response);
      if (response?.id) {
        fetchPaymentResult(response.id);
      }
    };
  }, []);

  return (
    <div
      style={{
        maxWidth: 500,
        margin: "40px auto",
        padding: 20,
        borderRadius: 12,
        background: "#f9f9f9",
        boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
      }}
    >
      <h2 style={{ textAlign: "center" }}>Add Payment Card</h2>
      <p style={{ textAlign: "center", color: "#666" }}>
        Securely enter your card details below.
      </p>

      {/* Load Peach script */}
      <Script src={`https://test.oppwa.com/v1/paymentWidgets.js?checkoutId=${checkoutId}`} />

      {/* Render form */}
      <form
        className="paymentWidgets"
        data-brands="VISA MASTER AMEX DINERS DISCOVER"
      ></form>

      {/* Bind success handler */}
      <Script id="bevgo-peach-handler">
        {`
          document.addEventListener("DOMContentLoaded", function () {
            if (typeof wpwl !== "undefined") {
              wpwl.options = {
                onSuccess: function (resp) {
                  if (window.__BEVGO_PEACH_SUCCESS__) {
                    window.__BEVGO_PEACH_SUCCESS__(resp);
                  }
                }
              };
            }
          });
        `}
      </Script>
    </div>
  );
}

// Wrapped in suspense to fix the Next.js searchParams error
export default function AddCardPage() {
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <AddCardInner />
    </Suspense>
  );
}
