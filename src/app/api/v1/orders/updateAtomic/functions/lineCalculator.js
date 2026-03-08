const VAT_RATE = 0.15;
const r2 = (v) => Number((Number(v) || 0).toFixed(2));

function normalizePricingAdjustment(pricingAdjustment, subtotalExcl) {
  const raw = pricingAdjustment && typeof pricingAdjustment === "object"
    ? pricingAdjustment
    : {};

  const percent = Math.max(0, Number(raw?.percent) || 0);
  const providedAmount = Math.max(0, Number(raw?.amount_excl) || 0);
  const base = Math.max(0, Number(subtotalExcl) || 0);

  let amount_excl = 0;
  if (percent > 0) {
    amount_excl = r2((base * percent) / 100);
  } else if (providedAmount > 0) {
    amount_excl = r2(providedAmount);
  }

  amount_excl = Math.min(amount_excl, r2(base));
  const type = amount_excl > 0 ? (raw?.type || "rebate") : "none";

  return {
    ...raw,
    type,
    percent: r2(percent),
    amount_excl
  };
}

/* Resolve the unit price using rental > sale > standard selling price */
export function resolveUnitPrice(variant) {
  if (variant?.rental?.is_rental) {
    return r2(variant?.rental?.rental_price_excl || 0);
  }
  if (variant?.sale?.is_on_sale) {
    return r2(variant?.sale?.sale_price_excl || 0);
  }
  return r2(variant?.pricing?.selling_price_excl || 0);
}

export function computeLineTotals(variant, qty) {
  const quantity = Math.max(0, Number(qty) || 0);
  const unit = resolveUnitPrice(variant);
  const line_subtotal_excl = r2(unit * quantity);
  const item_vat = r2(line_subtotal_excl * VAT_RATE);

  const returnable_unit = r2(
    variant?.returnable?.pricing?.full_returnable_price_excl ??
    variant?.returnable?.data?.pricing?.full_returnable_price_excl ??
    0
  );
  const returnable_excl = r2(returnable_unit * quantity);
  const returnable_vat = r2(returnable_excl * VAT_RATE);

  const total_vat = r2(item_vat + returnable_vat);
  const final_excl = r2(line_subtotal_excl + returnable_excl);
  const final_incl = r2(final_excl + total_vat);

  return {
    unit_price_excl: unit,
    line_subtotal_excl,
    returnable_excl,
    returnable_vat,
    item_vat,
    total_vat,
    final_excl,
    final_incl
  };
}

export function computeCartTotals(items, options = {}) {
  let subtotal = 0;
  let deposit = 0;
  let sale_savings_excl = 0;

  for (const it of Array.isArray(items) ? items : []) {
    const qty = Number(it?.quantity) || 0;
    const variant = it?.selected_variant_snapshot || null;
    const lt = it?.line_totals || computeLineTotals(variant, qty);

    subtotal += lt?.line_subtotal_excl || 0;
    deposit += lt?.returnable_excl || 0;

    const normal = Number(variant?.pricing?.selling_price_excl) || 0;
    const sale = Number(variant?.sale?.sale_price_excl) || 0;
    if (variant?.sale?.is_on_sale && normal > sale) {
      sale_savings_excl += (normal - sale) * qty;
    }
  }

  const delivery_fee_excl = r2(options?.deliveryFeeExcl || 0);
  const delivery_fee_vat = r2(
    options?.deliveryFeeVat ??
      ((Number(options?.deliveryFeeIncl || 0) - Number(options?.deliveryFeeExcl || 0)) || 0)
  );
  const delivery_fee_incl = r2(
    options?.deliveryFeeIncl ??
      (delivery_fee_excl + delivery_fee_vat)
  );

  const pricing_adjustment = normalizePricingAdjustment(
    options?.pricingAdjustment,
    subtotal
  );
  const pricing_savings_excl = r2(pricing_adjustment.amount_excl || 0);

  const discountedSubtotalExcl = r2(Math.max(subtotal - pricing_savings_excl, 0));
  const base_final_excl = r2(subtotal + deposit + delivery_fee_excl);
  const final_excl_after_discount = r2(discountedSubtotalExcl + deposit + delivery_fee_excl);

  // Discount/rebate is applied to subtotal before VAT.
  const vat_total = r2((discountedSubtotalExcl + deposit) * VAT_RATE + delivery_fee_vat);
  const base_final_incl = r2(base_final_excl + r2((subtotal + deposit) * VAT_RATE + delivery_fee_vat));
  const final_incl_after_discount = r2(final_excl_after_discount + vat_total);
  const final_excl = final_excl_after_discount;
  const final_incl = final_incl_after_discount;

  return {
    subtotal_excl: r2(subtotal),
    subtotal_incl: r2(discountedSubtotalExcl + vat_total),
    sale_savings_excl: r2(sale_savings_excl),
    pricing_savings_excl,
    pricing_adjustment,
    deposit_total_excl: r2(deposit),
    delivery_fee_excl,
    delivery_fee_incl,
    delivery_fee_vat,
    vat_total,
    base_final_excl,
    base_final_incl,
    final_excl_after_discount,
    final_incl_after_discount,
    final_excl,
    final_incl
  };
}

export { VAT_RATE };
