📘 README for /api/v1/carts/list
Purpose

Provides a lightweight administrative overview of all active carts.

Features

Returns cart metadata (not full cart contents)

Optional filtering by cart status

Useful for dashboards, abandoned-cart workflow, CRM integration, etc.

Request
POST /api/v1/carts/list
{
  "status": "active"   // optional
}

Response
{
  "ok": true,
  "data": {
    "total": 4,
    "carts": [
      {
        "cart_id": "uid123",
        "user_id": "uid123",
        "status": "active",
        "item_count": 3,
        "updatedAt": "2025-12-01T10:00:00.000Z",
        "createdAt": "2025-12-01T09:55:00.000Z"
      }
    ]
  }
}

Notes

This endpoint does not calculate totals because totals may be expensive and should be fetched via /cart/get.

Only metadata is returned for performance and cost reasons.