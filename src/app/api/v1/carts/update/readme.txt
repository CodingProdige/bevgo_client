🛒 Bevgo Cart Update Endpoint — Full Technical README

Endpoint: POST /api/v1/carts/update
Purpose: Create/update a user’s active cart, apply inventory and sale rules, perform customer-pricing logic, split variant quantities into sale/regular buckets, remove unavailable items, and return a recalculated cart snapshot + totals + warnings.

📌 Overview

This endpoint is the core of Bevgo’s ordering engine.
It performs all cart logic in the backend to ensure:

Correct sale-limit behavior

Correct stock checks

Correct customer-specific pricing

Correct VAT calculations

Correct returnables & rental logic

Consistent totals

Zero client-side logic or risk

Zero stale pricing

Zero oversold stock

Zero cart inconsistencies

It also supports:

Partial allocation

Sale price splitting

Dynamic pricing context

Global/cart/item warnings

Auto-create cart if missing

Auto-delete cart if empty

This allows the frontend to stay simple, and the backend stays authoritative.

🧾 Request Format
POST Body
{
  "uid": "USER_ID",
  "product": { ...full product JSON from getProducts endpoint... },
  "variant_id": 12345678,
  "qty": 12
}

Field Descriptions
Field	Type	Required	Description
uid	string	Yes	The Firestore user ID (also used as cart ID).
product	object	Yes	Complete product JSON including variants, pricing, sale structure, inventory, returnables, rental metadata.
variant_id	number	Yes	The 8-digit variant identifier selected.
qty	number	Yes	The requested total quantity for this variant. Backend auto-splits sale/regular buckets.
Notes

The frontend does NOT send pricing context or totals.

The backend fully calculates all sale, stock, pricing, and totals logic.

🛒 Cart Document Structure

The endpoint maintains a Firestore document at:

carts_active/{uid}


with structure:

{
  "docId": "uid",
  "cart": {
    "cart_id": "uid",
    "status": "active",
    "user_id": "uid"
  },
  "metadata": {
    "device_id": null,
    "channel": "app"
  },
  "items": [ /* populated by update endpoint */ ],
  "timestamps": {
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}


Totals are NOT stored in Firestore — only returned to client.

🔥 Business Logic Implemented
1. Full Create/Update/Delete Cart Behavior

If the cart does not exist → create it

If qty = 0 for a variant → remove item

If no items remain → delete entire cart

Otherwise → update in place

2. Sale Quantity Splitting (Limited Sale Stock)

If a variant is on sale and has:

sale.qty_available = 8


And user requests:

qty = 12


Then the backend calculates:

sale_qty = 8
regular_qty = 4


Two line items are created:

Sale bucket (pricing_context: "sale")

Regular bucket (pricing_context: "regular")

This ensures:

Sale abuse is impossible

Sale limits are enforced

Regular items always priced properly

Cart behaves identically to Amazon/Takealot promotional limits

3. Sale Bucket Realignment

If sale qty decreases later (admin change, inventory change):

Sale bucket shrinks

Overflow moves to regular bucket

If regular stock also insufficient → total qty shrinks

Warnings are generated

4. Regular Stock Shrinking (M1 Rule)

If total stock is insufficient to meet the request:

Sale bucket is preserved first

Regular bucket shrinks

If still insufficient → sale bucket shrinks too

Total qty is reduced to available stock

Appropriate warnings are added

5. Partial Stock Allocation (PS1)

If user requests more than total stock:

requested = 12
available = 9


Cart becomes:

qty = 9


User gets:

Correct final qty

Warnings explaining the adjustment

The request does not fail — it gracefully downgrades.

6. Out-of-Stock Handling (B1)

If both sale and regular stock are 0 for a variant:

✔ Item is removed entirely
✔ Global + cart + item warnings emitted
✔ If no items left → cart is deleted

This avoids overselling and invoice errors.

7. Pricing Context

Each line item has:

pricing_context: "sale" | "regular"


This prevents:

Incorrect discounts applied to sale items

Incorrect rebates applied to regular items

Mixing of pricing rules

UI-side confusion

Buckets are regenerated during each update.

8. Customer Pricing Model

Pricing is computed in this order:

8.1 If rental:

Ignore discounts

Ignore rebates

Ignore sale

Use rental_price_excl

8.2 Sale:

Sale price replaces selling price

Discounts do NOT apply to sale price

Rebates do NOT apply to sale price

8.3 Discounts:

If customer has:

discountPercentage > 0


Then:

Rebates are disabled

New price = selling_price_excl - percentage

8.4 Rebates:

Only applied when:

variant.pricing.rebate_eligible = true

AND customer.discountPercentage = 0

AND customer.pricing.rebate.rebateEligible = true

Rebate percentage comes from customer tier.

9. Returnables & Deposits

The endpoint calculates:

Returnable fees

Deposit fees (if deposit_included = false)

These are included in totals.

10. VAT (V1 Model)

All product prices stored EXCL VAT.

Totals are computed:

VAT = subtotal_excl * VAT_RATE


Then:

subtotal_incl = subtotal_excl + VAT
final_incl = final_excl + VAT


VAT_RATE is a global constant:

const VAT_RATE = 0.15;

💰 Totals Returned (Not Stored)

The endpoint returns a totals object:

{
  "subtotal_excl": 0.00,
  "subtotal_incl": 0.00,
  "rebate_amount": 0.00,
  "sale_savings_excl": 0.00,
  "deposit_total_excl": 0.00,
  "final_excl": 0.00,
  "final_incl": 0.00
}

⚠️ Warnings (W4 model)
Global warnings:

High-level problems (stock shortage, sale limitations...)

Cart-level warnings:

Issues affecting the overall cart state (realignments, stock changes...)

Per-item warnings:

Specific adjustments made to a variant:

{
  "variant_id": 12345,
  "context": "sale",
  "message": "Sale quantity reduced from 8 to 6."
}

🎯 Response Format
{
  "ok": true,
  "data": {
    "cart": { ...snapshot... },
    "totals": { ...calculated totals... },
    "warnings": {
      "global": [ ... ],
      "cart": [ ... ],
      "items": [ ... ]
    }
  }
}

🎉 Summary

This endpoint:

Is the single source of truth for cart operations

Ensures safe, accurate, compliant ordering behavior

Fully handles all pricing, stock, sale, rebate, deposit, rental, and VAT rules

Guarantees no overselling

Keeps frontend logic minimal

Ensures carts always match real-time inventory

Returns rich structured warnings

Builds foundation for /convertToOrder and invoice generation