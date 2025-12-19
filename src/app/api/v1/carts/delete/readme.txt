📘 README — /api/v1/carts/delete
Purpose

This endpoint clears a user’s entire active cart.
It is typically used when:

User taps “Clear cart”

After a successful order (cart becomes converted into an order)

Admin resets a user’s cart

System cleanup processes

🧠 Behavior
✔ Idempotent

If the cart doesn’t exist, it still returns { cart: null }.

✔ Deletes entire document

Deletes the document at:

/carts_active/{uid}

✔ Does NOT delete historical or converted carts

Only affects the active cart.

📤 Request Payload
{
  "uid": "USER_ID"
}

📥 Response
If cart existed and was deleted:
{
  "ok": true,
  "data": {
    "cart": null,
    "message": "Cart successfully cleared."
  }
}

If cart did not exist:
{
  "ok": true,
  "data": {
    "cart": null,
    "message": "Cart already empty."
  }
}

🧩 Integration Notes

Use this after /carts/convertToOrder

Use this for “Clear Cart” button in the app

Safe to call multiple times

Very low cost (single Firestore read + delete)

Very fast