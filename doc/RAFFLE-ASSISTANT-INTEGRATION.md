# Raffle Market assistant integration — 2026-10-25

Scope: one separate site, exact https://raffle-fe-next.vercel.app:443. Raffle repository, other customers, Nova and accepted builds are unchanged.

## Hosted Vercel proof

`header` ownership method is limited to a single-label project host under vercel.app. Configure a project-level response header `x-v4c-verify: <this account verification token>` on GET / with an exact Host condition using the authenticated Vercel project CDN Routing UI. The verifier fetches that precise HTTPS origin with the existing DNS-pinned SSRF-safe transport, refuses cross-origin redirects and requires the exact account token. No wildcard or domain inheritance. Other public platforms remain DNS-only. Missing header is a definitive failure; outages are inconclusive. Existing 90-day expiry and daily recheck/revocation semantics apply; rechecks preserve the header method. Removing the project rule revokes verification through the regular recheck and grace mechanism.

Vercel project routing rules do not require a new deployment: https://vercel.com/docs/routing/project-routing-rules. The public verification token is not an API credential. Do not put provider keys in this header. Domain verification establishes site control only; it never grants payment/wallet automation.

## Site caps

Internal operator `PATCH /internal/admin/assist/sites/:siteId` accepts `voiceDailyCapUsd` (finite number 0–1000 or null); the account view includes this field. Stored as integer microdollars on only the requested `assist_sites` row, audited `site:voice-cap`; no subscription edits. Admin → Помощник сайтов → Кабинеты и сайты → selected account has separate site chat/voice cap fields. Zero denies spending, empty uses plan default. Caps reset daily UTC and are NOT lifetime test allowances. For the approved $0.70 total experiment, set a smaller daily ceiling, run bounded probes, reconcile usage and switch voice off/zero after testing. No automatic top-up or plan purchase.

## Pending production acceptance

Raffle site cmvnqslxj000008lb33zuq9qh was already created once. Reuse it and its three site-only FAQ, do not recreate. After deploying the method and cap UI, verify the existing pending host using header, publish only this exact public host, enforce a bounded cap, test allowed/foreign origins and frame CSP, then one short Soniox/text probe within the approved $0.70 total (including the ten persona-gate checks). No client repository integration in this chat. Physical iOS/Android/Telegram microphone acceptance is separate. UI remains RU/UK/EN with explicit en fallback for other Raffle locales.
