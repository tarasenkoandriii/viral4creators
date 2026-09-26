# viral4creators - UGC Advertisement Video Generator

An AI-powered application that analyzes successful UGC (User-Generated Content) advertisement videos and generates new promotional videos for your products based on the same style and techniques.

## Overview

viral4creators allows marketers to upload a reference UGC advertisement video, extracts key insights using AI (visual style, messaging tone, pacing, engagement techniques), and then generates a brand-new advertisement video for their product while maintaining the successful elements of the original.

**[Watch Demo on YouTube](https://youtu.be/Ylw-e1AayGE)**

**Built with [GitHub Spec Kit](https://github.com/github/spec-kit)**

## Features

- **Video Upload & Analysis**: Upload UGC advertisement videos (MP4, MOV, AVI up to 100MB) and get AI-powered analysis of visual style, messaging, pacing, and engagement techniques
- **Product Customization**: Input your product details (name, description, image) to personalize the generated advertisement
- **AI Prompt Generation**: Automatically generate and moderate text-to-video prompts combining insights from the original video with your product information
- **Video Generation**: Create new advertisement videos using Google Veo 3.1
- **Side-by-Side Comparison**: View original and generated videos together to compare results
- **Cloud Storage**: All videos and assets are stored in Vercel Blob
- **Telegram Mini App**: The frontend also works as a Telegram Mini App — Telegram login inside Telegram, the same anonymous browser flow as before outside it, plus an optional "Log in with Telegram" button for the ordinary browser flow too (see `doc/TELEGRAM-ADMIN.md`)
- **Admin Panel**: Session list, basic telemetry, env-settings check, **users** (service mode, operator rights and blocking, with activity counts and per-user AI spend — an operator cannot strip their own rights or block themselves), **AI cost accounting** (every paid call to Gemini / GPT-5 / Veo / SerpApi / YouTube is logged with tokens, seconds and money; totals, breakdowns, daily caps and the pricing table live on the Costs tab, `doc/PRODUCT-PROJECT-SPEC.md` §26), the **publication moderation queue** and **analysis-library moderation** (hide with a reason / make public or author-only / fix the category / delete), gated behind Telegram login (`admin/`)
- **Projects & products** (`doc/PRODUCT-PROJECT-SPEC.md`): a persistent catalog per Telegram user — Project (single product or a product line, country → currency) → ProductItem with photo, auto-detected category and market analogs/prices via SerpApi Google Lens, voice-dictated description (Gemini transcription), price. A generation Session is started from an item and carries a **snapshot** of it.
- **Brand Manifest**: brand-wide style notes, voice-over notes, filters/effects, brand characters and permanent brand scenes (with photos) — attached to projects, copied into each session and editable per video without touching the manifest
- **Reference video search**: YouTube Data API search tab (sortable table, per-user daily cap) next to the existing link / upload options
- **Analysis library**: every Gemini breakdown is stored once per source (`yt:<id>` / file hash) — the same reference is never analysed twice, and stored analyses become a third way to pick a scenario, ranked against the product's audience and category. An analysis of an uploaded file stays private to its author; operators moderate the rest (`doc/PRODUCT-PROJECT-SPEC.md` §21)
- **Terms & offer**: a public-offer agreement and terms of use (`doc/legal/`), accepted before the first analysis — they are what makes one shared library legitimate: the analyses belong to the service, the product materials and the finished video belong to the user
- **Daily spend caps**: a per-plan money ceiling on paid calls, plus one shared ceiling for all anonymous traffic — without the shared one, logging out would be enough to bypass the personal one. The user never sees dollars: the app says "the daily limit is used up, it resets tomorrow", and warns before it runs out (`doc/PRODUCT-PROJECT-SPEC.md` §26.4)
- **Service modes**: Lite (default) / Standard / Premium — one capability matrix (`backend/src/common/plans.ts`) that the server enforces and the UI reads over `GET /api/me/plan`, so a locked feature is shown with what unlocks it rather than hidden. All three modes are **free for now** (`doc/PRODUCT-PROJECT-SPEC.md` §23)
- **Storage hygiene**: every blob has exactly one owner in the DB, and deleting the owner deletes the file; two daily crons — expired sessions with their files, then an orphan sweeper with a per-kind breakdown in the log (`doc/STORAGE-AUDIT.md`)
- **Readable failures**: a database connection error is logged as a diagnosis plus a "what to do" line, with the target as `host:port/db` and never the credentials (`doc/PRODUCT-PROJECT-SPEC.md` §24)
- **Scenes & extras**: scene and background-crowd chips work like the character ones — click to highlight the matching lines of the breakdown, drop what should not appear in the clone
- **Audience fit**: Gemini reads the product's target audience from its photo and the reference video's audience + what it sells; a separate relevance call scores the match, explains it and feeds concrete adjustments into the prompt brief (AUDIENCE FIT)
- **Characters & references**: Gemini lists the people in the reference video (with preview frames grabbed from the uploaded file); keep/drop them, swap in your own photo, text or a brand character; pick which images (characters, your own scene photos, the brand's permanent scenes, the product) fill Veo's three `referenceImages` slots — everything else is described in the prompt
- **Voice-over language & brand voice**: dialogue language chosen per session (defaults from the market or the description's script), lines built from the product description, brand voice notes in the prompt
- **Picture format**: reference frame auto-detected (file metadata or Gemini), output ratio chosen from standard presets or a custom W:H. Veo renders 16:9 / 9:16 natively; any other ratio is composed for a centre crop and then actually cropped by a hosted FFmpeg service after the render — the native cut stays available for comparison (`doc/PRODUCT-PROJECT-SPEC.md` §16.1)
- **Post-generation audit**: Gemini checks the result for generation artefacts and proposes a revised prompt; one-click regenerate; manual "point out the problem" path; soft iteration cap
- **Acceptance**: what to verify on a real stand with real keys — `doc/ACCEPTANCE-CHECKLIST.md`
- **Publication queue**: "Publish" files a request for operator moderation (approve / reject with reason) — channel uploads (OAuth) are a separate spec, `doc/PUBLISHING-AND-VOICEOVER-SPEC.md`
- **Multi-language**: the TMA UI and the AI-generated product output (prompt, audience fit, etc.) follow the user's language, not just the interface chrome (`doc/PRODUCT-PROJECT-SPEC.md` §35, §37, §39)
- **Blog**: AI-drafted posts with an xAI Grok Batch translation queue, a public showcase with moderation, and RSS/`sitemap-news` promotion (§36, §38)
- **Public video page & fork loop**: a shareable public page per generated video, with a one-click "make one like this" path back into the product flow (§40)
- **Payments**: Telegram Stars and WayForPay subscriptions plus one-off credit packs, with automatic renewal/backoff and downgrade on repeated failure (§41)
- **Marketing broadcast**: an opt-in Telegram channel curating successful generated videos, consent tracked per user and withdrawn automatically on a bot block (§42)
- **YouTube/TikTok publishing**: OAuth-connected channels, moderated upload queue with backoff (`doc/PUBLISHING-AND-VOICEOVER-SPEC.md`, part of the publication queue above)
- **Catalog batch generation**: generate the same style of video for every product in a line in one pass, with per-item progress, retry, and resumable workers (§44)
- **A/B variants**: multiple text/voice-over variants of one video from a single GPT-5 call, rendered and compared side by side (§45)
- **Hardcoded subtitles**: brand-styled burned-in captions with auto-timing from the voice-over track, or a heuristic fallback (§46)
- **Product feed import**: point at a seller's own YML/CSV feed URL and import a whole catalog line at once, with SSRF-safe fetching and a size-limited stream (§47)
- **Admin "Cron" tab**: a registry of every scheduled job with manual run + debug mode and a history of both real Vercel Cron runs and manual ones (`doc/PRODUCT-PROJECT-SPEC.md` §69)
- **Second TTS provider**: Resemble AI alongside ElevenLabs, switchable per deployment, plus self-service voice cloning for subscribers (`doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md`)
- **Talking AI-avatar pilot**: an operator-only pipeline (Hedra Character-3 + Resemble AI) for a lip-synced speaking avatar, separate from the Veo path (`doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md`)
- **Multi-format autoexport**: turn one finished video into several platform-ready formats — a cheap batched crop (one ffmpeg job, one charge) for formats in the same frame family as the render, or an explicit paid Veo re-render for a different family; publication requests (§14) now pick the matching completed export instead of always shipping whatever file happens to be on the session (`doc/MULTI-FORMAT-EXPORT-SPEC.md`)

## Tech Stack

### Backend
- **Framework**: NestJS (Node.js/TypeScript)
- **Video Analysis**: Google Gemini 2.5 Flash API
- **Text Generation**: OpenAI GPT-5 (via Laozhang API)
- **Video Generation**: Google Veo 3.1 (via Gemini API)
- **Storage**: Vercel Blob with presigned URLs (one provider for the reference video, the product image, and the generated video — see `doc/VERCEL-READINESS-AUDIT.md`)
- **Auth**: Optional Telegram login (initData validation + dev-login bypass for local Docker) — see `doc/TELEGRAM-ADMIN.md`; the ordinary anonymous flow is unaffected when Telegram isn't involved
- **Architecture**: Modular structure — analysis, generation, prompt, product, storage, sessions, video, telegram-auth, telegram-login, admin-auth, admin-panel, project, product-analog (SerpApi), voice (Gemini transcription), reference (countries), brand-manifest, project-session, youtube-search, casting, video-audit, publication, reference-assets, relevance, library, legal, plan (service modes + spend gate), ai-usage (cost ledger), tts (ElevenLabs voices and preview), postprod (hosted FFmpeg: crop + voice-over in one pass), notify (Telegram alert/stats channels), grok (xAI Batch translation), blog, shared-video (public video page + fork loop), publishing-channel (YouTube/TikTok OAuth), publishing (upload workers + backoff), cron (session/blob cleanup, orphan sweep, blog, publish), health

### Frontend (TMA)
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: TailwindCSS
- **State Management**: Custom hooks (`useWorkflow`)
- **API Client**: Axios
- Also works as a Telegram Mini App (see `doc/TELEGRAM-ADMIN.md`) — same codebase, no separate app

### Admin panel (`admin/`) and landing (`landing/`)
- **Framework**: Next.js 14, App Router
- `admin/`: seven tabs — sessions, publication moderation, analysis-library moderation, users (service mode, operator rights, blocking), AI costs, telemetry, env-settings check; Telegram Login Widget (+ dev-login for local Docker), httpOnly cookie session
- `landing/`: static marketing page, no backend calls

### Infrastructure
- Session-based workflow management (Telegram login optional, not required —
  see `doc/TELEGRAM-ADMIN.md`), persisted in Supabase Postgres via Prisma
  (survives across serverless Function instances — see `doc/PRISMA-SUPABASE.md`)
- RESTful API with modular controllers
- Direct-to-storage file uploads via presigned Vercel Blob URLs — video/image
  bytes never pass through the API's request body
- Environment-based configuration

## Project Structure

```
viral4creators/
├── backend/              # NestJS API server
│   └── src/
│       ├── modules/      # Feature modules
│       │   ├── analysis/       # Video analysis with Gemini
│       │   ├── generation/     # Video generation orchestration
│       │   ├── prompt/         # Prompt generation & moderation
│       │   ├── product/        # Product information management
│       │   ├── sessions/       # Session state management
│       │   ├── storage/        # Vercel Blob integration
│       │   ├── video/          # Video upload handling
│       │   ├── telegram-auth/  # Telegram identification (TMA, optional)
│       │   ├── admin-auth/     # Admin login (Telegram Login Widget + dev-login)
│       │   ├── admin-panel/    # Admin session list + telemetry API
│       │   ├── library/        # Analysis library: cache, recommendations, moderation
│       │   ├── legal/          # Offer / terms acceptance
│       │   ├── plan/           # Service modes + the one paid-call gate
│       │   ├── ai-usage/        # Cost ledger for every paid call
│       │   ├── postprod/        # Hosted FFmpeg: crop + voice-over, one pass
│       │   ├── cron/           # Session + blob cleanup, orphan sweeper
│       │   └── …               # 31 modules in total — see the Architecture list above
│       ├── common/       # Shared utilities & types
│       └── config/       # Configuration management
├── frontend/             # React SPA — also the Telegram Mini App (TMA)
│   └── src/
│       ├── components/   # UI components
│       ├── hooks/        # Custom React hooks
│       ├── lib/          # Telegram WebApp wrapper (telegram.ts)
│       ├── services/     # API client
│       └── types/        # TypeScript definitions
├── admin/                # Admin panel — Next.js 14
│   └── src/
│       ├── app/           # login, sessions, sessions/[id], publications,
│       │                  # library, users, costs, telemetry, settings
│       ├── components/    # AdminNav
│       └── lib/           # API client, auth context
├── landing/              # Marketing landing — Next.js 14, static
├── scripts/              # Utility scripts (e.g. sync-legal.mjs — legal docs
│                         # → landing/TMA) and their output directory
├── doc/                  # All supplementary documentation (deployment,
│                         # local dev, Supabase/Prisma, audit, Telegram/admin)
└── specs/               # Spec-First development docs
    └── 001-ugc-video-generator/
```

## Getting Started

### Prerequisites
- Node.js 18+
- A Vercel Blob store (all file storage — reference video, product image,
  generated video)
- A Supabase project (Postgres) — see `doc/PRISMA-SUPABASE.md`
- API keys for:
  - Google Gemini API (video analysis + Veo 3.1 video generation)
  - Laozhang API (GPT-5 text-prompt generation)
- A Telegram bot token (only needed for Telegram login — the TMA and the
  admin panel both work locally via dev-login without one; see
  `doc/TELEGRAM-ADMIN.md`)

### Installation

> This section is the quick manual path (backend + frontend only, no
> Telegram/admin/landing). For every local setup option — Docker Compose
> (base or full Telegram stand) vs. native, all 4 apps, and which API
> keys are actually required — see [`doc/LOCAL-DEVELOPMENT.md`](doc/LOCAL-DEVELOPMENT.md).

1. Clone the repository:
```bash
git clone https://github.com/IuriiD/viral4creators.git
cd viral4creators
```

2. Install dependencies (there is no root package — each app installs its own):
```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install

# Install admin dependencies
cd ../admin
npm install

# Install landing dependencies
cd ../landing
npm install
```

3. Configure environment variables:
```bash
# Backend: create backend/.env
cp backend/.env.example backend/.env
# Add your API keys and Vercel Blob credentials

# Frontend: create frontend/.env
cp frontend/.env.example frontend/.env
# Configure API endpoint

# Admin: create admin/.env
cp admin/.env.example admin/.env

# Landing: create landing/.env
cp landing/.env.example landing/.env
```

For the full Telegram-login stand (backend + frontend/TMA + admin +
landing, all wired together with dev-login) it's easier to use
`make up` (Docker) instead of the manual steps above — see
`doc/TELEGRAM-ADMIN.md`.

4. Start the development servers:
```bash
# Terminal 1: Start backend (port 3000)
cd backend
npm run start:dev

# Terminal 2: Start frontend (port 5173)
cd frontend
npm run dev
```

5. Open http://localhost:5173 in your browser

## Workflow

The quick anonymous path is still just "reference in → video out". With a
Telegram login and a project it becomes:

0. **Pick a mode** (or keep the default Lite) — `#/plan` says what each one does
1. **Project & product**: create a project (country → currency), add the product —
   photo (category, target audience and market analogs are detected from it),
   description typed or dictated, price
2. **Accept the offer** once — the analysis it is about to create belongs to the service
3. **Pick a reference**: a ready analysis from the library (no AI call at all),
   YouTube search, a link, or a file
4. **Analyse**: scenes with timecodes, characters, background extras, picture
   format, plus who the reference speaks to and what it sells
5. **Cast and filter**: keep/drop characters, scenes and extras — a click
   highlights the matching lines of the breakdown; swap a character for your
   photo, a text description or a brand character
6. **Check relevance**: does this reference fit the product's audience — score,
   reasoning, concrete adjustments
7. **Prompt**: GPT-5 writes it from the analysis, the product, the brand manifest,
   the voice-over language and the audience-fit advice; review and approve
8. **Choose the frame and the reference images**: aspect ratio and which three
   pictures Veo actually receives
9. **Generate**, then optionally **audit** the result for artefacts and regenerate
10. **Download** or file a **publication request** for operator moderation

## API Documentation

`doc/API.md` is the current, complete route list (427 routes in 77 controller files; CI checks the count). The older
[specs/001-ugc-video-generator/contracts/openapi.yaml](specs/001-ugc-video-generator/contracts/openapi.yaml)
covers only the ten routes of the first milestone and is kept as history.
The external API for integrators (`/v1`, Premium) has its own machine-
readable description in [doc/openapi-v1.json](doc/openapi-v1.json) and a
separate limits document in [doc/API-LIMITS.md](doc/API-LIMITS.md);
`check-docs` fails if a `/v1` route exists in one and not the other.

## CI

`.github/workflows/ci.yml` runs on every push: backend (Prisma client,
migrations against a real Postgres 16, **`prisma migrate diff`** to catch
a hand-written migration drifting from the schema, types, lint, 5043
tests with per-file coverage thresholds), frontend (types, lint, 41 unit
scripts, build), admin and landing
(types + lint + build), `npm audit --audit-level=high` in every job
(advisory for now), plus the legal-text sync check and a script that
verifies the numbers quoted in `doc/` still match the code — including
that every environment variable the code reads is described in
`doc/DEPLOYMENT.md` or `.env.docker.example`. `make ci` runs the same
locally except the two Prisma steps that need network (`migrate deploy`,
`migrate diff`). See [`doc/CI.md`](doc/CI.md) for what is deliberately
*not* in there.

## Documentation

All supplementary documentation lives in [`doc/`](doc/):

- [`doc/CI.md`](doc/CI.md) — what the pipeline checks and why those
  particular things.
- [`doc/PRODUCT-PROJECT-SPEC.md`](doc/PRODUCT-PROJECT-SPEC.md) — the
  product/technical spec (ТЗ), the source of every decision, by section.
- [`doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`](doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md)
  — the stage-by-stage plan with a "done" block per stage; CI checks its
  numbers.
- [`doc/TODO.md`](doc/TODO.md) — the ranked backlog: audit debt, near-term
  improvements, big directions, roadmap.
- [`doc/AUDIT-2026-09-06.md`](doc/AUDIT-2026-09-06.md),
  [`doc/AUDIT-2026-09-06-round2.md`](doc/AUDIT-2026-09-06-round2.md),
  [`doc/AUDIT-2026-09-07-round3.md`](doc/AUDIT-2026-09-07-round3.md),
  [`doc/AUDIT-2026-09-09-round5.md`](doc/AUDIT-2026-09-09-round5.md) —
  four end-to-end audits; findings are referenced from the plan and TODO
  as А-, Б-, В- and Д- numbers respectively (round 4's findings were
  folded into TODO/SPEC prose rather than saved as their own file — see
  the Д-6.6 note inside round 5).
- [`doc/AVATAR-PIPELINE-AUDIT-2026-09-09.md`](doc/AVATAR-PIPELINE-AUDIT-2026-09-09.md)
  — a focused audit of just the AI-avatar pipeline (stages 72/72а), not
  a repeat of the end-to-end audits above.
- [`doc/ACCEPTANCE-CHECKLIST.md`](doc/ACCEPTANCE-CHECKLIST.md) — what to
  verify by hand on a stand with real keys, in dependency order.
- [`doc/TESTER-ACCEPTANCE.md`](doc/TESTER-ACCEPTANCE.md) — the end-to-end
  run for the tester workflow (stages 154–161), written against the
  seams *between* stages rather than the stages themselves. Needs a real
  second Telegram account: half of what it checks does not exist under
  the dev bypass.
- [`doc/PUBLISHING-AND-VOICEOVER-SPEC.md`](doc/PUBLISHING-AND-VOICEOVER-SPEC.md)
  — the publishing and voice-over sub-spec.
- [`doc/MULTI-FORMAT-EXPORT-SPEC.md`](doc/MULTI-FORMAT-EXPORT-SPEC.md) —
  proposal spec for TODO §III item 35 (multi-platform/format export from
  one generation), not yet implemented.
- [`doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md`](doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md)
  — second speech-synthesis provider (Resemble AI, alongside
  ElevenLabs); implemented at stage 70.
- [`doc/AI-ACTORS-NO-REFERENCE-SPEC.md`](doc/AI-ACTORS-NO-REFERENCE-SPEC.md)
  — proposal spec for TODO §III "Уровень 6" (reference-free AI actors and
  content, items 30–34), not yet implemented.
- [`doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md`](doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md)
  — the admin-only talking-AI-avatar pilot (Hedra Character-3 + Resemble
  AI); implemented at stages 72/72а.

- [`doc/LOCAL-DEVELOPMENT.md`](doc/LOCAL-DEVELOPMENT.md) — **start here**:
  how to run everything locally (Docker Compose or native, for all 4 apps),
  which API keys actually matter, and which docs below to read for more depth.
- [`doc/DEPLOYMENT.md`](doc/DEPLOYMENT.md) — deploying to Vercel
  (all four Vercel projects, environment variables, CORS/CSRF for
  Production/Preview; the backend project needs the **Pro** plan as of
  stage 61 — see that doc's intro).
- [`doc/VERCEL-READINESS-AUDIT.md`](doc/VERCEL-READINESS-AUDIT.md) — the
  readiness audit this deployment setup is based on.
- [`doc/DATABASE-AUDIT.md`](doc/DATABASE-AUDIT.md) — a DB-focused audit
  of every table/model and hand-written migration, verified by actually
  applying them to a real local Postgres 16 instance.
- [`doc/LANDING-ILLUSTRATIONS-BRIEF.md`](doc/LANDING-ILLUSTRATIONS-BRIEF.md) —
  spec for the landing page's illustrations (hero, feature icons, demo
  poster, OG image), including the deliberately clickbait-style hero brief.
- [`doc/API.md`](doc/API.md) — every HTTP route the backend serves, grouped
  by module, with who may call it.
- [`doc/STORAGE-AUDIT.md`](doc/STORAGE-AUDIT.md) — every blob path, its owner
  and what deletes it; session cleanup and the orphan sweeper.
- [`doc/legal/`](doc/legal/) — the public-offer agreement and the terms of use
  (single source; `scripts/sync-legal.mjs` publishes them to landing and TMA).
- [`doc/DOCKER.md`](doc/DOCKER.md) — local development via docker-compose.
- [`doc/PRISMA-SUPABASE.md`](doc/PRISMA-SUPABASE.md) — session persistence
  (Supabase Postgres via Prisma).
- [`doc/TELEGRAM-ADMIN.md`](doc/TELEGRAM-ADMIN.md) — Telegram login (TMA +
  admin dev-login), the admin panel, and the landing page: local Docker
  stand, how the two dev-logins work, and `isOperator` setup in production.

## Development

- **Backend tests**: `cd backend && npm test` (Jest)
- **Frontend unit scripts**: `cd frontend && npx tsx scripts/<name>.test.ts` —
  plain Node assertions over the pure helpers (router, aspect-ratio, casting,
  voice-over, audience, highlight, frame capture, legal markdown, …)
- **Legal docs**: after editing `doc/legal/*.md` run `node scripts/sync-legal.mjs`
  (`--check` in CI) to regenerate the copies used by the landing and the TMA
- **Tutorial-landing OG cards**: after editing `hero.title`/`hero.badge` in
  `landing/src/dictionaries/*.json` run `node scripts/og-tutorial-cards.mjs`
  and commit the regenerated `landing/public/og/tutorial-*.jpg` together with
  `scripts/assets/og-tutorial-cards.lock.json`. CI (`check-docs`, seam 16)
  fails when the cards were drawn from older text — that drift is invisible on
  the page itself, it only shows in link previews. Needs a headless Chromium
  (`CHROME_PATH` if not auto-detected) plus ImageMagick or ffmpeg; no npm
  dependency.
- **Tutorial-landing real frames**: the four screenshots in the "how it looks"
  section are captured on production — see `doc/TUTORIAL-FRAMES-CAPTURE.md`.
  Pictures, their `alt` and the caveat under the heading all switch off one
  list (`REAL_FRAME_LOCALES` in `landing/src/lib/tutorial-frames.ts`), so the
  page can never show real frames under a caption that calls them diagrams.
  `check-docs` seam 17 refuses a locale declared without its files, and files
  dropped in without the locale.
- **Linting**: `npm run lint` in respective directories
- **Formatting**: `npm run format` in respective directories
- **API reference**: [`doc/API.md`](doc/API.md) — every route the backend serves

## License

UNLICENSED - Private project

## Contributing

This project follows spec-first development practices. See [specs/001-ugc-video-generator/](specs/001-ugc-video-generator/) for detailed specifications and development plans.
