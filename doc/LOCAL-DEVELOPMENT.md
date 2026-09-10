# Локальный запуск — с чего начать

Единая точка входа в локальную разработку. Проект — 4 приложения
(`backend/`, `frontend/` он же TMA, `admin/`, `landing/`) плюс Postgres.
Ниже — какой вариант запуска выбрать и куда идти за подробностями;
сама эта страница дублирует только самый нужный минимум, вся глубина —
в документах, на которые она ссылается.

Заменяет собой старый `doc/README-SETUP.md` (удалён этим же изменением)
— тот описывал раннюю версию проекта (S3 вместо Vercel Blob, без
admin/landing/Telegram) и был неточным.

---

## Какой вариант выбрать

| Хотите... | Вариант |
| --- | --- |
| Просто посмотреть, как работает продукт, ничего не настраивая | `make up` (см. ниже) |
| Потрогать Telegram-логин, админку или лендинг | `make up` |
| Работать только над backend/frontend, Telegram/admin/landing не нужны | базовый `docker compose up` ИЛИ нативно |
| Не хотите Docker вообще | Нативно (Вариант Б) — но нужен свой Postgres |

---

## Вариант А: Docker Compose (рекомендуется)

Два файла compose, под разные задачи (подробно — почему два, а не
профили одного — см. `doc/DOCKER.md` и `doc/TELEGRAM-ADMIN.md`):

### A1. Базовый стенд — только продукт (`docker-compose.yml`)

`db` + `backend` + `frontend`, без Telegram-контекста вообще.

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
docker compose up --build
```

- Backend: http://localhost:3000/api (health: `/api/health`; полный
  список маршрутов — `doc/API.md`)
- Frontend: http://localhost:5173

`DATABASE_URL`/`DIRECT_URL` трогать не нужно — уже указывают на
локальный сервис `db`. Реальные API-ключи (Gemini/Laozhang/Blob) нужны
только чтобы дойти до конца воркфлоу — без них приложение стартует, но
соответствующий шаг честно упадёт на своём эндпоинте (см. таблицу ключей
ниже). Остановить: `Ctrl+C`, `docker compose down`. Подробности,
hot-reload, дебаг бэкенда через VS Code/Chrome DevTools, troubleshooting
— всё в `doc/DOCKER.md`.

### A2. Полный стенд — + Telegram-логин, админка, лендинг (`docker-compose.dev.yml`)

`db` + `adminer` + `backend` + `frontend` (TMA) + `admin` + `landing`,
все dev-входы включены — не нужен ни один настоящий Telegram-бот, чтобы
всё потыкать.

```bash
make up
```

(сам создаёт `.env.docker` из `.env.docker.example` при первом запуске).

| Порт | Что это |
| --- | --- |
| 5173 | TMA / frontend (dev-вход автоматический) |
| 3002 | Админка (кнопка «Войти как dev-123» на `/login`) |
| 3003 | Лендинг |
| 3000 | Backend API |
| 8080 | Adminer (просмотр БД) |

Остановить: `make down` (данные БД сохраняются). Полный сброс БД:
`make reset`. Все команды и ручной прогон сценария — `doc/TELEGRAM-ADMIN.md`.

**Нельзя поднимать A1 и A2 одновременно** — оба публикуют Postgres на
`5432` и backend на `3000`; это осознанно (см. комментарий в самом
`docker-compose.dev.yml`), чтобы `DATABASE_URL` из `.env` подходил к
обоим вариантам без правок.

---

## Вариант Б: без Docker (нативно)

Нужен свой Postgres — либо поднятый локально самостоятельно, либо
настоящий Supabase-проект (см. `doc/PRISMA-SUPABASE.md`, там же — где
взять `DATABASE_URL`/`DIRECT_URL`). Docker сам подставляет их за вас;
нативно — нет.

1. **Backend**:
   ```bash
   cd backend
   cp .env.example .env    # заполнить DATABASE_URL/DIRECT_URL + нужные API-ключи
   npm install              # postinstall сам вызывает `prisma generate`
   npm run start:dev
   ```
   → http://localhost:3000
2. **Frontend (TMA)**:
   ```bash
   cd frontend
   cp .env.example .env
   npm install
   npm run dev
   ```
   → http://localhost:5173
3. **Admin** (опционально — только если работаете над админкой):
   ```bash
   cd admin
   cp .env.example .env
   npm install
   npm run dev
   ```
   → http://localhost:3002. Чтобы реально войти без настоящего
   Telegram-бота — выставить `ALLOW_DEV_AUTH=true` в `backend/.env` (и
   `NEXT_PUBLIC_ALLOW_DEV_AUTH=true` в `admin/.env`), см.
   `doc/TELEGRAM-ADMIN.md`.
4. **Landing** (опционально):
   ```bash
   cd landing
   cp .env.example .env
   npm install
   npm run dev
   ```
   → http://localhost:3003. Полностью статический, backend не нужен
   вообще.

---

## Ключи API — что реально нужно, а что можно оставить пустым

Стенд (в любом варианте) поднимается и без единого ключа — пустой ключ
не ошибка, просто соответствующий шаг честно откажет на своём
эндпоинте, а не уронит запуск всего остального.

| Переменная | Разблокирует | Обязательна, чтобы... | Где взять |
| --- | --- | --- | --- |
| `DATABASE_URL`/`DIRECT_URL` | Postgres (сессии) | вообще что-либо сохранялось | Docker: подставляется сам. Нативно: свой Postgres или Supabase, см. `doc/PRISMA-SUPABASE.md` |
| `GEMINI_API_KEY` | Анализ видео + генерация Veo 3.1; также категория товара по фото и голос→текст (`/api/projects/**/photo/process`, `/voice/transcribe`) | дойти до конца воркфлоу | Google AI Studio |
| `LAOZHANG_API_KEY` (+`_BASE_URL`) | Текст промпта (GPT-5) | получить сгенерированный промпт | laozhang.ai |
| `BLOB_READ_WRITE_TOKEN`/`BLOB_STORE_ID` | Vercel Blob | загрузить видео/фото товара | Vercel Dashboard → Blob Store |
| `TELEGRAM_BOT_TOKEN` | Настоящий (не dev) Telegram-логин | войти БЕЗ dev-обхода | @BotFather — не нужен вообще для обычной локальной разработки, см. ниже |
| `SERPAPI_API_KEY` (+`SERPAPI_DAILY_LIMIT_PER_USER`, по умолчанию 50) | Аналоги товара по фото (Google Lens), `doc/PRODUCT-PROJECT-SPEC.md` §6.1 | искать рыночные аналоги/цены по фото | serpapi.com. Читается `SerpApiLensService` (`POST /api/projects/:id/items/:itemId/photo/process`). Без ключа фото сохраняется, аналогов нет, в ответе `analogsReason` |
| `YOUTUBE_API_KEY` | Поиск референсного видео по YouTube, ТЗ §6.4 | искать реф. видео (ручная ссылка/файл работают и без него) | Google Cloud Console, YouTube Data API v3. Читается `YoutubeSearchService` (`GET /api/youtube-search?q=…`). Без ключа — 503 с понятным текстом |
| `YOUTUBE_SEARCH_DAILY_LIMIT_PER_USER` (по умолчанию 20) | Дневной лимит поисков YouTube на пользователя | — (не секрет, просто число) | Квота Google ~100 `search.list`/день общая на деплой; лимит не даёт одному пользователю израсходовать её за всех. Читается `YoutubeSearchUsageService` |
| `AUDIT_AUTO_ITERATIONS_LIMIT` (по умолчанию 3) | Лимит циклов аудит→правка→перегенерация, ТЗ §11.1 | — (не секрет, просто число) | Читается `VideoAuditService` (`GET/POST /api/sessions/:id/audit`) — мягкий лимит: в ответе `overLimit`, UI предупреждает |
| `PROJECT_LINE_ITEM_LIMIT` (по умолчанию 20) | Максимум товаров в линейке, ТЗ §7.3 | — (не секрет, просто число) | Читается `ProjectService` (`POST /api/projects/:id/items`) |
| `FFMPEG_API_KEY` | Обрезку кадра под неродной формат и вообще всю постобработку, ТЗ §16.1 | получить ролик в 3:4 / 1:1 / своём W:H, а не в родном кадре Veo | verygoodffmpeg.com (база меняется через `FFMPEG_API_BASE_URL`). Читается `FfmpegApiService`. Без ключа ролик остаётся в родном формате, в карточке — «обрезка на этом стенде не подключена», а не ошибка |
| `VOICE_API_KEY` | Настоящую озвучку — свой голос вместо голоса Veo, ТЗ §15 | услышать голос бренда, а не случайный голос модели | elevenlabs.io. Читается `ElevenLabsService` (`GET /api/tts/voices`, `POST /api/tts/preview` и постобработка). Без ключа реплики произносит Veo — поведение до этапа 35 |
| `VOICE_ID`, `VOICE_MODEL` | Голос и модель синтеза по умолчанию | — (не секрет; голос бренда всё равно выбирается в манифесте) | Идентификатор голоса — из каталога `GET /api/tts/voices`. Модель по умолчанию `eleven_multilingual_v2`: умеет украинский и русский |
| `TELEGRAM_ALERTS_CHAT_ID`, `TELEGRAM_STATS_CHAT_ID` | Служебные каналы: ошибки и суточный отчёт, ТЗ §28 | — (локально обычно не нужны) | Идентификаторы чатов, куда пишет тот же бот. Пусто — сервис молчит, это нормальное состояние стенда. Проверить руками: `curl localhost:3000/api/cron/report` |
| `GEMINI_MODEL` (по умолчанию `gemini-2.5-flash`) | Модель Gemini для ВСЕХ пяти вызовов: разбор видео, релевантность, аудит ролика, категория по фото, голос→текст | — (не секрет) | С этапа 43 читается из одного места (`common/gemini-model.ts`); до этого три вызова из пяти держали модель зашитой, а админка обещала обратное (Б-5.4). Модель вне прайса пишется в расход как `unpriced` |
| `OPENAI_GPT_MODEL` (по умолчанию `gpt-5`) | Модель для сборки промпта | — (не секрет) | Читается `PromptService` через `configuration.ts` |
| `ADMIN_LOGIN_BOT_TOKEN` | Отдельный бот под Login Widget админки | — (нужен, только если у админки свой домен) | @BotFather; у Login Widget один домен на бота, см. `doc/DEPLOYMENT.md` |
| `CORS_ORIGIN` (по умолчанию `http://localhost:5173`) | Кто может ходить в API из браузера — и кому разрешено писать по cookie | — (на стенде хватает умолчания) | Тот же список читает CSRF-проверка (`common/csrf.ts`, этап 41): в проде переменная обязательна, пустая означает отказ на запись |
| `PLANS_BILLING_ENABLED` (по умолчанию выключено) | Запрет менять себе режим самому, ТЗ §23 | — | Пока `false`, любой вошедший может поставить себе Premium — и поднять свой суточный потолок расхода |
| `DAILY_SPEND_LIMIT_USD_*` | Суточные потолки расхода по режимам и общий для анонимных, ТЗ §26.4 | — (не секрет, числа) | Читается `spend-limits.ts`; единственное, что ограничивает счёт за Veo |
| `AI_PRICE_*` | Переопределение ставок прайса, ТЗ §26 | — | Нужно, только если цены провайдеров разошлись с таблицей в коде |
| `BLOB_PUBLIC_HOSTS` | Свой домен хранилища, ТЗ §12 (этап 38) | — (нужен, только если у Blob-store свой домен) | Сервер скачивает референс-изображения строго со своих адресов; пусто — только `*.public.blob.vercel-storage.com`. **Пустое значение проверку не отключает** |

Эндпоинты `/api/projects/**` требуют идентичности (401 без неё) — на
dev-стенде это заголовок `X-Dev-User-Id: 123` (ALLOW_DEV_AUTH уже
включён в `make up`), например:
`curl -H 'X-Dev-User-Id: 123' -H 'Content-Type: application/json' -d '{"type":"LINE","title":"Тест","countryCode":"UA"}' http://localhost:3000/api/projects`.

Запуск генерации из товара (этап 10): `curl -X POST -H 'X-Dev-User-Id: 123'
http://localhost:3000/api/projects/<projectId>/items/<itemId>/sessions` —
вернёт `{sessionId, session}` того же вида, что `POST /api/sessions`, но с
уже заполненным `session.productInformation` (копия товара) и, если у
проекта есть манифест, `session.brandManifestSnapshot`. Дальше — обычные
`/api/sessions/:id/**`. Правка копии манифеста для этого прогона:
`PATCH /api/sessions/<sessionId>/brand-manifest` (без идентичности — как
все `/sessions/**`).

Поиск референсного видео (этап 11): `curl -H 'X-Dev-User-Id: 123'
'http://localhost:3000/api/youtube-search?q=running+shoes&regionCode=UA&language=uk'`
— 50 результатов одним вызовом (`search.list` + один batch `videos.list`),
в ответе `results[]` (превью, название, канал, длительность, просмотры,
лайки, `url`) и `usage` (счётчик дня). Выбранный `url` дальше идёт в уже
существующий `POST /api/sessions/:id/video/youtube`.

Персонажи (этап 14): после анализа `GET /api/sessions/:id/characters`
отдаёт кастинг, `PUT` с `{casts:[{characterId, active, order,
replacement:{kind,…}}]}` сохраняет его (id персонажей — из
`videoAnalysis.characters`), `POST …/characters/:cid/photo/upload-url` +
`…/confirm` — фото-замена («новый скин»). Без идентичности, как все
`/sessions/**`.

Аудит готового ролика (этап 16): `POST /api/sessions/:id/audit` (пустое
тело — Gemini смотрит видео; `{"issue":"третья рука на 0:03"}` — вы
указываете сами, Gemini только переписывает промпт), `GET` — история и
счётчик итераций против `AUDIT_AUTO_ITERATIONS_LIMIT`,
`POST …/audit/apply {"auditId"}` — положить предложенный промпт в
черновик (сбросит approve).

Сцены и слоты референсов (этап 21): `POST /api/sessions/:id/scenes/upload-url`
→ PUT → `POST …/scenes/confirm {"pathname","label","description"}`;
`GET /api/sessions/:id/references` — кандидаты (`character:c1`, `scene:<id>`,
`brand-scene:<id>`, `product`, у каждого `origin: session|brand`) и текущие
слоты, `PUT {"slots":[…]}` (≤3, порядок = номер референса), `DELETE` —
вернуть авто-правило.

Сцены бренда (этап 22): `POST /api/brand-manifests/:id/scenes {"label",
"description"}` под `X-Dev-User-Id`, затем `POST …/scenes/:sid/photo/
upload-url` → PUT → `…/photo/confirm {"pathname"}` — ровно как у
персонажей. Сессия, созданная из проекта с этим манифестом, получает
копию в `brandManifestSnapshot.scenes[]` и кандидат `brand-scene:<sid>`
в `/references` (только у сцен с фото).

Аудитория и релевантность (этап 23): `PATCH /api/projects/:id/items/:iid
{"audience":{"ageRange":"25-44","gender":"women","interests":["бег"],
"summary":"…"}}` — ручной профиль (после фото он заполняется сам);
`POST /api/sessions/:id/relevance` после анализа и товара → `{report:
{score, verdict, summary, reasoning[], matches[], gaps[], adjustments[],
promptAdvice}, useInPrompt}`; `PATCH …/relevance {"useInPrompt":false}`
убирает секцию AUDIENCE FIT из брифа GPT. Превью-кадры:
`POST /api/sessions/:id/analysis/previews/upload-url {"keys":
["character:c1","scene:s1"]}` → PUT JPEG → `…/previews/confirm
{"items":[{"key","pathname"}]}` (в норме это делает браузер сам из
загруженного файла).

Сцены, массовка и библиотека (этап 24): `GET/PUT
/api/sessions/:id/analysis/selection {"droppedScenes":["s2"],
"droppedExtras":["e1"]}` — снять сцену/массовку (id из разбора);
`GET /api/library/recommend?sessionId=…` — рекомендации со счётом и
причинами; `POST /api/sessions/:id/video/library {"entryId"}` — взять
готовый разбор (Gemini не вызывается). Кеш проверяется сам: повторный
анализ той же YouTube-ссылки или того же файла (SHA-256) возвращает
разбор из библиотеки, в логе — «Analysis served from the library».
Модерация библиотеки (этап 25, только оператор): `GET /api/admin/library?
visibility=HIDDEN&sourceType=upload&q=крос`, `GET /api/admin/library/:id`
(с самим разбором), `PATCH /api/admin/library/:id {"visibility":"HIDDEN",
"hiddenReason":"…"}` (причина обязательна), `DELETE …`. Разборы
загруженных файлов создаются приватными — в рекомендациях их видит только
автор; скрытая запись не отдаётся и из кеша.
Согласие с офертой: `GET /api/me/terms`, `POST /api/me/terms/accept`
под `X-Dev-User-Id`. Юридические тексты — `doc/legal/*.md`, после правки
`node scripts/sync-legal.mjs` (в CI — `--check`).

Смена референса (этап 28): подстановка другого референса любым из трёх
путей обнуляет кастинг, снятые сцены и массовку, выбор слотов и отчёт
релевантности — они описывали прошлый ролик. Товар, манифест бренда и
загруженные сцены остаются.

Уборка (этап 26): `curl -H "Authorization: Bearer $CRON_SECRET"
'http://localhost:3000/api/cron/cleanup-sessions'` — ответ содержит
`deletedCount`, `deletedBlobs` и `hasMoreSessions`; с `SESSION_TTL_HOURS=0`
удобно проверять, что файлы сессии действительно исчезают из Blob
(`doc/STORAGE-AUDIT.md`). С этапа 51 тот же маршрут убирает и
невостребованные разборы библиотеки (`deletedLibraryEntries`,
`hasMoreLibraryEntries`; срок — `LIBRARY_UNUSED_TTL_DAYS`, по умолчанию
180 дней, партия 200 записей). Потолок уборки сессий — 500 × 20 партий =
10 000 сессий за прогон (В-4.3); при большем суточном потоке очередь не
догоняется, о чём крон пишет в лог.

Метла осиротевших файлов (этап 27): `curl -H "Authorization: Bearer
$CRON_SECRET" 'http://localhost:3000/api/cron/sweep-orphans?dryRun=1'` —
покажет, какие файлы под `sessions/` больше не принадлежат ни одной
сессии; без `dryRun` удалит. Не в расписании: удаление необратимо.

Очередь публикации (этап 18, без интеграций): `POST
/api/sessions/:id/publications {"platform":"YOUTUBE","title":"…"}` (нужна
идентичность и сессия, созданная под ней — анонимная даст 403) → заявка
PENDING; `GET` — заявки сессии; `DELETE …/publications/:requestId` —
отозвать PENDING. Оператор: `GET /api/admin/publications?status=PENDING`,
`POST /api/admin/publications/:id/approve`, `POST …/reject {"reason"}` —
cookie админки + `isOperator`. Одобрение ничего не выкладывает — выгрузка
в канал будет отдельным ТЗ.

Обрезка кадра и озвучка (этапы 34–36): оба ключа кладутся в
`.env.docker` (полный стенд) или `backend/.env` (нативно) — в
`docker-compose.dev.yml` они уже проброшены, добавлять туда ничего не
нужно. Проверить, что стенд их видит, быстрее всего в админке:
http://localhost:3002/settings → группы «Постобработка ролика» и
«Озвучка».
Каталог голосов — `curl -H 'X-Dev-User-Id: 123'
'http://localhost:3000/api/tts/voices'` (без ключа ответ
`{"configured":false, "error":…}` — это не ошибка стенда, а честный
отказ); проба голоса — `POST /api/tts/preview {"text":"Привет","voiceId":…}`,
mp3 приходит `data:`-URL и нигде не оседает, 30 проб в сутки на
пользователя. Сама постобработка отдельного маршрута не имеет: она
запускается после рендера и опрашивается тем же
`GET /api/sessions/:id/generate` — в ответе `postStatus`, `voiceStatus`
и причина, если не вышло. **Без ключей ничего не ломается**: ролик
остаётся в родном кадре Veo и с его же голосом, а интерфейс пишет об
этом пометкой, а не красной ошибкой, — это и есть главное свойство обоих
этапов, и проверять его стоит первым.

**Telegram-бот для локальной разработки не нужен вообще** — у TMA,
админки и постоянного логина `frontend/` есть dev-обход
(`ALLOW_DEV_AUTH=true`), включённый по умолчанию в `make up`. Подробно
— `doc/TELEGRAM-ADMIN.md`.

---

## Дальше

- `doc/DOCKER.md` — подробности базового стенда: hot-reload, дебаг
  бэкенда (VS Code/Chrome DevTools), troubleshooting.
- `doc/TELEGRAM-ADMIN.md` — подробности полного стенда: два dev-входа,
  ручной прогон сценария, `isOperator` в продакшене.
- `doc/PRISMA-SUPABASE.md` — если нужен настоящий Postgres (Supabase)
  вместо локального контейнера.
- `doc/DATABASE-AUDIT.md` — устройство схемы БД, если меняете
  `schema.prisma`.
- `doc/DEPLOYMENT.md` — деплой на Vercel (это НЕ локальный запуск).
