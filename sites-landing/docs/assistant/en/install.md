---
title: Installing the AI assistant — %%brand%% docs
heading: Installing the AI assistant
description: How to put the assistant widget on your site: verify each host, add one tag to the head, data-* attributes, single-page apps and the install check.
---
The assistant appears on your site with one `<script async>` tag. The widget loads after your page, and the chat window only after a visitor clicks. You get the site key and the ready-made snippet in the assistant's cabinet in Telegram.

:::claim ownership-verification
## 1. Verify every host

The widget only answers on hosts whose ownership is verified: `shop.example.com` and `www.shop.example.com` are two different hosts. Pick one method in the cabinet:

- **DNS:** a TXT record `%%verifyDnsName%%` with the value `%%verifyDnsValue%%`.
- **File:** `%%verifyFileUrl%%` with the token on the first line.
- **Meta tag** on the home page:

```gen:verifyMeta
```

> Hosts on public platforms (`*.myshopify.com`, `*.tilda.ws`, `*.wordpress.com` and similar) can only be verified via DNS — so the widget works on your own domain, not on the platform's subdomain.
:::

:::claim install-snippet
## 2. Add the tag

Paste the snippet from the cabinet before `</head>` on every page. It looks like this (the key is yours, from the cabinet):

```gen:embedTag
```

- `async` is required: the tag does not block your page.
- A second identical tag on the same page is ignored.
- A `pk_test_…` key only works on `localhost` — for debugging; your live site needs `pk_live_…`.

## 3. Check

Open your site: the assistant button appears in the chosen corner. Run the "Install check" in the cabinet — it finds the tag, checks the host and names any missing CSP directive. No button? See [what to check](/%%loc%%/docs/assistant/csp).

## Tag attributes

Look and behaviour come from the settings published in the cabinet. Attributes override them only on the page with this tag — and only placement, language and mode, never the brand.

Table: data-* attributes of the loader tag
| Attribute | Values | What it does |
| `data-site` | `pk_live_…` | Site key (required) |
| `data-position` | `bottom-right`, `bottom-left`, `top-right`, `top-left` | Button corner |
| `data-offset-x`, `data-offset-y` | 0–200 | Offset from the edge, px |
| `data-mobile` | `fullscreen`, `sheet`, `bubble` | Chat layout on phones |
| `data-launcher` | `default`, `none` | `none` — no button: your own button opens the chat |
| `data-container` | CSS selector | Embed the chat into a block of the page |
| `data-lang` | `uk`, `ru`, `en` | Widget interface language |
| `data-z-index` | number | Widget layer above the page |
| `data-hide-on` | `/checkout,/cart` | Do not show on these paths (up to 20 masks) |

## Single-page apps

The widget follows History API navigation (React Router, Next.js, Vue Router) by itself — the conversation is not interrupted. If your router changes pages differently, tell the widget with `%%global%%('route')` — see [JS API](/%%loc%%/docs/assistant/js-api).
:::

:::claim install-guides
## Platforms

Step-by-step guides: [HTML](/%%loc%%/assistant/integrations/html), [Google Tag Manager](/%%loc%%/assistant/integrations/gtm), [WordPress](/%%loc%%/assistant/integrations/wordpress), [WooCommerce](/%%loc%%/assistant/integrations/woocommerce), [React and Next.js](/%%loc%%/assistant/integrations/react), [Shopify](/%%loc%%/assistant/integrations/shopify), [Horoshop](/%%loc%%/assistant/integrations/horoshop), [Tilda](/%%loc%%/assistant/integrations/tilda).
:::

:::claim wp-plugin
## WordPress plugin

The plugin for WordPress and WooCommerce (key in settings, "do not show on pages", order goals, signed-in customer) is ready in the product code. It is not published yet — until then, add the tag as described above.
:::

:::claim npm-package
## npm package for React, Vue and Next.js

A wrapper around the same loader (typed JS API, a React component, server-side webhook signing) is ready in the product code but not yet published to npm. Until then — the tag or `next/script`, as on the React and Next.js page.
:::
