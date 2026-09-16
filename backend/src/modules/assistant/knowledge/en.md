# viral4creators AI consultant knowledge base

_Собрано автоматически 2026-09-16 из lending/frontend/backend; коммит — local._

## Mini-app sections

- **Projects** — A product or line for which ads are generated
- **Brand** — A single style and characters for all of a brand's projects
- **Production** — the generation wizard — from choosing a reference to a finished video (see the tutorial steps below)
- **Postprod** — All your finished videos: re-voice, export, publish and share.

## Tutorial steps

### 1. Add a product
A project and a product: a photo (used to determine category, target audience and comparable prices), a description as text or voice, and a price. The quick path without a project also works — then the product is described right inside the wizard.

### 2. Pick a reference
Four ways: search YouTube, paste a link, upload your own file up to 100MB, or — on the Premium plan — a ready-made breakdown from the service's library, instant and with no new AI call.
(available from plan: Premium)
- A library of ready-made breakdowns — no new AI call (Premium)
- YouTube search — sign-in required
- A YouTube link or your own file up to 100MB

### 3. AI breaks down the video
Gemini extracts timestamped scenes, cast and extras, visual style, pacing and aspect ratio — and assesses who the video is aimed at and what it's selling.
- Nothing to enter — the AI shows you the scene-by-scene breakdown on its own

### 4. Check relevance
A separate check compares the video's audience with your product's buyers: a score, the reasoning behind it, and concrete edits — whether cloning this reference is even worth it.
(available from plan: Standard+)
- "Use in generation" checkbox — adds the suggestion to the prompt
- "Check again" button — a fresh relevance check
- "Pick another reference" button — back to step 2

### 5. Assemble the shot list
Remove unwanted characters, scenes and extras — clicking any of them highlights the relevant lines of the breakdown. A character can be swapped for your own photo, a description, or a brand character.
(available from plan: Standard+)
- Click a character — turn it on or off in the video
- Replace a character: keep as-is, your own photo (Standard+), a text description, or a brand character
- Click a scene or extras group — turn it on or off in frame
- Voice, subtitles and camera movement — from the brand manifest (for products with a project)

### 6. Get the prompt
GPT-5 assembles a text-to-video prompt from the breakdown, the product, the brand manifest, the voice-over language and the relevance suggestions. The prompt can be edited by hand.
- "Generate prompt" button — a ready text built from the breakdown and the product
- The prompt can be edited by hand before saving
- A separate voice-over script field — when a custom voice is selected

### 7. Choose the format and reference images
Aspect ratio — 16:9 and 9:16 on any plan, plus 3:4, 1:1 or a custom one from Standard up — and which three images the model will get as references: characters, your scenes, brand scenes, product photo. Everything else goes into the prompt as text.
(available from plan: Standard+)
- Render quality: "Fast" or "Cinematic" (Standard+)
- Up to three reference images for the generation engine — your own scenes and photos (Standard+)
- Aspect ratio: 16:9 and 9:16 on any plan, the rest from Standard up

### 8. Generate the video
Grok or Google Veo 3.1 renders the new ad video — pick the engine and render quality, faster or more cinematic.
- A product photo is required — the generate button stays hidden without it
- "Generate the ad video" button
- On failure — "Generate again"

### 9. Review the result
A separate artifact check will propose a fixed prompt for a re-generation. For a product from a project, a batch run for the whole line and three A/B hook variants are right there. The finished video is a direct file link, then an “Open in Postprod” button.
(available from plan: Standard+)
- Artifact check and sound check (Standard+)
- A batch run for a whole product line, and 3 A/B variants (Premium, products with a project only)
- An “Open in Postprod” button — the same video, alongside all your other ones

### 10. Manage it in Postprod
A separate Postprod tab with all your finished videos, not just the latest one. Change the script and the voice — with an explicit synthesis provider and an honest pre-listen before you pay — without a new render. Export to several platforms and publish with a shareable page.
(available from plan: Standard+)
- Re-voice without a new render — only the audio, subtitles and script change (Standard+)
- Voice synthesis provider — ElevenLabs or Resemble explicitly, or “as is”
- Pre-listen to the exact text, voice and provider combination — before paying for the re-voice
- Export to several platforms at once — no extra render charge (Standard+)
- Publication and a shareable page (Standard+, sign-in required)

## Frequently asked questions

**Do I need to sign up?**
No. The session is anonymous and created automatically on your first visit — you only need to accept the public offer and terms of use once, before your first breakdown. Signing in through Telegram is available but optional: it's needed for projects, the product catalog, the brand manifest, and to come back to your sessions later.

**Which video formats are supported?**
MP4, MOV and AVI up to 100MB, or simply a link to a public YouTube video — in which case there's nothing to download or upload at all.

**How long does video generation take?**
Once the prompt is approved, the video is usually ready in 3–5 minutes — the exact time depends on the chosen generation engine (Grok by default, Google Veo 3.1 with Fast/Standard modes is also available) and current load.

**How much does it cost?**
Right now, nothing: all three plans — Lite, Standard and Premium — are free and switch right inside the app. This is a rollout period; whatever you've already made stays yours once paid plans arrive. Later, Lite is planned to become conditionally free — in exchange for liking the project's YouTube channel and sending a few links to the service.

**What's the difference between the plans?**
Lite is the minimal path: reference breakdown and video generation in 16:9 or 9:16. Standard adds a relevance check, a video artifact audit, a brand manifest, your own scenes, photo character swap, any aspect ratio, and publishing. Premium is Standard plus the library of ready-made breakdowns. You can switch plans at any time without affecting projects, videos or breakdowns you've already made.

**Where are my files stored, and when are they deleted?**
In Vercel Blob — the reference, product photos and the finished video all live in the same storage. Every file has an owner in the database: an expired session takes its files with it, a deleted product takes its photo, a deleted manifest takes its character and scene photos. Cleanup runs daily, and a separate pass picks up orphaned files.

**Who owns the breakdowns and the finished videos?**
The service creates the reference breakdown, and under the terms of use the breakdowns belong to it — that's exactly what lets the library offer them to other users. Your product, your uploaded materials and the generated video remain yours. Breakdowns of videos uploaded as a file are private: only the author sees them.

**Can I use it from Telegram?**
Yes — the same product works both as a regular website in a browser and as a Telegram Mini App inside Telegram, with the same set of features.

**Can I manually edit the video breakdown or the prompt?**
Yes, at both steps: after the automatic reference analysis and after the automatic prompt generation, both results can be edited before moving on.

**Is this an open-source project?**
Yes — the source code is available on GitHub, and development followed the GitHub Spec Kit methodology.

## Plans and features

All plans are currently free and switched by the user themselves in the mini-app (this is a temporary trial period, billing is not enabled yet).

### Lite
Разбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.
16:9/9:16 only

### Standard
Весь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.
Reference relevance scoring, Audit of a finished video, Publishing through the service, Brand manifest, Your own scenes and reference slots, Photo character replacement, Any aspect ratio, Full Veo model, Clone your own voice
any aspect ratio

### Premium
Всё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.
Library of ready-made breakdowns, Reference relevance scoring, Audit of a finished video, Publishing through the service, Brand manifest, Your own scenes and reference slots, Photo character replacement, Any aspect ratio, Full Veo model, Clone your own voice, Dub (full replacement of the model's voice)
any aspect ratio

## Pipeline rules

Veo: до 8 секунд за вызов, до 7 вызовов, максимум 56 секунд суммарно.
Grok: базовый ролик до 15 секунд плюс одно расширение до 10 секунд, максимум 25 секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.
Референс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.
Озвучка — три режима: Голос Veo, Свой голос поверх, Свой голос вместо; по умолчанию — «Свой голос поверх».
Форматы кадра: 16:9 и 9:16 доступны на всех тарифах; остальные — от Standard.
Фото товара — до 10 МБ.

## Wizard field hints

**Загрузка референса**: A successful UGC ad we'll clone for your product — grab a ready-made breakdown from the library, find a video on YouTube, paste a link, or upload a file.

**Файл референса**: MP4, MOV, AVI · up to 100 MB

**Референс — файл слишком большой**: The video is larger than 100 MB.

**Манифест бренда — голос**: Voice character, pace, manner — goes into the prompt; the line language is set on the “Product” step.

**Манифест бренда — по умолчанию**: Copy for this clip: adjust the style for this specific generation — the manifest itself doesn't change.

**Клонирование голоса — лимит**: Reached the limit of {{max}} voices — delete one to clone a new one.

## Additional notes

<!-- Manual knowledge layer (spec §5.2, item 6) — English translation. -->

## Choosing a good reference

Any ad or review video works, as long as it shows pacing, editing and
delivery — it does not need to feature the same kind of product. The
analysis extracts structure (scenes, cast, style, aspect ratio), it does
not transplant someone else's product onto the screen: you add your own
product and photo at step 5, even if the reference was about sneakers
and your product is cosmetics. A poor reference is one with almost no
action (a static talking head for ten minutes) or one where the analysis
clearly can't find what is being sold (no product in frame at all).

## If a render fails

The video is automatically marked as failed, the reason is shown in the
interface, and a "Retry" button is usually available — a new attempt
with the same settings. If a video keeps failing for the same reason,
the issue is likely the reference itself or the frame composition (too
long a scene chain, an unusual aspect ratio), not a transient error —
simplifying the frame composition at step 5 and re-running the analysis
is worth trying first.

## Veo vs. Grok in practice

Veo is the primary engine, up to 56 seconds total (8 seconds per call,
up to seven calls), consistently higher quality, generation usually
takes a few minutes. Grok is the alternative engine, up to 25 seconds
(a 15-second base clip plus one extension of up to 10 seconds),
resolution up to 1080p (capped at 720p when reference images or an
extension are used) — usually a bit cheaper with a different visual
character. Which engine is used for a given session is decided by the
wizard and the brand settings — the consultant does not switch engines
itself.

## Positioning

The service is a tool for people who already have (or found) an example
video and want something similar for their own product, without a film
crew or editing from scratch: analyze the reference, then generate a new
video based on the structure of that analysis. It is not a from-scratch
ad builder or a library of ready-made templates — a reference is always
required (found on YouTube, by link, your own file, or — on Premium — an
already-analyzed entry from the library).

## Support and documents

There is no separate support channel besides the service's own Telegram
bot yet (open question for the product owner, spec §12.3) — for
anything the consultant can't answer about the product itself, suggest
opening the mini-app. The terms of use and the offer are at
`/legal/offer` and `/legal/terms-of-use`; the consultant does not quote
them verbatim or give legal guarantees, it points to the document.
