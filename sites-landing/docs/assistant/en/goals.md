---
title: Goals and the signed webhook — %%brand%% docs
heading: Goals and the signed webhook
description: How the assistant counts goals (leads, purchases): markup, a JavaScript call and a server-to-server webhook signed with HMAC-SHA256.
---
A goal is a visitor action you treat as a result: a lead, a purchase, a booking. The assistant counts goals reached after talking to it and sends reports to your Telegram.

:::claim goal-stats
## What the statistics show

- **Direct conversions:** the assistant led to it — a goal after a conversation within the attribution window.
- **Assisted:** the visitor talked to the assistant, but not necessarily thanks to it.
- **Operator workload saved:** conversations resolved without a human and ≈ operator hours by your estimate of minutes per question.
- CSV export from the cabinet; a morning summary in the bot.

We do not show uplift "thanks to the assistant": it needs a control group — that is the product's next stage.

## Markup without code

```gen:goalMarkup
```

## From JavaScript

On the "Thank you for your order" page:

```gen:goal
```
:::

:::claim weekly-report
## Weekly report

Every Monday (in the site's time zone) the bot sends a summary: the last 7 days against the previous 7 — conversations, resolved without a human, handoffs, leads, conversions and new topics the assistant does not know yet.
:::

:::claim goal-webhook
## Server-to-server webhook

An event from your server is more reliable than one from the page: blockers cannot stop it, and it carries the real amount and refunds.

- **Endpoint:** `POST %%webhookPath%%` on the assistant API — the exact address and the secret are in the cabinet ("Integrations").
- **Body:** JSON `goalKey`, `orderId`, `status` (`completed`, `refunded`, `cancelled`), `occurredAt` (ISO 8601), optional `value` and `currency`.
- **Header `%%signatureHeader%%`:** `%%signatureFormat%%`, where `t` is Unix time in seconds. Sign exactly the bytes you send in the body.
- **Window:** ±5 minutes of server time; an older signature is rejected.
- **`Idempotency-Key`:** the order number. A retry with the same key does not double the goal; `refunded` or `cancelled` for the same order subtracts it.

```gen:webhook
```

Table: Webhook responses
| Code | Reason |
| 200 | Event accepted (or a retry) |
| 401 | Signature missing, stale or foreign |
| 400 | No `Idempotency-Key`, body does not match the schema, unknown goal |
| 422 | Invalid order number |
| 429 | Too many events (over 120 a minute per site) |
:::
