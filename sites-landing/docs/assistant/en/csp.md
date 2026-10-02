---
title: CSP and what to do if the widget does not appear — %%brand%% docs
heading: CSP and what to do if the widget does not appear
description: Content-Security-Policy directives for the assistant widget and a checklist of why the button does not appear or covers page elements.
---
If your site sends a `Content-Security-Policy` header, add the widget source to your directives — one line per directive. Your own sources stay; we only add ours.

:::claim install-snippet
## CSP directives

```gen:csp
```

- `script-src` — the widget loader.
- `frame-src` — the chat window (a separate iframe from our domain).
- `img-src` — icons and the avatar.
- `connect-src` — look settings. Without it the button works in the default look, and the install check names the missing directive.

## The widget did not appear

1. **The host is not verified.** Every host (with and without `www`) is verified separately — see [installation](/%%loc%%/docs/assistant).
2. **CSP.** The browser console shows "Refused to load…": add the directives above.
3. **A `pk_test_…` key on the live site.** It only works on `localhost`.
4. **The tag is not on the page.** A page cache or CDN serves an old version — clear the cache.
5. **The page is in `data-hide-on`.** The button is hidden on those paths on purpose.

## The button covers an element

Change the corner (`data-position`) or the offsets (`data-offset-x`, `data-offset-y`) — with an attribute for a single page, in the cabinet for the whole site. On phones you can choose the `bubble` layout.
:::
