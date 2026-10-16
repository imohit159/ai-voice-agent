# Business system integration contract (v1)

How your system asks the voice agent to call a customer, and how it receives the result.
The machine-readable source of truth is [`packages/contracts/src/integration.ts`](../../packages/contracts/src/integration.ts).

## Signing

Both directions are signed with HMAC-SHA256 using a shared secret (at least 32 characters). Each direction uses its own secret.

```
X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw request body>")>
```

- Sign the exact bytes you send. The receiver verifies against the raw body before parsing it.
- Requests with a timestamp more than 300 seconds from the receiver's clock are rejected. Keep server clocks NTP-synchronised.

## Call request

`POST /integrations/v1/call-requests` with `Content-Type: application/json`.

```json
{
  "requestId": "6f1c2a9e-3b0d-4c55-9f1e-8a2b7c0d4e11",
  "useCase": "order_confirmation",
  "customer": {
    "reference": "CUST-88231",
    "name": "Asha Verma",
    "phone": "+919876543210"
  },
  "order": {
    "id": "ORD-1001",
    "items": [{ "name": "Wireless headphones", "quantity": 1 }],
    "total": { "amountMinor": 149900, "currency": "INR" },
    "paymentMethod": "cash_on_delivery",
    "deliveryAddress": "Indiranagar, Bengaluru 560038"
  },
  "schedule": {
    "notBefore": "2026-10-16T12:00:00+05:30",
    "notAfter": "2026-10-16T18:00:00+05:30",
    "maxAttempts": 2
  },
  "metadata": { "campaign": "cod_check" }
}
```

| Field                  | Rules                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requestId`            | Your idempotency key: 1–100 characters of `A-Z a-z 0-9 . _ : -`. Never reuse it for different content.                                           |
| `customer.phone`       | Indian number in E.164 format: `+91` followed by 10 digits.                                                                                      |
| `order.total`          | Amount in paise (`149900` = ₹1,499.00).                                                                                                          |
| `schedule` (optional)  | Narrows when we may call. Default window: now to 24 hours from now. `notAfter` must be within 7 days. Calls are also limited to 10:00–19:00 IST. |
| `schedule.maxAttempts` | 1–3, default 3. An unanswered or busy call is retried within the window.                                                                         |
| `metadata` (optional)  | Up to 10 string entries, echoed back in every result.                                                                                            |

Unknown fields are rejected.

| Response | Meaning                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `202`    | Accepted. Body: `{ "requestId", "status": "pending", "acceptedAt" }`.                                                               |
| `200`    | Replay of an already accepted request with identical content. The original receipt is returned; no new call is made. Safe to retry. |
| `400`    | Invalid JSON or fields. `fields` lists the failing paths, e.g. `["customer.phone"]`.                                                |
| `401`    | Missing, invalid or expired signature.                                                                                              |
| `409`    | `requestId` reused with different content, or an open request already exists for this order.                                        |
| `422`    | Schedule window is invalid, already over, or more than 7 days ahead.                                                                |
| `503`    | Integration not configured on our side. Retry later.                                                                                |

Retry on network errors and `5xx` with the same body and `requestId`. Do not retry `4xx` without fixing the request.

## Call result

We send `POST` to your configured result URL after **every attempt**, signed with the result secret. Respond with any `2xx` to acknowledge receipt. We retry failed deliveries with backoff, so deduplicate by `eventId`.

```json
{
  "eventId": "0b8e3f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  "occurredAt": "2026-10-16T12:07:41+05:30",
  "requestId": "6f1c2a9e-3b0d-4c55-9f1e-8a2b7c0d4e11",
  "requestStatus": "completed",
  "useCase": "order_confirmation",
  "attempt": {
    "id": "a3d4e5f6-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    "number": 1,
    "result": "answered",
    "startedAt": "2026-10-16T12:05:30+05:30",
    "answeredAt": "2026-10-16T12:05:38+05:30",
    "endedAt": "2026-10-16T12:07:40+05:30",
    "durationSeconds": 122,
    "failureReason": null
  },
  "outcome": {
    "code": "change_requested",
    "summary": "Customer confirmed the order but asked to deliver to their office address.",
    "callbackAt": null
  },
  "metadata": { "campaign": "cod_check" }
}
```

| Field            | Values                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `requestStatus`  | `pending` (another attempt will follow), `completed`, `exhausted` (no attempt answered), `expired` (window ended). |
| `attempt.result` | `answered`, `no_answer`, `busy`, `failed`.                                                                         |
| `outcome`        | `null` unless the call was answered and reached a decision.                                                        |
| `outcome.code`   | `confirmed`, `cancel_requested`, `change_requested`, `callback_requested`, `wrong_person`, `needs_follow_up`.      |

An outcome records what the customer said. It never means a change has been applied; your system decides and applies changes. `wrong_person` means the agent disclosed no order details.
