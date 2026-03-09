# Peach Payments API (v1)

This folder contains all Peach payment endpoints used by the app.

## Base path

`/api/v1/payments/peach/*`

## Required environment variables

- `PEACH_S2S_ENTITY_ID`
- `PEACH_S2S_ACCESS_TOKEN`
- `BASE_URL` (used by `charge-card` to build internal redirect URL)
- `PEACH_SHOPPER_RESULT_URL` (optional fallback result URL if request does not provide `shopperResultUrl`)

---

## Endpoints

### `POST /charge-card`
Primary card checkout endpoint (the one your app calls).

What it does:
1. Charges card via Peach (`/v1/payments`).
2. Saves/updates card in `users.paymentMethods.cards`.
3. Resolves order by `merchantTransactionId` in `orders_v2`.
4. Applies order payment success via `applyOrderPaymentSuccess(...)`.
5. Stores redirect mapping in `peach_redirects/{merchantTransactionId}`.
6. Returns success payload including `paymentId` + `shopperResultUrl`.

Important:
- This endpoint already applies order success on the server.
- It configures Peach `shopperResultUrl` to this API:
  - `/api/v1/payments/peach/shopper-redirect?merchantTransactionId=...`

---

### `GET|POST /shopper-redirect`
Bridge endpoint used when Peach/bank challenge returns the shopper.

What it does:
1. Reads `merchantTransactionId` (query or POST body/form).
2. Loads `peach_redirects/{merchantTransactionId}`.
3. Builds final redirect URL by appending:
   - `paymentId`
   - `merchantTransactionId`
   - `orderNumber` (if present)
4. Redirects (`302`) to your original `shopperResultUrl`.

Why both methods:
- Some browser/device return flows hit this URL as `GET`, others as `POST`.
- Supporting both prevents `HTTP 405` during 3DS return.

---

### `POST /charge-token`
Charges a previously tokenized/saved card (MIT/CIT token flow).

Typical use:
- Repeat customer payment without full card capture step.

---

### `POST /tokenize`
Saves card token/registration details from Peach for later token charges.

---

### `GET /payment-status`
Fetches payment status from Peach for a payment id/reference.

Use this to verify payment state independently from app state.

---

### `POST /charge-refund`
Issues refund against prior Peach charge/payment id.

Expected behavior:
- Validates amount and request.
- Calls Peach refund API.
- Updates order/payment refund state in your documents.

---

## 3DS Endpoints

These are a dedicated 3DS flow. They can run separately from `charge-card`.

### `POST /3ds/initiate`
Starts a 3DS session with Peach and stores attempt in `payment_3ds_attempts`.

Returns:
- `threeDSecureId`
- `redirect`
- `startUrl`

### `GET /3ds/status`
Polls Peach 3DS status and updates `payment_3ds_attempts` state.

### `POST /3ds/finalize`
Final charge call after successful challenge/authentication.

What it does:
- Uses stored 3DS attempt + verification data.
- Charges Peach.
- Marks attempt finalized.
- Applies order payment success.

### `GET /3ds/attempt`
Reads one saved 3DS attempt snapshot by id.

---

## Data collections touched

- `orders_v2` (payment/order status updates)
- `payments_v2` (via shared payment success logic, where applicable)
- `users` (saved cards and payment attempts on card profiles)
- `peach_redirects` (redirect mapping for return flow)
- `payment_3ds_attempts` (3DS lifecycle state)

---

## Recommended client flow (charge-card path)

1. App calls `POST /api/v1/payments/peach/charge-card`.
2. Backend processes charge + order success.
3. Peach returns shopper to `/api/v1/payments/peach/shopper-redirect`.
4. `shopper-redirect` forwards to your app result URL/deeplink with `paymentId`.
5. App handles final UI/cart cleanup using returned params.

If app UI and backend state disagree, call:
- `GET /api/v1/payments/peach/payment-status`
- then refresh order from `/api/v1/orders/get`.

