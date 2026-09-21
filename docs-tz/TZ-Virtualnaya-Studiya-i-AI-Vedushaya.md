# ТЗ — Виртуальная студия и ИИ-ведущая (админка)

Версия: 1.4 (живой эфир ограничен BLITZ + согласие продавца) · Проект: viral4creators (Next.js admin / NestJS backend / Prisma)

2026-09-20 · @Someone · правки версии 1.1 — 2026-09-21 · правки версии 1.2 — 2026-09-21 · правки версии 1.3 — 2026-09-21 · правки версии 1.4 — 2026-09-21

> **Что изменилось в 1.4.** По прямому запросу: живой эфир (Этап 5/6)
> ограничен только BLITZ-лотами — открытый вопрос §7.3 версии 1.2
> («включать ли эфир только для BLITZ»), до этого момента не решённый,
> теперь закреплён как обязательное условие в `AuctionService.
> assignVirtualStudio()`, не рекомендация. Плюс новое, независимое
> условие: продавец должен явно согласиться на живую трансляцию своего
> лота — `AuctionListing.liveStreamOptIn` (новая колонка, миграция
> `20261206090000_live_auction_opt_in`), чекбокс в
> `CreateAuctionListingDto` тем же приёмом, что уже есть у
> `antiSnipeEnabled` (§7.3). Оба условия проверяются в сервисе, оба
> обязательны одновременно — BLITZ без согласия или согласие на
> STANDARD-лоте одинаково отклоняются. Технической правки в остальных
> параграфах §7 версия 1.4 не вносит.
>
> **Что изменилось в 1.3.** По прямому запросу владельца продукта
> индексация живого эфира через Google Indexing API / `BroadcastEvent`
> — исключённая версией 1.2 (§7.7, §8) как решение с неочевидной
> ценностью — возвращена в объём отдельным §7.8 и Этапом 6 в §9. Решение
> пересмотрено не «просто по запросу»: `AUDIT-Live-Auction-Google-
> Indexing-API.md` (новый файл) разбирает, что эта технология делает
> реально (по документации Google, актуальной на 2026 год, а не по
> памяти) — включая нюанс, которого версия 1.2 не могла знать заранее:
> с сентября 2024 года дефолтная квота API тестовая, реальное
> использование в проде требует отдельного одобрения Google, а получить
> его быстро на команду разработки не влияет. Также разбирается, почему
> наш случай (страница лота — буквально прямая трансляция) — это
> ЗАКОННОЕ применение API по его официально поддерживаемому назначению
> (`BroadcastEvent`), а не то злоупотребление им для обычных страниц, за
> которое рынок в 2024–2026 годах регулярно получает бан домена в
> ручную проверку. Технической правки в §1–§7.7 версия 1.3 не вносит —
> добавляет только §7.8, дополняет §8/§9 отсылками к нему.
>
> **Что изменилось в 1.2.** §9 «Этапы внедрения» полностью
> перегруппирован по прямому запросу — не по техническим зависимостям
> («что от чего требуется»), а по отдаче: что оператор/бизнес получает
> на выходе каждого этапа и какой ценой. Прежняя раскладка сохранена
> ниже как §9.1 «для истории», новая — §9 выше нижнего блока правок.
> Самое заметное следствие перестановки: исправление антиснайпера
> (Этап 0) — маленькая правка на уже работающем и монетизируемом
> аукционе — теперь стоит первым, а не спрятано восьмым пунктом внутри
> самой крупной и рискованной части документа (живой аукцион, теперь
> Этап 5, последний). Технической правки в §1–§8 версия 1.2 не вносит —
> только перестановку и переформулировку плана в §9.
>
> **Что изменилось в 1.1.** Версия 1.0 (приложена целиком ниже, без
> купюр) была написана и, по её собственному §10, трижды проаудирована
> — но каждый из трёх проходов аудита читал только те файлы, которые
> сам же и называл, и ни разу не открывал `backend/src/modules/auction/`
> целиком. При подготовке к реализации этот каталог прочитан построчно
> (`auction.service.ts` — 613 строк, `auction.controller.ts`,
> `auction-ai-assessment.service.ts`, плюс `admin/src/app/auctions/
> page.tsx`) — и обнаружилось, что §7 этого ТЗ построен на неверной
> посылке: механика ставок, модерация оператором и ИИ-оценка лота
> **уже реализованы и работают**, а не «отсутствуют вообще», как
> утверждает §7 (первый абзац) и §7.3 (п.1). Отдельно перепроверены
> `HedraClientService` (§4.2) и обратная связь `BrandManifest`↔`Auction-
> Listing` (§2) — оба тоже оказались не такими, как описано.
>
> Все найденные расхождения — в новом §10.5 ниже, с точными цитатами
> кода. Текст §1–§9 оставлен как есть (это входные данные версии 1.0,
> переписывать их задним числом значило бы прятать, что именно было
> неверно понято) — но там, где утверждение прямо противоречит коду,
> сразу после него добавлена вставка **[ПРАВКА 1.1 — см. §10.5.N]**,
> отсылающая к конкретному пункту нового аудита. Часть плана внедрения
> (§9, шаг 8) физически не может выполняться так, как написана — она
> предполагает `BidService`/`live-auction/`, которых, как выяснилось,
> не должно быть отдельно от уже существующего `AuctionModule`.
>
> Это версия для документации/каталога, не отчёт о выполненной
> реализации — сама реализация (миграция Prisma, модуль
> `virtual-studio`, правки `AuctionModule`, админ-вкладка) этим проходом
> **не выполнялась**, по прямому решению автора задачи (см. финальное
> сообщение сессии): «Просто внести исправления в ТЗ и положить в папку
> документации». §9 «Этапы внедрения» остаётся планом на будущее, не
> списком сделанного.

## 1. Цель и контекст

В SilverFinance (`doc/TZ-Blitz-Auction.md` §6.2–6.3, код `src/lib/server/liveStream.ts`) уже реализован и работает механизм «виртуальной студии»: один раз на лот генерируется референс-кадр (Grok Imagine, image-модель) со сценой «студия + женщина-ведущая», затем все видео-фрагменты анимируются от этого кадра (image-to-video), чтобы студия, ведущая, ракурс и свет не менялись между клипами. Голос — отдельная TTS-дорожка поверх (ElevenLabs), накладывается на замьюченное видео.

Задача этого ТЗ — перенести именно этот приём (генерация референс-кадра → фрагменты видео → отдельная озвучка) в viral4creators, но не как часть живого аукциона (эфир со ставками — это отдельная, более крупная задача, см. §7 «вне объёма»), а как **самостоятельный инструмент админки**: оператор заходит на вкладку, генерирует варианты студии, оставляет понравившийся, удаляет остальные, и готовит из неё отдельные фрагменты — видео и озвучку — впрок, до того как появится модуль, который будет их использовать.

Отличие от SilverFinance по архитектуре: там `studioRefUrl`/`studioVariants` — это колонки на самой сущности `Auction`, студия жёстко привязана к одному лоту. В viral4creators на момент этого ТЗ аукцион (§22 `docs-tz/UGC-маркетплейс — анализ и ТЗ.md`) реализован только слоем данных (`auction_listings`/`auction_bids`/`auction_payments`, миграция `20261125090000_auction_stage1`) — ни бэкенд-сервиса, ни фронтенда, ни admin-страниц под него ещё нет. **[ПРАВКА 1.1 — см. §10.5.1: неверно. `backend/src/modules/auction/` — рабочий модуль с сервисом, тремя контроллерами и ИИ-оценкой; `admin/src/app/auctions/page.tsx` — рабочая страница модерации. Слоем данных дело не ограничилось уже на момент написания версии 1.0.]** Поэтому студия здесь проектируется как **отдельная переиспользуемая сущность** (своя таблица, не колонки на несуществующем пока модуле), которую позже сможет забрать себе любой модуль — будущий аукцион-эфир, промо-ролики или что-то ещё, а не только один конкретный лот.

Три типа фрагментов, которые нужно уметь готовить внутри студии:

1. **Видео-фрагмент** — image-to-video от референс-кадра (по умолчанию Grok Imagine, как в SilverFinance), опционально — Hedra Character-3 (уже есть в проекте как admin-only пилот, `backend/src/modules/actors/`, но для сессий генерации UGC, не для студии; здесь — тот же движок, включаемый флагом).
2. **Голосовой фрагмент** — синтез озвучки под конкретный текст реплики, провайдер и голос выбираются явно в форме, по умолчанию Resemble (в проекте уже есть переключаемый TTS-слой, см. §4).
3. **ИИ-анализ-фрагмент** — не видео и не звук, а текстовый результат: Gemini-анализ видео (и опционально брендбука) по образцу уже существующего `VideoAuditService` (`backend/src/modules/video-audit/`) и запланированных в §22 полей `aiAssessment`/`brandManifestAiAudit` — сводка + черновой сценарий реплики, который потом можно отправить в голосовой фрагмент. **[ПРАВКА 1.1 — см. §10.5.4: `aiAssessment`/`brandManifestAiAudit` не «запланированы», они уже есть в схеме и уже заполняются `AuctionAiAssessmentService`. Правильный образец для этого пункта — этот сервис, не `VideoAuditService` (у которого другие, документированные в его же коде причины не подходить).]**

## 2. Модель данных (Prisma)

Стиль — как у `AuctionListing`/`PortfolioItem`: `id String @id @default(cuid())`, мягкий soft-delete (`deletedAt DateTime?` + индекс, по образцу `Project`/`Session`), русские комментарии `///` над каждым неочевидным полем.

```prisma
enum VirtualStudioFragmentKind {
  VIDEO      // image-to-video от референс-кадра (Grok или, если включено в настройках, Hedra)
  VOICE      // TTS-дорожка под текст реплики (Resemble по умолчанию, ElevenLabs)
  ANALYSIS   // текстовый результат Gemini-анализа видео/брендбука
}

/// Переиспользуемая студия — аналог пары studioRefUrl/studioVariants из
/// SilverFinance (liveStream.ts), но как отдельная сущность, а не колонки на Auction —
/// в viral4creators нет ещё ни лив-аукциона, ни другой сущности, к которой её стоило бы привязывать.
model VirtualStudio {
  id   String @id @default(cuid())
  name String

  /// Промпт референс-кадра по умолчанию (аналог STUDIO_REF_PROMPT из SilverFinance) —
  /// редактируется в админке перед генерацией первого варианта.
  refPrompt String

  /// Выбранный вариант референс-кадра — денормализованная ссылка на VirtualStudioVariant.id,
  /// чтобы удаление выбранного варианта было видно через FK, а не проверкой JSON-списка
  /// (в SilverFinance варианты — JSON-блоб на колонке и без удаления; здесь нужно удаление,
  /// поэтому — отдельная таблица с удаляемыми строками).
  selectedVariantId String?

  status VirtualStudioStatus @default(DRAFT)

  createdBy String // id оператора (admin user)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  deletedAt DateTime?

  variants  VirtualStudioVariant[]
  fragments VirtualStudioFragment[]

  @@index([deletedAt])
  @@map("virtual_studios")
}

enum VirtualStudioStatus {
  DRAFT     // ещё нет выбранного варианта
  READY     // вариант выбран, можно готовить фрагменты
  ARCHIVED  // скрыта из списка активных, но не удалена (история фрагментов сохраняется)
}

/// Один сгенерированный вариант референс-кадра. Своя таблица (не JSON-колонка, как в
/// SilverFinance) — чтобы в админке можно было удалить конкретный вариант одним DELETE, а не перезаписывать весь блоб.
model VirtualStudioVariant {
  id       String @id @default(cuid())
  studioId String
  studio   VirtualStudio @relation(fields: [studioId], references: [id], onDelete: Cascade)

  imageUrl String
  prompt   String // фактически использованный промпт (мог отличаться от studio.refPrompt, если оператор правил перед повторной генерацией)

  createdAt DateTime @default(now())

  @@index([studioId])
  @@map("virtual_studio_variants")
}

/// Один готовый (или готовящийся) фрагмент студии — один из трёх типов из §1.
model VirtualStudioFragment {
  id       String @id @default(cuid())
  studioId String
  studio   VirtualStudio @relation(fields: [studioId], references: [id], onDelete: Cascade)

  /// Для VIDEO — с какого варианта анимирован (image-to-video); для VOICE/ANALYSIS обычно null.
  variantId String?
  variant   VirtualStudioVariant? @relation(fields: [variantId], references: [id], onDelete: SetNull)

  kind     VirtualStudioFragmentKind

  /// Животный статус генерации — НЕ новый энум, а тот же приём, что у Session.status:
  /// String-колонка, валидируемая на уровне приложения уже существующим TS-энумом
  /// GenerationStatus (common/types/generation.types.ts: PENDING/PROCESSING/COMPLETE/FAILED) —
  /// тот самый, который AVATAR-LIPSYNC-PIPELINE-SPEC.md §1.1 прямо называет «достаточно общим,
  /// чтобы переиспользовать без изменений для нового движка». Черновик статуса в SilverFinance
  /// (pending/generating/ready/failed) сюда НЕ переносится — в viral4creators уже есть свой словарь.
  status String @default("pending")

  /// Провайдер: VIDEO → 'grok' | 'hedra'; VOICE → 'resemble' | 'elevenlabs' (те же ключи, что
  /// VoiceoverProviderKey в tts/default-tts-provider.ts); ANALYSIS → 'gemini'.
  provider String

  /// Только для VOICE с provider='resemble'|'elevenlabs' — voiceId из каталога TtsProvider.voices().
  voiceId String?

  /// Текст реплики (VOICE) или видео-промпт (VIDEO); для ANALYSIS — входной вопрос/инструкция анализа.
  text String? @db.Text

  /// Для ANALYSIS — что анализируем: URL видео (свой фрагмент или произвольный ролик из портфолио), и опционально brandManifestId.
  sourceVideoUrl   String?
  brandManifestId  String?
  /// Требует обратную связь на BrandManifest (см. правку ниже) — без неё Prisma
  /// откажет этот relation при `prisma validate` (точно так же, как у BrandManifest.auctionListings).
  brandManifest    BrandManifest? @relation(fields: [brandManifestId], references: [id], onDelete: SetNull)

  /// Результат: VIDEO → resultUrl (mp4), VOICE → resultUrl (mp3), ANALYSIS → resultText (сводка + черновик сценария).
  resultUrl  String?
  resultText String? @db.Text

  durationSec  Int?
  errorMessage String?

  createdAt DateTime @default(now())
  readyAt   DateTime?

  @@index([studioId])
  @@index([kind, status])
  @@map("virtual_studio_fragments")
}
```

**Правка существующей модели** (обязательна, иначе `prisma validate` откажет схему, см. §10.2): в `model BrandManifest` добавить обратную ссылку, рядом с уже существующим `auctionListings AuctionListing[]`:

```prisma
model BrandManifest {
  // ...существующие поля...
  auctionListings         AuctionListing[]
  virtualStudioFragments  VirtualStudioFragment[] // новое поле
}
```

**[ПРАВКА 1.1 — см. §10.5.2:** блок кода выше по-прежнему корректен как ЦЕЛЕВОЕ состояние файла, но формулировка «добавить … рядом с уже существующим `auctionListings`» слегка вводит в заблуждение: `auctionListings AuctionListing[]` в `BrandManifest` **уже существует в коде на сегодня** (`backend/prisma/schema.prisma:682`) — это не часть правки, а константа, рядом с которой правка вставляется. Единственное, что реально нужно добавить, — строка `virtualStudioFragments VirtualStudioFragment[]`.**]**

После изменения схемы — обычная аддитивная миграция Prisma (ни одна существующая таблица не трогается), по образцу `20261125090000_auction_stage1`.

После изменения схемы — обычная аддитивная миграция Prisma (ни одна существующая таблица не трогается), по образцу `20261125090000_auction_stage1`.

## 3. Админ-вкладка «Виртуальная студия»

Новая страница `admin/src/app/virtual-studio/page.tsx`, в том же стиле, что уже есть `admin/src/app/actors/page.tsx`.

### 3.1. Список студий

- Карточки: название, превью выбранного варианта, статус (`DRAFT`/`READY`/`ARCHIVED`), дата.
- Кнопка «Новая студия» → форма (имя + промпт референс-кадра, по умолчанию — аналог `STUDIO_REF_PROMPT` из SilverFinance, адаптированный под бренд viral4creators).
- Кнопка «Удалить» на карточке студии — soft-delete (`deletedAt`), не физическое удаление строки (чтобы ссылки из `VirtualStudioFragment.studio` не ломались).

### 3.2. Внутри студии — варианты референс-кадра

- Сетка сгенерированных вариантов (аналог `listStudioVariants`) — каждая карточка: превью, промпт, радиокнопка «Выбрать» (`selectedVariantId`), кнопка 🗑 «Удалить».
- Кнопка «Сгенерировать ещё вариант» — поле для промпта (по умолчанию — `refPrompt` студии), вызывает Grok Imagine image-эндпоинт (как `generateRefImage` в SilverFinance), сохраняет результат в Blob и строкой `VirtualStudioVariant`.
- Первый сгенерированный вариант автовыбирается (как в `generateStudioVariant`), дальше оператор выбирает вручную — это и есть «если понравилась» из запроса.
- Удаление выбранного варианта сбрасывает `selectedVariantId` в `null` и переводит студию в `DRAFT`, если других вариантов не осталось — это новое поведение по сравнению с SilverFinance, где удаления вариантов нет вообще (там список просто обрезается до последних 12).

### 3.3. Фрагменты

Кнопка **«Создать видео-фрагмент»** — доступна, только когда у студии есть `selectedVariantId`. Форма:

- Провайдер видео: **Grok Imagine** (по умолчанию) или **Hedra** — второй пункт виден только если включён флаг из §3.5.
- Текст/промпт движения ведущей (аналог `clipPrompt`).
- Длительность (по умолчанию 10–12 с).
- При Grok — image-to-video от `variant.imageUrl` (как `GrokVideoProvider.generate` с `refImageUrl`). При Hedra — говорящая голова с честным лип-синком под текст реплики (см. §4.2 про отвязку от Session).

**Озвучка** — отдельная форма, не входит в тот же запрос, что видео (голос накладывается поверх видео отдельно, точно как в SilverFinance):

1. Селектор **«Провайдер»** — **Resemble** (по умолчанию) или ElevenLabs.
2. После выбора провайдера — подгрузка каталога голосов (`TtsProvider.voices()`), селектор **«Голос»**.
3. Поле текста реплики — по умолчанию подставляется `resultText` последнего ANALYSIS-фрагмента этой студии, если он есть — можно отредактировать.
4. Кнопка «Озвучить» → `synthesize()` выбранного провайдера.

**«ИИ-анализ»** — третий тип фрагмента:

- Выбор источника: видео-фрагмент этой же студии или любой URL готового ролика из портфолио (`PortfolioItem.videoUrl`).
- Опционально — выбор `BrandManifest` для аудита брендбука рядом.
- Кнопка «Проанализировать» → Gemini-пайплайн по образцу `VideoAuditService`, результат — текстовая сводка + черновик сценария реплики в `resultText`. **[ПРАВКА 1.1 — см. §10.5.4: точнее «по образцу `AuctionAiAssessmentService`» — у него ровно тот же вход (произвольный внешний URL видео, не сессия), и в его же доккомментарии явно объяснено, почему `VideoAuditService` для этого не подходит.]**
- Результат можно одним кликом перенести в поле текста нового голосового фрагмента (п. 3 выше).

### 3.4. Превью фрагмента

Список фрагментов студии под сеткой вариантов: тип, статус (`pending/processing/complete/failed — те же значения, что у GenerationStatus, §2)`, поллинг статуса пока генерируется, как в `getAvatarVideoStatus`), плеер/аудиоплеер для READY, кнопка удаления.

### 3.5. Настройки

В существующую страницу `admin/src/app/settings/page.tsx` добавляется переключатель **«Включить Hedra для видео-фрагментов студии»** — platform setting через `PlatformSettingsService` (тот же механизм, что уже хранит `DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY`), ключ например `VIRTUAL_STUDIO_HEDRA_ENABLED`, по умолчанию `false`. Пока выключено — в форме видео-фрагмента виден только Grok, пункт Hedra скрыт.

## 4. Провайдеры и переиспользование существующего кода

### 4.1. Референс-кадр — новый код; видео-фрагмент — переиспользование `GrokVideoService`

У Grok Imagine два разных REST-эндпоинта: `/v1/images/generations` (текст → картинка) и `/v1/videos/generations` (текст/картинка → видео). В viral4creators уже есть полноценный клиент второго — `GrokVideoService` (`backend/src/modules/generation/grok-video.service.ts`), который `GenerationService` уже использует как альтернативу Veo (`provider: 'grok'`): `startGeneration({ prompt, imageUrl, durationSeconds, aspectRatio, resolution })` + `getStatus()`. Он уже умеет ровно то, что нужно фрагменту студии: image-to-video от `imageUrl` — точно тот же приём, что `refImageUrl` в SilverFinance. Нового клиента для видео писать не нужно — только вызвать существующий.

- **Видео-фрагмент студии** → `grokVideo.startGeneration({ prompt, imageUrl: variant.imageUrl, durationSeconds, aspectRatio: '9:16', resolution })` + поллинг `getStatus()`, тем же способом, что и `generation.service.ts`. Надо сверить при реализации, ре-хостит ли уже `GrokVideoService`/`GenerationService` готовый ролик в своё хранилище, или этот шаг придётся добавить отдельно (в SilverFinance за это отвечает `rehost()` в `GrokVideoProvider`). **[ПРАВКА 1.1 — см. §10.5.5: проверено. Да, ре-хостит — `generation.service.ts` скачивает `status.videoUrl` через `fetch()` и заливает в `BlobService.uploadBuffer()` (см. `generation.service.ts:1656-1670`). Видео-фрагмент студии обязан повторить именно этот шаг — ссылка от xAI не постоянна.]**
- **Референс-кадр (still image)** — действительно новый код: своего сервиса под `/v1/images/generations` в проекте нет ни в `generation/`, ни где-либо ещё. Нужен небольшой новый `VirtualStudioImageService` по образцу `generateRefImage` из SilverFinance.
- **Ключ** — `GROK_API_KEY` (тот же, что уже используют `GrokVideoService`/`GrokVideoBatchService`), а НЕ `VIDEO_GEN_API_KEY`/`XAI_API_KEY`, как было бы при переносе имён 1-в-1 из SilverFinance — в viral4creators уже закрепилось другое имя для того же xAI-ключа.

### 4.2. Hedra — переиспользование без рефакторинга

`HedraClientService` (`backend/src/modules/actors/hedra-client.service.ts`) уже есть и уже протестирован, но `ActorsService.generateAvatarVideo(sessionId, ...)` жёстко привязан к `Session` (читает референс-фото из сессии продакта). Для студии референс — это `VirtualStudioVariant.imageUrl`, а не фото из сессии. Требуется небольшой рефакторинг: вынести из `ActorsService` часть, которая зовёт `HedraClientService` по (referenceImageUrl, текст, аспектратио, разрешение) без `sessionId`, и вызывать её из обоих мест — и из `ActorsService` (как раньше), и из нового `VirtualStudioService`. Без этого рефакторинга пришлось бы дублировать вызов Hedra API вторым клиентом — лишний источник расхождения с кодом и багов при изменении Hedra API.

**[ПРАВКА 1.1 — см. §10.5.3: этот рефакторинг не нужен вовсе.** Прочитан `hedra-client.service.ts` целиком: `HedraClientService.submit(opts: { prompt, startImage, audioUrl, aspectRatio, resolution })` и `.status(jobId)` **уже** не принимают и нигде не используют `sessionId` — весь код, завязанный на сессию (получение фото персонажа из `session.brandManifestSnapshot`, пути в Blob вида `sessions/${sessionId}/...`, `session.avatarVideo` как хранилище статуса, `SessionService.claimWork`), живёт целиком в `ActorsService`, ни строчки — в `HedraClientService`. Значит `VirtualStudioService` может инжектировать `HedraClientService` напрямую и вызывать `.submit({ prompt, startImage: variant.imageUrl, audioUrl, aspectRatio, resolution })`/`.status(jobId)` без единой правки в `actors/` — а значит и без единого риска для `actors.service.spec.ts` (1172 строки тестов, см. §10.2 п.4 версии 1.0 — этот риск снят полностью, не «снижен»). Единственное, что студии придётся сделать самой (в отличие от `ActorsService`, где это уже есть) — синтезировать аудио под лип-синк ДО вызова Hedra: взять выбранный TTS-провайдер (§4.3), синтезировать реплику, залить в Blob, и уже готовый `audioUrl` передать в `submit()`. Это не рефакторинг чужого кода, а обычная новая логика внутри самого `VirtualStudioService`.**]**

Важно: юридический периметр из `doc/AI-ACTORS-NO-REFERENCE-SPEC.md` §0 (нет инфраструктуры маркировки ИИ-контента/согласия) применяется без изменений и к Hedra-ветке студии — это та же причина, по которой флаг в §3.5 по умолчанию выключен. См. §7.

### 4.3. Голос — без нового кода

Здесь переиспользование полное, а не «по образцу»: `TtsProviderResolverService.resolveByKey('resemble' | 'elevenlabs')` уже даёт конкретный `TtsProvider` в обход одной сессии генерации (комментарий в самом сервисе прямо описывают этот случай: «глобально ElevenLabs, но для этого ролика — Resemble»). Для видео-фрагмента студии то же самое: выбор провайдера в форме → `resolveByKey(key)` → `.voices()` для селектора голоса → `.synthesize({ text, voiceId })`. По умолчанию (если оператор не переключил) — `resemble`, что совпадает с требованием и с уже принятым в проекте решением `TTS-PROVIDER-ALTERNATIVES-SPEC.md §5.2` (неотличимость от живого голоса важнее скорости клонирования). Проверено буквально по `tts-provider-resolver.service.ts` и `tts.types.ts` при подготовке версии 1.1 — описание здесь точное, правок не потребовалось.

### 4.4. ИИ-анализ — по образцу уже существующего `AuctionAiAssessmentService`, а не `video-audit`

Новый метод `analyzeStudioFragment(videoUrl, brandManifestId?)` в `backend/src/modules/virtual-studio/`, переиспользующий `GeminiFilesService`/`createGeminiClient`. **[ПРАВКА 1.1 — см. §10.5.4: исходная версия 1.0 писала «точно так же, как `VideoAuditService`» — это было неточно уже на момент написания версии 1.0, и с тех пор нашёлся ещё более подходящий образец.]** `VideoAuditService` (`backend/src/modules/video-audit/`) скачивает видео из СВОЕГО внутреннего Blob по внутреннему `pathname` и тарифицируется через `PlanService`/`sessionId` — оба предположения неверны для фрагмента студии (`sourceVideoUrl` — произвольный внешний URL, инструмент admin-only, не пользовательский). Ровно с этой же проблемой уже столкнулся `AuctionAiAssessmentService` (`backend/src/modules/auction/auction-ai-assessment.service.ts`) — его собственный доккомментарий прямо объясняет, почему он НЕ переиспользует `VideoAuditService`, и вместо этого использует только низкоуровневые части (`GeminiFilesService` + свой `fetch()` по произвольному URL, без `BlobService`/`PlanService`). Это и есть правильный образец для `analyzeStudioFragment` — тот же приём, применённый к той же самой проблеме, уже в коде проекта, не по аналогии из другого модуля.

Если `brandManifestId` задан — второй отдельный вызов с данными брендбука в промпте — по аналогии с `brandManifestAiAudit` из §22 (там это тоже отдельный аудит от аудита видео, не один вызов на двое). Ни `aiAssessment`, ни `brandManifestAiAudit` в коде пока не реализованы — это первая реализация этой идеи в коде, а не перенос готового. **[ПРАВКА 1.1 — см. §10.5.4: последнее предложение неверно и снимается целиком. Оба поля уже есть в `schema.prisma` (`model AuctionListing`, комментарий «ИИ-оценка видео от Gemini-пайплайна (§16, по образцу video-audit)») и оба уже заполняются `AuctionAiAssessmentService.runTick()`, вызываемым кроном `auction-assess` каждые 2 минуты (`backend/vercel.json`, `cron.controller.ts:248-257`). Это НЕ первая реализация идеи «ИИ-оценка видео + опционально брендбука», это третья: у `VideoAuditService` (пользовательский аудит уже сгенерированного видео), у `AuctionAiAssessmentService` (лот аукциона) и теперь у `VirtualStudioFragment` (студийный фрагмент) — три разных потребителя одной и той же идеи, что нормально и не требует унификации в этом ТЗ, но заявлять «первая реализация» значило бы не заметить два уже существующих аналога.]**

## 5. API эндпоинты

Новый `VirtualStudioController` (`backend/src/modules/virtual-studio/`), по точной аналогии с `ActorsController`: `@Controller('admin/virtual-studio')`, `@UseGuards(AdminSessionGuard)`, каждый метод начинается с `adminPanel.assertOperator(req.userId)`.

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/admin/virtual-studio` | Список студий (без `deletedAt`) |
| POST | `/admin/virtual-studio` | Создать студию `{ name, refPrompt }` |
| DELETE | `/admin/virtual-studio/:id` | Soft-delete студии |
| GET | `/admin/virtual-studio/:id/variants` | Список вариантов + `selectedVariantId` |
| POST | `/admin/virtual-studio/:id/variants` | Сгенерировать вариант `{ prompt? }` (Grok image), rate-limited |
| POST | `/admin/virtual-studio/:id/variants/:variantId/select` | Выбрать вариант |
| DELETE | `/admin/virtual-studio/:id/variants/:variantId` | Удалить вариант (сбрасывает `selectedVariantId`, если удаляли выбранный) |
| GET | `/admin/virtual-studio/:id/fragments` | Список фрагментов + статусы |
| POST | `/admin/virtual-studio/:id/fragments/video` | Создать видео-фрагмент `{ provider: 'grok'\|'hedra', prompt, durationSec? }`, rate-limited |
| POST | `/admin/virtual-studio/:id/fragments/voice` | Создать голосовой фрагмент `{ provider: 'resemble'\|'elevenlabs', voiceId, text }`, rate-limited |
| GET | `/admin/virtual-studio/voices?provider=` | Каталог голосов выбранного провайдера (→ `TtsProviderResolverService.resolveByKey(provider).voices()`) |
| POST | `/admin/virtual-studio/:id/fragments/analysis` | Создать ANALYSIS-фрагмент `{ sourceVideoUrl, brandManifestId? }`, rate-limited (Gemini) |
| GET | `/admin/virtual-studio/:id/fragments/:fragmentId/status` | Поллинг статуса генерации |
| DELETE | `/admin/virtual-studio/:id/fragments/:fragmentId` | Удалить фрагмент |

Настройка Hedra-флага — через уже существующий механизм platform settings (отдельный эндпоинт не нужен, если `PlatformSettingsService` уже отдан в admin-panel API общим списком настроек; если нет — добавить туда же ключ `VIRTUAL_STUDIO_HEDRA_ENABLED`).

## 6. Rate limiting и бюджет

- На все три дорогих вызова (вариант студии, видео-фрагмент, анализ) — `@RateLimit`, как в `actors.controller.ts` (`limit: 5, windowSec: 15`). Голосовой фрагмент дешевле видео/Hedra, но тоже не бесплатный — лимит ставится тот же.
- Стоимость каждой генерации логируется там же, где уже логируются цены Hedra/Resemble/ElevenLabs — `ai-pricing.ts` и `credit-ledger` модуль, чтобы расходы студий были видны в `admin/costs` рядом с остальными расходами, а не отдельной слепой зоной.
- Генерация видео/анализа не тарифицируется через `PlanService` — это admin-only инструмент, не пользовательская фича, по тому же принципу, что и `ActorsController` сегодня (§5.3 `AVATAR-LIPSYNC-PIPELINE-SPEC.md`).
- `ai-pricing.ts` сегодня знает только видео Grok (`grok-imagine-video-1.5:480p`/`720p`) — записи для `/v1/images/generations` (референс-кадр) там нет, её нужно добавить как новую позицию модели (по ценам xAI на image-эндпоинт), а не просто «логироваться там же, где уже логируется GROK». **[ПРАВКА 1.1 — см. §10.5.6: цена найдена и проверена по первоисточнику при подготовке версии 1.1 — `docs.x.ai/developers/pricing` (2026-09-21) перечисляет три модели генерации изображений: `grok-imagine-image` — $0.02/img (1K), `grok-imagine-image-2.0` — $0.04/img (1K, Low quality), `grok-imagine-image-quality` — $0.05/img (1K). Для референс-кадра студии (одно неподвижное изображение, не требующее максимального качества) подходит базовая `grok-imagine-image` за $0.02/img. Новая позиция в `common/ai-pricing.ts`: `'grok-imagine-image': { provider: 'GROK', perCall: 0.02 * USD, note: 'docs.x.ai/developers/pricing, проверено 2026-09-21, 1K resolution' }` — по образцу уже существующих `perCall`-записей (`ffmpeg-api`, `resemble-voice-clone`). Модель прописывается в `config.grok.imageModel` (`configuration.ts`, по образцу `videoModel`/`videoExtendModel`), по умолчанию `process.env.GROK_IMAGE_MODEL || 'grok-imagine-image'`.]**

## 7. Живой аукцион: ставки, антиснайпер и оркестрация подсказок озвучки

По требованию владельца продукта эта часть теперь входит в объём ТЗ — ранее она была в «вне объёма» (§8) как отдельная задача. Это механика, которой в viral4creators сегодня нет вообще (в отличие от §1–§6, где большая часть кода уже есть и переиспользуется) — аналог `bidding.ts` из SilverFinance придётся писать с нуля, но на данных и фрагментах, которые уже готовит админ-вкладка из §2–§3.

**[ПРАВКА 1.1 — см. §10.5.1: первый абзац этого раздела неверен почти целиком.** Ставки, антиснайпер (частично — см. ниже) и модерация оператором — НЕ «механика, которой сегодня нет вообще». Прочитан `backend/src/modules/auction/auction.service.ts` (613 строк) целиком:
> - `AuctionService.placeBid()` — уже полноценно реализован: проверяет `status === 'ACTIVE'` и `expiresAt`, вычисляет текущую максимальную ставку, отклоняет ставку не выше неё, создаёт `Bid`, при достижении `buyNowPrice` немедленно закрывает лот (`closeListing`) и уведомляет победителя в Telegram (`notifyWinner`).
> - `AuctionService.closeExpiredListings()` — уже вызывается кроном `auction-close` каждые 2 минуты (`backend/vercel.json`, `cron.controller.ts:229-238`) и уже выбирает победителя по `reservePrice`, переводит проигравший без ставок ≥ резерва лот в `EXPIRED`, освобождает место следующему в очереди (`promoteNextQueued`, с приоритетом BLITZ и подлимитом на брендбук-эксклюзив).
> - `AuctionController`/`PublicAuctionController`/`AdminAuctionController` (`auction.controller.ts`) — уже дают полный набор маршрутов: подача заявки, свои заявки/ставки, отзыв, публичная витрина, ставка, чек-аут, и админская модерация (список/одобрить/отклонить/подтвердить оплату вручную).
> - `admin/src/app/auctions/page.tsx` — уже рабочая страница модерации оператора: фильтр по статусу, таблица заявок, одобрить/отклонить с причиной, подтвердить оплату вручную. Полностью соответствует по функциям тому, что `AdminAuctionController` отдаёт.
>
> Из перечисленного в этом ТЗ **действительно отсутствует**: (а) антиснайпер — `placeBid()` НЕ продлевает `expiresAt` на позднюю ставку, и поля `extensions` в схеме нет; (б) привязка студии к лоту и статус эфира (`virtualStudioId`, `liveStreamActive/StartedAt/EndedAt`) — этих полей в `AuctionListing` нет; (в) генерация и оркестрация голосовых подсказок эфира (`AuctionLiveVoiceCue`, весь §7.4) — это подлинно новая механика; (г) SSE-доставка эфира (§7.5) — подлинно новая; (д) авто-сворачивание эфира по крону (§7.5) — подлинно новая. Пункты (а)–(д) остаются в объёме этого ТЗ и описаны ниже без изменений по существу — но реализовывать их нужно КАК ДОПОЛНЕНИЕ к уже существующему `AuctionService`/`AuctionModule`, а не с нуля рядом с ним (см. правки §7.3 и §7.6 ниже) — иначе в проекте появятся два независимых, слегка по-разному ведущих себя способа принять ставку.**]**

### 7.1. Идея: постоянное видео + меняющаяся озвучка, а не плейлист из клипов

В SilverFinance эфир — это плейлист из 5–7 разных видео-клипов (каждый — отдельный вызов image-to-video) плюс событийный клип на каждую ставку. Здесь — исходное требование всего этого ТЗ («только изменяемая озвучка») применяется и к самому эфиру: **видеоряд один и постоянный** на всё время эфира лота (один `VirtualStudioFragment` с `kind=VIDEO`, выбранный оператором заранее в админке и зацикленный на клиенте), а меняется только аудиодорожка поверх него (точно так же, как `voiceMode: 'voiceover'` уже работает в постпродакшене — §1). На каждую ставку генерируется **только новая аудиодорожка** (через `TtsProviderResolverService`, §4.3), а не новое видео — это на порядок дешевле и быстрее (синтез речи — секунды, не десятки секунд), чем был бы полный SilverFinance-подход с отдельным видео-рендером на каждую ставку, и снимает риск латентности text-to-video, который SilverFinance явно признал и компенсировал текстовыми оверлеями (`TZ-Blitz-Auction.md` §6.4).

Лот здесь — `AuctionListing` из §22 (аукцион готовых видео из портфолио), не физический предмет, как в SilverFinance. Значит, текст подсказок озвучки говорит про ролик-лот (автор, категория, цена), а не про предмет в кадре — это тот же смысловой разрыв, что уже отмечен в §1.

### 7.2. Модель данных

```prisma
/// Правка существующей модели AuctionListing (§22) — поля эфира и антиснайпера.
/// Аддитивно к AuctionListing, ничего из §22 не трогает.
model AuctionListing {
  // ...все существующие поля из §22...

  /// Какая студия обслуживает эфир этого лота — назначает ОПЕРАТОР (админ) через §7.6
  /// (POST /admin/live-auction/:listingId/studio), а не сам продавец: VirtualStudio — админский
  /// ресурс из §3 (создаётся и генерируется только через AdminSessionGuard-маршруты §5), у продавца
  /// нет доступа ни к его созданию, ни к выбору. Только из студий в статусе READY с выбранным вариантом (§3.2).
  /// [ПРАВКА 1.4 — см. §7.3/§7.8: назначение дополнительно требует auctionType === 'BLITZ'
  /// И liveStreamOptIn === true (новое поле ниже) — оба гейта проверяются в сервисе, не здесь.]
  virtualStudioId String?
  virtualStudio   VirtualStudio? @relation(fields: [virtualStudioId], references: [id], onDelete: SetNull)

  liveStreamActive    Boolean   @default(false)
  liveStreamStartedAt DateTime?
  liveStreamEndedAt   DateTime?

  /// [ПРАВКА 1.4 — новое поле версии 1.4, отсутствовало в версиях 1.0-1.3] Явное
  /// согласие продавца при подаче заявки — тот же приём, что antiSnipeEnabled
  /// (§7.3): чекбокс в CreateAuctionListingDto, false по умолчанию. Без него
  /// AuctionService.assignVirtualStudio отклоняет назначение студии, даже для BLITZ.
  liveStreamOptIn Boolean @default(false)

  /// Антиснайпер (§7.3) — сколько раз реально продлился expiresAt.
  /// То же назначение, что extensions в SilverFinance Auction.
  extensions Int @default(0)

  virtualStudioFragments VirtualStudioFragment[] // back-relation, см. правку ниже
  voiceCues              AuctionLiveVoiceCue[]
}

/// Правка VirtualStudio (§2) — обратная связь на лоты, которые её используют.
model VirtualStudio {
  // ...все существующие поля из §2...
  auctionListings AuctionListing[] // новое поле
}

/// Правка VirtualStudioFragment (§2) — обратная связь: какой лот СЕЙЧАС использует этот видео-фрагмент
/// как постоянный видеоряд (§7.1). Одиночная nullable-ссылка, НЕ список: в любой момент времени
/// фрагмент обслуживает не более одного живого эфира; "последовательное использование разными лотами"
/// означает переназначение поля (лот A завершился → оператор освобождает/переназначает фрагмент лоту B),
/// а не одновременную привязку к нескольким лотам.
model VirtualStudioFragment {
  // ...все существующие поля из §2...
  liveAuctionListingId String?
  liveAuctionListing   AuctionListing? @relation(fields: [liveAuctionListingId], references: [id], onDelete: SetNull)
}

enum VoiceCueKind {
  LOT_DESC    // описание лота (автор, категория, цена) — pregen
  INVITE      // приглашение ставить — pregen
  PRAISE      // имиджевый клип про viral4creators — pregen
  BID_STATS   // число участников со ставками + сумма последней ставки — событие (на каждую ставку)
}

enum VoiceCueTrigger {
  PREGEN
  BID
}

/// Одна запись — один момент эфира, когда поверх постоянного видео (§7.1) звучит
/// одна реплика. Аналог AuctionStreamSegment из SilverFinance, но без поля под видео —
/// видео тут одно и постоянно (liveAuctionListing.virtualStudio), меняется только voiceFragment.
model AuctionLiveVoiceCue {
  id        String @id @default(cuid())
  listingId String
  listing   AuctionListing @relation(fields: [listingId], references: [id], onDelete: Cascade)

  seq         Int             // порядок в подсказках этого лота
  kind        VoiceCueKind
  triggeredBy VoiceCueTrigger @default(PREGEN)

  /// Ставка, спровоцировавшая подсказку — только для BID_STATS.
  bidId String?
  bid   Bid?    @relation(fields: [bidId], references: [id], onDelete: SetNull)

  /// Сама аудиодорожка — переиспользует VirtualStudioFragment kind=VOICE (§2), не свою колонку —
  /// чтобы озвучка шла через тот же пайплайн, что и голосовые фрагменты в админке.
  voiceFragmentId String?
  voiceFragment   VirtualStudioFragment? @relation(fields: [voiceFragmentId], references: [id], onDelete: SetNull)

  /// Животный статус — та же строка GenerationStatus, что у VirtualStudioFragment.status (§10.1).
  status String @default("pending")

  createdAt DateTime @default(now())
  readyAt   DateTime?

  @@unique([listingId, seq])
  @@index([listingId])
  @@map("auction_live_voice_cues")
}
```

**Правка `model Bid`** (§22) — обратная связь для `AuctionLiveVoiceCue.bid`, той же причине, что и выше для `BrandManifest` (без неё `prisma validate` откажет схему):

```prisma
model Bid {
  // ...существующие поля...
  voiceCue AuctionLiveVoiceCue?
}
```

Все правки этого раздела (в отличие от §2) действительно ещё не внесены в схему — проверено по `schema.prisma`: ни `virtualStudioId`/`liveStreamActive`/`extensions` на `AuctionListing`, ни модель `AuctionLiveVoiceCue`, ни обратная связь на `Bid` в коде на сегодня не встречаются. Здесь версия 1.0 не нуждается в правке.

### 7.3. Ставки и антиснайпер

Сейчас в viral4creators нет ни одного сервиса, который бы создавал `Bid` — модель есть, сервиса нет. Новый `BidService` (`backend/src/modules/live-auction/`):

**[ПРАВКА 1.1 — см. §10.5.1: первое предложение неверно (см. правку в начале §7) — сервис, создающий `Bid`, есть и работает: `AuctionService.placeBid()` (`auction.service.ts:206-238`). Новый `BidService` заводить не нужно и не следует: если антиснайпер окажется во ВТОРОМ сервисе, который тоже умеет принимать ставки, в проекте станет два места с частично разной логикой проверки ставки — реальный источник расхождений при следующей правке одного из них. Правильная реализация — прямое дополнение существующего метода:**]**

1. `placeBid(listingId, buyerId, amount)`:
   - отказ, если `status !== 'ACTIVE'` или `now > expiresAt`;
   - отказ, если `amount` не выше текущей максимальной ставки по лоту (или `startingPrice`, если ставок ещё нет);
   - создаёт `Bid`;
   - если `amount === buyNowPrice` (задан) — сразу завершает лот в `WON` и создаёт `AuctionPayment` (уже описано в §22.5, этот ТЗ ничего здесь не меняет) — эфир останавливается так же, как при обычном истечении (§7.5);
   - иначе — срабатывает антиснайпер (ниже) и ставит в очередь генерацию `BID_STATS`-подсказки (§7.4).

   **[ПРАВКА 1.1: все пять пунктов уже есть в `AuctionService.placeBid()`, КРОМЕ «срабатывает антиснайпер» (антиснайпера там действительно нет) и «ставит в очередь генерацию `BID_STATS`-подсказки» (оркестратора пока не существует, это и есть §7.4). Значит объём реальной работы этого пункта — не «написать `placeBid` с нуля», а добавить в СУЩЕСТВУЮЩИЙ метод: (а) вызов антиснайпера перед `return`, после успешного `this.prisma.bid.create(...)`; (б) вызов (best-effort, не блокирующий ответ покупателю) нового `LiveAuctionOrchestratorService` на ту же ставку, только если у `listing.virtualStudioId` есть значение — для лотов без назначенной студии эфира попросту нет, и это не должно ничего менять в уже работающем поведении ставок.]**

2. **Антиснайпер** — та же формула, что в SilverFinance (`TZ-Blitz-Auction.md` §5): `expiresAt = max(expiresAt, now + 2 минуты)`, `extensions += 1` только при фактическом продлении. Применяется к `AuctionListing.expiresAt` (§22, уже есть в схеме) — новых полей для этого не нужно, только `extensions` из §7.2.
3. **Важное отличие от SilverFinance**: там антиснайпер применяется ко всем аукционам (там один тип `Auction`, разница — saleType). Здесь `AuctionListing` имеет только один тип торгов со ставками (BLITZ/STANDARD из §22 — это длина окна 48ч против 3–7 дней, а не разные механики торгов). Вопрос (см. §10.2): включать ли эфир только для BLITZ (по аналогии с SilverFinance, где эфир — только для `saleType: 'blitz'`) или для обоих типов — в этом ТЗ не решено, так как это бизнес-решение, не техническое — предлагаю только BLITZ (дороже на единицу времени, но окно короче — бюджет предсказуем).

   **[ПРАВКА 1.4 — вопрос решён явно, по прямому запросу: только BLITZ.**
   `AuctionService.assignVirtualStudio()` отклоняет назначение студии
   (`BadRequestException`), если `auctionType !== 'BLITZ'` — тот же вывод,
   что предлагала версия 1.2 («дороже на единицу времени, но окно короче
   — бюджет предсказуем»), теперь закреплён как обязательное условие, а
   не рекомендация. STANDARD-лот (3–7 суток) технически может дойти до
   этого вызова (поле `auctionType` не проверяется при подаче заявки,
   §22) — отклонение происходит здесь, в сервисе, с понятным сообщением
   оператору, а не через голое нарушение ограничения схемы. Заодно тем же
   ПРАВКА 1.4 добавлено второе, независимое условие: явное согласие
   продавца — `AuctionListing.liveStreamOptIn` (новое поле, §7.2), чекбокс
   в `CreateAuctionListingDto` (тот же приём, что `antiSnipeEnabled` выше)
   — без него оператор не может назначить студию лоту, ДАЖЕ если тот уже
   BLITZ: техническая пригодность (BLITZ) и согласие продавца — два
   независимых гейта, оба обязательны, ни один не подразумевает другой.]**

### 7.4. Оркестрация подсказок озвучки

`LiveAuctionOrchestratorService` — **[ПРАВКА 1.1: новый файл внутри уже существующего `backend/src/modules/auction/` (например, `live-auction-orchestrator.service.ts`), не отдельный модуль — см. правку §7.6.]** (тот же модуль, аналог оркестратора из `liveStream.ts`):

1. **При переходе лота в `ACTIVE`** — если у `AuctionListing` есть `virtualStudioId`: ставит в очередь pregen-подсказки `LOT_DESC` → `INVITE` → `PRAISE` (по 1 на каждый `VoiceCueKind`, `seq` по порядку), генерирует текст под каждый (данные лота: автор, категория, `startingPrice`; для `LOT_DESC` можно подставить `resultText` из ANALYSIS-фрагмента студии, если он есть — §3.3), вызывает `TtsProviderResolverService` и сохраняет каждый как `VirtualStudioFragment` с `kind=VOICE`, `liveAuctionListingId = listing.id`. **[ПРАВКА 1.1: единственное место, где сегодня лот переходит в `ACTIVE`, — `AuctionService.promoteNextQueued()` (`auction.service.ts:329-359`), вызываемый и из `adminApprove()`, и из `closeExpiredListings()`/`withdraw()` при освобождении места. Хук в оркестратор нужно ставить именно там, после `this.prisma.auctionListing.update({ data: { status: 'ACTIVE', ... } })` — не в новом месте.]**
2. **На каждую принятую ставку** (из `BidService.placeBid`, §7.3) **[ПРАВКА 1.1: из `AuctionService.placeBid`, см. правку §7.3]** — считает `participantCount` (`Bid.groupBy(['buyerId'])` по `listingId`) и последнюе `amount`, строит текст (аналог `clipText(kind: 'bid_stats')` из SilverFinance), синтезирует новый `VirtualStudioFragment(kind=VOICE)` и `AuctionLiveVoiceCue(kind=BID_STATS, triggeredBy=BID, bidId)`.
3. **Как и в SilverFinance** (`TZ-Blitz-Auction.md` §6.4) — синтез речи не мгновенный, поэтому `BID_STATS`-подсказка выходит в эфир с небольшим сдвигом — компенсируется мгновенным текстовым оверлеем в плеере (§7.5), но сдвиг короче, чем у полного видео-рендера — синтез речи через `eleven_flash_v2_5`-класс модели — секунды, а не десятки секунд у text-to-video.
4. **Между подсказками** — видео продолжает играть свой фиксированный луп (`liveAuctionListing.virtualStudio`'s выбранный `VirtualStudioFragment kind=VIDEO`) без звука — холостой студийный клип, как в SilverFinance, здесь не нужен отдельно — это просто пауза в аудиодорожке над тем же видео.

### 7.5. Реалтайм-доставка и авто-сворачивание эфира

**Доставка.** В viral4creators нет HLS-инфраструктуры, но она здесь и не нужна — видео одно и статично (§7.1), меняется только аудиодорожка. SSE-прецедент в проекте есть (`assistant`, `LiveLoginSession`) — новый публичный (не admin) эндпоинт `GET /api/live-auction/:id/stream` отдаёт SSE-события по тому же образцу: новая готовая `AuctionLiveVoiceCue` (URL аудио из `voiceFragment.resultUrl`), новая ставка (для мгновенного текстового оверлея, пока озвучка ещё генерируется, — приём из SilverFinance §6.4). Клиент: `<video loop muted>` с постоянным `resultUrl` видео-фрагмента лота + `<audio>` подменяемым `src` по каждой SSE-подсказке — никакого плеера-плейлиста не нужно, это проще, чем hls.js из SilverFinance.

**Авто-сворачивание** — тот же приём, что SilverFinance `TZ-Blitz-Auction.md` §6.6: если с момента `liveStreamStartedAt` за `LIVE_NO_BID_COLLAPSE_MIN` минут (по умолчанию 15) не поступило ни одной `Bid` — `liveStreamActive = false`, `liveStreamEndedAt = now`, плеер переключается на статичную обложку лота. **Сам аукцион продолжается** до `expiresAt` в обычном режиме (без эфира) — сворачивается именно трансляция, не торги (точно та же развязка, что в SilverFinance). Если ставка всё-таки приходит до истечения — таймер сворачивания снимается, эфир идёт штатно.

Проверка таймера сворачивания — лениво (при каждом чтении состояния лота, как уже делает `finalizeExpired`-подобная логика в SilverFinance) либо через новый частый крон — в `backend/vercel.json` уже есть примеры `*/2 * * * *` (`catalog-batch-run`, `ab-test-run`, и т.д.), по тому же образцу можно добавить `/api/cron/live-auction-tick`.

### 7.6. Новый бэкенд-модуль и эндпоинты

`backend/src/modules/live-auction/` — `BidService`, `LiveAuctionOrchestratorService`, `LiveAuctionController`. В отличие от `VirtualStudioController` (§5) этот контроллер **публичный** — ставки делают покупатели, не операторы, гейт — `TelegramIdentityGuard` (тот же, что уже использует `PortfolioController` для публичных маршрутов, `backend/src/modules/portfolio/portfolio.controller.ts`), не `AdminSessionGuard`. Admin-маршрут §7.6 (назначение студии лоту) — исключение внутри этого же контроллера/модуля, он остаётся под `AdminSessionGuard`, как и весь §5.

**[ПРАВКА 1.1 — см. §10.5.1/§10.5.7: заголовок и первое предложение неверны — новый модуль `live-auction/` заводить не нужно.** `AuctionController` (публичная часть, `@Controller('auctions')`, БЕЗ гварда) и `AuctionController` с `@UseGuards(TelegramIdentityGuard)` (та же аннотация типа, что называет TZ — `TelegramIdentityGuard`, названо верно) УЖЕ существуют в `backend/src/modules/auction/auction.controller.ts` и уже держат ставку (`POST /auctions/:id/bids`), публичный список/карточку лота и чек-аут. Новые публичные маршруты этого параграфа (SSE-стрим, состояние эфира) логично добавить туда же, новыми методами того же файла (или соседним файлом `live-auction-sse.controller.ts` в том же каталоге `modules/auction/`, если контроллер разрастётся) — не в отдельном модуле, ради тех же причин, что и в правке §7.3 (одно место для логики ставок/лота, не два параллельных). Admin-маршрут назначения студии — новый метод в уже существующем `AdminAuctionController` того же файла, рядом с `approve`/`reject`/`confirm-payment`, а не в отдельном контроллере.**]**

| Метод | Путь | Назначение |
| --- | --- | --- |
| POST | `/api/live-auction/:listingId/bid` | `placeBid` — публичный, rate-limited по байеру (антиспам) |
| GET | `/api/live-auction/:listingId/stream` | SSE: новые подсказки и ставки |
| GET | `/api/live-auction/:listingId/state` | Текущая цена, `expiresAt`, `liveStreamActive`, текущий видео-фрагмент, последняя `AuctionLiveVoiceCue` (для клиента, подключившегося позже начала эфира) |
| POST | `/admin/live-auction/:listingId/studio` | Admin-эндпоинт: привязать `virtualStudioId` к лоту (только из `READY`-студий, §3.2/§7.2) |

**[ПРАВКА 1.1: строка `POST /api/live-auction/:listingId/bid` в этой таблице избыточна и не нужна — ставка уже принимается по адресу `POST /auctions/:id/bids` (`auction.controller.ts:79-86`, уже под `TelegramIdentityGuard`). Заводить второй маршрут для того же действия значило бы либо дублировать проверки `placeBid()`, либо превратить один из двух маршрутов в тонкую обёртку над другим без явной причины — таблицу стоит сократить до трёх реально новых маршрутов (SSE, state, admin-назначение студии), и разместить их под уже существующим префиксом `/auctions`/`/admin/auctions`, а не заводить отдельный префикс `/api/live-auction` только ради названия модуля из этого параграфа, которого больше нет.]**

### 7.7. Граница даже внутри этого раздела

Следующее остаётся вне даже этой, расширенной части — см. §8:

- Видео-генерация на каждую ставку (полная SilverFinance-модель) — осознанно отклонена в пользу модели «постоянное видео + меняющаяся озвучка» (§7.1) — если это решение пересмотрится, потребуется новый раунд этого ТЗ, не правка.
- Совместное действие с ограничением «не более 5 ACTIVE на весь сайт, 3 с брендбуком» из §22.1 — этот ТЗ его не трогает, но бюджет эфира (§10.2) стоит считать именно на эти 5 одновременные позиции, а не на неограниченный поток. Это ограничение, к слову, уже реализовано и активно применяется в `promoteNextQueued()` (`MAX_ACTIVE_LISTINGS = 5`, `MAX_ACTIVE_EXCLUSIVE_LISTINGS = 3`, `auction.service.ts:44-45`) — здесь версия 1.0 верна, править нечего.

**[ПРАВКА 1.3 — см. §7.8: третий пункт этого списка версии 1.2, «Индексация трансляции через Google Indexing API / `BroadcastEvent`», ИЗЪЯТ отсюда и возвращён в объём отдельным §7.8 по прямому запросу владельца продукта. Обоснование версии 1.2 («ценность индексации неочевидна для лота одного исполнителя») не было ошибкой — оно остаётся верным как предупреждение о калибровке ожиданий (см. §7.8, п.5 «Калиброванная оценка эффекта»), но перестало быть основанием для полного исключения фичи из объёма.]**

### 7.8. Индексация живого эфира через Google Indexing API (`BroadcastEvent` в `VideoObject`) — ПЕРЕСМОТРЕНО, снова в объёме (v1.3)

**[ПРАВКА 1.3]** Возвращено в объём по прямому запросу владельца продукта.
Полный разбор — что технология делает реально, чем наш случай отличается
от типичного злоупотребления этим API на рынке, и калиброванная (не
хайповая) оценка ожидаемого эффекта — вынесен в отдельный файл
`docs-tz/AUDIT-Live-Auction-Google-Indexing-API.md`, по тому же принципу,
что `AUDIT-Auction-Money-Currency.md` в своё время информировал решения
основного ТЗ маркетплейса, а не дублировался в нём целиком. Здесь —
только тот минимум, который нужен для реализации.

**Что это даёт.** Google Indexing API и разметка `BroadcastEvent` —
формально две разные вещи. Разметка `BroadcastEvent` внутри `VideoObject`
делает страницу лота ПРЕТЕНДЕНТОМ на красный значок «LIVE» прямо в выдаче
Google Search (подтверждённая, актуальная функция, см. официальную
документацию Google Search Central — «Video (VideoObject, Clip,
BroadcastEvent) structured data»: LIVE-бейдж «can be applied to any
public video that is live-streamed for any length of time»). Indexing API
— документированный Google способ гарантировать, что краулер видит эту
разметку РОВНО пока эфир идёт, а не часами позже, когда `isLiveBroadcast`
уже устарел. Это не общий «ускоритель SEO» — для страниц с `BroadcastEvent`
это единственный официально поддерживаемый Google механизм (API
официально ограничен только двумя типами страниц — `JobPosting` и
`BroadcastEvent`), и наш случай — честное применение по прямому
назначению, не притянутое за уши ради SEO-хака: страница лота в фазе
эфира буквально является прямой трансляцией.

**Важная оговорка (см. `AUDIT-Live-Auction-Google-Indexing-API.md` §5):**
разметка делает страницу ЭЛИГИБЛЬНОЙ для значка, не гарантирует его показ
— решение всегда за Google. Ожидания стоит калибровать соразмерно
масштабу площадки (эксклюзивное видео одного исполнителя — принципиально
более узкая тема поискового спроса, чем флагманские примеры Google:
спорт, награждения, стримы блогеров-миллионников).

**Модель данных — ничего нового не требуется.** В отличие от SilverFinance
(которой пришлось заводить `liveStreamActive`/`liveStreamStartedAt`/
`liveStreamEndedAt` специально под эту задачу), у нас эти поля уже есть
на `AuctionListing` с Этапа 5 — вся работа сводится к best-effort
side-эффектам в уже существующих точках жизненного цикла эфира, без
новой миграции.

**Что делать:**
1. Подать заявку на увеличение квоты Google Indexing API в Google Cloud
   Console — внешняя зависимость с неконтролируемым сроком ответа
   (см. `AUDIT-Live-Auction-Google-Indexing-API.md` §3: с 2024 года
   дефолтная квота тестовая, реальное использование в проде требует
   этого одобрения). Подавать как можно раньше, параллельно с
   разработкой, не после неё.
2. Новый файл `backend/src/modules/auction/google-indexing.service.ts`
   (имя не пересекается с уже существующим `google-ads.service.ts` в том
   же каталоге) — аутентификация через service account (JSON-ключ в env),
   область `https://www.googleapis.com/auth/indexing`, `POST
   https://indexing.googleapis.com/v3/urlNotifications:publish`, тело
   `{ url, type: 'URL_UPDATED' | 'URL_DELETED' }`. Best-effort — тот же
   принцип, что у `pauseGoogleAdsCampaignIfAny`/`notifyWinner`
   (`auction.service.ts`): сбой сети или отсутствие credentials не должны
   ронять сам жизненный цикл эфира/аукциона.
3. Хуки в уже существующих (не новых) точках Этапа 5 — новых мест в
   доменной логике не заводится:
   - `LiveAuctionOrchestratorService.activateLiveStream()` — после
     установки `liveStreamActive: true` → `URL_UPDATED`.
   - `LiveAuctionOrchestratorService.collapseInactiveStreams()`
     (авто-сворачивание, §7.5) и реактивация эфира в `onBidPlaced()` →
     `URL_UPDATED` на каждый переход состояния трансляции.
   - `AuctionService.closeListing()` / `closeExpiredListings()`
     (завершение торгов) → финальный `URL_UPDATED` с `isLiveBroadcast:
     false`.
4. JSON-LD `VideoObject`+`BroadcastEvent` на странице лота — это
   фронтенд маркетплейса (`marketplace/`), не бэкенд/админка, которые
   покрывает остальной этот документ; отдельный небольшой фронтенд-таск,
   тот же принцип разделения объёма, что уже применён к «покупательский
   UI со ставками» в Этапе 5, п.6.
5. Ручной шаг в Google Search Console (не автоматизируется) — владелец
   сайта должен добавить сервис-аккаунт как владельца сайта, иначе
   вызовы API будут отклоняться с ошибкой авторизации независимо от кода.

**Соответствие требованиям LIVE-бейджа.** Google требует отсутствия
«вульгарных или потенциально оскорбительных формулировок» в разметке.
Название/описание лота — свободный текст исполнителя, но он и так проходит
через существующую модерацию оператора (`adminApprove`/`adminReject`, §22)
до перехода в `QUEUED`/`ACTIVE` — отдельного нового шага модерации не
требуется, только пункт в памятке оператора «не подходит по тону для
показа в Google с LIVE-бейджем» на время ревью заявки.

## 8. Вне объёма этого этапа

- **Полная регенерация видео по каждой ставке и встраивание в лимит «5 активных» лотов (§22.1)** — даже там, где живой аукцион теперь реализован (§7), эти два пункта остаются вне объёма; подробности и обоснование — §7.7. **[ПРАВКА 1.3: третий пункт версии 1.2 этого списка, «Google Indexing/BroadcastEvent-разметка», убран отсюда — возвращён в объём, см. §7.8.]**
- **Юридический периметр ИИ-аватара** (маркировка/согласие) — уже открытый вопрос `AI-ACTORS-NO-REFERENCE-SPEC.md §0`, не решается этим документом. Пока он открыт, Hedra-ветка остаётся выключенной по умолчанию — это не формальность, а условие включения.
- **Единый смикшанный файл видео+звук — намеренно остаётся вне объёма, хотя платный микшер в проде уже есть.** В viral4creators действительно есть готовый сервис для этого — `FfmpegApiService` (`backend/src/modules/postprod/ffmpeg-api.service.ts`), который именно и решает проблему «нет ffmpeg на Vercel serverless» отправкой команд на внешний хостед API (`verygoodffmpeg`, ключ `FFMPEG_API_KEY`) — и уже собирает ровно такой же audio+video микс (`adelay`/`volume`/`amix`/`loudnorm`) для постпродакшн видео в `postprod.service.ts`. То есть технически свести видео+аудио в один mp4 было бы можно без новой инфраструктуры.

  Но это готовый сервис — **платный** (`ai-pricing.ts`: `'ffmpeg-api'`, оценка $0.01/вызов, помечена в самом коде как «ПРОВЕРИТЬ», то есть неподтверждённая), а в `postprod.service.ts` он вызывается один раз на готовое портфолио-видео. В этом ТЗ картина другая — частота вызовов на порядки выше: в §3.3 оператор может перегенерировать озвучку десятками раз при подборе голоса, а в §7 каждая ставка в живом эфире меняет голосовой фрагмент — при аукционе на сотни ставок это сотни отдельных платных mux-вызовов на один лот, чего `postprod.service.ts` никогда не делал (там — ровно один вызов на готовое видео). К этому добавляется задержка асинхронного job+poll — для §7.5, где голос должен смениться почти сразу после ставки, это неприемлемая задержка.

  **Вывод:** гонять `FfmpegApiService` на каждый фрагмент/ставку не стоит — это умножает платные вызовы там, где в SilverFinance и так было осознанно выбрано бесплатное наложение на клиенте, и добавляет задержку там, где важна скорость. Решение «видео и аудио хранятся отдельными файлами, накладываются на превью/плеере» (§3.4, §7.5) остаётся без изменений. Единственное место, где `FfmpegApiService` имеет смысл: опциональная кнопка «Скачать как один файл» в §3.4 — разовый, нечастый экспорт одного уже выбранного фрагмента для внешнего использования (соцсети/превью-ссылка) — там частота вызова та же, что и в уже существующем использовании сервиса (один вызов на готовое видео), а не на каждую подборку/ставку.

## 9. Этапы внедрения — по профиту

**Версия 1.2.** Прежняя раскладка по этапам (ниже, в §9.1 «для истории») шла по техническим зависимостям («что от чего требуется»), а не по отдаче: миграция → CRUD-заглушка без UI → админка → видео → голос → анализ → Hedra → аукцион, восемь примерно равных по важности шагов подряд. При этом самая дешёвая и самая денежно значимая правка всего документа (антиснайпер) стояла последней, потому что попала в один пункт с самой дорогой и рискованной частью (живой аукцион), а самая раскрученная в разговоре «фича-мечта» (Hedra говорящая голова) стояла раньше вещей, которые дешевле и без которых Hedra всё равно бесполезна.

Ниже — тот же объём работы, перегруппированный по критерию «что оператор/бизнес получает и какой ценой», от наибольшего отношения профит/усилие к наименьшему. Технические зависимости внутри каждого этапа не нарушены (миграция по-прежнему идёт раньше кода, который читает новые таблицы) — просто крупные технические шаги из §9.1 разъединены и рассортированы по факту отдачи, а не по факту порядка написания кода.

### Этап 0 — Антиснайпер на уже работающем аукционе (профит/усилие — максимальный из всего документа)

**Что получает бизнес.** Аукцион (`AuctionService`/`AuctionController`) уже принимает настоящие деньги через self-serve чек-аут (WayForPay) — это не прототип. Без антиснайпера лот со ставками системно уязвим к «снайпингу в последнюю секунду»: ставка за мгновение до `expiresAt` побеждает без шанса у остальных участников поднять цену, что напрямую занижает выручку продавца (и комиссию платформы — 30%/20% от суммы сделки, `AuctionPayment.commission`) на каждом горячем лоте. Это единственная находка всего документа, которая чинит **уже реализованную и монетизируемую** функцию, а не строит новую.

**Что делать.** Ровно два маленьких изменения на уже существующем коде — без единой новой таблицы фрагментов/студии:
1. Миграция: добавить `extensions Int @default(0)` в `model AuctionListing` (единственное поле из §7.2, которое нужно для этого этапа — `virtualStudioId`/`liveStreamActive*` этому этапу не нужны).
2. `AuctionService.placeBid()` (`auction.service.ts:206-238`) — после успешного `this.prisma.bid.create(...)` и до `return`, если ставка не мгновенно выиграла (`buyNowPrice`) и лот не BUY-NOW-закрыт: `expiresAt = max(expiresAt, now + 2 минуты)`, `extensions += 1` только при фактическом продлении (формула §7.3, п.2, без изменений).

**Почему первым по профиту, а не по логике «сначала фундамент студии».** Эффект виден сразу на реальных деньгах, ничего не ждёт (ни миграции VirtualStudio, ни новой админ-вкладки), риск регрессии — минимальный (один читаемый диff в уже покрытом кодом методе, никакой новой инфраструктуры). Если из всего документа реализовать только этот этап и больше ничего — он уже окупает время на чтение ТЗ.

### Этап 1 — Минимальная рабочая студия: референс-кадр + видео-фрагмент (Grok)

**Что получает оператор.** То, ради чего вообще затевалось это ТЗ (§1): повторяемый визуальный образ студии/ведущей, который можно один раз сгенерировать, один раз выбрать и переиспользовать в видео-роликах без повторной оплаты за визуал на каждый клип — экономия именно на том внешнем вызове (Grok video), который дороже всех остальных в этом документе. Уже на этом этапе получается самостоятельно демонстрируемый результат: оператор генерирует несколько вариантов кадра, выбирает один, генерирует от него видео-фрагмент — и получает готовый зацикливаемый ролик.

**Что делать.**
1. Миграция: `VirtualStudio`, `VirtualStudioVariant`, `VirtualStudioFragment` (только `kind: VIDEO` пока актуален) + энумы (§2), плюс обратная связь `BrandManifest.virtualStudioFragments` (единственная реально недостающая часть правки из §2 — `auctionListings` там уже есть, см. §10.5.2).
2. `VirtualStudioImageService` — генерация референс-кадра (`/v1/images/generations`, новый код, §4.1) + CRUD вариантов (генерация/выбор/удаление, сброс `selectedVariantId`/`DRAFT` при удалении выбранного, §3.2).
3. Видео-фрагмент через уже существующий `GrokVideoService.startGeneration({ imageUrl: variant.imageUrl, ... })` + поллинг `getStatus()` + **обязательный rehost** результата в свой Blob (подтверждено чтением `generation.service.ts:1656-1670`, §10.5.5 — ссылка xAI не постоянна).
4. Минимальная админ-вкладка `admin/src/app/virtual-studio/page.tsx`: список студий, сетка вариантов, кнопка «Создать видео-фрагмент», плеер превью, поллинг статуса (§3.1, §3.2, часть §3.3/§3.4 — без голоса и анализа, они в следующих этапах).
5. Новая позиция в `common/ai-pricing.ts` — `grok-imagine-image`, $0.02/img, `docs.x.ai/developers/pricing` (§10.5.6) — без неё расход на референс-кадры будет писаться в отчёт немаркированным нулём.

**Почему вторым по профиту.** Это самый дорогой по объёму кода этап документа, но он — единственный, без которого весь остальной §1–§6 бессмысленен: нет смысла собирать голосовые/аналитические фрагменты или включать Hedra, пока нечего фрагментировать. В отличие от прежней раскладки (§9.1, шаги 1–4 отдельно, с промежуточным «CRUD без UI»), здесь миграция и admin-UI объединены в один этап — промежуточное состояние «данные есть, показать оператору нечем» самостоятельной ценности не несёт, разбивать его на два отдельных шага только ради видимости прогресса нет смысла.

### Этап 2 — Голосовой фрагмент (профит/усилие — почти дармовой)

**Что получает оператор.** Видео + голос поверх — уже полноценный «говорящий» ролик-заготовка студии, которую можно один раз показать как питч фичи целиком ("вот AI-ведущая, которая говорит").

**Что делать.** Ничего нового не пишется на уровне провайдера — `TtsProviderResolverService.resolveByKey('resemble' | 'elevenlabs')` → `.voices()` → `.synthesize({ text, voiceId })` уже даёт всё необходимое (§4.3, проверено буквально при подготовке версии 1.1, правок не потребовалось). Реальная работа этого этапа — только форма в уже существующей вкладке (селектор провайдера → селектор голоса → текст реплики → «Озвучить») и запись результата как `VirtualStudioFragment(kind: VOICE)`.

**Почему третьим.** Ниже усилий, чем Этап 1 (нет нового внешнего клиента, нет нового провайдера расходов, `ai-pricing.ts` уже знает `resemble-tts`/`elevenlabs-tts`), но зависит от Этапа 1 буквально (нечего собирать в «говорящий ролик» без видео-фрагмента) — поэтому не может стоять раньше него, несмотря на более высокое отношение профит/усилие само по себе.

### Этап 3 — ИИ-анализ-фрагмент

**Что получает оператор.** Не готовый контент, а ускоритель написания реплик: сводка по референсному ролику + черновой сценарий, одним кликом переносимый в текст голосового фрагмента (§3.3) — экономит время оператора на подборе слов для каждой новой студии/лота, но сам по себе не производит то, ради чего заводилась студия (видео/голос).

**Что делать.** `analyzeStudioFragment(videoUrl, brandManifestId?)` по образцу уже существующего `AuctionAiAssessmentService` (не `VideoAuditService` — см. §4.4/§10.5.4): `GeminiFilesService` + свой `fetch()` по произвольному внешнему URL, без `BlobService`/`PlanService`. Второй отдельный вызов, если задан `brandManifestId` (аудит брендбука).

**Почему четвёртым.** Ценность реальна, но вспомогательная (ускоряет написание текста, не производит сам продукт), и технически почти не пересекается с Этапами 1–2 (можно было бы делать параллельно с ними, если исполнителей несколько) — но по чистому профиту уступает уже работающему видео+голосу.

### Этап 4 — Hedra как опциональный видео-провайдер

**Что получает оператор.** Второй, более реалистичный (честный лип-синк, не просто движение в кадре) движок для видео-фрагмента — но за экраном, выключенным по умолчанию (`VIRTUAL_STUDIO_HEDRA_ENABLED`), пока не закрыт открытый юридический вопрос маркировки ИИ-контента (`AI-ACTORS-NO-REFERENCE-SPEC.md §0`, см. §8). То есть даже при готовом коде фактическая отдача этого этапа равна нулю до отдельного бизнес-решения, не зависящего от разработки.

**Что делать.** Ощутимо дешевле, чем в версии 1.0: рефакторинг `ActorsService` не требуется вовсе (§4.2/§10.5.3 — `HedraClientService.submit()`/`.status()` уже не знают о `sessionId`). Реальная новая работа — синтез аудио под лип-синк ДО вызова Hedra (TTS §4.3 → Blob → `hedra.submit({ prompt, startImage: variant.imageUrl, audioUrl, aspectRatio, resolution })`) и сам флаг в `/settings`.

**Почему пятым, несмотря на то что стал заметно дешевле.** Дело не в цене реализации (она невелика), а в том, что ценность включённой фичи фактически равна нулю, пока открыт юридический вопрос — вкладывать очередной этап разработки в функцию, которую нельзя включить по умолчанию и, возможно, нельзя включить вообще, менее выгодно, чем что угодно из Этапов 0–3, которые дают отдачу сразу по завершении кода.

### Этап 5 — Живой аукцион: студия в эфире, антиснайпер уже есть с Этапа 0

**Что получает бизнес.** Самая амбициозная и потенциально самая денежно значимая часть документа — превращает статичную карточку лота в живую трансляцию с реагирующей на ставки озвучкой, прямой аналог механики SilverFinance, которая там уже доказала эффект на монетизации блиц-лотов. Это же и самая крупная новая инженерная поверхность документа: `AuctionLiveVoiceCue`, оркестрация, SSE, авто-сворачивание — ничего из этого не существует в коде ни в каком виде (в отличие от Этапа 0, который просто чинит существующее).

**Что делать** (без изменений по существу к §7, только собранное в один этап и без задваивания уже существующего — см. §10.5.1/§10.5.7):
1. Миграция: `virtualStudioId`/`liveStreamActive`/`liveStreamStartedAt`/`liveStreamEndedAt` на `AuctionListing` (поле `extensions` уже добавлено Этапом 0), модель `AuctionLiveVoiceCue` + энумы, обратная связь `Bid.voiceCue`.
2. Хук на `AuctionService.promoteNextQueued()` (переход в `ACTIVE`) и на `AuctionService.placeBid()` (после создания `Bid`, best-effort, только если `listing.virtualStudioId` задан) — вызывает новый `LiveAuctionOrchestratorService` (новый файл внутри `modules/auction/`, НЕ новый модуль — §7.6/§10.5.7).
3. Сериализация `seq` в `AuctionLiveVoiceCue` под конкурентными ставками — открытый вопрос §10.2 (транзакция с блокировкой строки лота либо атомарный `increment`) должна быть решена ДО кода этого пункта, не после — единственный пункт всего документа, где реализация без предварительного решения гарантированно потеряет часть `BID_STATS`-подсказок на горячем лоте.
4. Новые методы в уже существующих `AuctionController`/`AdminAuctionController` (`GET /auctions/:listingId/stream`, `GET /auctions/:listingId/state`, `POST /admin/auctions/:listingId/studio`) — без нового префикса `/api/live-auction` и без нового `LiveAuctionController`.
5. `/api/cron/live-auction-tick` — авто-сворачивание эфира без ставок (§7.5), по образцу уже существующих кронов `vercel.json`.
6. *(Отдельный следующий этап, вне этого документа)* — покупательский UI со ставками под SSE на фронтенде маркетплейса.

**Почему последним, а не по важности идеи.** Идея — самая ценная в документе, но и самая дорогая и самая рискованная: единственная часть, где есть нерешённый архитектурный вопрос (конкурентность `seq`) и непроверенное техническое ограничение платформы (лимит времени SSE-соединения на serverless-функциях Vercel, §10.4) — то есть единственный этап, который в принципе может потребовать смены подхода (SSE → polling) уже по ходу реализации. Кроме того, он зависит от Этапа 1 (нужен готовый `VirtualStudioFragment kind=VIDEO`, чтобы вообще к чему-то привязать эфир) и получает наибольшую отдачу, когда голосовые фрагменты (Этап 2) уже отработаны на обычных студиях — заходить в самую рискованную часть первой означало бы отлаживать одновременно и новую доменную логику, и ещё не обкатанный до этого пайплайн голосовых фрагментов.

### Этап 6 — Индексация живого эфира через Google Indexing API (**[ПРАВКА 1.3]** — возвращено в объём поверх уже реализованного Этапа 5)

**Что получает бизнес.** Соответствующий политике Google, практически
бесплатный (инфраструктура уже полностью готова, см. §7.8) способ
получить визуально выделяющийся значок «LIVE» в выдаче Google Search
именно в момент, когда лот действительно в эфире. Не «мощный фактор
раскрутки» сам по себе (см. калиброванную оценку в
`AUDIT-Live-Auction-Google-Indexing-API.md` §5 — площадка с эксклюзивным
видео одного исполнителя объективно уже, чем флагманские примеры Google
для этой функции: спорт, награждения, стримы блогеров-миллионников), а
низкозатратный бонус поверх уже существующих каналов роста, который
стоит делать именно потому, что теперь он почти ничего не стоит.

**Что делать** — см. полный список в §7.8, п. «Что делать»: заявка на
увеличение квоты Indexing API (внешняя зависимость, подавать раньше
всего остального), `GoogleIndexingService`, best-effort хуки в уже
существующих точках `LiveAuctionOrchestratorService`/`AuctionService`
(никаких новых мест в доменной логике), JSON-LD на странице лота
маркетплейса (отдельный фронтенд-таск, вне объёма бэкенда/админки этого
документа), ручное добавление сервис-аккаунта в Google Search Console.

**Почему шестым, после уже реализованного Этапа 5, а не встроено в него
задним числом.** Технически это чистая надстройка над Этапом 5 (те же
поля `liveStreamActive`/`liveStreamStartedAt`/`liveStreamEndedAt`, те же
хуки в оркестраторе, без единой новой миграции) — но исторически Этап 5
уже реализован БЕЗ этой части (она была явно исключена версией 1.2 на
момент реализации), и переписывать «задним числом» уже сданный этап
менее уместно, чем добавить короткий, отдельно оцениваемый этап поверх
него — тот же принцип, что и у остальных «Этап N» в этом документе.

### 9.1. Прежняя раскладка по техническим зависимостям (версия 1.0/1.1, для истории)

Оставлено без изменений как исходная точка версии 1.2 выше — если реализация уже началась по этому порядку, переключаться на §9 не обязательно ради самого переключения: суть работы та же, разница только в том, в каком порядке она приносит отдачу.

1. **Данные** — миграция Prisma (`VirtualStudio`/`VirtualStudioVariant`/`VirtualStudioFragment` + энумы), `prisma db push`/migrate.
2. **Сервис референс-кадра** — `generateRefImage` (Grok image) + CRUD вариантов и удаление, без UI (тесты/консоль).
3. **Админ-вкладка** — список студий, сетка вариантов, генерация/выбор/удаление — первая версия, которую уже можно показать оператору.
4. **Видео-фрагмент (Grok)** — image-to-video + плеер превью в админке.
5. **Голосовой фрагмент** — переиспользование `TtsProviderResolverService`, селектор провайдера/голоса, Resemble по умолчанию.
6. **ИИ-анализ-фрагмент** — Gemini по образцу `video-audit` **[ПРАВКА 1.1: по образцу `AuctionAiAssessmentService`, см. §4.4/§10.5.4]**, связка с `BrandManifest`.
7. **Hedra как опциональный видео-провайдер** — рефакторинг `ActorsService`/`HedraClientService` для работы без `sessionId` **[ПРАВКА 1.1: рефакторинг не требуется, см. §4.2/§10.5.3 — `HedraClientService` уже вызывается без `sessionId`; шаг сводится к вызову уже существующего клиента напрямую из `VirtualStudioService`]**, флаг `VIRTUAL_STUDIO_HEDRA_ENABLED` в `/settings`, по умолчанию выключен.
8. **Модель данных живого аукциона** — миграция под дополнения §7.2 (поля на `AuctionListing`, `Bid`, состояние оркестрации). **Антиснайпер и хук на оркестратор** — дополняют уже существующий `AuctionService.placeBid()`/`promoteNextQueued()` **[ПРАВКА 1.1: было «`BidService` — приём ставок, антиснайпер (§7.3), без UI» — заменено, см. §7.3/§10.5.1: `BidService` не создаётся, ставки уже принимает `AuctionService`]**. **`LiveAuctionOrchestratorService`** — новый файл в `modules/auction/`, выбор фрагмента озвучки по событию (§7.4). **Новые методы `AuctionController`/`PublicAuctionController`/`AdminAuctionController`, SSE-эндпоинт** **[ПРАВКА 1.1: было «`LiveAuctionController`» в отдельном модуле — заменено, см. §7.6/§10.5.7]** — `GET /auctions/:listingId/stream`, `GET /auctions/:listingId/state`, `POST /admin/auctions/:listingId/studio`, без нового префикса `/api/live-auction` (§7.6). **Авто-сворачивание** — `/api/cron/live-auction-tick` по образцу уже существующих кронов в `vercel.json` (§7.5). *(Следующий этап, вне этого ТЗ)* — UI со ставками на стороне покупателя (фронтенд под SSE), вынесено за границу — это ТЗ покрывает бэкенд и админку, не покупательский интерфейс аукциона.

## 10. Аудит этого ТЗ

Проверялись технические утверждения про код чтением самого кода (не вторичные документы), внутренняя непротиворечивость с уже принятыми решениями, и совместимость с уже написанными спеками.

### 10.1. Найдено и уже исправлено в тексте выше

Первоначальная версия §4.1 утверждала, что в viral4creators нет сервиса вызова Grok Imagine — это было неверно. `backend/src/modules/generation/grok-video.service.ts` уже делает именно то, что нужно видео-фрагменту (image-to-video через `startGeneration({ imageUrl })`), и использует `GROK_API_KEY`, а не имена env из SilverFinance. Исправлено прямо в тексте §4.1 выше — оставшаяся новая часть сведена только к генерации самого референс-кадра (`/v1/images/generations`), которого в проекте действительно нет. Зачем это важно: без этой правки реализация пошла бы писать второй клиент к xAI video API рядом с уже существующим, с двойным риском расхождения при следующем изменении xAI API (в коде уже есть история таких багов — комментарий про `image` вместо `image_url` и про `video` вместо `video_url` в `grok-video.service.ts`).

Второй проход аудита нашёл и исправил ещё три места (правки уже внесены в текст выше, здесь — только сам факт и почему это была ошибка):

1. **Отсутствовала обратная связь в `BrandManifest`.** `VirtualStudioFragment.brandManifest` был добавлен без соответствующего массива на самой `BrandManifest` — `prisma validate` отказал бы такую схему. Сверено по `schema.prisma`: у `AuctionListing` точно такая же связь с `BrandManifest`, и там обратное поле (`auctionListings AuctionListing[]`) действительно есть. Исправлено в §2 добавлением явной правки существующей модели.
2. **`VirtualStudioFragmentStatus` дублировал уже существующий словарь.** В `common/types/generation.types.ts` уже есть `GenerationStatus` (pending/processing/complete/failed), и `Session.status` хранится как обычный `String`, валидируемый этим типом на уровне приложения — не как Prisma-энум. Исправлено в §2 и §3.4: `status` — `String`, значения из `GenerationStatus`.
3. **`ai-pricing.ts` не знает про `/v1/images/generations`.** В §6 было сказано «стоимость логируется там же, где уже логируются цены Grok» — но в `ai-pricing.ts` есть только позиции для видео (`grok-imagine-video-1.5:480p`/`720p`), ни одной для still-image генерации нет. Исправлено в §6 — это новая позиция, а не переиспользование существующей.
4. **Третий проход аудита нашёл и исправил ещё четыре места** (правки уже внесены в текст выше): (a) комментарий к `AuctionListing.virtualStudioId` в §7.2 утверждал, что студию к лоту привязывает продавец, что противоречило §7.6, где это admin-only эндпоинт — VirtualStudio везде в этом ТЗ описан как admin-only ресурс (§3), у продавца-криэйтора к нему нет доступа — исправлено на «назначает оператор». (b) Комментарий над `VirtualStudioFragment.liveAuctionListingId` противоречил сам себе: текст говорил «поэтому — список, не единичная ссылка», а само поле — скалярный nullable FK, а не список. Исправлено: комментарий теперь корректно описывает одиночную ссылку с переназначением. (c) В §7.3 была опечатка «длина окна 44/48ч» — сверено по `docs-tz/UGC-маркетплейс — анализ и ТЗ.md`: BLITZ — до 48 часов, без второго числа; исправлено на «48ч». (d) В §7.6 гейт публичных маршрутов был назван расплывчато — «обычная аутентификация покупателя» без имени; сверено по `portfolio.controller.ts` — это `TelegramIdentityGuard`, теперь назван явно.

### 10.2. Открытые вопросы, которые требуют проверки при реализации

1. **Ре-хостинг видео.** ~~Не проверено чтением, куда сейчас попадает готовый URL из `GrokVideoService.getStatus()` в существующем пайплайне~~ **[ПРАВКА 1.1 — см. §10.5.5: проверено и закрыто. `generation.service.ts:1656-1670` скачивает `status.videoUrl` через `fetch()` и заливает через `BlobService.uploadBuffer()` в постоянное хранилище — временная ссылка xAI НЕ используется напрямую нигде дальше. Видео-фрагмент студии обязан повторить этот же шаг rehost, не полагаться на вечность ссылки xAI.]**
2. **Серверлесс-платформа бэкенда — подтверждено, уже без оговорок.** `backend/vercel.json` содержит `crons`, то есть backend viral4creators тоже развёрнут на Vercel — и это теперь подтверждено не только косвенно (через crons), а напрямую: в проекте уже есть `FfmpegApiService` (`backend/src/modules/postprod/ffmpeg-api.service.ts`) — отдельный платный внешний API именно потому, что локального ffmpeg на Vercel Functions нет. Решение «видео и аудио хранятся отдельно, накладываются на плеере» (§8) — не запасной вариант, а сознательный выбор: платный `FfmpegApiService` технически мог бы свести видео+аудио в один файл, но при частоте вызовов этого ТЗ (каждая перегенерация в §3.3, каждая ставка в §7) это было бы существенно дороже и медленнее единственного вызова на готовое видео, для которого он сейчас и используется в `postprod.service.ts`. См. подробный разбор в §8.
3. **`PlatformSettingsService` — строка, не boolean.** `get`/`set` работают с `string | null`, не с `boolean` напрямую — флаг `VIRTUAL_STUDIO_HEDRA_ENABLED` из §3.5/§5 нужно читать как `(await settings.get(KEY)) === 'true'`, по тому же принципу, что уже делает `resolveDefaultProviderKey` для TTS-провайдера. В §3.5/§5 это не уточнено явно — стоит добавить при реализации. Проверено повторно при подготовке версии 1.1 (`platform-settings.service.ts`) — описание точное, менять нечего.
4. ~~**`ActorsService`/`HedraClientService` рефакторинг (§4.2) — самый рискованный шаг этого ТЗ.**~~ **[ПРАВКА 1.1 — см. §10.5.3: этот пункт снимается целиком. `HedraClientService.submit()`/`.status()` уже принимают только `(prompt, startImage, audioUrl, aspectRatio, resolution)`/`(jobId)` — без `sessionId` и без единой зависимости от `SessionService`. Рефакторинга нет, `actors.service.spec.ts` не затрагивается вовсе, риск отсутствует.]**

   **Конкурентность `seq` в `AuctionLiveVoiceCue` под одновременными ставками (§7.2/§7.4).** `@@unique([listingId, seq])` требует, чтобы каждая новая запись брала следующий номер последовательно, но `LiveAuctionOrchestratorService.“на каждую принятую ставку”` (§7.4) не описывает, как именно вычисляется следующий `seq`. На горячем лоте (§7.7: до сотен ставок) две почти одновременные ставки могут прочитать один и тот же текущий максимум `seq` до того, как первая запишет свою запись, и вторая получит `unique constraint` violation на `(listingId, seq)`. При реализации `AuctionService.placeBid`/`LiveAuctionOrchestratorService` **[ПРАВКА 1.1: было «`BidService.placeBid`» — переименовано вслед за правкой §7.3]** нужна сериализация по лоту (транзакция с блокировкой строки лота, либо `seq` через атомарный `increment`/advisory lock), иначе при реальной нагрузке лота часть `BID_STATS`-подсказок будет теряться на ошибках базы данных, а не бить в ответ на каждую ставку. Это не описано в §7.3/§7.4 и требует решения до кодирования, не после. Актуальность этого пункта версия 1.1 не меняет — риск реальный и относится к новой части (§7.4), которая по-прежнему нуждается в реализации.

   **[РЕШЕНО при реализации Этапа 5 — см. `AUDIT-Live-Auction-vs-SilverFinance.md`, находка 1.** `LiveAuctionOrchestratorService.emitCue()` резервирует `seq` внутри короткой транзакции с `pg_advisory_xact_lock(hashtext('live-auction-voice-cue:' + listingId))` — тот же приём, что `promoteNextQueued()` уже применяет для лимита 5/3 ACTIVE-лотов. Сам платный вызов провайдера озвучки идёт ПОСЛЕ коммита этой транзакции — лок не удерживается на время сетевого запроса. Этот пункт был единственным в §10.2, оставшимся без явной пометки о решении при переходе к версии 1.4 — исправлено здесь же, задним числом, без технических изменений.]**

### 10.3. Согласовано, не требует изменений

- **Resemble по умолчанию** (§3.3/§4.3) — совпадает с уже принятым в проекте решением `TTS-PROVIDER-ALTERNATIVES-SPEC.md §5.2`, не новое решение для проекта.
- **Модель данных** (§2) держится стиля `AuctionListing`/`Project` (cuid, soft-delete, русские `///`-комментарии над неочевидными решениями) — проверено по `schema.prisma`.
- **Отдельная таблица вариантов вместо JSON-колонки** — осознанное отклонение от SilverFinance, прямо требуемое требованием «удаление» — не противоречит образцу, так как образец этого не требовал.
- **Гейтинг Hedra через platform setting, не через env** — согласуется с прямым требованием «включаться из админки», а не из передеплоя сервера. **`AuctionListingStatus.ACTIVE` действительно так называется (§7.3)** — проверено по `schema.prisma`/`migration.sql`: `enum AuctionListingStatus { PENDING_MODERATION, QUEUED, ACTIVE, WON, EXPIRED, REJECTED, WITHDRAWN }` — `BidService.placeBid`’с `status !== 'ACTIVE'` сравнивает с реальным значением энума, а не с придуманным **[ПРАВКА 1.1: `BidService` не существует и не заводится — сравнение `status !== 'ACTIVE'` УЖЕ живёт в `AuctionService.placeBid()` (`auction.service.ts:211`), проверено при подготовке версии 1.1 — вывод по существу (что сравнение верное) не меняется, только имя сервиса]**. **`Bid.listingId` уже проиндексирован (§7.3)** — `@@index([listingId])` есть и в `schema.prisma`, и в миграции (`auction_bids_listingId_idx`) — запрос «текущая максимальная ставка по лоту» в `placeBid` не требует новой миграции для производительности.

### 10.4. Аудит добавленного §7 (живой аукцион)

Ставки/антиснайп из §7 опираются на уже существующие в коде модели (`AuctionListing`/`Bid` из §22, миграция `20261125090000_auction_stage1`), а не на придуманный с нуля domain — это проверено чтением `schema.prisma` и миграции. **[ПРАВКА 1.1: этот проход аудита проверил только МОДЕЛИ данных, но не сервисный/контроллерный слой поверх них — отсюда и пропущенная в версиях 1.0 находка §10.5.1: сами модели действительно новый domain не описывают, но СЕРВИС и КОНТРОЛЛЕРЫ поверх них к моменту третьего аудита уже существовали и не были прочитаны. Урок для будущих аудитов этого документа: «модель есть в схеме» и «сервис есть в коде» — два разных факта, и наличие одного не должно приниматься за отсутствие другого без отдельной проверки.]** Одно генуинно новое место, которое не с чем сверить по коду, так как в viral4creators её просто нет: **SSE на Vercel serverless-функциях** (§7.5, `GET /api/live-auction/:listingId/stream`). Серверлесс-функции Vercel имеют жёсткий лимит времени выполнения одного вызова (зависит от плана/рантайма), а долгоживущий SSE-коннект по определению держит функцию открытой всё время подключения. Это не проверено чтением конфига тарифного плана проекта и остаётся открытым вопросом к §10.2: если лимит слишком короткий, §7.5 придётся заменить SSE на короткий polling (клиент опрашивает `GET .../state` каждые 2—3 секунды), что требует правки §7.5 перед реализацией, не после неё.

### 10.5. Четвёртый проход аудита (версия 1.1) — против фактического кода `backend/src/modules/auction/` и смежных сервисов

Проведён отдельно, при подготовке этой версии документа, специально по прямому требованию — увидеть, что из написанного в версии 1.0 разошлось с кодом, который версия 1.0 сама же описывала. Метод тот же, что у трёх предыдущих проходов (§10.1/10.4): чтение самого кода, не пересказа. Отличие — на этот раз прочитан **весь** каталог `backend/src/modules/auction/` целиком (613+163+177+102+31 строка), а не только модели, на которые он ссылается, плюс `admin/src/app/auctions/page.tsx` и `backend/src/modules/actors/hedra-client.service.ts` целиком.

1. **Самая крупная находка: §7 и §1 неверно утверждают, что бэкенд/фронтенд аукциона не существуют.** `AuctionService` (`auction.service.ts`, 613 строк) уже реализует: подачу заявки с проверкой прав и дублей (`create`), список своих заявок и ставок (`listMine`/`listMyBids`), отзыв (`withdraw`), публичную витрину (`listPublic`/`getPublic`), ставки с проверкой текущего максимума и мгновенным `buyNowPrice`-закрытием (`placeBid`), закрытие по дедлайну с выбором победителя по резерву (`closeExpiredListings`), продвижение очереди с приоритетом BLITZ и подлимитом на брендбук (`promoteNextQueued`), полную модерацию оператором (`adminList`/`adminApprove`/`adminReject`/`adminConfirmPayment`) и self-serve чек-аут (`startCheckout`). `AuctionController`/`PublicAuctionController`/`AdminAuctionController` (`auction.controller.ts`) отдают всё это HTTP-маршрутами, под правильными гвардами (`TelegramIdentityGuard` для покупателя/исполнителя, без гварда для публичной витрины, `AdminSessionGuard` для модерации) — именно так, как §7.6 версии 1.0 ОПИСЫВАЕТ, что должно быть сделано, не понимая, что это уже сделано. `admin/src/app/auctions/page.tsx` (313 строк) — рабочая страница модерации с фильтром по статусу, одобрить/отклонить с причиной, подтвердить оплату. Отражено правками в §1, §7 (вводный абзац), §7.3, §7.6, §9 (шаг 8), §10.3, §10.4 выше.
2. **`BrandManifest.auctionListings` уже существует.** `schema.prisma:682` — `auctionListings AuctionListing[]` внутри `model BrandManifest`. §2 версии 1.0 описывает его как часть «правки, которую нужно внести» — на самом деле это уже действующее поле, рядом с которым нужно добавить только `virtualStudioFragments`. Отражено правкой в §2.
3. **`HedraClientService` уже полностью независим от `Session`.** `hedra-client.service.ts` целиком: `submit(opts: HedraSubmitOptions)` принимает только `{ prompt, startImage, audioUrl, aspectRatio, resolution }`, `status(jobId: string)` — только `jobId`. Ни `Session`, ни `sessionId`, ни `SessionService` этот файл не импортирует и не использует. Вся привязка к сессии в §4.2 версии 1.0 (фото персонажа из `session.brandManifestSnapshot`, пути Blob `sessions/${sessionId}/...`, `session.avatarVideo`, `SessionService.claimWork`) реально живёт в `ActorsService.generateAvatarVideo`/`startAvatarGeneration` (`actors.service.ts:158-420`), не в `HedraClientService`. «Самый рискованный шаг этого ТЗ» (§10.2 версии 1.0, п.4) снимается целиком — рефакторинг не требуется, `VirtualStudioService` может вызывать `HedraClientService` напрямую. Отражено правками в §4.2, §9 (шаг 7), §10.2 (п.4).
4. **`aiAssessment`/`brandManifestAiAudit` уже реализованы, а не «первая реализация идеи».** `schema.prisma` (модель `AuctionListing`) уже содержит оба поля; `AuctionAiAssessmentService` (`auction-ai-assessment.service.ts`, 177 строк) уже их заполняет по крону `auction-assess` (`cron.controller.ts:248-257`, `vercel.json`: `*/2 * * * *`), явно НЕ переиспользуя `VideoAuditService` (по документированной в самом файле причине — внешний произвольный URL видео, не внутренняя сессия) — а переиспользуя только `GeminiFilesService` и свой `fetch()`. Это и есть правильный образец для нового `analyzeStudioFragment`, у которого источник (`sourceVideoUrl`) — тоже произвольный внешний URL, а не привязанная к сессии генерация. Отражено правками в §1, §4.4, §9 (шаг 6).
5. **Ре-хостинг видео Grok — подтверждён построчным чтением.** `generation.service.ts:1656-1670`: `fetch(status.videoUrl)` → `Buffer.from(await res.arrayBuffer())` → `this.blobService.uploadBuffer(current.pathname, videoBuffer, 'video/mp4')`. Закрывает открытый вопрос §10.2 п.1 версии 1.0 однозначно: да, нужно повторить тот же rehost-шаг в видео-фрагменте студии.
6. **Реальная цена Grok Imagine image-эндпоинта найдена по первоисточнику.** `docs.x.ai/developers/pricing` (проверено 2026-09-21): `grok-imagine-image` — $0.02/img (1K), `grok-imagine-image-2.0` — $0.04/img (1K, Low quality), `grok-imagine-image-quality` — $0.05/img (1K). Закрывает открытую часть §6 версии 1.0 («нужно добавить как новую позицию … по ценам xAI на image-эндпоинт», без самой цены) — теперь есть конкретное число и источник, годные для прямой записи в `common/ai-pricing.ts` по образцу уже существующих `perCall`-записей.
7. **§7.6 предлагала отдельный HTTP-префикс `/api/live-auction`, дублирующий уже существующий `/auctions`.** Ставка уже принимается по `POST /auctions/:id/bids`. Заводить параллельный `POST /api/live-auction/:listingId/bid` для того же действия означало бы либо не использовать существующий метод (дублирование логики — риск расхождения), либо использовать (тогда сам новый маршрут не нужен, это просто алиас без причины). Реально новые маршруты этого раздела (SSE-стрим, состояние эфира, назначение студии) стоит добавлять как новые методы в уже существующие `AuctionController`/`AdminAuctionController`, под уже существующим префиксом `/auctions`/`/admin/auctions`. Отражено правками в §7.6, §9 (шаг 8).

**Что этот проход НЕ нашёл — то есть что в версии 1.0 подтвердилось при повторной проверке и не нуждается в правке:** формула антиснайпера (§7.3, п.2 — поля `extensions`/`liveStreamActive`/`virtualStudioId` в `AuctionListing` действительно отсутствуют, это по-прежнему открытая работа); лимит «5 активных / 3 эксклюзивных» (§7.7 — уже реализован в `promoteNextQueued`, число совпадает буквально); `TtsProviderResolverService`/`TtsProvider`-интерфейс (§4.3 — описание точное); `PlatformSettingsService`'а строковый (не boolean) `get`/`set` (§10.2 п.3); индекс `Bid.listingId` (§10.3). Конкурентность `seq` у `AuctionLiveVoiceCue` (§10.2, без номера пункта в версии 1.0) остаётся нерешённым и настоящим открытым вопросом реализации — это часть §7.4/§7.2, которая действительно ещё не существует в коде, поэтому находка версии 1.0 здесь не была ошибочной, просто относилась к подлинно новой части, а не к части, которая, как выяснилось, уже была готова.
