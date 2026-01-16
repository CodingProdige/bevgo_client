/* eslint-disable import/namespace */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseConfig";
import { pricingDb } from "@/lib/firebasePricingConfig";
import { collection, doc, getDoc, getDocs, query, runTransaction, updateDoc, where } from "firebase/firestore";
import { updateOrderAtomic } from "./functions";

/* ------------------ HELPERS ------------------ */
const ok = (data = {}, ui = null, status = 200) =>
  NextResponse.json({ ok: true, data, ui }, { status });

const err = (status = 500, title = "Server Error", message = "Unknown error", ui = null) => {
  status = Number(status);
  if (!status || status < 200 || status > 599) status = 500;

  return NextResponse.json(
    { ok: false, title, message, ui },
    { status }
  );
};

async function resolveOrderId(orderId, orderNumber) {
  if (orderId) return orderId;
  if (!orderNumber) return null;

  const matchSnap = await getDocs(
    query(
      collection(db, "orders_v2"),
      where("order.orderNumber", "==", orderNumber)
    )
  );

  if (matchSnap.size > 1) {
    throw { code: 409, title: "Multiple Orders Found", message: "Multiple orders match this orderNumber." };
  }

  if (matchSnap.empty) return null;
  return matchSnap.docs[0].id;
}

/* ------------------ POST ------------------ */
export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch {
    return err(400, "Bad Request", "Request JSON body required");
  }

  if (!body?.orderId && !body?.orderNumber) {
    return err(400, "Missing Input", "orderId or orderNumber required");
  }

  try {
    const resolvedOrderId = await resolveOrderId(body?.orderId, body?.orderNumber);
    if (!resolvedOrderId) {
      return err(404, "Order Not Found", "Order could not be located.");
    }

    let effectiveProductId = body?.productId || null;
    let effectiveVariantId = body?.variantId || null;
    if ((!effectiveProductId || !effectiveVariantId) && body?.cart_item_key) {
      const orderRef = doc(db, "orders_v2", resolvedOrderId);
      const orderSnap = await getDoc(orderRef);
      const items = orderSnap.exists() && Array.isArray(orderSnap.data()?.items)
        ? orderSnap.data().items
        : [];
      const match = items.find(
        (it) => String(it?.cart_item_key || "") === String(body?.cart_item_key || "")
      );
      if (match) {
        effectiveProductId =
          String(match?.product_snapshot?.product?.unique_id || "") ||
          String(match?.product_snapshot?.docId || "") ||
          String(match?.product_snapshot?.product?.product_id || "") ||
          effectiveProductId;
        effectiveVariantId = String(match?.selected_variant_snapshot?.variant_id || "") || effectiveVariantId;
      }
    }

    let pricingProductSnapshot = null;
    if (effectiveProductId && effectiveVariantId) {
      const pricingRef = doc(pricingDb, "products_v2", String(effectiveProductId));
      const pricingSnap = await getDoc(pricingRef);
      if (!pricingSnap.exists()) {
        return err(404, "Product Not Found", "No product with this productId.");
      }
      pricingProductSnapshot = pricingSnap.data();
    }

    const result = await runTransaction(db, (tx) =>
      updateOrderAtomic(tx, {
        ...body,
        productId: effectiveProductId ?? body?.productId,
        variantId: effectiveVariantId ?? body?.variantId,
        orderId: resolvedOrderId,
        productSnapshot: pricingProductSnapshot,
        allowProductLookup: false
      })
    );

    let productUpdateError = null;
    if (result?.updatedVariants && result?.productId) {
      try {
        const pricingRef = doc(pricingDb, "products_v2", String(result.productId));
        await updateDoc(pricingRef, {
          variants: result.updatedVariants,
          "timestamps.updatedAt": new Date().toISOString()
        });
      } catch (updateError) {
        productUpdateError = updateError?.message || "Failed to update product stock.";
        console.error("[updateOrderAtomic] pricing update failed", updateError);
      }
    }

    const { _ui, _generatedKey, updatedVariants, productId, variantId, ...clean } = result ?? {};
    let ui = _ui ?? null;
    if (productUpdateError) {
      ui = {
        type: "warning",
        title: "Order Updated",
        message: "Order updated, but product stock update failed.",
        detail: productUpdateError
      };
    }

    return ok(
      { ...clean, generatedKey: _generatedKey ?? null },
      ui,
      200
    );
  } catch (e) {
    console.error("[updateOrderAtomic]", e);

    return err(
      e.code ?? 500,
      e.title ?? "Transaction Failed",
      e.message ?? "Unexpected error occurred",
      e.ui ?? null
    );
  }
}

/* ------------------ NEXT CONFIG ------------------ */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
