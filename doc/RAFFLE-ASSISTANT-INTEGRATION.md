# Raffle Market assistant integration — 2026-10-25

Scope: one separate site, exact https://raffle-fe-next.vercel.app:443. Raffle repository, other customers, Nova and accepted builds are unchanged.

## Hosted Vercel proof

`header` ownership method is limited to a single-label project host under vercel.app. Configure a project-level response header `x-v4c-verify: <this account verification token>` on GET / with an exact Host condition using the authenticated Vercel project CDN Routing UI. The verifier fetches that precise HTTPS origin with the existing DNS-pinned SSRF-safe transport, refuses cross-origin redirects and requires the exact account token. No wildcard or domain inheritance. Other public platforms remain DNS-only. Missing header is a definitive failure; outages are inconclusive. Existing 90-day expiry and daily recheck/revocation semantics apply; rechecks preserve the header method. Removing the project rule revokes verification through the regular recheck and grace mechanism.

Vercel project routing rules do not require a new deployment: https://vercel.com/docs/routing/project-routing-rules. The public verification token is not an API credential. Do not put provider keys in this header. Domain verification establishes site control only; it never grants payment/wallet automation.

## Site caps

Internal operator `PATCH /internal/admin/assist/sites/:siteId` accepts `voiceDailyCapUsd` (finite number 0–1000 or null); the account view includes this field. Stored as integer microdollars on only the requested `assist_sites` row, audited `site:voice-cap`; no subscription edits. Admin → Помощник сайтов → Кабинеты и сайты → selected account has separate site chat/voice cap fields. Zero denies spending, empty uses plan default. Caps reset daily UTC and are NOT lifetime test allowances. For the approved $0.70 total experiment, set a smaller daily ceiling, run bounded probes, reconcile usage and switch voice off/zero after testing. No automatic top-up or plan purchase.

## Production acceptance — completed 25.10.2026

Reuse site `cmvnqslxj000008lb33zuq9qh` and public key `pk_live_WP7uhdoB5eWOhcZwSbxWQ0Et`. Loader: https://assist-w.viral4creators.app/v1/loader.js. Exact host is verified until 2027-01-23; persona and widget version1 are published with the three site-only FAQ. Public display is limited to `/`, `/about`, `/raffle-rules`, `/privacy`, `/terms`, `/returns`; financial/private routes are excluded. Voice control remains off.

Production: exact parent accepted; unrelated host, suffix-spoof, non-default port and admin origin denied403; iframe CSP contains only the exact Raffle ancestor. Correct STT, grounded English TON Testnet answer, MP3 TTS and replay of the same initial request passed. The source recording was synthetic macOS Samantha speech, not a physical microphone. Two STT and two TTS calls were made; the first wrong-language fixture was not accepted as a quality pass. Provider keys were valid at test time; no plan/key purchases and no claim about future provider balance.

Fixed in PR70–73: supported Vercel proof and per-site spend controls; publication-specific timeout without retries and invariant failure reason; explicit page-AI-instruction execution rejected before retrieval/model/billing; initial request identity atomically scoped to account/site/visitor/request ID, with concurrent creation protection. No schema migration. Final main CI69642627: 536 suites, 5,663 tests passed,3 tests skipped. The retry/race also passed on a disposable local PostgreSQL16 under the real public role.

Platform-ledger cost is $0.09243 of the approved cumulative $0.70 (not a reconciled provider invoice). Final chat and voice daily caps are both0. A new STT request returns429 VOICE_LIMIT; all three synthetic conversations of the probe visitor were deleted and its local token removed. Other site caps are unchanged. Set an agreed ongoing quota before enabling real traffic; daily caps are not a lifetime spending allowance.

Client integration remains disabled in the separate Raffle repository and was not edited here. UI languages ru/uk/en; fallback en only for the assistant. `data-lang` is construction-time: destroy/remove/remount on explicit subsequent opening after locale changes. Supported API: open/close/toggle/ask/position/hide/show/on/route/destroy/preview. Do not use identify/context or expose authorization/wallet/history/form values. Destroy before private navigation or wallet/payment confirmations. No autonomous financial actions.

Keep CSP and add https://assist-w.viral4creators.app to script-src/frame-src/connect-src and applicable image sources. Preserve nonce/strict-dynamic, without adding unsafe-inline. Microphone delegation: `Permissions-Policy: microphone=(self "https://assist-w.viral4creators.app")`; loader iframe uses `allow="microphone"`. Every enclosing iframe must delegate; browser permission still requires a user gesture.

Remaining acceptance: actual Raffle embedding/mobile overlap and physical iOS/Android/Telegram microphone, Stop/close, permission revocation, Bluetooth and calls. API/synthetic/browser-mock results are not hardware acceptance. Nova, accepted media and other client configuration are unchanged.

## Supervised frontend test — follow-up 25.10.2026

User explicitly lifted the no-edit boundary for a temporary test only. Raffle commit 1df00ff is deployed and Vercel status is successful. Public enabled remains false; `?assistant-test=1` exposes a user-click button until 2026-10-26 00:00 UTC. This is discoverability, not authentication. Server-side spend caps bound the supervised test and were restored to zero. 48 suites / 406 tests and production build passed.

In the actual production Raffle page, verified no pre-click widget resources, English grounded TON Testnet answer, read-aloud control and Stop return to idle, close, financial-route removal, and no widget on ordinary visits. Mobile viewport390×844 checked; no physical microphone recording or device/speaker quality claim. Correct microphone Permissions-Policy is served. Public config can cache lead_only/active for300seconds after caps change; server-side caps still enforce spend. Cumulative ledger is now $0.100822/$0.70, final chat/voice caps0, other site caps unchanged. See frontend-acceptance.json.
