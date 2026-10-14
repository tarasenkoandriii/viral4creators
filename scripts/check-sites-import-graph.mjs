#!/usr/bin/env node
/**
 * Правило графа зависимостей sites-backend (ТЗ помощника §4.3-бис, слой 2
 * изоляции «Сайт»/«Админка», К-9; §4.2 ред. 1.4; приёмка Э0: «CI падает на
 * импорте assist-admin-* из assist-site-*»).
 *
 * Слой 2 ловит ошибку разработчика «вызвал не тот репозиторий»: код
 * режима «Сайт» физически не может дотянуться до знаний «Админки», потому
 * что не может их импортировать. Роль БД (слой 3) ловит то, что прошло
 * мимо, — но падение сборки дешевле и раньше, чем отказ Postgres в проде.
 *
 * Правила (модуль = папка `sites-backend/src/modules/<имя>/`):
 *  1. «Сайт» ↛ «Админка»: `assist-site-*`, `assist-widget`,
 *     `assist-analytics`, `assist-voice-map`, `site-crawl` не импортируют
 *     `assist-admin-*` (§4.3-бис, §4.2 1.4, У-9).
 *  2. «Админка» ↛ «Сайт»: `assist-admin-*` не импортируют модули режима
 *     «Сайт» из п.1, кроме общего с QA `site-crawl` — «Админка» по Р-19
 *     индексирует те же публичные страницы (таблица §5-кватер «Код»;
 *     §4-бис.8 «и наоборот»).
 *  3. `assist-ui-core` — нейтральный, без доступа к БД: не импортирует ни
 *     `assist-site-*`, ни `assist-admin-*` (§5-бис.3 п.3, У-19).
 *  4. `src/shared/**` (копии чистых модулей backend/) не импортирует
 *     `src/modules/**`: иначе «чистая» копия тянула бы за собой продукт.
 *  5. (Э1) Нейтральные модули `assist-knowledge-core` (чанкер, эмбеддинги,
 *     гибридный поиск, версии — по таблицам, имена которых передаёт модуль
 *     режима) и `site-ai` (клиенты Gemini, учёт расходов, бюджет обучения)
 *     не импортируют модули режимов (`assist-site-*`, `assist-admin-*`,
 *     `assist-sandbox`, `assist-widget`).
 *  6. (Э1) `site-crawl` общий с QA: не импортирует ни один продуктовый
 *     модуль (`assist-*`, `qa-*`). Продукты сами решают, что и когда
 *     обходить, и сами читают `site_pages`.
 *  7. (Э1) Имена таблиц и моделей чужого режима в КОДЕ модуля (не в
 *     комментариях): в модулях режима «Сайт» нет `assist_admin_…`,
 *     `AssistAdmin…`, `prisma.assistAdmin…`; в «Админке» — `assist_site_…`,
 *     `AssistSite…`, `prisma.assistSite…`; в нейтральных — ни тех, ни
 *     других. Это слой 2 для сырого SQL: импорт репозитория правило 1
 *     ловит, а строку `FROM "sites"."assist_admin_chunks"` — только это.
 *  8. (Э2) `public-db`: ПУБЛИЧНЫЙ код виджета — модуль `assist-widget`
 *     (кроме папки `cabinet/`) и `assist-site-chat` (кроме папки `system/`)
 *     — не импортирует клиентов основной роли (`prisma/sites-db.service`,
 *     `prisma/prisma.service`) и сервисы, которые ходят ими в базу
 *     (`assist-site-knowledge/site-knowledge.service`, `…/site-sources.service`,
 *     `site-core/ownership/host-access.service`). Слой 3 (§4.3-бис):
 *     маршрут посетителя работает ТОЛЬКО под assist_public (AssistPublicDb),
 *     и случайный «удобный» импорт основного клиента — дыра, которую роль
 *     БД уже не поймает. Спеки и `testing/` — можно (тесты сеют данные
 *     владельцем схемы). Э3: публичные зоны — ещё папки `public/` модулей
 *     `assist-site-handoff`, `assist-site-learning`, `assist-analytics`.
 *  9. (Э3) `public-zone-e3`: публичный код (все зоны правила 8) берёт из
 *     ДРУГИХ модулей Э3 (`assist-site-handoff`, `assist-site-learning`,
 *     `assist-analytics`, `assist-digest`) только `public/**`, типы
 *     (`*types.ts`), чистые настройки (`*-config.ts`) и `*.module.ts`
 *     (проводка DI). Сервисы кабинета и
 *     системы этих модулей ходят основным клиентом — транзитивный импорт
 *     правило 8 не видит (оно проверяет прямой импорт клиента). Внутри
 *     СВОЕГО модуля публичная часть может звать свой `system/` по id (как
 *     лид Э2 → LeadDelivery) — это граница модуля, её держит ревью.
 * 10. (Э3) `digest-leaf`: модуль `assist-digest` — единственный, кто
 *     собирает числа «Сайта» и «Админки» в одно сообщение (раздел
 *     «Админка» — только assistAdmin: owner, У-27); его не импортирует ни
 *     один модуль — иначе «Сайт» получил бы путь к данным «Админки» через
 *     оркестратор.
 * 11. (Э4) `public-zone-e4`: публичный код (зоны правила 8 и папка
 *     `public/` модуля `assist-billing`) берёт из `assist-billing` только
 *     `public/**`, чистые `plans`, `units`, `subscription-state`, типы и
 *     `*.module`: кабинет тарифа, оплата и крон ходят основным клиентом
 *     (и держат секреты провайдеров), а квота виджета — только под
 *     assist_public (assist-billing/public/entitlements.ts).
 * 12. (Э-С Ш1) `internal-sites-scope` / `internal-sites-leaf`: модуль
 *     `internal-sites` (внутренний API обучалки генератора, HMAC) берёт из
 *     модулей только `site-core` и `telegram-auth`, и его не импортирует
 *     никто: канал «генератор → кабинет» действует от имени любого
 *     telegramId и не должен становиться входом в помощник или QA.
 * 14. (Э-С Ш2) зона секретов: `site-credentials-scope` — модуль
 *     `site-credentials` (тестовые учётки сайта и хранилище их секретов)
 *     берёт из модулей только `site-core` и `telegram-auth`;
 *     `credentials-zone` — импортировать его могут только `internal-sites`
 *     (канал генератора) и `qa-*` (аренда `qa-login`), ни один модуль
 *     помощника и ни один публичный код; `credentials-crypto-private` —
 *     `site-credentials/credential-crypto` (ключи и расшифровка) не
 *     импортирует никто вне модуля; `credentials-names` — имён таблиц и
 *     моделей хранилища нет в коде других модулей (сырой SQL мимо сервиса).
 *     Э7: `assist-admin-crawl` (обход админки за логином, opt-in) — третий
 *     допущенный потребитель: читает реестр учёток без секретов; аренду
 *     возьмёт браузерный воркер Ш3. Прочие `assist-admin-*` — нет.
 * 13. (Э5) `public-zone-e5`: голос посетителя — папка `public/` модуля
 *     `assist-site-voice` — публичная зона правила 8 (только assist_public);
 *     публичный код других модулей берёт из `assist-site-voice` только
 *     `public/**`, типы, `*-config` и `*.module`: кабинет голоса
 *     (`cabinet/`) ходит основным клиентом.
 *     Э-С Ш4: основной ролью ходят и `site-core/ui-map/ui-map-store`,
 *     `…/ui-map-maintenance.service` (запись и сводка общей карты) — их
 *     публичный код не берёт (из ядра карты — только чистые `ui-map`,
 *     `ui-map-model`).
 * 14. (Э6) `public-zone-e6`: видео и подсветка посетителя — папка `public/`
 *     модуля `assist-site-media` — публичная зона правила 8; публичный код
 *     других модулей берёт из `assist-site-media` только `public/**`, типы,
 *     `*-config` и `*.module`: кабинет экрана «Видео» (`cabinet/`) ходит
 *     основным клиентом.
 * 15. (Э6-бис) `ui-core-no-db` / `ui-core-names`: нейтральный пакет
 *     голосового управления `assist-ui-core` (снимок, словарь действий,
 *     проверки плана, промпт — §5-бис.3 п.3, У-19) — БЕЗ доступа к базе: не
 *     импортирует ни `prisma/**`, ни `@prisma/client` и не называет таблиц
 *     режимов (их передаёт модуль своего режима). Вместе с правилом 3
 *     (`ui-core-neutral`) это и есть «пакет `assist-ui-core` и правило графа»
 *     аудита 1.2.
 * 16. (Э6-бис) `public-zone-e6b`: план посетителя — папка `public/` модуля
 *     `assist-site-voice-control` — публичная зона правила 8; публичный код
 *     других модулей берёт из него только `public/**`, типы, `*-config` и
 *     `*.module`: кабинет переключателя и правил (`cabinet/`) ходит
 *     основным клиентом.
 *
 * 17. (Э6-бис (е)) `memo-public-views`: публичный код (зоны правила 8)
 *     не называет таблиц и моделей мемо (`assist_site_memos`,
 *     `assist_site_memo_versions`, `assist_site_memo_changes`,
 *     `assist_site_phrases`, `AssistSiteMemo…`, `AssistSitePhrase`):
 *     черновики, история и индекс фраз — только кабинету; публичный код
 *     читает ТОЛЬКО представления `assist_site_memo_published` и
 *     `assist_site_memo_checks` (§5-бис.17 п.12). Слой 2 к правам роли
 *     (слой 3, миграция _assist_chains_memo).
 *
 * 18. (Э6-тер) `voice-map-public-views`: публичный код (зоны правила 8)
 *     не называет таблиц и моделей голосовой карты (`assist_site_voice_maps`,
 *     `assist_site_voice_map_versions`, `assist_site_voice_map_changes`,
 *     `assist_site_voice_map_editor_sessions`, `AssistSiteVoiceMap…`):
 *     черновик, версии, журнал и сессии редактора — только кабинету и панели
 *     `we.` (основная роль); публичный код читает ТОЛЬКО представление
 *     `assist_site_voice_map_published` (§5-кватер.9, миграция
 *     _assist_visual_editor). Модуль `assist-site-voice-map` — режим «Сайт»
 *     (правило 1 по префиксу `assist-site-`).
 *
 * 19. (Э-С Ш3) браузерный воркер: `browser-jobs-neutral` — очередь заданий
 *     воркера (`browser-jobs`) берёт из модулей только `site-core` и
 *     `telegram-auth` (продукты регистрируют обработчики сами);
 *     `browser-jobs-zone` — ставить задания могут только канал воркера
 *     `internal-worker`, канал генератора `internal-sites`, обход «Админки»
 *     `assist-admin-crawl`, голосовая карта `assist-site-voice-map` и
 *     `qa-*`; публичный код и прочие модули — нет; `internal-worker-scope` /
 *     `internal-worker-leaf` — канал воркера (`/internal/worker/v1/*`) берёт
 *     только `browser-jobs`, `site-credentials`, `site-core`,
 *     `telegram-auth`, и его не импортирует никто; `worker-seal-private` —
 *     запечатывание секретов под ключ воркера
 *     (`browser-jobs/worker-seal`) — только `browser-jobs` и
 *     `internal-worker`; `browser-jobs-names` — имён таблиц/моделей очереди
 *     нет в коде других модулей (только через сервис). `internal-worker` —
 *     четвёртый допущенный потребитель `site-credentials` (аренда
 *     `assist-admin-login`).
 *
 * 20. (AI Publisher, P-A0; doc/ai-publisher/IMPLEMENTATION-DESIGN.md §5.1)
 *     `publisher-scope` — модуль `publisher` берёт из модулей только
 *     `site-core`, `site-ai`, `site-crawl`, `telegram-auth` и ровно два
 *     чистых файла `assist-knowledge-core/{injection,notify}`; `publisher-leaf`
 *     — его не импортирует ни один модуль (Publisher не прорастает в помощник
 *     и QA); `publisher` — в PRODUCT_MODULES/MODE_MODULES (site-crawl и
 *     нейтральные site-ai/assist-knowledge-core его не берут); папка
 *     `publisher/public/` — публичная зона правила 8 (`public-db`), её клиент
 *     — только `prisma/publisher-public-db.service` (`publisher-public-db`:
 *     не AssistPublicDb), а сам этот клиент берёт только `publisher/public/**`
 *     и спеки/`testing/` модуля (`publisher-public-db-zone`); публичный код
 *     из других папок `publisher` берёт только `contracts/**`, чистые
 *     `core/{kyiv-time,money,utm,contact-crypto,clock}` и `*.module`
 *     (`publisher-public-zone`) и называет только таблицы/представления
 *     приёма (`publisher-public-names`); код `publisher/ai/**` не берёт
 *     заявки, распространение, согласования, параметры, роли и гейты
 *     (`publisher-ai-no-authority`); в `publisher` нет имён таблиц/моделей
 *     помощника и QA, в `assist-*`/`qa-*` — Publisher (`publisher-names`,
 *     `assist-names`; имена — из schema.prisma).
 *     Пакет P-R (Reddit Manual MVP, doc/ai-publisher/reddit-manual-mvp-
 *     adapted.md §M1.0, §8.3): `publisher/reddit/**` не берёт `site-crawl/**`
 *     (там `pinned-fetch`), импорт источников по URL и ревалидацию сайта
 *     (`publisher-reddit-no-network`) и не называет сетевые пакеты Node,
 *     `fetch(` и HTTP-клиенты (`publisher-reddit-no-network-io`); AI-слой не
 *     берёт сервисы P-R (`publisher-ai-no-authority`; чистые normalize/
 *     policy/score/markers — можно, markers — признаки текста для находок
 *     `pub.reddit.draft`, M2) и не называет таблицы и модели P-R
 *     (`publisher-ai-no-reddit-rules`): модель не меняет policy и статусы.
 *
 * Учитываются все виды ссылок: `import … from`, `export … from`,
 * `import '…'`, `import(…)`, `require(…)`, `jest.mock(…)`; пути —
 * относительные и от `baseUrl` (`src/…`). Тесты (*.spec.ts) проверяются
 * тоже: спек «Сайта», импортирующий «Админку», — та же дыра в слое.
 *
 *   node scripts/check-sites-import-graph.mjs              # проверить sites-backend/src
 *   node scripts/check-sites-import-graph.mjs --self-test  # самотест на фикстурах
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SITE_MODE = [
  /^assist-site-/,
  /^assist-sandbox$/,
  /^assist-widget$/,
  /^assist-analytics$/,
  /^assist-voice-map$/,
  /^site-crawl$/,
];
const ADMIN_MODE = [/^assist-admin-/];
const UI_CORE = [/^assist-ui-core$/];
/** Э1: нейтральный общий код знаний и ИИ — без доступа к таблицам режима. */
const NEUTRAL = [/^assist-knowledge-core$/, /^site-ai$/];
/** Э3: оркестратор утренней сводки/отчёта — лист графа (правило 10). */
const DIGEST = 'assist-digest';
/** Э-С Ш1: внутренний API обучалки генератора — лист графа (правило 12). */
const INTERNAL_SITES = 'internal-sites';
/** Э-С Ш2: зона секретов — тестовые учётки и их шифротексты (правило 14). */
const CREDENTIALS = 'site-credentials';
// Э7: `assist-admin-crawl` — обход админки за логином (opt-in): читает
// реестр тестовых учёток (без секретов), аренду для воркера Ш3 — позже.
// Остальные модули «Админки» и весь «Сайт» к реестру дороги не имеют.
// Э-С Ш3: `internal-worker` — канал браузерного воркера: аренда учётки
// под обход «Админки» (`assist-admin-login`), конвертом под ключ воркера.
const CREDENTIALS_CONSUMERS = [
  /^internal-sites$/,
  /^qa-/,
  /^assist-admin-crawl$/,
  /^internal-worker$/,
];
/** Э-С Ш3: очередь браузерного воркера и его канал (правило 19). */
const BROWSER_JOBS = 'browser-jobs';
const INTERNAL_WORKER = 'internal-worker';
const BROWSER_JOBS_CONSUMERS = [
  /^internal-worker$/,
  /^internal-sites$/,
  /^assist-admin-crawl$/,
  /^assist-site-voice-map$/,
  /^qa-/,
];
const MODE_MODULES = [
  /^assist-site-/,
  /^assist-admin-/,
  /^assist-sandbox$/,
  /^assist-widget$/,
  // AI Publisher (P-A0, §5.1): нейтральные site-ai/assist-knowledge-core его не берут.
  /^publisher$/,
];
const PRODUCT_MODULES = [/^assist-/, /^qa-/, /^publisher$/];
/** AI Publisher (правило 20): модуль, его допустимые зависимости и зоны. */
const PUBLISHER = 'publisher';
const PUBLISHER_SCOPE = new Set([
  'site-core',
  'site-ai',
  'site-crawl',
  'telegram-auth',
]);
/** Два чистых файла помощника, которые Publisher может взять (§5.1). */
const PUBLISHER_KNOWLEDGE_FILES =
  /^modules\/assist-knowledge-core\/(injection|notify)$/;
const PUBLISHER_PUBLIC_DB = 'prisma/publisher-public-db.service';
/** Что публичный код Publisher берёт из других папок модуля (§5.1). */
const PUBLISHER_PUBLIC_ALLOWED =
  /^(public\/.+|contracts\/.+|core\/(kyiv-time|money|utm|contact-crypto|clock)|(.+\/)?[\w-]+\.module)$/;
/** Чего AI-слой Publisher не импортирует (принцип 6, §5.1). */
const PUBLISHER_AI_FORBIDDEN =
  /^(leads\/.+|distribution\/.+|core\/(approvals|parameters|role-grants|gates)[^/]*|reddit\/(?!(normalize|policy|score|markers)$).+)$/;
/** P-R: сетевые входы, которых нет в `publisher/reddit/**` (Р-RD-0, §8.3). */
const PUBLISHER_REDDIT_NETWORK =
  /^modules\/(site-crawl\/.+|publisher\/content\/source-import|publisher\/core\/site-revalidate[^/]*)$/;
/** P-R: сетевые пакеты Node и клиенты, `fetch(` в коде `publisher/reddit/**`. */
const REDDIT_NETWORK_IO =
  /(['"](node:)?(http|https|http2|net|tls|dgram|dns|undici|axios|node-fetch|got|superagent|ws)['"])|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/;
const inPublisherReddit = (moduleName, inModule) =>
  moduleName === PUBLISHER &&
  /^reddit\//.test(inModule) &&
  !/\.spec\.ts$/.test(inModule);
const inPublisherPublic = (moduleName, inModule) =>
  moduleName === PUBLISHER &&
  /^public\//.test(inModule) &&
  !/\.spec\.ts$/.test(inModule) &&
  !/(^|\/)testing\//.test(inModule);

const matches = (name, patterns) =>
  name !== null && patterns.some((re) => re.test(name));

/** Правила: кто (from) не может импортировать кого (to). */
export const RULES = [
  {
    id: 'site↛admin',
    why: '§4.3-бис слой 2: код режима «Сайт» не импортирует «Админку»',
    from: (m) => matches(m, SITE_MODE),
    to: (m) => matches(m, ADMIN_MODE),
  },
  {
    id: 'admin↛site',
    why: '§5-кватер/§4-бис.8: «Админка» не импортирует модули «Сайта» (site-crawl — общий, можно)',
    from: (m) => matches(m, ADMIN_MODE),
    to: (m) => matches(m, SITE_MODE) && m !== 'site-crawl',
  },
  {
    id: 'core-neutral',
    why: 'Э1: assist-knowledge-core и site-ai не импортируют модули режимов',
    from: (m) => matches(m, NEUTRAL),
    to: (m) => matches(m, MODE_MODULES),
  },
  {
    id: 'crawl-product-neutral',
    why: 'Э1: site-crawl общий с QA — не импортирует продуктовые модули',
    from: (m) => m === 'site-crawl',
    // «Админку» уже ловит правило site↛admin — одно нарушение, одно правило.
    to: (m) => matches(m, PRODUCT_MODULES) && !matches(m, ADMIN_MODE),
  },
  {
    id: 'digest-leaf',
    why: 'Э3: assist-digest (числа «Сайта» и «Админки» в одном отчёте) не импортирует ни один модуль',
    from: (m) => m !== DIGEST,
    to: (m) => m === DIGEST,
  },
  {
    id: 'internal-sites-scope',
    why: 'Э-С Ш1/Ш2/Ш3: internal-sites (внутренний API генератора) берёт из модулей только ядра site-core, site-credentials, telegram-auth и очередь browser-jobs',
    from: (m) => m === INTERNAL_SITES,
    to: (m) =>
      m !== 'site-core' &&
      m !== 'telegram-auth' &&
      m !== CREDENTIALS &&
      m !== BROWSER_JOBS,
  },
  {
    id: 'browser-jobs-neutral',
    why: 'Э-С Ш3: очередь браузерного воркера (browser-jobs) берёт из модулей только site-core и telegram-auth — продукты регистрируют обработчики сами',
    from: (m) => m === BROWSER_JOBS,
    to: (m) => m !== 'site-core' && m !== 'telegram-auth',
  },
  {
    id: 'browser-jobs-zone',
    why: 'Э-С Ш3: задания воркеру ставят только internal-worker, internal-sites, assist-admin-crawl, assist-site-voice-map и qa-* — остальной помощник и публичный код нет',
    from: (m) => m !== BROWSER_JOBS && !matches(m, BROWSER_JOBS_CONSUMERS),
    to: (m) => m === BROWSER_JOBS,
  },
  {
    id: 'internal-worker-scope',
    why: 'Э-С Ш3: канал воркера (internal-worker) берёт из модулей только browser-jobs, site-credentials, site-core и telegram-auth',
    from: (m) => m === INTERNAL_WORKER,
    to: (m) =>
      m !== BROWSER_JOBS &&
      m !== CREDENTIALS &&
      m !== 'site-core' &&
      m !== 'telegram-auth',
  },
  {
    id: 'internal-worker-leaf',
    why: 'Э-С Ш3: internal-worker — лист графа, его не импортирует ни один модуль (канал воркера с арендой учёток не прорастает в продукты)',
    from: (m) => m !== INTERNAL_WORKER,
    to: (m) => m === INTERNAL_WORKER,
  },
  {
    id: 'site-credentials-scope',
    why: 'Э-С Ш2: site-credentials (секреты тестовых учёток) берёт из модулей только site-core и telegram-auth',
    from: (m) => m === CREDENTIALS,
    to: (m) => m !== 'site-core' && m !== 'telegram-auth',
  },
  {
    id: 'credentials-zone',
    why: 'Э-С Ш2: site-credentials импортируют только internal-sites, qa-*, (Э7) assist-admin-crawl и (Ш3) internal-worker — остальной помощник и публичный код к секретам дороги не имеют',
    from: (m) => m !== CREDENTIALS && !matches(m, CREDENTIALS_CONSUMERS),
    to: (m) => m === CREDENTIALS,
  },
  {
    id: 'internal-sites-leaf',
    why: 'Э-С Ш1: internal-sites — лист графа, его не импортирует ни один модуль (канал генератора не прорастает в продукты)',
    from: (m) => m !== INTERNAL_SITES,
    to: (m) => m === INTERNAL_SITES,
  },
  {
    id: 'ui-core-neutral',
    why: '§5-бис.3 п.3: assist-ui-core не импортирует ни «Сайт», ни «Админку»',
    from: (m) => matches(m, UI_CORE),
    to: (m) => matches(m, [/^assist-site-/, ...ADMIN_MODE]),
  },
  {
    id: 'publisher-leaf',
    why: 'AI Publisher §5.1: модуль publisher не импортирует ни один модуль — Publisher не прорастает в помощник, QA и ядро',
    from: (m) => m !== PUBLISHER,
    to: (m) => m === PUBLISHER,
  },
];

/**
 * Правило 8 (Э2): публичный код виджета ↛ клиенты основной роли. Зона
 * задаётся путём внутри модуля, цель — путём от src.
 */
const PUBLIC_ZONES = [
  { module: 'assist-widget', except: /^cabinet\// },
  { module: 'assist-site-chat', except: /^system\// },
  // Э3: только папка public/ (остальное — кабинет и система).
  { module: 'assist-site-handoff', only: /^public\// },
  { module: 'assist-site-learning', only: /^public\// },
  { module: 'assist-analytics', only: /^public\// },
  // Э4: квота и тариф кабинета под assist_public.
  { module: 'assist-billing', only: /^public\// },
  // Э5: распознавание и озвучка посетителя под assist_public.
  { module: 'assist-site-voice', only: /^public\// },
  // Э6: ролики и карта интерфейса для посетителя под assist_public.
  { module: 'assist-site-media', only: /^public\// },
  // Э6-бис: голосовой план посетителя под assist_public.
  { module: 'assist-site-voice-control', only: /^public\// },
  // AI Publisher: публичные маршруты /public/publisher/v1/* — под
  // publisher_public (PublisherPublicDb), не основной ролью.
  { module: PUBLISHER, only: /^public\// },
];
const inPublicZone = (moduleName, inModule) =>
  !/\.spec\.ts$/.test(inModule) &&
  !/(^|\/)testing\//.test(inModule) &&
  PUBLIC_ZONES.some(
    (z) =>
      z.module === moduleName &&
      (z.only ? z.only.test(inModule) : !z.except.test(inModule)),
  );
/** Э3: модули, из которых публичный код берёт только public/, типы и *-config. */
const E3_MODULES =
  /^modules\/(assist-site-handoff|assist-site-learning|assist-analytics|assist-digest)\/(.+)$/;
/** Э4: что публичный код может взять из assist-billing (правило 11). */
const E4_BILLING = /^modules\/assist-billing\/(.+)$/;
const E4_ALLOWED = /^(public\/.+|plans|units|subscription-state|[\w-]*types|[\w-]+\.module)$/;
/** Э5: что публичный код может взять из assist-site-voice (правило 13). */
const E5_VOICE = /^modules\/assist-site-voice\/(.+)$/;
const E5_ALLOWED = /^(public\/.+|[\w-]*types|[\w-]+-config|[\w-]+\.module)$/;
/** Э6: что публичный код может взять из assist-site-media (правило 14). */
const E6_MEDIA = /^modules\/assist-site-media\/(.+)$/;
/** Э6-бис: что публичный код может взять из assist-site-voice-control (правило 16). */
const E6B_VC = /^modules\/assist-site-voice-control\/(.+)$/;
/** Э6-бис: нейтральный пакет голосового управления без базы (правило 15). */
const UI_CORE_DB_TARGETS = /^prisma(\/|$)/;
const MAIN_DB_TARGETS = [
  /^prisma\/sites-db\.service$/,
  /^prisma\/prisma\.service$/,
  /^modules\/assist-site-knowledge\/site-knowledge\.service$/,
  /^modules\/assist-site-knowledge\/site-sources\.service$/,
  /^modules\/site-core\/ownership\/host-access\.service$/,
  // Э-С Ш4: запись и сводка общей карты интерфейса — основной ролью
  // (публичный код карты — assist-site-media/public/ui-map.ts под
  // assist_public; из ядра он берёт только чистые ui-map и ui-map-model).
  /^modules\/site-core\/ui-map\/ui-map-store$/,
  /^modules\/site-core\/ui-map\/ui-map-maintenance\.service$/,
];
export const PATH_RULES = [
  {
    id: 'publisher-scope',
    why: 'AI Publisher §5.1: publisher берёт из модулей только site-core, site-ai, site-crawl, telegram-auth и assist-knowledge-core/{injection,notify}',
    from: (moduleName) => moduleName === PUBLISHER,
    to: (target) => {
      const t = target.replace(SOURCE_RE, '');
      const m = /^modules\/([^/]+)/.exec(t);
      if (!m) return false;
      const name = m[1];
      if (name === PUBLISHER || PUBLISHER_SCOPE.has(name)) return false;
      return !PUBLISHER_KNOWLEDGE_FILES.test(t);
    },
  },
  {
    id: 'publisher-public-db-zone',
    why: 'AI Publisher §5.1: клиент роли publisher_public (prisma/publisher-public-db.service) берёт только publisher/public/** (и спеки/testing/ модуля)',
    from: (moduleName, inModule) =>
      !(
        moduleName === PUBLISHER &&
        (/^public\//.test(inModule) ||
          /\.spec\.ts$/.test(inModule) ||
          /(^|\/)testing\//.test(inModule))
      ),
    to: (target) => target.replace(SOURCE_RE, '') === PUBLISHER_PUBLIC_DB,
  },
  {
    id: 'publisher-public-db',
    why: 'AI Publisher Р-PUB-5: публичный код Publisher работает только под publisher_public — не AssistPublicDb (основную роль ловит public-db)',
    from: inPublisherPublic,
    to: (target) =>
      /^prisma\/assist-public-db\.service$/.test(target.replace(SOURCE_RE, '')),
  },
  {
    id: 'publisher-public-zone',
    why: 'AI Publisher §5.1: публичный код Publisher берёт из других папок модуля только contracts/**, core/{kyiv-time,money,utm,contact-crypto,clock} и *.module',
    from: inPublisherPublic,
    to: (target) => {
      const m = /^modules\/publisher\/(.+)$/.exec(target.replace(SOURCE_RE, ''));
      return !!m && !PUBLISHER_PUBLIC_ALLOWED.test(m[1]);
    },
  },
  {
    id: 'publisher-ai-no-authority',
    why: 'AI Publisher принцип 6: publisher/ai/** не импортирует заявки, распространение и core/{approvals,parameters,role-grants,gates}* — AI предлагает, человек решает',
    from: (moduleName, inModule) =>
      moduleName === PUBLISHER && /^ai\//.test(inModule),
    to: (target) => {
      const m = /^modules\/publisher\/(.+)$/.exec(target.replace(SOURCE_RE, ''));
      return !!m && PUBLISHER_AI_FORBIDDEN.test(m[1]);
    },
  },
  {
    id: 'publisher-reddit-no-network',
    why: 'AI Publisher P-R (Р-RD-0): publisher/reddit/** не берёт site-crawl/**, импорт источников по URL и ревалидацию сайта — запросов к Reddit нет',
    from: inPublisherReddit,
    to: (target) => PUBLISHER_REDDIT_NETWORK.test(target.replace(SOURCE_RE, '')),
  },
  {
    id: 'worker-seal-private',
    why: 'Э-С Ш3: запечатывание секретов под ключ воркера (browser-jobs/worker-seal) — только browser-jobs и internal-worker',
    from: (moduleName) =>
      moduleName !== BROWSER_JOBS && moduleName !== INTERNAL_WORKER,
    to: (target) =>
      /^modules\/browser-jobs\/worker-seal$/.test(target.replace(SOURCE_RE, '')),
  },
  {
    id: 'credentials-crypto-private',
    why: 'Э-С Ш2: ключи и расшифровка (site-credentials/credential-crypto) — только внутри модуля site-credentials',
    from: (moduleName) => moduleName !== CREDENTIALS,
    to: (target) =>
      /^modules\/site-credentials\/credential-crypto$/.test(
        target.replace(SOURCE_RE, ''),
      ),
  },
  {
    id: 'public-db',
    why: 'Э2 §4.3-бис слой 3: публичный код виджета работает только под assist_public (AssistPublicDb)',
    from: inPublicZone,
    to: (target) =>
      MAIN_DB_TARGETS.some((re) => re.test(target.replace(SOURCE_RE, ''))),
  },
  {
    id: 'public-zone-e3',
    why: 'Э3: публичный код берёт из модулей Э3 только public/, *types.ts и *-config.ts (их сервисы ходят основным клиентом)',
    from: inPublicZone,
    to: (target, moduleName) => {
      const m = E3_MODULES.exec(target.replace(SOURCE_RE, ''));
      if (!m || m[1] === moduleName) return false;
      const rest = m[2];
      return !(
        rest.startsWith('public/') ||
        // Модуль Nest — проводка DI, не код доступа к базе.
        /^[\w-]+\.module$/.test(rest) ||
        /(^|[/-])types$/.test(rest) ||
        /-config$/.test(rest)
      );
    },
  },
  {
    id: 'public-zone-e4',
    why: 'Э4: публичный код берёт из assist-billing только public/, plans, units, subscription-state, *types (оплата и кабинет — основная роль и секреты)',
    from: inPublicZone,
    to: (target, moduleName) => {
      const m = E4_BILLING.exec(target.replace(SOURCE_RE, ''));
      if (!m || moduleName === 'assist-billing') return false;
      return !E4_ALLOWED.test(m[1]);
    },
  },
  {
    id: 'public-zone-e5',
    why: 'Э5: публичный код берёт из assist-site-voice только public/, *types, *-config и *.module (кабинет голоса — основная роль)',
    from: inPublicZone,
    to: (target, moduleName) => {
      const m = E5_VOICE.exec(target.replace(SOURCE_RE, ''));
      if (!m || moduleName === 'assist-site-voice') return false;
      return !E5_ALLOWED.test(m[1]);
    },
  },
  {
    id: 'public-zone-e6',
    why: 'Э6: публичный код берёт из assist-site-media только public/, *types, *-config и *.module (кабинет «Видео» — основная роль)',
    from: inPublicZone,
    to: (target, moduleName) => {
      const m = E6_MEDIA.exec(target.replace(SOURCE_RE, ''));
      if (!m || moduleName === 'assist-site-media') return false;
      // Тот же набор, что у голоса (правило 13).
      return !E5_ALLOWED.test(m[1]);
    },
  },
  {
    id: 'public-zone-e6b',
    why: 'Э6-бис: публичный код берёт из assist-site-voice-control только public/, *types, *-config и *.module (кабинет переключателя — основная роль)',
    from: inPublicZone,
    to: (target, moduleName) => {
      const m = E6B_VC.exec(target.replace(SOURCE_RE, ''));
      if (!m || moduleName === 'assist-site-voice-control') return false;
      return !E5_ALLOWED.test(m[1]);
    },
  },
  {
    id: 'ui-core-no-db',
    why: 'Э6-бис §5-бис.3 п.3: assist-ui-core — без доступа к базе (не импортирует prisma/**)',
    from: (moduleName) => matches(moduleName, UI_CORE),
    to: (target) => UI_CORE_DB_TARGETS.test(target.replace(SOURCE_RE, '')),
  },
];

/**
 * Правило 7: имена таблиц/моделей чужого режима в коде модуля. Проверяется
 * текст без комментариев. `assist_sites` (общая строка помощника) под
 * `assist_site_` не попадает — после `assist_site` там `s`, а не `_`.
 */
const ADMIN_NAMES = /assist_admin_|\bAssistAdmin[A-Z]?\w*|\bassistAdmin[A-Z]\w*/;
const SITE_NAMES = /assist_site_|\bAssistSite[A-Z]\w*|\bassistSite[A-Z]\w*/;
/** Э6-бис (е): таблицы/модели мемо (представления `_published`/`_checks` — можно). */
const MEMO_TABLE_NAMES =
  /\bassist_site_memos\b|\bassist_site_memo_versions\b|\bassist_site_memo_changes\b|\bassist_site_phrases\b|\bAssistSiteMemo(?:Version|Change)?\b|\bAssistSitePhrase\b|\bassistSiteMemo(?:Version|Change)?\b|\bassistSitePhrase\b/;
/** Э6-тер: таблицы/модели голосовой карты (представление `_published` — можно). */
const VOICE_MAP_TABLE_NAMES =
  /\bassist_site_voice_maps\b|\bassist_site_voice_map_(?:versions|changes|editor_sessions)\b|\bAssistSiteVoiceMap(?:Version|Change|EditorSession)?\b|\bassistSiteVoiceMap(?:Version|Change|EditorSession)?\b/;
const CREDENTIAL_NAMES =
  /\b(site_test_accounts|site_credentials|site_credential_leases|site_credential_audit|user_site_sessions|user_site_secrets)\b|\b(siteTestAccount|siteCredential|siteCredentialLease|siteCredentialAudit|userSiteSession|userSiteSecret)\b/;
/**
 * AI Publisher (правило 20): имена таблиц (`@@map`) и моделей схемы с
 * делегатами Prisma (`pubLead`, `assistSiteFaq`). Список — из schema.prisma,
 * а не регэксп по префиксу: `pubRow` или `QaChecksService` — не имена схемы.
 */
function schemaNames(prefixModel, prefixTable) {
  const file = path.join(ROOT, 'sites-backend', 'prisma', 'schema.prisma');
  const schema = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const models = [...schema.matchAll(/^model (\w+) \{/gm)]
    .map((m) => m[1])
    .filter((n) => prefixModel.test(n));
  const tables = [...schema.matchAll(/@@map\("([^"]+)"\)/g)]
    .map((m) => m[1])
    .filter((n) => prefixTable.test(n));
  const delegates = models.map((n) => n.charAt(0).toLowerCase() + n.slice(1));
  const all = [...tables, ...models, ...delegates];
  // Пустая схема (нет файла) — регэксп, который не совпадает ни с чем.
  return all.length
    ? new RegExp(`\\b(?:${all.sort((a, b) => b.length - a.length).join('|')})\\b`)
    : /(?!)/;
}
const PUB_NAMES = schemaNames(/^Pub[A-Z]/, /^pub_/);
const ASSIST_QA_NAMES = schemaNames(/^(Assist|Qa)[A-Z]/, /^(assist_|qa_)/);
/** Таблицы и представления, которые называет публичный код Publisher. */
const PUBLISHER_PUBLIC_NAMES =
  /\bpub_(?!(?:public_products|public_contents|leads|lead_contacts|events|sessions|lead_outbox|rate_hits|sref)\b)[a-z][a-z_]*/;
/** Э-С Ш3: таблицы и модели очереди браузерного воркера. */
const BROWSER_JOB_NAMES =
  /\b(site_browser_jobs|site_browser_artifacts)\b|\b(siteBrowserJob|siteBrowserArtifact|SiteBrowserJob|SiteBrowserArtifact)\b/;
export const LITERAL_RULES = [
  {
    id: 'publisher-public-names',
    why: 'AI Publisher §5.1: публичный код Publisher называет только pub_public_products, pub_public_contents и таблицы приёма (pub_leads, pub_lead_contacts, pub_events, pub_sessions, pub_lead_outbox, pub_rate_hits)',
    in: (m, inModule) => inPublisherPublic(m, inModule ?? ''),
    re: PUBLISHER_PUBLIC_NAMES,
  },
  {
    id: 'publisher-reddit-no-network-io',
    why: 'AI Publisher P-R (Р-RD-0): в publisher/reddit/** нет сетевых пакетов Node, HTTP-клиентов и fetch( — Reddit не запрашивается',
    in: (m, inModule) => inPublisherReddit(m, inModule ?? ''),
    re: REDDIT_NETWORK_IO,
  },
  {
    id: 'publisher-ai-no-reddit-rules',
    why: 'AI Publisher P-R (§M1.3, аудит S3-5): AI-слой не называет таблицы и модели Reddit (pub_reddit_*, PubReddit*) — модель не меняет policy, статусы и снимки',
    in: (m, inModule) => m === PUBLISHER && /^ai\//.test(inModule ?? ''),
    re: /\bpub_reddit_\w+|\bpubReddit\w+|\bPubReddit\w+/,
  },
  {
    id: 'publisher-names',
    why: 'AI Publisher §5.1: в publisher нет имён таблиц и моделей помощника и QA (assist_*, Assist*, qa_*, Qa*)',
    in: (m) => m === PUBLISHER,
    re: ASSIST_QA_NAMES,
  },
  {
    id: 'assist-names',
    why: 'AI Publisher §5.1: в assist-* и qa-* нет имён таблиц и моделей Publisher (pub_*, Pub*)',
    in: (m) => /^(assist-|qa-)/.test(m),
    re: PUB_NAMES,
  },
  {
    id: 'browser-jobs-names',
    why: 'Э-С Ш3: имена таблиц/моделей очереди воркера — только в browser-jobs (продукты и каналы ходят через BrowserJobsService)',
    in: (m) => m !== BROWSER_JOBS,
    re: BROWSER_JOB_NAMES,
  },
  {
    id: 'site-names↛admin',
    why: 'Э1 слой 2: в модуле «Сайта» нет имён таблиц/моделей «Админки»',
    in: (m) => matches(m, SITE_MODE),
    re: ADMIN_NAMES,
  },
  {
    id: 'admin-names↛site',
    why: 'Э1 слой 2: в модуле «Админки» нет имён таблиц/моделей «Сайта»',
    in: (m) => matches(m, ADMIN_MODE),
    re: SITE_NAMES,
  },
  {
    id: 'credentials-names',
    why: 'Э-С Ш2: имена таблиц/моделей хранилища учётных данных — только в site-credentials (internal-sites и qa-* ходят через сервис)',
    in: (m) => m !== CREDENTIALS,
    re: CREDENTIAL_NAMES,
  },
  {
    id: 'neutral-names',
    why: 'Э1: нейтральный модуль не называет таблиц режимов — их передаёт модуль режима',
    in: (m) => matches(m, NEUTRAL),
    re: new RegExp(`${ADMIN_NAMES.source}|${SITE_NAMES.source}`),
  },
  {
    id: 'ui-core-names',
    why: 'Э6-бис: assist-ui-core не называет таблиц/моделей режимов и не берёт клиент Prisma (без базы)',
    in: (m) => matches(m, UI_CORE),
    re: new RegExp(
      `${ADMIN_NAMES.source}|${SITE_NAMES.source}|['"]@prisma\\/client['"]|\\$(?:queryRaw|executeRaw)`,
    ),
  },
  {
    id: 'memo-public-views',
    why: 'Э6-бис (е) §5-бис.17 п.12: публичный код читает мемо только через представления (assist_site_memo_published/_checks) — не таблицы мемо, историю и индекс фраз',
    in: (m, inModule) => inPublicZone(m, inModule ?? ''),
    re: MEMO_TABLE_NAMES,
  },
  {
    id: 'voice-map-public-views',
    why: 'Э6-тер §5-кватер.9: публичный код читает голосовую карту только через представление assist_site_voice_map_published — не черновик, версии, журнал и сессии редактора',
    in: (m, inModule) => inPublicZone(m, inModule ?? ''),
    re: VOICE_MAP_TABLE_NAMES,
  },
];

const SOURCE_RE = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (SOURCE_RE.test(e.name) && !e.name.endsWith('.d.ts'))
      out.push(full);
  }
  return out;
}

/** Комментарии вырезаются: пример импорта в комментарии — не импорт. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Все спецификаторы модулей в исходнике. */
export function importSpecifiers(source) {
  const src = stripComments(source);
  const specs = [];
  const re =
    /(?:^|[^\w$.])(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w$.])import\s*['"]([^'"]+)['"]|(?:^|[^\w$.])(?:require|import|jest\.mock|jest\.requireActual|jest\.doMock)\(\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) specs.push(m[1] ?? m[2] ?? m[3]);
  return specs;
}

/**
 * Путь файла (от src) → «зона»: имя модуля, 'shared' или null (прочее:
 * prisma, common, config…).
 */
function zoneOf(relFromSrc, isTarget = false) {
  const parts = relFromSrc.split('/');
  if (parts[0] === 'modules' && parts.length >= 2) {
    // Файл-исходник прямо в modules/ (без папки модуля) — не модуль. А цель
    // `modules/<имя>` — это index модуля (`import … from '../assist-admin-chat'`).
    if (parts.length >= 3 || isTarget) {
      return { kind: 'module', name: parts[1].replace(SOURCE_RE, '') };
    }
    return { kind: 'other' };
  }
  if (parts[0] === 'shared') return { kind: 'shared' };
  return { kind: 'other' };
}

/** Спецификатор → путь цели от src (или null, если это пакет). */
function resolveTarget(fileRelFromSrc, spec) {
  if (spec.startsWith('.')) {
    const joined = path.posix.normalize(
      path.posix.join(path.posix.dirname(fileRelFromSrc), spec),
    );
    return joined.startsWith('..') ? null : joined;
  }
  // `baseUrl: "./"` в tsconfig — `src/modules/...` тоже валидный путь.
  if (spec.startsWith('src/')) return spec.slice(4);
  return null;
}

/**
 * Нарушения графа в дереве `srcDir` (это `sites-backend/src` или папка
 * фикстур самотеста той же формы).
 */
export function findViolations(srcDir) {
  const violations = [];
  for (const abs of walk(srcDir)) {
    const rel = path.relative(srcDir, abs).split(path.sep).join('/');
    const fromZone = zoneOf(rel);
    if (fromZone.kind === 'other') continue;
    const source = fs.readFileSync(abs, 'utf8');
    if (fromZone.kind === 'module') {
      const code = stripComments(source);
      const inModule = rel.split('/').slice(2).join('/');
      for (const rule of LITERAL_RULES) {
        if (!rule.in(fromZone.name, inModule)) continue;
        const hit = code.match(rule.re);
        if (hit) {
          violations.push({ file: rel, spec: hit[0], rule: rule.id, why: rule.why });
        }
      }
    }
    for (const spec of importSpecifiers(source)) {
      const target = resolveTarget(rel, spec);
      if (target === null) continue;
      const toZone = zoneOf(target, true);
      if (fromZone.kind === 'shared') {
        if (
          toZone.kind === 'module' ||
          target === 'modules' ||
          target.startsWith('modules/')
        ) {
          violations.push({
            file: rel,
            spec,
            rule: 'shared↛modules',
            why: 'src/shared — копии чистых модулей, они не зависят от модулей продукта',
          });
        }
        continue;
      }
      if (fromZone.kind === 'module') {
        const inModule = rel.split('/').slice(2).join('/');
        for (const rule of PATH_RULES) {
          if (
            rule.from(fromZone.name, inModule) &&
            rule.to(target, fromZone.name)
          ) {
            violations.push({ file: rel, spec, rule: rule.id, why: rule.why });
          }
        }
      }
      if (toZone.kind !== 'module' || toZone.name === fromZone.name) continue;
      for (const rule of RULES) {
        if (rule.from(fromZone.name) && rule.to(toZone.name)) {
          violations.push({ file: rel, spec, rule: rule.id, why: rule.why });
        }
      }
    }
  }
  return violations;
}

function report(violations, label) {
  if (violations.length === 0) {
    console.log(`ok   check-sites-import-graph: ${label} — нарушений нет`);
    return true;
  }
  console.error(
    `check-sites-import-graph: ${label} — нарушения правила графа зависимостей:`,
  );
  for (const v of violations) {
    console.error(`  - ${v.file}: «${v.spec}» [${v.rule}] ${v.why}`);
  }
  return false;
}

/**
 * Самотест: фикстуры-нарушители и «чистые» во временной папке. Без него
 * проверка, которая сейчас проходит потому, что модулей помощника ещё нет,
 * могла бы проходить и потому, что она сломана.
 */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-graph-'));
  const write = (rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  // Каждая фикстура-нарушитель — ровно одно нарушение своего правила.
  const bad = [
    // AI Publisher (правило 20, P-A0).
    [
      'modules/publisher/content/pa1.ts',
      `import { SiteChat } from '../../assist-site-chat/chat.service';`,
      'publisher-scope',
    ],
    [
      'modules/publisher/pa2.ts',
      `import { chunk } from '../assist-knowledge-core/chunker';`,
      'publisher-scope',
    ],
    [
      'modules/assist-site-chat/pa3.ts',
      `import { PublisherModule } from '../publisher/publisher.module';`,
      'publisher-leaf',
    ],
    [
      'modules/publisher/public/pa4.ts',
      `import { SitesDb } from '../../../prisma/sites-db.service';`,
      'public-db',
    ],
    [
      'modules/publisher/public/pa5.ts',
      `import { AssistPublicDb } from '../../../prisma/assist-public-db.service';`,
      'publisher-public-db',
    ],
    [
      'modules/publisher/core/pa6.ts',
      `import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';`,
      'publisher-public-db-zone',
    ],
    [
      'modules/assist-widget/pa7.ts',
      `import type { PublisherPublicDb } from '../../prisma/publisher-public-db.service';`,
      'publisher-public-db-zone',
    ],
    [
      'modules/publisher/public/pa8.ts',
      `import { runOperation } from '../core/operation';`,
      'publisher-public-zone',
    ],
    [
      'modules/publisher/public/pa9.ts',
      'const q = `SELECT "value" FROM "sites"."pub_parameters" WHERE "productId" = $1`;',
      'publisher-public-names',
    ],
    [
      'modules/publisher/ai/pa10.ts',
      `import { LeadsService } from '../leads/leads.service';`,
      'publisher-ai-no-authority',
    ],
    [
      'modules/publisher/ai/generators/pa11.generator.ts',
      `import { approvePublish } from '../../core/approvals-publish';`,
      'publisher-ai-no-authority',
    ],
    [
      'modules/publisher/content/pa12.ts',
      `const rows = await db.assistSiteFaq.findMany({});`,
      'publisher-names',
    ],
    // P-R (Reddit Manual MVP): сеть и полномочия AI.
    [
      'modules/publisher/reddit/pa14.ts',
      `import { pinnedFetch } from '../../site-crawl/net/pinned-fetch';`,
      'publisher-reddit-no-network',
    ],
    [
      'modules/publisher/reddit/pa15.ts',
      `import { fetchForImport } from '../content/source-import';`,
      'publisher-reddit-no-network',
    ],
    [
      'modules/publisher/reddit/pa16.ts',
      `import * as https from 'node:https';`,
      'publisher-reddit-no-network-io',
    ],
    [
      'modules/publisher/reddit/pa17.ts',
      `const r = await fetch('https://www.reddit.com/r/x/about.json');`,
      'publisher-reddit-no-network-io',
    ],
    [
      'modules/publisher/ai/pa18.ts',
      `import { RedditCommunitiesService } from '../reddit/communities.service';`,
      'publisher-ai-no-authority',
    ],
    [
      'modules/publisher/ai/generators/pa21.generator.ts',
      `import { redditChecks } from '../../reddit/checks';`,
      'publisher-ai-no-authority',
    ],
    [
      'modules/publisher/ai/pa20.ts',
      `await tx.pubRedditOpportunity.updateMany({ data: { policy: 'ok', status: 'qualified' } });`,
      'publisher-ai-no-reddit-rules',
    ],
    [
      'modules/publisher/ai/generators/pa19.generator.ts',
      `await tx.pubRedditRuleSnapshot.updateMany({ data: { reviewState: 'reviewed' } });`,
      'publisher-ai-no-reddit-rules',
    ],
    [
      'modules/qa-catalog/pa13.ts',
      'const q = `SELECT 1 FROM "sites"."pub_leads"`;',
      'assist-names',
    ],
    // Э-С Ш3: очередь браузерного воркера и его канал.
    [
      'modules/browser-jobs/sh3a.ts',
      `import { AdminCrawlService } from '../assist-admin-crawl/admin-crawl.service';`,
      'browser-jobs-neutral',
    ],
    [
      'modules/assist-site-chat/sh3b.ts',
      `import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';`,
      'browser-jobs-zone',
    ],
    [
      'modules/internal-worker/sh3c.ts',
      `import { AssistBilling } from '../assist-billing/billing.service';`,
      'internal-worker-scope',
    ],
    [
      'modules/site-core/sh3d.ts',
      `import { InternalWorkerService } from '../internal-worker/internal-worker.service';`,
      'internal-worker-leaf',
    ],
    [
      'modules/assist-admin-crawl/sh3e.ts',
      `import { sealForWorker } from '../browser-jobs/worker-seal';`,
      'worker-seal-private',
    ],
    [
      'modules/assist-site-voice-map/sh3f.ts',
      `const rows = await db.siteBrowserJob.findMany({});`,
      'browser-jobs-names',
    ],
    // Э6-тер: публичный код голосовой карты — только представление.
    [
      'modules/assist-site-voice-control/public/vm1.ts',
      'const q = `SELECT "draft" FROM "sites"."assist_site_voice_maps" WHERE "siteId" = $1`;',
      'voice-map-public-views',
    ],
    [
      'modules/assist-widget/vm2.ts',
      'const rows = await db.assistSiteVoiceMapEditorSession.findMany({});',
      'voice-map-public-views',
    ],
    // Э6-бис (е): публичный код мемо — только представления.
    [
      'modules/assist-site-voice-control/public/mp1.ts',
      'const q = `SELECT "draft" FROM "sites"."assist_site_memos" WHERE "siteId" = $1`;',
      'memo-public-views',
    ],
    [
      'modules/assist-widget/mp2.ts',
      'const rows = await db.assistSitePhrase.findMany({});',
      'memo-public-views',
    ],
    [
      'modules/assist-site-chat/a.ts',
      `import { X } from '../assist-admin-knowledge/repo';`,
      'site↛admin',
    ],
    [
      'modules/assist-site-knowledge/deep/b.ts',
      `import type { Y } from '../../assist-admin-chat';`,
      'site↛admin',
    ],
    [
      'modules/assist-widget/c.ts',
      `export * from 'src/modules/assist-admin-knowledge/x';`,
      'site↛admin',
    ],
    [
      'modules/assist-analytics/d.ts',
      `const m = require('../assist-admin-analytics/y');`,
      'site↛admin',
    ],
    [
      'modules/assist-voice-map/e.ts',
      `const m = await import('../assist-admin-voice-map/z');`,
      'site↛admin',
    ],
    [
      'modules/site-crawl/f.ts',
      `import '../assist-admin-crawl/side-effect';`,
      'site↛admin',
    ],
    [
      'modules/assist-site-chat/g.spec.ts',
      `jest.mock('../assist-admin-chat/svc');`,
      'site↛admin',
    ],
    [
      'modules/assist-admin-chat/h.ts',
      `import {\n  Z,\n} from '../assist-site-knowledge/repo';`,
      'admin↛site',
    ],
    [
      'modules/assist-admin-knowledge/i.ts',
      `import { W } from '../assist-widget/w';`,
      'admin↛site',
    ],
    [
      'modules/assist-ui-core/j.ts',
      `import { V } from '../assist-site-chat/v';`,
      'ui-core-neutral',
    ],
    [
      'modules/assist-ui-core/k.ts',
      `import { V } from '../assist-admin-chat/v';`,
      'ui-core-neutral',
    ],
    [
      'modules/assist-sandbox/n.ts',
      `import { K } from '../assist-admin-knowledge/k';`,
      'site↛admin',
    ],
    [
      'modules/assist-knowledge-core/o.ts',
      `import { L } from '../assist-site-knowledge/l';`,
      'core-neutral',
    ],
    [
      'modules/site-ai/p.ts',
      `import { M } from '../assist-sandbox/m';`,
      'core-neutral',
    ],
    [
      'modules/site-crawl/q.ts',
      `import { N } from '../assist-site-knowledge/n';`,
      'crawl-product-neutral',
    ],
    [
      'modules/site-crawl/r.ts',
      `import { O } from '../qa-runs/o';`,
      'crawl-product-neutral',
    ],
    [
      'modules/assist-site-knowledge/s.ts',
      `const sql = 'SELECT 1 FROM "sites"."assist_admin_chunks"';`,
      'site-names↛admin',
    ],
    [
      'modules/assist-sandbox/t.ts',
      `await db.assistAdminFaq.findMany({});`,
      'site-names↛admin',
    ],
    [
      'modules/assist-admin-knowledge/u.ts',
      `import type { AssistSiteChunk } from '@prisma/client';`,
      'admin-names↛site',
    ],
    [
      'modules/assist-knowledge-core/v.ts',
      `export const T = { chunks: 'assist_site_chunks' };`,
      'neutral-names',
    ],
    [
      'modules/assist-site-chat/w.ts',
      `import { SitesDb } from '../../prisma/sites-db.service';`,
      'public-db',
    ],
    [
      'modules/assist-widget/x.ts',
      `import type { PrismaService } from 'src/prisma/prisma.service';`,
      'public-db',
    ],
    [
      'modules/assist-widget/deep/y.ts',
      `import { HostAccessService } from '../../site-core/ownership/host-access.service';`,
      'public-db',
    ],
    [
      'modules/assist-site-chat/z.ts',
      `import { SiteKnowledgeService } from '../assist-site-knowledge/site-knowledge.service';`,
      'public-db',
    ],
    [
      'modules/assist-site-handoff/public/aa.ts',
      `import { SitesDb } from '../../../prisma/sites-db.service';`,
      'public-db',
    ],
    [
      'modules/assist-analytics/public/ab.ts',
      `import { PrismaService } from 'src/prisma/prisma.service';`,
      'public-db',
    ],
    [
      'modules/assist-widget/ac.ts',
      `import { HandoffDispatcher } from '../assist-site-handoff/system/handoff-dispatcher.service';`,
      'public-zone-e3',
    ],
    [
      'modules/assist-site-chat/ad.ts',
      `import { GoalsService } from '../assist-analytics/goals.service';`,
      'public-zone-e3',
    ],
    [
      'modules/assist-site-learning/public/ae.ts',
      `import { ConversationsService } from '../../assist-site-handoff/cabinet/conversations.service';`,
      'public-zone-e3',
    ],
    [
      'modules/assist-analytics/af.ts',
      `import { AssistDigestService } from '../assist-digest/digest.service';`,
      'digest-leaf',
    ],
    [
      'modules/assist-site-handoff/system/ag.ts',
      `export { X } from '../../assist-digest/report-text';`,
      'digest-leaf',
    ],
    [
      'modules/assist-site-chat/ah.ts',
      `import { AssistBilling } from '../assist-billing/billing.service';`,
      'public-zone-e4',
    ],
    [
      'modules/assist-widget/ai.ts',
      `import { AssistPayments } from '../assist-billing/payments.service';`,
      'public-zone-e4',
    ],
    [
      'modules/assist-billing/public/aj.ts',
      `import { PrismaService } from '../../../prisma/prisma.service';`,
      'public-db',
    ],
    [
      'modules/internal-sites/ak.ts',
      `import { AssistBilling } from '../assist-billing/billing.service';`,
      'internal-sites-scope',
    ],
    [
      'modules/internal-sites/al.ts',
      `import { PlatformAdmin } from '../platform-admin/platform-admin.service';`,
      'internal-sites-scope',
    ],
    [
      'modules/site-core/am.ts',
      `import { InternalSitesService } from '../internal-sites/internal-sites.service';`,
      'internal-sites-leaf',
    ],
    [
      'modules/assist-site-voice/public/an.ts',
      `import { SitesDb } from '../../../prisma/sites-db.service';`,
      'public-db',
    ],
    [
      'modules/assist-widget/ao.ts',
      `import { VoiceSettingsService } from '../assist-site-voice/cabinet/voice-settings.service';`,
      'public-zone-e5',
    ],
    [
      'modules/assist-site-media/public/sh4a.ts',
      `import { ingestUiSnapshot } from '../../site-core/ui-map/ui-map-store';`,
      'public-db',
    ],
    [
      'modules/assist-widget/sh4b.ts',
      `import { UiMapMaintenanceService } from '../site-core/ui-map/ui-map-maintenance.service';`,
      'public-db',
    ],
    [
      'modules/assist-site-chat/ap.ts',
      `import { X } from '../assist-site-voice/cabinet/voice-errors';`,
      'public-zone-e5',
    ],
    [
      'modules/site-credentials/aq.ts',
      `import { AssistBilling } from '../assist-billing/billing.service';`,
      'site-credentials-scope',
    ],
    [
      'modules/assist-site-chat/ar.ts',
      `import { SiteCredentialsService } from '../site-credentials/site-credentials.service';`,
      'credentials-zone',
    ],
    [
      'modules/assist-widget/public-x/as.ts',
      `import type { TestAccountView } from 'src/modules/site-credentials/site-credentials.service';`,
      'credentials-zone',
    ],
    [
      'modules/qa-runs/at.ts',
      `import { openCredential } from '../site-credentials/credential-crypto';`,
      'credentials-crypto-private',
    ],
    [
      'modules/assist-admin-knowledge/au.ts',
      `const rows = await db.siteCredential.findMany({});`,
      'credentials-names',
    ],
    // Э7: «Админка» — к реестру учёток только модуль обхода за логином;
    // публичный код «Сайта» не берёт ничего из «Админки».
    [
      'modules/assist-admin-chat/aw.ts',
      `import { SiteCredentialsService } from '../site-credentials/site-credentials.service';`,
      'credentials-zone',
    ],
    [
      'modules/assist-widget/ax.ts',
      `import { AdminSessionService } from '../assist-admin-chat/admin-session.service';`,
      'site↛admin',
    ],
    [
      'modules/assist-site-chat/ay.ts',
      `import { executeRead } from '../assist-admin-mode/connector-exec';`,
      'site↛admin',
    ],
    [
      'modules/assist-admin-chat/az.ts',
      `import { WidgetChatService } from '../assist-widget/widget-chat.service';`,
      'admin↛site',
    ],
    [
      'modules/assist-admin-mode/ba.ts',
      `const n = await db.assistSiteConversation.count();`,
      'admin-names↛site',
    ],
    // Э8: «Админка: действия» — предложения/«Да»/мемо АМ-N только в зоне
    // «Админки»: публичный код и мемо «Сайта» к ним дороги не имеют, а сами
    // действия «Сайт» (план голосового управления, мемо «Сайта») не берут.
    [
      'modules/assist-widget/bb.ts',
      `import { ProposalsService } from '../assist-admin-actions/proposals.service';`,
      'site↛admin',
    ],
    [
      'modules/assist-site-voice-control/cabinet/bc.ts',
      `import { AdminMemoService } from '../../assist-admin-actions/admin-memo.service';`,
      'site↛admin',
    ],
    [
      'modules/assist-admin-actions/bd.ts',
      `import { MemoService } from '../assist-site-voice-control/cabinet/memo.service';`,
      'admin↛site',
    ],
    [
      'modules/assist-admin-actions/be.ts',
      `const m = await db.assistSiteMemo.findMany();`,
      'admin-names↛site',
    ],
    [
      'modules/assist-ui-core/bf.ts',
      `import { adminMemoGates } from '../assist-admin-actions/admin-memo';`,
      'ui-core-neutral',
    ],
    // Э6-бис (б): голосовое управление «Админкой» — модуль зоны «Админки»:
    // «Сайт» (виджет, план и кабинет голосового управления) его не берёт, он
    // не берёт «Сайт» и не называет его таблиц; ядро — нейтрально.
    [
      'modules/assist-widget/bg.ts',
      `import { AdminUiPlanService } from '../assist-admin-voice/admin-ui-plan.service';`,
      'site↛admin',
    ],
    [
      'modules/assist-site-voice-control/cabinet/bh.ts',
      `import { checkAdminPlan } from '../../assist-admin-voice/admin-voice-rules';`,
      'site↛admin',
    ],
    [
      'modules/assist-admin-voice/bi.ts',
      `import { SiteUiPlanService } from '../assist-site-voice-control/public/ui-plan.service';`,
      'admin↛site',
    ],
    [
      'modules/assist-admin-voice/bj.ts',
      `const n = await db.assistSiteUiPlan.count();`,
      'admin-names↛site',
    ],
    [
      'modules/assist-ui-core/bk.ts',
      `import { checkAdminPlan } from '../assist-admin-voice/admin-voice-rules';`,
      'ui-core-neutral',
    ],
    [
      'modules/site-core/av.ts',
      `const sql = 'SELECT 1 FROM "sites"."user_site_secrets"';`,
      'credentials-names',
    ],
    [
      'modules/assist-widget/aq.ts',
      `import { SiteVideosService } from '../assist-site-media/cabinet/site-videos.service';`,
      'public-zone-e6',
    ],
    [
      'modules/assist-site-media/public/ar.ts',
      `import { PrismaService } from '../../../prisma/prisma.service';`,
      'public-db',
    ],
    [
      'modules/internal-sites/as.ts',
      `import { promptVideos } from '../assist-site-media/public/site-videos';`,
      'internal-sites-scope',
    ],
    [
      'modules/assist-ui-core/aw.ts',
      `import { PrismaService } from '../../prisma/prisma.service';`,
      'ui-core-no-db',
    ],
    [
      'modules/assist-ui-core/ax.ts',
      `import { Prisma } from '@prisma/client';`,
      'ui-core-names',
    ],
    [
      'modules/assist-ui-core/ay.ts',
      `const sql = 'SELECT 1 FROM "sites"."assist_site_ui_plans"';`,
      'ui-core-names',
    ],
    [
      'modules/assist-ui-core/az.ts',
      `export async function q(db) { return db.$queryRawUnsafe('SELECT 1'); }`,
      'ui-core-names',
    ],
    [
      'modules/assist-widget/ba.ts',
      `import { VoiceControlSettingsService } from '../assist-site-voice-control/cabinet/voice-control-settings.service';`,
      'public-zone-e6b',
    ],
    [
      'modules/assist-site-voice-control/public/bb.ts',
      `import { SitesDb } from '../../../prisma/sites-db.service';`,
      'public-db',
    ],
    [
      'modules/assist-ui-core/bc.ts',
      `import { SiteUiPlanService } from '../assist-site-voice-control/public/ui-plan.service';`,
      'ui-core-neutral',
    ],
    [
      'shared/l.ts',
      `import { G } from '../modules/telegram-auth/guard';`,
      'shared↛modules',
    ],
    [
      'shared/sub/m.ts',
      `export { H } from 'src/modules/site-core/h';`,
      'shared↛modules',
    ],
  ];
  // Разрешённое: своё внутри модуля, общий код, site-crawl из «Админки»,
  // пакеты, импорт в комментарии, «Админка» → «Админка».
  const good = [
    // AI Publisher (правило 20): разрешённое.
    [
      'modules/publisher/content/okp1.ts',
      `import { HostAccessService } from '../../site-core/ownership/host-access.service';\nimport { GeminiText } from '../../site-ai/gemini-text';\nimport { PublicPageFetcher } from '../../site-crawl/page-fetcher';\nimport { PublicRoute } from '../../telegram-auth/allow-apps.decorator';\nimport { detectInjection } from '../../assist-knowledge-core/injection';\nimport { recipients } from '../../assist-knowledge-core/notify';\nimport { SitesDb } from '../../../prisma/sites-db.service';\nimport { ipLimitKey } from '../../../common/ip-limit-key';\nimport { kyivDateOf } from '../core/kyiv-time';\nconst r = db.pubSource;\nconst q = 'SELECT 1 FROM "sites"."pub_parameters"';\n// assist_site_faq в комментарии — можно`,
    ],
    [
      'modules/publisher/public/okp2.ts',
      `import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';\nimport type { LeadBody } from '../contracts/public-api';\nimport { kyivDateOf } from '../core/kyiv-time';\nimport { openContact } from '../core/contact-crypto';\nimport { LeadsModule } from '../leads/leads.module';\nimport { SiteConfig } from './site-config';\nconst q = 'SELECT "formOpen" FROM "sites"."pub_public_products"; INSERT INTO "sites"."pub_leads"; INSERT INTO "sites"."pub_rate_hits"';\nconst k = 'pub_sref';`,
    ],
    [
      'modules/publisher/core/okp3.spec.ts',
      `import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';`,
    ],
    [
      'modules/publisher/ai/okp4.ts',
      `import { kyivDateOf } from '../core/kyiv-time';\nimport type { AiContext } from '../contracts/ai';\nimport { GeminiText } from '../../site-ai/gemini-text';`,
    ],
    // P-R: сервисы контента/каналов и ядро — можно; AI берёт только чистые функции P-R.
    [
      'modules/publisher/reddit/okp6.ts',
      `import { SourcesService } from '../content/sources.service';\nimport { ChannelsService } from '../distribution/channels.service';\nimport { PubOperations } from '../core/operation';\nimport type { RedditOpportunityView } from '../contracts/reddit-api';\nimport { Injectable } from '@nestjs/common';\nconst refetch = 1;`,
    ],
    [
      'modules/publisher/reddit/okp7.spec.ts',
      `import * as http from 'node:http';\nglobalThis.fetch = () => { throw new Error('egress'); };`,
    ],
    [
      'modules/publisher/ai/okp8.ts',
      `import { policyGate } from '../reddit/policy';\nimport { computeScore } from '../reddit/score';\nimport { normalizeThreadUrl } from '../reddit/normalize';\nimport { hasLink } from '../reddit/markers';`,
    ],
    [
      'modules/assist-site-chat/okp5.ts',
      `const pubRow = 1;\nconst QaChecksLike = 2;`,
    ],
    // Э-С Ш3: продукты ставят задания через сервис; канал воркера арендует учётки.
    [
      'modules/assist-admin-crawl/oksh3a.ts',
      `import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';\nimport { SiteCredentialsService } from '../site-credentials/site-credentials.service';`,
    ],
    [
      'modules/internal-worker/oksh3b.ts',
      `import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';\nimport { sealForWorker } from '../browser-jobs/worker-seal';\nimport { SiteCredentialsService } from '../site-credentials/site-credentials.service';`,
    ],
    [
      'modules/browser-jobs/oksh3c.ts',
      `import { evaluateHostAccess } from '../site-core/ownership/host-access';\nconst n = await db.siteBrowserJob.count();`,
    ],
    // Э6-бис (б): голосовое управление «Админкой» берёт ядро и «Админку».
    [
      'modules/assist-admin-voice/okv.ts',
      `import { checkPlan } from '../assist-ui-core/plan-checks';\nimport { AdminMemoService } from '../assist-admin-actions/admin-memo.service';\nconst q = 'SELECT 1 FROM "sites"."assist_admin_ui_plans"';`,
    ],
    // Э6-тер: представление карты — публичному коду можно; модулю карты — таблицы.
    [
      'modules/assist-site-voice-control/public/vmok1.ts',
      'const q = `SELECT "content" FROM "sites"."assist_site_voice_map_published" WHERE "siteId" = $1`;',
    ],
    [
      'modules/assist-site-voice-map/vmok2.ts',
      'const rows = await db.assistSiteVoiceMapEditorSession.findMany({});',
    ],
    // Э6-бис (е): представления мемо — публичному коду можно; кабинету — таблицы.
    [
      'modules/assist-site-voice-control/public/mok1.ts',
      'const q = `SELECT "content" FROM "sites"."assist_site_memo_published" WHERE "siteId" = $1`;\nconst c = `SELECT "id" FROM "sites"."assist_site_memo_checks"`;',
    ],
    [
      'modules/assist-site-voice-control/cabinet/mok2.ts',
      'const rows = await db.assistSiteMemo.findMany({}); // assist_site_phrases',
    ],
    [
      'modules/assist-site-chat/ok1.ts',
      `import { A } from './local';\nimport { B } from '../assist-site-knowledge/repo';\nimport { C } from '../../shared/assist-chat-core';\nimport { D } from '../site-core/x';\nimport { Injectable } from '@nestjs/common';`,
    ],
    [
      'modules/assist-site-chat/ok2.ts',
      `// import { X } from '../assist-admin-knowledge/repo';\n/* require('../assist-admin-chat') */\nexport const s = "../assist-admin-x";`,
    ],
    [
      'modules/assist-admin-knowledge/ok3.ts',
      `import { P } from '../site-crawl/pages';\nimport { Q } from '../assist-admin-chat/q';\nimport { R } from '../../prisma/sites-db.service';`,
    ],
    [
      'modules/assist-ui-core/ok4.ts',
      `import { S } from '../../shared/assist-chat-core';`,
    ],
    [
      'modules/assist-site-knowledge/ok8.ts',
      `import { C } from '../assist-knowledge-core/chunker';\nimport { F } from '../site-crawl/fetcher';\nimport { G } from '../site-ai/embedder';\nconst t = { chunks: 'assist_site_chunks', site: 'assist_sites' };\n// assist_admin_chunks — в комментарии можно\nconst roles = { assistAdmin: ['owner'] };`,
    ],
    [
      'modules/assist-admin-knowledge/ok9.ts',
      `import { C } from '../assist-knowledge-core/chunker';\nconst t = { chunks: 'assist_admin_chunks', settings: 'assist_admin_settings' };`,
    ],
    [
      'modules/assist-sandbox/ok10.ts',
      `import { S } from '../assist-site-knowledge/search';\nimport { R } from '../site-crawl/robots';`,
    ],
    [
      'modules/assist-knowledge-core/ok11.ts',
      `import { E } from '../site-ai/embedder';\nexport type Tables = { chunks: string };`,
    ],
    [
      'modules/assist-site-chat/system/ok12.ts',
      `import { SitesDb } from '../../../prisma/sites-db.service';\nimport { P } from '../../../prisma/prisma.service';`,
    ],
    [
      'modules/assist-widget/cabinet/ok13.ts',
      `import { SitesDb } from '../../../prisma/sites-db.service';`,
    ],
    [
      'modules/assist-widget/ok14.ts',
      `import { AssistPublicDb } from '../../prisma/assist-public-db.service';\nimport { evaluateHostAccess } from '../site-core/ownership/host-access';\nimport { T } from '../assist-site-knowledge/site-tables';\nimport { C } from '../assist-site-chat/chat-types';`,
    ],
    [
      'modules/assist-site-chat/ok15.spec.ts',
      `import { PrismaService } from '../../prisma/prisma.service';`,
    ],
    [
      'modules/assist-site-setup/ok16.ts',
      `import { SitesDb } from '../../prisma/sites-db.service';`,
    ],
    [
      'modules/assist-widget/ok17.ts',
      `import { HandoffIntake } from '../assist-site-handoff/public/handoff-intake.service';\nimport type { GoalView } from '../assist-analytics/api-types';\nimport type { PublicGoal } from '../assist-analytics/goal-types';\nimport { effectiveHandoffConfig } from '../assist-site-handoff/public/handoff-config';\nimport { defaultAnalyticsConfig } from '../assist-analytics/analytics-config';\nimport { LearningSignals } from '../assist-site-learning/public/learning-signals';\nimport { AssistAnalyticsModule } from '../assist-analytics/assist-analytics.module';`,
    ],
    [
      'modules/assist-site-handoff/public/ok18.ts',
      `import { HandoffDispatcher } from '../system/handoff-dispatcher.service';\nimport type { HandoffView } from '../api-types';`,
    ],
    [
      'modules/assist-site-handoff/system/ok19.ts',
      `import { PrismaService } from '../../../prisma/prisma.service';\nimport { LearningCandidates } from '../../assist-site-learning/learning-queue.service';`,
    ],
    [
      'modules/assist-digest/ok20.ts',
      `import { AdminDigestSource } from '../assist-admin-knowledge/admin-digest';\nimport { StatsService } from '../assist-analytics/stats.service';\nimport { SitesDb } from '../../prisma/sites-db.service';`,
    ],
    [
      'modules/assist-site-chat/system/ok21.ts',
      `import { IntegrationsService } from '../../assist-analytics/integrations.service';`,
    ],
    [
      'modules/assist-site-chat/ok22.ts',
      `import { claimUnits } from '../assist-billing/public/entitlements';\nimport { ASSIST_PLANS } from '../assist-billing/plans';\nimport { unitsDelta } from '../assist-billing/units';\nimport type { SubscriptionState } from '../assist-billing/subscription-state';\nimport type { BillingOverview } from '../assist-billing/api-types';`,
    ],
    [
      'modules/assist-billing/ok23.ts',
      `import { PrismaService } from '../../prisma/prisma.service';\nimport { readState } from './public/entitlements';`,
    ],
    [
      'modules/site-ai/ok24.ts',
      `import { learningBudgetCap } from '../assist-billing/limits';`,
    ],
    [
      'modules/internal-sites/ok25.ts',
      `import { AccountService } from '../site-core/account/account.service';\nimport { PublicRoute } from '../telegram-auth/allow-apps.decorator';\nimport { verifySitesRequest } from '../../shared/sites-internal-signature';\nimport { SitesDb } from '../../prisma/sites-db.service';`,
    ],
    [
      'modules/assist-widget/ok26.ts',
      `import { SiteVoiceService } from '../assist-site-voice/public/site-voice.service';\nimport type { WidgetVoiceResponse } from '../assist-site-voice/api-types';\nimport { VOICE_DEFAULTS } from '../assist-site-voice/voice-config';\nimport { AssistSiteVoiceModule } from '../assist-site-voice/assist-site-voice.module';`,
    ],
    [
      'modules/assist-site-voice/cabinet/ok27.ts',
      `import { SitesDb } from '../../../prisma/sites-db.service';\nimport { PrismaService } from '../../../prisma/prisma.service';\nimport { SiteBudget } from '../../assist-site-chat/budget';`,
    ],
    [
      'modules/assist-site-voice/public/ok28.ts',
      `import { AssistPublicDb } from '../../../prisma/assist-public-db.service';\nimport { VoiceSettingsService } from '../cabinet/voice-settings.service';\nimport { claimUnits } from '../../assist-billing/public/entitlements';`,
    ],
    [
      'modules/internal-sites/ok29.ts',
      `import { SiteCredentialsService } from '../site-credentials/site-credentials.service';\nimport { isCredentialPurpose } from '../site-credentials/credential-types';`,
    ],
    [
      'modules/qa-runs/ok30.ts',
      `import { SiteCredentialsService } from '../site-credentials/site-credentials.service';`,
    ],
    [
      'modules/assist-admin-crawl/ok35.ts',
      `import { SiteCredentialsService } from '../site-credentials/site-credentials.service';\nimport { AdminModeService } from '../assist-admin-mode/admin-mode.service';`,
    ],
    [
      'modules/assist-admin-actions/ok37.ts',
      `import { phraseNorm } from '../assist-ui-core/memo';\nimport { ConnectorsService } from '../assist-admin-mode/connectors.service';\nimport { pinnedFetch } from '../site-crawl/net/pinned-fetch';\nconst r = db.assistAdminActionProposal;`,
    ],
    [
      'modules/assist-admin-chat/ok36.ts',
      `import { pinnedFetch } from '../site-crawl/net/pinned-fetch';\nimport { AdminKnowledgeService } from '../assist-admin-knowledge/admin-knowledge.service';\nimport { readState } from '../assist-billing/public/entitlements';`,
    ],
    [
      'modules/site-credentials/ok31.ts',
      `import { openCredential } from './credential-crypto';\nimport { HostAccessService } from '../site-core/ownership/host-access.service';\nconst r = db.siteCredential;\n// site_credentials в комментарии — можно`,
    ],
    [
      'modules/assist-site-chat/ok29.ts',
      `import { promptVideos } from '../assist-site-media/public/site-videos';\nimport type { SiteVideosView } from '../assist-site-media/api-types';\nimport { MEDIA_DEFAULTS } from '../assist-site-media/media-config';\nimport { AssistSiteMediaModule } from '../assist-site-media/assist-site-media.module';`,
    ],
    [
      'modules/assist-site-media/cabinet/ok30.ts',
      `import { SitesDb } from '../../../prisma/sites-db.service';\nimport { readState } from '../../assist-billing/public/entitlements';`,
    ],
    [
      'modules/internal-sites/ok31.ts',
      `import { cleanUiElements } from '../site-core/ui-map/ui-map';\nimport { isAllowedVideoUrl } from '../../config/media-env';`,
    ],
    [
      'modules/assist-site-media/public/oksh4.ts',
      `import { cleanUiSnapshot } from '../../site-core/ui-map/ui-map-model';\nimport { uiMapKey } from '../../site-core/ui-map/ui-map';\nimport type { AssistPublicDb } from '../../../prisma/assist-public-db.service';`,
    ],
    [
      'modules/assist-widget/ok32.ts',
      `import { SiteUiPlanService } from '../assist-site-voice-control/public/ui-plan.service';\nimport type { UiPlanView } from '../assist-site-voice-control/api-types';\nimport { VOICE_CONTROL_DEFAULTS } from '../assist-site-voice-control/voice-control-config';\nimport { AssistSiteVoiceControlModule } from '../assist-site-voice-control/assist-site-voice-control.module';`,
    ],
    [
      'modules/assist-site-voice-control/public/ok33.ts',
      `import { AssistPublicDb } from '../../../prisma/assist-public-db.service';\nimport { checkPlan } from '../../assist-ui-core/plan-checks';\nimport { readState } from '../../assist-billing/public/entitlements';`,
    ],
    [
      'modules/assist-ui-core/ok34.ts',
      `import { maskSensitiveEcho } from '../../shared/assist-chat-core/post-filter';\nimport { dangerKindsFor } from '../../shared/danger-words';\nimport { uiMapHost } from '../site-core/ui-map/ui-map';\nimport { detectInjection } from '../assist-knowledge-core/injection';\n// assist_site_ui_plans — в комментарии можно`,
    ],
    [
      'shared/ok5.ts',
      `import { createHmac } from 'crypto';\nimport { T } from './ok6';`,
    ],
    [
      'prisma/ok7.ts',
      `import { U } from '../modules/assist-admin-knowledge/u';`,
    ],
  ];

  let ok = true;
  try {
    for (const [rel, src] of good) write(rel, src);
    const clean = findViolations(dir);
    if (clean.length !== 0) {
      ok = false;
      console.error('САМОТЕСТ: разрешённые импорты сочтены нарушениями:');
      for (const v of clean)
        console.error(`  - ${v.file}: «${v.spec}» [${v.rule}]`);
    }
    for (const [rel, src] of bad) write(rel, src);
    const found = findViolations(dir);
    for (const [rel, , rule] of bad) {
      const hits = found.filter((v) => v.file === rel);
      if (hits.length !== 1 || hits[0].rule !== rule) {
        ok = false;
        console.error(
          `САМОТЕСТ: ${rel} — ожидалось одно нарушение [${rule}], найдено: ${
            hits.map((h) => h.rule).join(', ') || 'ничего'
          }`,
        );
      }
    }
    if (found.length !== bad.length) {
      ok = false;
      console.error(
        `САМОТЕСТ: нарушений ${found.length}, ожидалось ${bad.length}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!ok) {
    console.error(
      'check-sites-import-graph: самотест провален — проверке нельзя верить',
    );
    return false;
  }
  console.log(
    `ok   check-sites-import-graph: самотест — ${bad.length} нарушителей пойманы, ${good.length} чистых пропущены`,
  );
  return true;
}

function main() {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }
  const src = path.join(ROOT, 'sites-backend', 'src');
  if (!fs.existsSync(src)) {
    console.error(
      `check-sites-import-graph: нет папки ${path.relative(ROOT, src)}`,
    );
    process.exit(1);
  }
  process.exit(report(findViolations(src), 'sites-backend/src') ? 0 : 1);
}

main();
