---
title: Widget JS API %%global%% — %%brand%% docs
heading: Widget JS API
description: Control the assistant widget from your page code: open the chat, ask a question, pass context and the customer, events and your own button.
---
Your page controls the widget through the global function `%%global%%(command, …)`. Calls made before the widget loads are not lost: put the queue stub before the tag and the loader will run what has accumulated.

:::claim js-api
## Queue stub

```js
window.%%global%% = window.%%global%% || function () {
  (window.%%global%%.q = window.%%global%%.q || []).push(arguments);
};
```

## Commands

Table: %%global%% commands
| Call | What it does |
| `%%global%%('open')`, `('close')`, `('toggle')` | Open, close, toggle the chat |
| `%%global%%('ask', 'How much is delivery?')` | Open the chat and ask a question (up to 500 characters) |
| `%%global%%('context', { plan: 'pro', cartTotal: 1299 })` | Page context for answers: up to 20 keys, strings or numbers |
| `%%global%%('identify', { name, email, externalId, userHash })` | Prefill the lead form; with `userHash` — a verified customer |
| `%%global%%('position', 'bottom-left')` | Move the button to another corner |
| `%%global%%('hide')`, `('show')` | Hide and show the button |
| `%%global%%('route')` | Report an SPA navigation if your router does not use the History API |
| `%%global%%('goal', 'purchase', { value, currency, orderId })` | A goal was reached — see [goals](/%%loc%%/docs/assistant/goals) |
| `%%global%%('consent', { analytics: true })` | Visitor's analytics consent from your cookie banner (`false` withdraws it); without consent or with GPC/DNT no visit analytics is collected |
| `%%global%%('group', fn)` | The visitor's experiment group: `fn('h')` — without the assistant, `fn('w')` — with it, `fn(null)` — no experiment |
| `%%global%%('ref', fn)` | A signed visit key for server-side orders: `fn(ref)` → pass it as `assistRef` in the server goal event |
| `%%global%%('on', 'open', fn)` | Subscribe to an event: `open`, `close`, `lead`, `handoff`, `goal` |
| `%%global%%('destroy')` | Remove the widget from the page |

An unknown command or a wrong argument is silently ignored — the widget never breaks your page.

## Your own button

With `data-launcher="none"` the widget has no button, and the chat is opened by any link to `%%anchor%%` or by your own `%%global%%('open')` call:

```html
<a href="%%anchor%%">Ask a question</a>
```

## Verified customer

`userHash` is HMAC-SHA256 of `externalId` with the site's identity secret. Compute it on your server only: the secret must never reach the browser. The site owner issues the secret in the cabinet ("Integrations").

```js
import { createHmac } from 'node:crypto';
const userHash = createHmac('sha256', process.env.ASSIST_IDENTITY_SECRET).update(customer.id).digest('hex');
```
:::
