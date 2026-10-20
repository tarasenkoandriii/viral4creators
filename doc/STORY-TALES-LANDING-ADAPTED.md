# Story‑Tales — ТЗ лендинга, адаптированное к коду

Версия 1.0-adapted · 16 октября 2026 · База: main `13ba0d7`.

Исходник: [STORY-TALES-LANDING-SPEC.md](STORY-TALES-LANDING-SPEC.md) v1.0. Продуктовое ТЗ: [STORY-TALE-FAMILY-GIFT-SPEC.md](STORY-TALE-FAMILY-GIFT-SPEC.md) v1.2, §21–22.

Этот документ не меняет требований исходника. Он фиксирует, **где и как** они ложатся на текущий код, какие решения приняты для разработки (Р-STL-N), и что уходит в следующие итерации. При расхождении по смыслу продукта главнее продуктовое ТЗ; по лендингу — исходник; по месту в коде — этот документ.

## 1. Что уже есть в коде (проверено по `13ba0d7`)

| Утверждение исходника | Состояние в коде |
|---|---|
| §2 профиль рассказчика в брендбуке, фото/скетч, независимый голос | Есть: `frontend/src/features/brand/NarratorProfile.tsx`, `backend/src/modules/brand-manifest/narrator-preamble*.ts`, `BrandManifest.tts*`, `ImageSketch` |
| §2 преамбула Tutorial — одобренный MP4 5–10 с, ≤ 20 МБ | Есть с `13ba0d7` (`narrator-preamble.ts`, миграция `20261016120000_narrator_preamble`, сборка в `tutorial-video-assembly.ts`) |
| §4 раздел TMA `#/stories`, четыре направления меню | Есть: `frontend/src/lib/router.ts` (`ProductArea = commerce | greetings | tutorials | stories`), `App.tsx`, `features/products/ProductHub.tsx` — честный информационный раздел («Полный генератор сказок ещё в разработке», кнопка «Настроить рассказчика») |
| §4 переход в TMA с языком и меткой источника | Частично: метки — закрытый список `LANDING_ENTRIES = ads | greetings | site-tutorial` (`frontend/src/features/projects/landing-entry.ts`, зеркало `landing/src/lib/telegram-entry.ts`); язык TMA из URL не читает (localStorage → `language_code` Telegram → `ru`) |
| §2 Nova `a9fc5a41` — глобальный дефолт | `RESEMBLE_VOICE_ID`, `postprod.tutorialVoice`, `voice_assistant_voice`; лендинг их не читает и не меняет |
| §2 забракованный Kling | Сессия `benchmark-kling-c9ae6a7dce8e6ab98bed5f97aa2de753`, видео `e64cdbd5-7364-40a8-927b-7c26c760a844` (Blob `…/sessions/benchmark-kling-…/generated-e64cdbd5-….mp4`); в `publisher-site/`, `landing/`, `sites-landing/` ссылок нет |
| §11 `GET /public/story-capabilities` | Нет (в продуктовом ТЗ тоже нет) |
| §8 демо, постер, субтитры, транскрипт Story‑Tales | Нет ни одного одобренного материала |
| Мастер сказки, каталог редакций, согласия, оплата, семейный клон | Нет (продуктовое ТЗ §12–13: «ещё не реализованные») |

Итог: лендинг сейчас может выйти только в **режиме §5.1 «Подготовка без разрешённого демо»**, без формы и без покупки.

## 2. Решения для разработки (Р-STL)

| № | Решение | Почему |
|---|---|---|
| Р-STL-1 | **Хост — `publisher-site/` (ai-publisher.org)**, маршруты `/ru/stories` и `/uk/stories`. Не `landing/`. | Так в исходнике §4; домен уже работает (Vercel `ai-publisher-site`, хост подтверждён в site-core). Страницы `landing/[locale]/*` индексируются (`robots index:true`) и несут бренд генератора — для всегда-noindex семейной страницы это хуже. |
| Р-STL-2 | **Отдельная route group со своим root layout**: текущие страницы переезжают в `app/(publisher)/…` без изменения URL, Story‑Tales — `app/(stories)/ru/stories`, `app/(stories)/uk/stories` (статические папки, без верхнего `[locale]`, чтобы не ловить чужие пути). | Текущий `layout.tsx` жёстко `lang="uk"`, бренд AI Publisher, баннер «closed» и `getSiteConfig()`. Story‑Tales не должна зависеть от продукта AI Publisher и падать при недоступном API. `not-found.tsx` переносится в группу `(publisher)`. |
| Р-STL-3 | **Режим выпуска v1 — версионируемый конфиг в репозитории**: `publisher-site/src/stories/release.ts` (типизированный объект + валидатор формы, ревью через PR). Поля — как в исходнике §11 (`releaseMode`, `locales`, `demo`, `audioDemo`, `captions`, `transcript`, `catalogEnabled`, `leadFormEnabled`, `wizardEnabled`, `checkoutEnabled`, `familyVoiceEnabled`, `syntheticVideoEnabled`, `wizardUrl`, `legalLinks`, `contentVersion`). Невалидный или неизвестный конфиг → безопасный режим `prep` (§5.1). | Исходник §11 разрешает конфиг с ревью до авторизованной настройки. Образец — `sites-landing/assist-plans.snapshot.json` + проверка формы. Эндпоинт `GET /public/story-capabilities` — итерация 2 (Р-STL-12). |
| Р-STL-4 | **v1: `releaseMode = prep`**, `leadFormEnabled = false`, `wizardEnabled = checkoutEnabled = familyVoiceEnabled = syntheticVideoEnabled = false`. Основной CTA — «Как это работает» (якорь), без Play, без формы, без цены. | Демо нет; форма — решение владельца «без формы». |
| Р-STL-5 | **Noindex всегда**, независимо от `PUBLISHER_INDEXING` и гейта сайта: в `next.config.js` `headers()` — отдельное правило ПОСЛЕ общего `/:path*` для `/(ru|uk)/stories/:path*` и `/stories-media/:path*` с `X-Robots-Tag: noindex, nofollow, noarchive`; в метаданных страниц `robots: { index:false, follow:false, nocache:true }`; маршрут не добавляется в `sitemap.ts`. Без canonical (исходник §12: canonical — после выбора адреса; на noindex-странице он не нужен), `hreflang` ru↔uk только между существующими локалями. | Исходник §12 + `noarchive` из продуктового ТЗ §11. Сейчас `X-Robots-Tag` ставится одним правилом и снимается при индексации всего сайта. |
| Р-STL-6 | **Медиа — только из `publisher-site/public/stories-media/`** (под noindex-правилом и `media-src 'self'`). Vercel Blob для материалов лендинга не используется. | На Blob нельзя поставить `X-Robots-Tag` (продуктовое ТЗ §11). Статика Vercel отдаёт Range/206 с заголовками правила — проверить curl на проде (ST-LPL-10). Медиа — после одобрения (Р-STL-9). |
| Р-STL-7 | **CSP**: добавить `media-src 'self'` явно (сейчас — fallback на `default-src`); внешних источников не добавлять. `Referrer-Policy` страниц Story‑Tales — `no-referrer`. | Продуктовое ТЗ §11; внешние медиа запрещены Р-STL-6. |
| Р-STL-8 | **Аналитика v1 — не отправляется.** Компонент `Track` и события Publisher в группу Story‑Tales не подключаются. | События Publisher принадлежат продукту AI Publisher (смешали бы его отчёты), сервер отклоняет их при `mode=closed`, имена событий закрыты списком (`PUBLISHER_EVENT_NAMES` + CHECK в БД), произвольных параметров нет. Исходник §13 допускает «ноль событий». События `story_*` — итерация 2 (Р-STL-12). |
| Р-STL-9 | **Допуск материалов — только по записи в конфиге с `approvalId`, источником и правами**; тест сборки отклоняет любой URL/идентификатор, содержащий `kling`, `benchmark-`, `sessions/`, `e64cdbd5-7364-40a8-927b-7c26c760a844`, и любой внешний хост. | Исходник §2, ST-LP-11. Механизм одобрения — по образцу `TutorialVideoAsset.reviewed` + `tutorial.siteTutorialDemoAssets`, но отдельно от B2B-таблицы Tutorial (продуктовое ТЗ §20.3). В v1 записей нет. |
| Р-STL-10 | **Переход в TMA v1 — только ссылка на информационный раздел `#/stories`** через закрытую метку `stories`: добавить её в `LANDING_ENTRIES` (frontend + зеркало landing) с переходом на маршрут `stories`, а не на создание проекта; язык передаётся как сейчас (`language_code`/выбор пользователя), в URL — только метка. Ссылка — вторичная, в блоке «Как это работает» («Посмотреть раздел в приложении»), не «Создать сказку». | Исходник §4: до мастера — честный раздел; ПД в URL запрещены. Раздел уже существует. |
| Р-STL-11 | **Название в интерфейсе — «Story‑Tales»** (с неразрывным дефисом), заголовок — из исходника («…с обращением близкого человека»), вторичный CTA — «Как это работает» / «Як це працює». | Исходник от 16.10 — более поздний и согласован с правилом продуктового ТЗ «не обещать чтение всей сказки голосом близкого». |
| Р-STL-12 | **Итерация 2 (не v1):** `GET /api/public/story-capabilities` в **backend** (там голоса, персоны, флаги и `PlatformSetting`), запрос серверный при сборке/ISR (без Origin, без CORS); события `story_*` (отдельная таблица или существующий журнал backend, не Publisher); заявка на пилот; режим §5.2 с демо. | Каждое требует собственной серверной приёмки. |
| Р-STL-13 | **Нумерация приёмки**: сценарии исходника §15 получают префикс `ST-LPL-01…15` (L — landing), чтобы не путаться с `ST-LP-01…06` продуктового ТЗ §21. | Совпадающие номера с разным смыслом. |
| Р-STL-14 | **Подвал**: оператор и контакты — из уже опубликованных юридических данных платформы; ссылки «Условия», «Приватность», «Правила согласия рассказчика» ведут только на существующие страницы. Пока страниц именно Story‑Tales нет — ссылки на общие документы платформы (`landing/src/app/legal/[slug]`, адреса `/legal/<slug>` основного сайта) с пометкой; пустых заглушек нет. | Исходник §6.11. Тексты юридических страниц Story‑Tales — решение владельца (§6 этого документа). |

## 3. Объём v1 (режим `prep`)

### 3.1. Страница

Блоки исходника §6 в режиме §5.1:

| Блок | В v1 |
|---|---|
| 6.1 Шапка | Логотип-текст Story‑Tales, якоря «Как это работает», «Вопросы», переключатель RU/UK (сохраняет якорь). Якорь «Пример» — только когда есть демо. |
| 6.2 Hero | Заголовок/подзаголовок/микротекст исходника; бейдж «Готовим семейный пилот»; справа (mobile — ниже) иллюстрация с видимой подписью «Иллюстрация формата», без кнопки Play. |
| 6.3 Пример | Схема «Личное обращение → Сказка → Завершение» без медиа, с подписью «Пример появится после одобрения записи». |
| 6.4 Кому подойдёт | Три карточки сценариев §3, без фото детей. |
| 6.5 Как это работает | Четыре шага, помечены «планируемый путь»; вторичная ссылка на раздел TMA (Р-STL-10). |
| 6.6 Рассказчик | Три пункта исходника; карточка «Фото или скетч» без технических полей. |
| 6.7 Каталог | «Каталог готовится» + объяснение выбора. |
| 6.8 Контроль и приватность | Текст исходника, без «полностью приватно». |
| 6.9 Цена/пилот | «Семейный пилот» со статусом «готовим», без цен. |
| 6.10 FAQ | Все 10 вопросов, ответы в будущем времени для недоступного; `<details>` без JS (как `Faq.tsx`). |
| 6.11 Финал и подвал | Один CTA «Как это работает» (наверх к блоку); подвал по Р-STL-14. |

### 3.2. Код

- `publisher-site/src/app/(publisher)/…` — перенос существующих маршрутов без изменения URL и поведения.
- `publisher-site/src/app/(stories)/layout.tsx` — свой root layout (`lang` по сегменту, свои метаданные, без `getSiteConfig`, без `Track`); `(stories)/ru/stories/page.tsx`, `(stories)/uk/stories/page.tsx` — тонкие обёртки над общим `StoriesPage`.
- `publisher-site/src/stories/` — `release.ts` (конфиг + валидатор + безопасный откат), `copy.ru.ts`, `copy.uk.ts` (типизированные словари одной формы), `cta.ts` (матрица режим → CTA), компоненты страницы, `stories.css` (токены «тёплая бумага»: свои переменные в пределах группы, светлая/тёмная по `prefers-color-scheme`, `prefers-reduced-motion`, safe-area).
- `publisher-site/next.config.js` — правило noindex (Р-STL-5), `media-src 'self'` (Р-STL-7), `no-referrer` для stories.
- `frontend/src/features/projects/landing-entry.ts`, `landing/src/lib/telegram-entry.ts` — метка `stories` → маршрут `#/stories` (Р-STL-10) + тесты зеркала.
- Плеер (§9) в v1 не публикуется (нет демо), но компонент можно сделать за флагом `demo` с тестами — не обязательно для v1.

### 3.3. Тесты и CI

- Юнит (`publisher-site/scripts/*.test.ts`): матрица режимов → CTA (нет «Создать»/покупки при выключенном мастере, нет Play без демо); валидатор конфига (неизвестный/битый → `prep`); безопасный `wizardUrl` (только разрешённый хост); паритет словарей RU/UK (одинаковые ключи, непустые); запреты текста (гарантии, отзывы, %, цены — как `dictionaries.test.ts`); запрет Kling/внешних/`sessions/` в конфиге (Р-STL-9).
- `check-built.ts`: ветка stories — `X-Robots-Tag: noindex, nofollow, noarchive` даже в indexable-сборке, `meta robots`, нет canonical, нет в sitemap, `lang` по локали, `no-referrer`; существующие проверки страниц AI Publisher без изменений.
- `first-load-js.mjs`: учесть route groups (чанк layout меняет имя) и отдельный бюджет stories.
- `axe-check.mjs`: + `/ru/stories`, `/uk/stories`, ширины 360/390/768/1440, light/dark; `lighthouserc.cjs`: stories без SEO-порога (всегда noindex), с порогами производительности/доступности.
- Прод-проверка после выкладки: `curl -sI` и `curl -sI -H 'Range: bytes=0-1'` для страниц и медиа (когда появятся), `/ru/stories/` (308) — заголовки (ST-LPL-10).

## 4. Приёмка v1

Из исходника §15 в v1 проверяются: ST-LPL-01, 02, 05, 06, 07, 09, 10, 11, 12, 14, 15 (13 — замеры LCP/CLS/INP записываются, бюджет исходника). ST-LPL-03, 04 (демо) и 08 (заявка) — «не применимо в `prep`», проверяется отсутствие соответствующих элементов.

## 5. Итерации после v1

1. **Демо (§5.2):** одобренная запись + постер + аудио + субтитры + транскрипт в `public/stories-media/` с записью происхождения и `approvalId`; плеер §9; CTA «Посмотреть пример».
2. **Сервер (Р-STL-12):** `GET /api/public/story-capabilities` в backend + переключение лендинга на серверный режим с откатом на `prep`; события `story_*`.
3. **Заявка на пилот:** обработчик с идемпотентностью и антиспамом (кандидат — существующий приём лидов; выбор при постановке), уведомление об обработке данных, политика хранения.
4. **Мастер/оплата (§5.3–5.4):** только после сквозной приёмки продукта.

## 6. Вопросы владельцу (не блокируют v1)

1. Юридические страницы именно Story‑Tales (условия, приватность, правила согласия рассказчика): писать отдельные или ссылаться на общие документы платформы?
2. Иллюстрация hero: рисуем собственную демонстрационную (с подписью) или ждём разрешённую съёмку?
3. Подтвердить, что вторичная ссылка «Посмотреть раздел в приложении» (TMA `#/stories`) в режиме `prep` нужна.

## 7. Решения 16.10 (вечер): поддомен и 5 локалей

Решения владельца после адаптации; где они расходятся с разделами 2–4, главнее этот раздел.

| № | Решение |
|---|---|
| Р-STL-1′ | **Р-STL-1 заменён.** Хост — **`landing/`**, поддомен **`story-tales.viral4creators.app`** — ровно по образцу поздравлений и обучалки: `landing/src/lib/stories-host.ts` (`NEXT_PUBLIC_STORIES_HOST` с дефолтом, `STORIES_SITE_URL`, `isStoriesHost`), строка `stories` в таблице `SUBDOMAIN_SITES` (`landing/src/middleware.ts`): `/<locale>` поддомена — rewrite в `/<locale>/stories`, `/<locale>/stories` на поддомене — 308 в `/<locale>`, на главном домене — 308 на поддомен. `publisher-site/` не затронут. |
| Р-STL-1″ | **Локали — все пять локалей landing: ru, uk, en, de, es, с одинаковой полнотой.** RU/UK — заголовок, подзаголовок и микротекст дословно из ТЗ §6–7; EN/DE/ES — перевод того же смысла без новых обещаний. hreflang — между пятью локалями, `x-default` → `ru`. Тексты — отдельными модулями `landing/src/lib/stories/copy/*.ts` (не в общих `dictionaries/*.json`: те уходят в RSC-данные каждой страницы). |
| Р-STL-5′ | Canonical теперь **есть**: адрес выбран (§12 ТЗ разрешает) — `https://story-tales.viral4creators.app/<locale>`. Noindex — всегда: meta `noindex, nofollow, noarchive` (замещает `robots: index` из `[locale]/layout.tsx`), `X-Robots-Tag` — `next.config.js` (`has: host` на весь поддомен, `/<locale>/stories[/*]` главного домена, `/stories-media/*`) + `middleware.ts` (каждый его ответ для Story‑Tales: 308, rewrite, корень). `sitemap.xml` поддомена пуст, главного — без `stories`; `robots.txt` обход не закрывает. |
| Р-STL-15 | **Слова и рамки «пилот» на странице нет** (все 5 языков, включая FAQ, бейдж, подвал). Статус — **«Скоро запуск»** (бейдж первого экрана) и блок **«Запуск»** (`#launch`): «Уже сейчас» (раздел Story‑Tales в приложении, профиль рассказчика — образ и голос) и «Появится к запуску» (мастер, каталог, одобренный пример, цена и сроки), примечание «сейчас ничего не продаётся и не списывается». Технический режим конфига остаётся `prep`; CTA формы заявки — «Узнать о запуске» (`lead`, только с обработчиком). Ответ FAQ о цене: «Цена появится к запуску; сейчас ничего не продаётся и не списывается». Запрет слова держит `stories-copy.test.ts` и `stories-page.test.ts`. |
| Р-STL-16 | **Слоган владельца** — «Всё лучшее — детям» / «Усе найкраще — дітям» / «All the best for children» / «Das Beste für die Kinder» / «Lo mejor para los niños» — над заголовком первого экрана и в финальном блоке (`copy.tagline`, курсив, без обещаний качества или эффекта; на OG-карточке тоже). |
| Р-STL-17 | **Основной CTA `prep` — раздел TMA `#/stories`**: «Открыть в Telegram» (`t.me/<бот>/app?startapp=e_stories`, нужен `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`), без бота — «Открыть приложение» (`TMA_URL?entry=stories#/stories`, если TMA_URL настоящий). «Как это работает» — вторичный якорь. Рядом подпись: в приложении уже можно настроить профиль рассказчика — образ (фото или скетч) и голос; создание сказки появится позже. Нет ни бота, ни адреса TMA — **откат**: основным становится якорь «Как это работает». Логика — `resolveStoryView(config, readiness, links)` и `appCta` в `cta.ts` (принимает только ссылки с меткой `stories`); «Создать сказку» по-прежнему только при `wizardEnabled` + разрешённом `wizardUrl`. |
| Р-STL-18 | **Юридические ссылки** — существующие `/legal/offer` и `/legal/terms-of-use` (на главный домен при заданном `SITE_URL`, иначе той же сборки); с 20.10.2026 — и `/legal/story-tales-rules` (Правила Story‑Tales, приложение к оферте; `release.json` `legalLinks.narratorConsent`). **OG-карточка — своя**: `landing/public/og/stories-<locale>.jpg` (1200×630, ~45–55 КБ) — рисунок первого экрана, марка, слоган, заголовок и бейдж (с 20.10.2026 — пилотный «Пилот по приглашению», `copy.access.pilot.badge`: карточки отдаются только в режимах лендинга `pilot`/`public`). `opengraph-image.tsx` не используется (тот же довод, что у карточек обучалки: маршрут `/<locale>/stories` прошёл бы через переписывание middleware, а `socialMeta()` задаёт картинку явно); генератор вне приложения — `landing/scripts/og-stories-cards.tsx` (headless-Chromium + ImageMagick/ffmpeg), отпечаток текстов — `landing/scripts/og-stories-cards.lock.json`, сверяет `stories-page.test.ts`. |
| Р-STL-19 | **Контакт в подвале — Telegram-бот платформы** (та же `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`, что у основной кнопки; нет бота — нет строки контакта, выдуманный адрес не подставляется). Ссылки — `/legal/offer`, `/legal/terms-of-use`; фраза «Реквизиты — в Договоре оферты» убрана: реквизиты §12 оферты (`doc/legal/offer.md:382-387` — регистрационные данные, налоговый статус, e-mail, сайт) стоят как «_указать перед публикацией_». Заполнить их — задача владельца (doc/TODO.md). Правки по аудиту 16.10 (S3-1…S3-10, кроме S3-7): `wizardUrl` — путь `/`, `entry` из `LANDING_ENTRIES`, `startapp` в формате входа, фрагмент из белого списка; признаки Kling — только в адресах и `approvalId`; FAQ о несуществующем — будущим временем; тексты о приложении — только при ссылке в него; noindex на `/og/stories-*.jpg` любого хоста; Esc в меню языка. |

**Что из §3.2 переехало из `publisher-site/` в `landing/`:**

- route group `(publisher)` и перенос маршрутов AI Publisher **не нужны**; группа `(stories)` — **нужна** с 20.10.2026 (находка S3-7: общий `[locale]/layout.tsx` отдаёт клиентскому провайдеру словарь главной, и он уходил в RSC-данные страницы). Страница — `landing/src/app/(stories)/[locale]/stories/page.tsx` (адрес тот же, `/<locale>/stories`) под своим `(stories)/[locale]/layout.tsx`: `<html lang>` через `HtmlDocument`, без словаря главной; `stories/layout.tsx` только подключает `stories.css`. Режим лендинга — `STORY_TALES_LANDING` (`closed`/`pilot`/`public`, `lib/stories/landing-mode.ts`, `doc/DEPLOYMENT.md` §4.1);
- `publisher-site/src/stories/*` → `landing/src/lib/stories/`: `release.json` + `release.ts` (конфиг, валидатор, откат на `prep`, запрет Kling/внешних), `cta.ts` (матрица режимов), `copy/` (пять локалей);
- noindex/`no-referrer` — `landing/next.config.js` (до этого у landing `headers()` не было) и `landing/src/middleware.ts`, а не `publisher-site/next.config.js`;
- CSP/медиа — по `landing/`: у landing CSP нет (добавлять её ради одной страницы не стали — `scripts/assist-widget.test.ts` требует, чтобы появившаяся CSP включала origin виджета); медиа — только `landing/public/stories-media/` под тем же `X-Robots-Tag` (в v1 папки нет);
- тесты — `landing/scripts/stories-{release,copy,page,noindex,closed,landing-mode,capabilities}.test.ts` (вместо `publisher-site/scripts/*` и `check-built.ts`); бюджет JS — строка `/(stories)/[locale]/stories/page` в `landing/scripts/first-load-js.mjs`; axe/Lighthouse у landing в CI нет — ручная проверка (ST-LPL-12/13);
- аналитика: у landing глобальных счётчиков нет — исключать нечего; страница не подключает консультанта и `next/script` (стережёт `stories-page.test.ts`);
- метка TMA `stories` — без изменений (Р-STL-10): `frontend/src/features/projects/landing-entry.ts` (`ENTRY_SECTION_ROUTES`, `entryHashRoute`) и зеркало `landing/src/lib/telegram-entry.ts` (`ENTRY_HASH_ROUTES`), браузер `?entry=stories#/stories`, Telegram `startapp=e_stories` → тот же адрес;
- подвал — существующие `/legal/offer` и `/legal/terms-of-use` (приватность — раздел 7 Условий); отдельных правил согласия рассказчика нет — сказано текстом, без пустой ссылки (вопрос 6.1 открыт).

**Известное ограничение:** встроенный 308 Next с хвостового слэша (`/ru/` → `/ru`, `/ru/stories/` → `/ru/stories`) рождается до middleware, и под `next start` заголовки `headers()` к нему не применяются (Next отдаёт редирект без них). Цель редиректа noindex несёт; проверка на Vercel — curl по публичному адресу после выкладки (doc/DEPLOYMENT.md §4.1).

