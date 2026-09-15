# План реализации: Проект → Товар → Аналоги → Референсное видео → Персонажи → Аудит → Манифест бренда

Статус: план внедрения по шагам к уже согласованному
`doc/PRODUCT-PROJECT-SPEC.md` (все открытые вопросы там закрыты
решениями, кроме явно оставленных открытыми продуктовых — этот
документ их не пересматривает, только реализует). Реализация ещё не
начата.

Ревизия: пересмотрен после того, как в ТЗ добавился §12 (Манифест
бренда) уже ПОСЛЕ первой версии этого плана — тогда план его не
учитывал вообще. В этой версии добавлены два новых этапа (7 и 9) и
расширены несколько существующих (2, 8, 10, 14, 15) — см. также
`doc/PRODUCT-PROJECT-SPEC.md`, где повторный аудит нашёл и поправил
несколько внутренних нестыковок самого ТЗ (устаревшие ссылки на уже
решённые открытые вопросы, отсутствие `photoHash`/`Session`-полей в
черновой модели §5, и реальное техническое противоречие между §10.2 и
§10.3 про лимит в 3 `referenceImages` — все поправлены там же).

## 0. Как разбито на этапы

Каждый этап — самостоятельный, демонстрируемый кусок: после него можно
руками прогнать сценарий через `docker compose -f docker-compose.dev.yml
up` и показать результат, не дожидаясь всех остальных этапов. Порядок
учитывает зависимости (Prisma-схема — раньше кода, который её
использует; секреты — раньше кода, который их читает).

**Про `frontend-v2/`.** Папка заводилась под редизайн вёрстки как
параллельная копия `frontend/`. В итоге редизайн сделан прямо в
`frontend/` (этап 8), и по решению владельца `frontend-v2/` вместе с
сервисом в `docker-compose.dev.yml` удалены — актуальный UI один.

## Этап 1 — Секреты и конфигурация

Ничего не сломает существующий функционал, разблокирует тестирование
следующих этапов реальными ключами.

- `backend/.env.example`, `backend/src/config/configuration.ts` —
  добавить `SERPAPI_API_KEY`, `YOUTUBE_API_KEY`.
- `admin` — вкладка «Настройки» (`env-settings.ts`) — добавить эти два
  ключа туда же, где уже есть `GEMINI_API_KEY`/`LAOZHANG_API_KEY`, плюс
  два конфигурируемых лимита (не секреты, но тот же принцип «настройка,
  не хардкод», см. §7.5 и §11.1 спеки):
  - `SERPAPI_DAILY_LIMIT_PER_USER` (по умолчанию 50).
  - `AUDIT_AUTO_ITERATIONS_LIMIT` (по умолчанию 3).
- `docker-compose.dev.yml` — прокинуть новые переменные в `backend`
  сервис (по аналогии с уже существующими `GEMINI_API_KEY` и т.д.).

**Проверка:** `docker compose -f docker-compose.dev.yml up`, открыть
`/settings` в админке — новые поля видны и сохраняются.

## Этап 2 — Prisma-схема и миграция

Финальная (для v1) схема — включает и §5 спеки, и Манифест бренда
(§12), и Session-связи (§7.8), одной миграцией, поскольку ничего из
этого ещё не в проде:

```prisma
model Project {
  id          String      @id @default(cuid())
  userId      String?
  user        User?       @relation(fields: [userId], references: [id])
  type        ProjectType
  title       String
  countryCode String
  currency    String
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @default(now()) @updatedAt
  items       ProductItem[]
  sessions    Session[]

  brandManifestId String?
  brandManifest    BrandManifest? @relation(fields: [brandManifestId], references: [id], onDelete: SetNull)

  @@map("projects")
}

enum ProjectType {
  SINGLE
  LINE
}

model ProductItem {
  id          String   @id @default(cuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  photoUrl    String?
  photoHash   String?      // ключ кеша SerpApi (§7.5) — SHA-256 файла/Blob-URL
  description String?
  category    String?      // авто-детект, свободный текст (§6.1, §9.4)
  price       Decimal?
  priceSource ProductPriceSource
  analogs     ProductAnalog[]
  sessions    Session[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @default(now()) @updatedAt
  @@map("product_items")
}

enum ProductPriceSource {
  MANUAL
  ANALOG
}

model ProductAnalog {
  id            String      @id @default(cuid())
  productItemId String
  productItem   ProductItem @relation(fields: [productItemId], references: [id], onDelete: Cascade)
  title         String
  sourceUrl     String
  price         Decimal?
  currency      String?
  thumbnailUrl  String?
  relevanceRank Int
  @@map("product_analogs")
}

// Манифест бренда — §12. Надпроектная сущность, много Project на один
// BrandManifest, много BrandManifest на одного пользователя.
model BrandManifest {
  id         String   @id @default(cuid())
  userId     String?
  user       User?    @relation(fields: [userId], references: [id])
  title      String
  filters    Json?
  effects    Json?
  styleNotes String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @default(now()) @updatedAt
  projects   Project[]
  characters BrandCharacter[]
  @@map("brand_manifests")
}

model BrandCharacter {
  id              String   @id @default(cuid())
  brandManifestId String
  brandManifest   BrandManifest @relation(fields: [brandManifestId], references: [id], onDelete: Cascade)
  label           String
  photoUrl        String?
  description     String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @default(now()) @updatedAt
  @@map("brand_characters")
}
```

И на существующей модели `Session` (не трогая её текущие поля, §7.8):

```prisma
model Session {
  // ...существующие поля без изменений...
  projectId     String?
  project       Project?     @relation(fields: [projectId], references: [id], onDelete: SetNull)
  productItemId String?
  productItem   ProductItem? @relation(fields: [productItemId], references: [id], onDelete: SetNull)
}
```

Кеш по хешу фото (§7.5) реализуется полем `photoHash` — при совпадении
хеша отдаём уже сохранённые `ProductAnalog`, не вызывая SerpApi заново.

Миграция — `backend/prisma/migrations/<timestamp>_project_product_brand/
migration.sql`, в том же стиле, что и существующие (Prisma 7 +
`prisma.config.ts` + driver adapter, см. `doc/PRISMA-SUPABASE.md`).

**Проверка:** `npx prisma migrate deploy` внутри контейнера бэкенда
проходит на чистой БД (`docker compose down -v` → `up --build`),
`npx prisma studio`/Adminer — все новые таблицы видны, включая
`brand_manifests`/`brand_characters`.

## Этап 3 — Backend: модуль `project` (CRUD)

Новый `backend/src/modules/project/`:
- `POST /projects` — создать проект (тип, страна → валюта авто, см.
  §6.3, опционально `brandManifestId`), `GET /projects`, `GET
  /projects/:id`.
- `POST /projects/:id/items` — добавить товар в линейку (валидация
  лимита 20, §7.3 — `403`/`400` с понятным сообщением при превышении).
- `PATCH /projects/:id/items/:itemId` — обновить товар (описание, цена,
  `priceSource`).
- `PATCH /projects/:id` — в т.ч. привязать/отвязать `brandManifestId`
  задним числом (манифест можно выбрать не только при создании).
- Валидация «полностью заполненного» товара (§7.4) — вычисляемое поле
  в ответе API (`isComplete: !!price && !!description`), не блокирует
  сохранение неполного черновика.

**Проверка:** `curl`/Postman по новым эндпоинтам — создание проекта,
добавление 21-го товара в линейку возвращает понятную ошибку лимита.

**Сделано (этап 3):** `backend/src/modules/project/` — контроллер,
сервис, три DTO, модуль, зарегистрирован в `AppModule`. Что отличается
от плана выше или уточнилось по ходу:
- Все роуты `/projects/**` требуют идентичности — новый
  `TelegramIdentityGuard` (`modules/telegram-auth/`), 401 без неё.
  Причина: Project — постоянный каталог, который потом листается и
  правится; без владельца его не под чем показывать, а «любой, кто
  угадал id, читает/правит чужие цены» недопустимо. Анонимный флоу не
  затронут — он живёт на Session без Project (ТЗ §7.8). Каждый запрос
  скоупится `where: { id, userId }`, промах — 404, не 403 (не
  раскрываем существование чужих id).
- Добавлены `DELETE /projects/:id` и `DELETE .../items/:itemId` (в
  плане не было — но убрать ошибочно добавленный товар из линейки на
  Экране 2 без этого нельзя). Каскады/SetNull проверены в этапе 2.
- `PATCH /projects/:id` с защитами: `LINE → SINGLE` только при ≤1
  товаре; смена `countryCode` только пока ни у одного товара нет цены
  (иначе числа молча стали бы в другой валюте — §7.1); `brandManifestId:
  null` отвязывает манифест.
- Лимит линейки — новая настройка `PROJECT_LINE_ITEM_LIMIT` (20),
  добавлена туда же, куда и лимиты этапа 1 (конфиг, `.env.example`,
  compose, вкладка «Настройки»).
- Справочник стран (`common/data/countries.ts`, 253 страны) сделан уже
  здесь, а не на этапе 6 — валюта нужна при создании проекта.
  Сгенерирован из CLDR (babel), не набран руками; один override
  поверх CLDR — BG → EUR (Болгария в еврозоне с 01.01.2026, снимок
  CLDR в babel это ещё не отражал). Этапу 6 остаётся только
  `GET /reference/countries` поверх этого файла.
- `ProductItem.title` добавлен в схему/ТЗ — §4/§9 на него ссылались,
  а в модели §5 его не было.
- Тесты: 48 (jest) — сервис с mock-Prisma (лимиты, валюта, скоупинг,
  переходы PATCH, `isComplete`), DTO под РЕАЛЬНЫМИ настройками
  `ValidationPipe` (whitelist+forbidNonWhitelisted — тот самый класс
  бага, что был у `DevLoginDto`; проверено, что `currency`/`category`/
  `photoUrl` в теле отклоняются), справочник стран, guard. В песочнице
  jest запускается с `ts-jest diagnostics: false` (нет сгенерированного
  клиента — см. doc/TELEGRAM-ADMIN.md §5); локально после `prisma
  generate` идёт с полной типизацией.

## Этап 4 — Backend: поиск аналогов по фото + авто-категория

Новый `backend/src/modules/product-analog/` (или метод в `project`
модуле — на усмотрение реализации):
- Интеграция SerpApi Google Lens — портирование/сверка с реализацией из
  проекта **SilverFinance** (§6.1) — точный файл/модуль уточняется на
  этом этапе, не раньше (единственный пункт, который физически нельзя
  спланировать точнее без доступа к тому репозиторию).
- При загрузке фото: (1) посчитать `photoHash`, (2) если для этого хеша
  уже есть `ProductAnalog` — вернуть их без вызова SerpApi, (3) иначе —
  вызвать SerpApi, сохранить `visual_matches` как `ProductAnalog[]` +
  сохранить авто-определённую категорию в `ProductItem.category`.
- Дневной лимит на пользователя (`SERPAPI_DAILY_LIMIT_PER_USER`, этап
  1) — простой счётчик вызовов (по `userId`, сброс по UTC-суткам,
  например через Redis-less подход — запись в БД с датой, аналогично
  тому, как уже считается что-то похожее в проекте, либо простая
  Postgres-таблица `serp_api_usage(userId, date, count)`).

**Проверка:** дважды загрузить одно и то же фото — второй раз без
реального вызова SerpApi (проверить по логам/счётчику); превысить
дневной лимит — понятная ошибка, не 500.

**Сделано (этап 4):** `backend/src/modules/product-analog/` — отдельный
модуль (не метод в `project`): три внешние интеграции + счётчик, CRUD
оставлен чистым. Реализация SilverFinance была приложена (архив
`silverfinance-main`), перенос — по её `src/lib/server/lens-search.ts`,
`api/auctions/lens-search/route.ts` и `recognize.ts`:
- `SerpApiLensService` — порт `lensVisualMatches` 1:1 по контракту
  (никогда не бросает, `{matches, reason}`, обе формы цены
  `price.extracted_value`/`extracted_price`, строки без ссылки
  отбрасываются) + флаг `billed` (SerpApi ответил 200 — именно такие
  поиски тарифицируются); `hl`/`country` — из страны проекта вместо
  захардкоженных `uk`/`ua`. CLIP-переранжирование (Replicate) НЕ
  перенесено — отдельный платный сервис, релевантность = позиция SerpApi.
- `ProductRecognitionService` — паттерн `recognize.ts` (vision-LLM →
  строгий JSON → устойчивый парсинг с обрезкой ```-fences) на Gemini
  вместо Grok; категория свободным текстом (§9.4) + подсказка названия
  (ставится, только если `title` пуст). Это и есть ответ на «уточнить
  источник категории» из §6.1 — у Lens поля категории нет, в
  SilverFinance она тоже из LLM.
- `SerpApiUsageService` + модель `SerpApiUsage` + миграция
  `20260905150000_serpapi_usage` — дневной счётчик (userId, UTC-день),
  upsert-инкремент. Считаются только billed-вызовы: кеш, отказ по ключу,
  сеть — лимит не расходуют. 429 при исчерпании, ПЕРЕД платным вызовом.
- Два эндпоинта на товар: `POST .../photo/upload-url` (presigned Blob
  PUT — тот же контракт, что у product-image, фото не проходит через
  тело запроса из-за лимита Vercel 4.5 MB) и `POST .../photo/process`
  `{pathname}` → head+download → SHA-256 → кеш по хешу (тот же
  пользователь, любой товар с сохранёнными аналогами → копируем без
  SerpApi; тот же товар с тем же фото → идемпотентно, ничего не платим)
  → лимит → Lens → Gemini → одна транзакция (замена аналогов, обновление
  товара, `updatedAt` проекта). Сбои Lens/Gemini деградируют, не
  блокируют (§7.4): ответ несёт `analogsSource: serpapi|cache|none` и
  `analogsReason`/`recognitionReason`, чтобы UI отличал «недоступно» от
  «не найдено».
- `SERPAPI_KEY` → `SERPAPI_API_KEY` везде (имя как в SilverFinance, по
  §6.1). `CountryRef.language` (CLDR likely-subtags) добавлен в
  справочник — для `hl`.
- Тесты: +31 (итого 81): парсер на фикстурах формы реального ответа
  SerpApi (обе формы цены, без цены, без ссылки), контракт `billed`
  (401 → не billed; 200 c `error` → billed), оркестрация (порядок
  кеш→лимит→оплата, идемпотентный повтор, 429 до платного вызова,
  деградация), парсер JSON-ответа Gemini, DTO под реальным
  `ValidationPipe`; седьмая миграция накатана на локальный Postgres 16
  с проверкой upsert-инкремента и каскада.

## Этап 5 — Backend: голос → текст (Gemini audio)

Новый эндпоинт (например, `POST /projects/:id/items/:itemId/transcribe`)
— принимает аудио-файл, отправляет в Gemini как аудио-вход
(`GEMINI_API_KEY`, уже настроен), возвращает расшифрованный текст.
Никакого нового сервиса/ключа — переиспользование существующей
интеграции (§6.2).

**Проверка:** записать короткое голосовое сообщение через `curl
-F audio=@test.ogg`, получить текст в ответе.

**Сделано (этап 5):** `backend/src/modules/voice/` — `VoiceModule`,
`VoiceTranscriptionService` (Gemini), `VoiceService`, два DTO,
контроллер, регистрация в `AppModule`. Отличия от наброска выше:
- НЕ multipart `-F audio=@…` на бэкенд, а тот же двухшаговый Blob-флоу,
  что у фото и product-image: `POST .../voice/upload-url` (presigned PUT)
  → `POST .../voice/transcribe {pathname, apply?}`. Причина: этот бэкенд
  намеренно убрал Multer/прямые загрузки из-за лимита тела Vercel
  Function 4.5 MB (см. ProductController) — голосовая заметка обычно
  мала, но WAV на несколько минут с iOS-фоллбэка уже нет; и у фронта
  уже есть загрузчик ровно под этот контракт. Запись — транзитная
  копия: удаляется из Blob сразу после того, как Gemini её прочитал
  (как транзитная копия референс-видео), хранится только текст.
- Формат записи: проверено по документации Gemini (audio understanding)
  — `audio/webm` (Chrome / Telegram Android WebView), `audio/mp4`/`m4a`
  (iOS Safari), `audio/ogg`/`opus`, wav/mp3/aac/flac все входят в
  официальный список, транскодирование на сервере не нужно. DTO
  сравнивает БАЗОВЫЙ тип, потому что MediaRecorder отдаёт
  `audio/webm;codecs=opus` — обычный `@IsIn` отклонял бы каждую реальную
  запись. Лимит 15 MB (inline-запрос Gemini ≤ 20 MB).
- `apply` (по умолчанию true) сразу пишет расшифровку в
  `item.description` — Экран 4 показывает её в редактируемом поле;
  `apply: false` только возвращает текст (для UI-вопроса «заменить
  существующее описание?»). Неудача расшифровки НЕ затирает уже
  имеющееся описание и возвращает `reason` (§7.4 — голос заполняет поле,
  не блокирует).
- Каждая запись — под своим timestamped-ключом (`voice-<ts>.<ext>`):
  перезапись новым дублем не гонится с ещё идущей расшифровкой
  предыдущего.
- Тесты: +18 (итого 99) — сервис Gemini с mock-SDK (base MIME в
  `inlineData`, пустой ответ → reason, сбой → reason), оркестрация
  (владение, чужой pathname, отсутствие загрузки, apply/не apply,
  удаление транзитной копии в любом исходе), DTO под реальным
  `ValidationPipe` (все браузерные MIME с параметрами кодека проходят,
  `video/webm` — нет).

## Этап 6 — Backend: справочник стран/валют

- Статические данные (готовый открытый датасет ISO 3166-1 ↔ ISO 4217,
  §6.3) — как JSON-файл в репозитории (`backend/src/common/data/
  countries.json`), не как отдельная таблица БД (справочник не
  меняется рантаймом).
- `GET /reference/countries` — список для селектора с поиском на
  фронте.

**Проверка:** эндпоинт отдаёт список, страна → валюта проставляется
верно при создании проекта (Этап 3).

**Сделано (этап 6):** `backend/src/modules/reference/` — `GET
/api/reference/countries`. Сам справочник (`common/data/countries.ts`,
253 страны из CLDR) был сделан ещё на этапе 3, здесь — только эндпоинт
поверх него. Решения: (а) TS-файл в бандле, не JSON и не таблица —
данные не меняются рантаймом, а типизированный экспорт уже используется
`ProjectService`/`SerpApiLensService` напрямую; (б) весь список целиком
(~15 KB), без серверного `?q=` — поиск в пикере (§6.3) делается на
клиенте, 253 строки фильтруются мгновенно и без сетевого запроса на
каждую букву внутри Telegram WebView; (в) публичный, без
`TelegramIdentityGuard` — ничего пользовательского, а Экран 1 нужен ДО
того, как появится проект; (г) `Cache-Control: public, max-age=86400` —
список неизменен в пределах деплоя; (д) поле `language` (SerpApi `hl`)
наружу не отдаётся — серверная деталь. Тесты: +6 (итого 105), в т.ч.
настоящий e2e через `@nestjs/testing` + supertest — поднят Nest-app
только с `ReferenceModule` (без Prisma, поэтому работает и в песочнице),
с тем же глобальным префиксом `/api` и `ResponseInterceptor`, что в
`main.ts`: проверены роут, конверт `{success, data, meta}`, заголовок
кеша.

## Этап 7 — Backend: модуль `brand-manifest` (CRUD) [новый этап]

Новый `backend/src/modules/brand-manifest/` (§12) — независим от
Project/ProductItem по данным (своя таблица), зависит только от
Prisma-схемы (Этап 2), можно делать параллельно с этапами 3–6:
- `POST /brand-manifests`, `GET /brand-manifests`, `GET
  /brand-manifests/:id`, `PATCH /brand-manifests/:id` (название,
  `filters`/`effects`/`styleNotes` — точная структура `filters`/
  `effects` уточняется здесь же, на этапе реализации, см. открытый
  вопрос §12.1 спеки).
- `POST /brand-manifests/:id/characters` — добавить персонажа бренда
  (фото ИЛИ текстовое описание), `PATCH .../characters/:characterId`,
  `DELETE .../characters/:characterId`.

**Проверка:** создать манифест, добавить 2 персонажей бренда (один с
фото, один только текстом) через `curl`/Postman.

**Сделано (этап 7):** `backend/src/modules/brand-manifest/` — 10
эндпоинтов за `TelegramIdentityGuard`: CRUD манифестов, CRUD персонажей,
фото персонажа через тот же presigned-Blob флоу (`photo/upload-url` →
PUT → `photo/confirm {pathname}` → сохраняется публичный URL). Решения:
- **§12.1 (структура `filters`/`effects`) — намеренно оставлено открытым
  на v1**: принимается любой плоский JSON-объект ≤ 16 KB (не массив, не
  скаляр), хранится как есть. Конкретная схема фиксируется на этапе 15,
  когда появится потребитель — иначе структуру пришлось бы угадывать
  раньше, чем известно, как она ложится в промпт Veo. Смена схемы
  миграции не потребует (колонка `Json`).
- Фото персонажа — **только PNG/JPEG**: оно уходит в Veo как
  `referenceImage` (§10.2), а входные изображения Veo — JPEG/PNG; принять
  WebP здесь значило бы сломаться позже, на генерации, где это гораздо
  труднее объяснить пользователю.
- `null` для `filters`/`effects` → `Prisma.DbNull` (Prisma отвергает
  голый JS-`null` для Json-колонок с ошибкой «use JsonNull or DbNull») —
  этот импорт `Prisma` из `@prisma/client` в песочнице даёт ту же
  известную TS-ошибку, что и в `session.service.ts`, уходит после
  `prisma generate`.
- Привязка манифеста к проекту — на стороне ПРОЕКТА (`PATCH
  /projects/:id {brandManifestId}`, этап 3), здесь только каноническая
  запись. Снимок манифеста в Session — этап 10, не здесь.
- Удаление манифеста: персонажи каскадом, проекты остаются с
  `brandManifestId → NULL` (проверено в этапе 2); в ответах `projectCount`
  — чтобы UI мог предупредить «используется в N проектах» перед
  удалением. Удаление персонажа заодно убирает его фото из Blob
  (best-effort).
- Тесты: +15 (итого 120) — сервис с mock-Prisma (владение через
  manifest→owner, no-op PATCH, DbNull, удаление blob фото, confirm с
  чужим pathname/без загрузки), DTO под реальным `ValidationPipe`
  (массив/строка/17 KB в Json — отклоняются, `userId`/`photoUrl` в теле —
  отклоняются, WebP для фото персонажа — отклоняется).

## Этап 8 — Frontend: экраны 1–5 (создание проекта → цена)

В `frontend/src/`, новые компоненты по образцу уже существующих
(`ProductInput.tsx` и т.д.), см. §4 спеки:
- Экран 1 — создание проекта (тип, страна с поиском, название,
  необязательный выбор Манифеста бренда из списка Этапа 7).
- Экран 2 — фото товара (камера/галерея, как в `VideoUpload.tsx`, но
  для фото).
- Экран 3 — список аналогов (сортировка по релевантности/цене,
  пустое состояние без блокировки).
- Экран 4 — голосовое описание (запись → расшифровка → редактируемое
  поле).
- Экран 5 — цена (клик по аналогу или ручной ввод, валюта проекта).
- Новый экран — список проектов (входная точка, до Экрана 1) — с учётом
  решения по §7.8 (Project — самостоятельный долгоживущий раздел, не
  разовая форма внутри одной Session).

**Проверка:** ручной прогон сценария 1→5 в браузере на
`http://localhost:5173`, включая линейку из 2+ товаров и проект с
привязанным манифестом.

**Сделано (этап 8) — вместе с переработкой стилей всего `frontend/`.**
По ходу этапа пришло требование «стили css ужасные — переработать под
вариант silverfinance», поэтому этап разбит на две части:

*Дизайн-система (перенос из SilverFinance, архив был приложен):*
`tailwind.config.js` — палитра `silver` 50–950 + `accent` (#7dd3fc),
шрифты Sora / JetBrains Mono (Google Fonts в `index.html`), тени
`glow`/`card`, sheen-градиент, анимации; `index.css` — глобальные стили
из `globals.css` SilverFinance (`.tabular`, `.backdrop-grid`, `.sheen`,
тонкий скроллбар) плюс единый рецепт полей ввода `.input`/`.label`. Был
удалён остаток шаблона Vite (тёмный `#242424` body с `place-items:
center` и `#root {padding: 2rem; text-align: center}`), который и
ломал вёрстку на каждом экране. `darkMode: 'class'`: внутри Telegram —
по `tg.colorScheme` (+ `themeChanged`), вне — по `prefers-color-scheme`,
тёмная по умолчанию (как TMA-лейаут SilverFinance). Примитивы
`src/components/ui/`: Button (рецепт `ui/Button.tsx` SilverFinance +
danger/размеры/loading), Card/CardHeader/FeaturePanel, Field/Input/
Textarea/Select, Pills (сегментный контрол из TMA-страницы), Badge,
Spinner/Busy, Alert, Tabs, EmptyState, Stepper. Иконки — `lucide-react`,
как в SilverFinance. Все существующие компоненты воркфлоу генерации
(VideoUpload, AnalysisDisplay, ProductInput, PromptEditor, ImageUpload,
VideoPlayer, ProgressIndicator, TelegramLoginButton) перестилизованы
БЕЗ изменения логики и пропсов; тексты UI переведены на русский.

*Экраны этапа 8:* хеш-роутер (`src/lib/router.ts`, без зависимостей —
статический бандл TMA/Vercel, deep-link на любой экран, назад = один
шаг): `#/projects` (список — новая точка входа), `#/projects/new` (Экран
1: тип, поиск страны с валютой, название, необязательный манифест),
`#/projects/:id` (товары со статусом; у SINGLE единственный товар
создаётся автоматически и сразу открывается фото-шаг), `#/projects/:id/
items/:itemId/<photo|analogs|voice|price>` (Экраны 2–5, шаг в URL),
`#/generate` — прежний Session-мастер, вынесен в
`features/generation/GenerationWizard.tsx` без изменения логики
(`useWorkflow.ts` не тронут). Фото: `<input capture="environment">` для
камеры + галерея, presigned PUT → `process`, прогресс и статус. Аналоги:
сортировка релевантность/цена, пустое состояние не блокирует (§7.4).
Голос: MediaRecorder с автоподбором MIME (`webm;codecs=opus` → `mp4` →
`ogg`), `transcribe apply:false` — текст дописывается в редактируемое
поле и сохраняется вместе с ручными правками. Цена: чипы цен аналогов
(→ `priceSource: ANALOG`) или ручной ввод (`MANUAL`), валюта проекта.
401 на `/projects` показывает объяснение (каталог требует входа, §7.8)
и ссылку на быструю генерацию без проекта. API-слой —
`services/projects-api.ts` + `types/project.ts` (зеркало backend-типов).

*Проверка:* `tsc`, `eslint --max-warnings 0`, `vite build` — чисто;
парсер роутера — 10 кейсов (`frontend/scripts/router.test.ts`); визуально —
Playwright-скриншоты собранного бандла с замоканным API: 12 экранов,
тёмная/светлая тема, 390×844 и десктоп.

**`frontend-v2/` удалена** (папка, сервис в `docker-compose.dev.yml`,
строка в `.gitignore`, упоминания в доках) — по решению владельца после
этого этапа: редизайн выполнен в `frontend/`, копия стала лишней.

## Этап 9 — Frontend: экран управления Манифестом бренда [новый этап]

Отдельный, самостоятельный раздел (§12), не привязан к конкретному
проекту — список манифестов пользователя → создать/открыть:
- Форма манифеста: название, `styleNotes` (текст), UI для
  `filters`/`effects` (минимальная версия на первую итерацию — форма
  зависит от того, что решится по §12.1 на Этапе 7; если конкретная
  структура ещё не определена к моменту фронтенд-работ — можно
  временно ограничиться одним свободным текстовым полем «стиль» вместо
  структурированных фильтров, без блокировки остального плана).
- Список персонажей бренда — добавить нового (фото или текст),
  редактировать/удалить существующего.

**Проверка:** создать манифест с фронта, добавить персонажа бренда с
фото, привязать манифест к проекту из Этапа 8 — привязка сохраняется.

**Сделано (этап 9).** Раздел «Бренд» в TMA, третья вкладка шапки
(`#/brand-manifests`), на тех же UI-примитивах, что этап 8:

- `frontend/src/lib/router.ts` — маршруты `manifests` /
  `manifest-new` / `manifest` (`#/brand-manifests`, `/new`, `/:id`),
  хелперы `routes.manifests/manifestNew/manifest`; тест роутера
  расширен до 14 случаев (`frontend/scripts/router.test.ts`).
- `src/services/projects-api.ts` — полный CRUD:
  `get/create/update/deleteBrandManifest`,
  `add/update/deleteBrandCharacter`, `uploadBrandCharacterPhoto`
  (upload-url → PUT в Blob → confirm — тот же presigned-паттерн, что у
  фото товара). Типы `BrandManifestView` / `BrandCharacterView` /
  `JsonObject` — в `src/types/project.ts`.
- `src/features/brand/ManifestsListScreen.tsx` — список: карточка на
  манифест (число персонажей бейджем, «в N проектах» / «не
  используется»), пустое состояние с CTA.
- `src/features/brand/ManifestScreen.tsx` — один экран на оба режима.
  Без id — форма создания (название + стиль), после сохранения
  `replace`-переход на URL редактирования. С id — блок «Стиль»
  (название, `styleNotes` ≤4000, кнопка «Сохранить» активна только при
  реальных изменениях, индикатор «Сохранено») и блок «Персонажи»
  (добавить/изменить/удалить, инлайн-редактор имя+описание ≤2000, фото
  PNG/JPEG ≤10 МБ по клику на превью с прогрессом загрузки). Удаление
  манифеста предупреждает, к скольким проектам он привязан
  (`projectCount`).
- `filters` / `effects` — по §12.1 схема ещё не решена (Этап 15),
  поэтому они спрятаны за «Дополнительно: фильтры и эффекты (JSON)» —
  `JsonField` (моно-textarea) с той же валидацией, что backend'овый
  `IsJsonObject`: объект, не массив, ≤16 КБ (`json-object.ts`, тест
  `frontend/scripts/json-object.test.ts`, 8 случаев). Раскрыто автоматически,
  если в манифесте уже что-то задано.
- Лимит §10.3 виден заранее: у первых трёх персонажей с фото бейдж
  «референс», у остальных с фото — «фото · текстом», без фото —
  «текст»; при >3 фото — предупреждение, что как картинки пойдут
  только первые три.
- Интеграция с проектами: на экране проекта карточка «Манифест бренда»
  — `Select` привязать/отвязать (`PATCH /projects/:id
  {brandManifestId}`), кнопка «Открыть»; если манифестов нет — ссылка
  «создать». На экране создания проекта подсказка пустого списка
  ведёт на `#/brand-manifests/new`.
- Шапка: три вкладки + кнопка входа не помещались в одну строку на
  390px — на телефонах навигация переносится на отдельную строку во всю
  ширину, от `sm` — как раньше в одну строку.

Проверено: `tsc --noEmit`, `eslint --max-warnings 0`, `vite build`,
оба unit-теста, Playwright-скриншоты (390/430/760px, dark/light) всех
новых экранов на мок-API. Реальная привязка к бэкенду — через
`GET/PATCH /brand-manifests/**` этапа 7, контракт совпадает
(`BrandManifestView` зеркалит `common/types/brand-manifest.types.ts`).

## Этап 10 — Backend: связка Project/ProductItem → Session (+ снимок Манифеста)

- Новый эндпоинт, например `POST /projects/:id/items/:itemId/sessions`
  — создаёт `Session` со СНИМКОМ данных `ProductItem` в
  `Session.data.productInformation` (§7.8 — копия, не живая связь) +
  проставляет `projectId`/`productItemId` для истории.
- **Если у проекта есть привязанный `brandManifestId`** (§12) —
  дополнительно копирует снимок `filters`/`effects`/`styleNotes` +
  список персонажей бренда в новое поле, например
  `Session.data.brandManifestSnapshot` — редактируемое для ЭТОЙ
  конкретной генерации, не меняющее сам манифест (та же логика
  снимка, что и для `productInformation`).
- Существующий флоу генерации (шаги 3–5 текущего воркфлоу) не меняется
  по сути — просто получает `productInformation` не из ручной формы
  (`ProductInput.tsx`), а из этого нового эндпоинта.

**Проверка:** создать Session из товара с привязанным манифестом,
убедиться, что дальнейшая правка ProductItem/BrandManifest НЕ меняет
уже созданную Session (снимок, не ссылка) ни по товару, ни по стилю.

**Сделано (этап 10).** Новый backend-модуль `modules/project-session/`
плюс минимальная проводка во фронтенде, чтобы связку можно было
пройти руками, а не только через curl.

Backend:
- `POST /projects/:projectId/items/:itemId/sessions` (за
  `TelegramIdentityGuard`, владение — через родительский проект) —
  создаёт Session с **копиями**: `data.productInformation` из
  ProductItem (`productName` ← title или, для товара без названия,
  title проекта; `productDescription`; `productImagePathname` +
  `productImageMimeType` выведены из `photoUrl` — у фото товара
  фиксированный pathname без random-suffix, поэтому путь URL и есть
  pathname, `GenerationService` скачает его как первый кадр без
  повторной загрузки; плюс `productImageUrl`, `category`, `price`,
  `currency`, `sourceProductItemId`), `data.brandManifestSnapshot`
  (`styleNotes`/`filters`/`effects` + персонажи с `sourceCharacterId`,
  `snapshotAt`, `editedAt: null`) — только если у проекта есть
  манифест; колонки `projectId`/`productItemId` — для истории. Ответ
  того же вида, что `POST /sessions`. Статус остаётся `created` (§7.9:
  SessionStatus не меняем; статус — маркер прогресса воркфлоу).
- `GET /projects/:projectId/items/:itemId/sessions` — история прогонов
  товара (sessionId, status, даты, `videoUrl` готового ролика,
  `hasBrandManifest`), новые сверху.
- `PATCH /sessions/:sessionId/brand-manifest` — правка копии манифеста
  ДЛЯ ЭТОЙ Session (§12): `styleNotes`/`filters`/`effects` (null =
  очистить, те же лимиты и `IsJsonObject`, что у манифеста),
  `characters` — заменяет список целиком (≤20, `label` обязателен,
  `photoUrl` только https). 404, если у Session снимка нет. В сам
  BrandManifest ничего не пишется — §12.3 остаётся открытым, «сохранить
  как манифест» будет отдельным явным действием. Без идентичности, как
  все `/sessions/**` (UUID сессии — bearer; снимок может появиться
  только через защищённый роут выше).
- `SessionService.createSession(userId?, seed?)` — необязательный seed
  (`SessionSeed`), `brandManifestSnapshot` добавлен в `DATA_KEYS`,
  `toSession` отдаёт `projectId`/`productItemId`/`brandManifestSnapshot`.
  Анонимный `POST /sessions` не изменился.
- Типы: `BrandManifestSnapshot`/`BrandCharacterSnapshot`
  (`common/types/brand-manifest.types.ts`), необязательные поля в
  `ProductInformation`, новые поля `Session`.
- Тесты: `snapshot.spec.ts` (чистые построители: pathname из URL, MIME
  по расширению, fallback названия, отбрасывание не-объектного JSON),
  `project-session.service.spec.ts` (владение, 404, состав seed, список,
  правка снимка не трогает манифест, `applySnapshotEdit`),
  `update-brand-snapshot.dto.spec.ts` (реальные настройки
  ValidationPipe, вложенные персонажи, лимиты). Всего по бэкенду:
  **143 теста / 16 наборов**.

Frontend (проводка, не новый экран):
- `ProjectScreen` — карточка «Ролик»: кнопка на каждый заполненный
  товар (`createSessionFromItem`), sessionId кладётся в тот же
  `localStorage.sessionId`, что использует мастер, и переход на
  `#/generate`.
- `useWorkflow` — при подхвате сохранённой сессии читает
  `GET /sessions/:id` и, если есть `productInformation`, засевает
  `productName`/`productDescription`, `productImagePreview` +
  `imageUploadProgress: 100` (фото товара уже в Blob под нужным
  pathname), `brandManifest` (снимок) и `projectId`. `ProductInput`
  получил `initialName`/`initialDescription` — форма предзаполнена, но
  редактируема (правки меняют только Session, не товар — об этом
  плашка над формой со ссылкой «Открыть проект»); под формой карточка
  «Манифест бренда: …» (редактор снимка — этап 14).
- Попутно закрыт пробел старого мастера: после анализа не было кнопки
  «дальше» без правки текста — добавлена «Далее: товар»
  (`proceedToProduct`).

Проверено: backend jest 143/143, eslint/prettier по новым файлам;
frontend tsc / eslint 0 warnings / vite build; Playwright на мок-API:
экран проекта с карточкой «Ролик» и мастер, доведённый через
YouTube-ссылку → анализ → шаг «Товар» с предзаполнением и карточкой
манифеста. Ограничение песочницы прежнее — реальный `prisma generate`
и живой стенд не запускались, контракт проверен юнит-тестами.

## Этап 11 — Backend: поиск референсного видео (YouTube Data API v3)

Новый `backend/src/modules/youtube-search/` (§6.4, §9):
- `GET /youtube-search?q=...` — `search.list` (`maxResults=50`, без
  пагинации, §9.3) → `videos.list` batch-запросом на статистику/
  длительность → объединённый результат.
- Debounce на фронте, не на каждое нажатие клавиши (квота).
- Предзаполнение запроса — по `ProductItem.title`/`category` выбранного
  товара (§9.1 — уровень товара, не проекта).

**Проверка:** реальный поиск с настоящим `YOUTUBE_API_KEY`, проверить
расход квоты в Google Cloud Console соответствует ожиданиям (100
units/поиск).

**Сделано (этап 11).** Новый backend-модуль `modules/youtube-search/`.

- `GET /youtube-search?q=…&regionCode=UA&language=uk` (за
  `TelegramIdentityGuard`) — `search.list` (`type=video`, `maxResults=50`,
  без пагинации по §9.3; `regionCode`/`relevanceLanguage` — из страны
  проекта, оба необязательны) → один batch `videos.list`
  (`part=statistics,contentDetails`, все id одним запросом) → слияние в
  строки таблицы §6.4: `videoId`, `url` (canonical watch-URL для
  существующего `POST /sessions/:id/video/youtube`), `title`,
  `channelTitle`, `channelId`, `publishedAt`, `thumbnailUrl`
  (medium→high→default), `durationSeconds` + `durationLabel`
  («4:13»/«1:02:05»), `viewCount`, `likeCount` (null, если канал скрыл
  лайки). Порядок — релевантность YouTube; сортировка — на клиенте
  (этап 12). HTML-сущности из `search.list` (`&amp;`, `&#39;`)
  декодируются.
- Квота: новый per-user дневной лимит `YOUTUBE_SEARCH_DAILY_LIMIT_PER_USER`
  (по умолчанию 20; таблица `youtube_search_usage`, миграция
  `20260905170000_youtube_search_usage`, `YoutubeSearchUsageService` —
  та же форма, что у SerpApi). Проверяется ДО платного вызова,
  засчитывается сразу после ответа `search.list` (падение `videos.list`
  не делает поиск «бесплатным», но и не валит ответ — строки уходят без
  статистики). Ошибки Google переведены в понятные HTTP: без ключа —
  503, `quotaExceeded` — 429, `keyInvalid`/400/403 — 503 с подсказкой
  про ключ, сеть — 502; во всех текстах — напоминание, что ссылка и файл
  работают без поиска (§9.2).
- Конфиг: `youtube.searchDailyLimitPerUser`; переменная добавлена в
  `.env.example`, `.env.docker.example`, `docker-compose.dev.yml`,
  вкладку «Настройки» админки.
- Тесты: парсер ISO 8601 длительности и форматирование; слияние
  результатов (порядок, пропуск не-видео, null-статистика, скрытые
  лайки, декодирование сущностей); сервис на мок-axios (нет ключа →
  503 без обращений; лимит → 429 до платного вызова; параметры обоих
  запросов; ноль результатов — без `videos.list`, но с учётом; деградация
  без статистики; `quotaExceeded` → 429 и не засчитывается; 400 → 503;
  сеть → 502); DTO под реальными настройками ValidationPipe. Всего по
  бэкенду: **171 тест / 19 наборов**.
- Проверка с настоящим ключом и сверка расхода квоты в Google Cloud
  Console — на стороне пользователя (в песочнице нет сети к
  googleapis.com); формат ответов взят из официальной документации
  YouTube Data API v3 и совпадает с тем, что парсит Devil's Advocate.

## Этап 12 — Frontend: экран поиска YouTube

- Форма поиска (предзаполненная) + таблица результатов (превью,
  название, канал, длительность, просмотры, лайки), сортировка кликом
  по колонке на клиенте.
- Три равноправных варианта выбора видео (§9.2, решено): поиск / ручная
  вставка ссылки / загрузка файла — все ведут в уже существующий
  `registerYoutubeVideo`/upload-флоу без изменений.

**Проверка:** выбор видео через каждый из трёх путей приводит к
одинаковому следующему шагу (анализ Gemini).

**Сделано (этап 12) — калька вкладки поиска из Devil's Advocate.**
За образец взят блок «Шаг 1 — поиск YouTube» из
`apps/admin/src/app/sandbox/page.tsx` DA: одно поле + кнопка «Искать»
(Enter отправляет), поиск только по явному действию — не при наборе
(каждый вызов = 100 quota-единиц), под полем строка «N результатов за
X мс. Поиск списал 100 quota-единиц из ~10 000/сутки … и K из L ваших
суточных поисков», затем таблица, последняя колонка — действие
(«Разобрать» в DA → «Выбрать» здесь). Поверх кальки — ровно то, что
требует ТЗ §6.4/§9 и чего в DA не было: колонки превью / просмотры /
лайки и сортировка кликом по заголовку любой колонки на клиенте.

- `src/components/YoutubeSearch.tsx` — сама вкладка;
  `src/lib/youtube-search.ts` — чистые `sortResults` (стабильная,
  `null` всегда внизу при любом направлении; текст — `localeCompare`
  ru без регистра; числа при первом клике — по убыванию, текст — по
  алфавиту, повторный клик меняет направление) и `formatCount`
  («12,3 тыс.», «2,3 млн»); тест `frontend/scripts/youtube-search.test.ts`
  (12 случаев).
- Клик по строке — выбор (§9), кнопка «Выбрать» — явная аффорданс;
  выбранная строка подсвечивается; ссылка названия открывает YouTube в
  новой вкладке, не выбирая. На телефоне таблица (min-width 520px)
  прокручивается горизонтально внутри карточки, клик по строке работает
  без прокрутки до кнопки.
- `VideoUpload` — три равноправных вкладки в порядке ТЗ §9.2: «Поиск
  YouTube» / «Ссылка» / «Файл». Выбор из поиска отдаёт `url` в тот же
  `onSubmitYoutubeUrl` → `registerYoutubeVideo`, что и ручная ссылка —
  следующий шаг (анализ Gemini) одинаков для всех трёх путей. Для
  сессии из проекта вкладка поиска открывается первой и предзаполнена;
  анонимный быстрый путь стартует, как раньше, с файла.
- Предзаполнение (§9.1, уровень товара): `searchQueryFor(title,
  category)` в `useWorkflow` — «категория + название» без дублирования
  («кроссовки Размер 42»); `regionCode`/`language` — из страны проекта:
  в снимок `productInformation` (этап 10) добавлены `countryCode` и
  `languageCode` (CLDR-язык страны из `common/data/countries.ts`).
  `VideoUpload` перемонтируется ключом, когда снимок сессии подгружен,
  чтобы вкладка поиска открылась уже с запросом.
- 401 на поиск (анонимный путь) — не ошибка, а спокойная подсказка:
  «доступен после входа, ссылка и файл работают без входа».
- Попутно: светлая тема — у SilverFinance словесный знак (`.sheen`)
  рассчитан на тёмный фон и на светлом почти исчезал; добавлен
  тёмно-металлический градиент для `html:not(.dark)`.

Проверено: tsc, eslint 0 warnings, vite build, три unit-скрипта;
Playwright на мок-API: предзаполненная вкладка, результаты с
сортировкой по «Просм.» (390px, тёмная), широкая светлая (760px),
анонимный 401. Реальный поиск — после `YOUTUBE_API_KEY` на стенде
пользователя (см. этап 11).

## Этап 13 — Backend: расширение анализа Gemini — персонажи

- Расширить промпт анализа и `AnalysisStructuredData` (`backend/src/
  common/types/analysis.types.ts`) новым полем — список персонажей, у
  каждого текстовое описание внешности (§10). Без тайм-кодов (§10.1,
  решено — не нужны в v1).
- Это правка промпта + типа ответа, НЕ новый сервис — тот же вызов
  анализа видео, что уже есть.

**Проверка:** прогнать анализ на видео с 1–2 людьми в кадре, убедиться,
что персонажи приходят в структурированном виде, а не только внутри
общего текста `sceneBreakdown`.

**Сделано (этап 13).** Правка промпта + типа ответа, без нового сервиса
— тот же `generateContent` в `AnalysisService.performAnalysis`.

- Промпт `ANALYSIS_PROMPT` просит два ключа: прежний `sceneBreakdown`
  и новый `characters[]` — для каждого `label` (короткая ручка),
  `role` (что делает в ролике), `appearance` (одежда, возраст, пол,
  волосы, черты, манера — «достаточно, чтобы видеомодель воссоздала
  человека, не видя футаж»), `prominence` (`main` / `secondary` /
  `background`). Явно: без тайм-кодов (§10.1), пустой массив, если
  людей нет. Запрос переведён в JSON-режим Gemini
  (`responseMimeType: 'application/json'`) — структурированный ответ
  теперь требование к модели, а не просьба.
- Разбор ответа вынесен в чистый `analysis-response.ts`
  (`parseAnalysisResponse`, `parseCharacters`): `sceneBreakdown` ведёт
  себя ровно как раньше (строка / массив / не-JSON → сырой текст), а
  `characters` нормализуются — стабильные `id` (`c1`, `c2`…) как ключ
  выбора в UI, синонимы `name`/`description`, дефолт `secondary` для
  неизвестного `prominence`, отбрасывание записей без `appearance`,
  лимит 10 персонажей и обрезка длинных текстов; `undefined`, если ключа
  нет или он не массив (анализы до этого этапа), `[]` — «в кадре никого».
- Тип: `AnalysisCharacter` и `VideoAnalysis.characters?` — на верхнем
  уровне `VideoAnalysis`, а не внутри `structuredData`, как было
  сформулировано в плане: `structuredData` сегодня не заполняется
  вообще (`scenes` всегда пуст), и класть единственное реально
  распарсенное поле в полупустой объект вводило бы в заблуждение.
  Отражено в ТЗ §10. Зеркало во фронтенде (`types/index.ts`,
  `services/api.ts`) — экран выбора персонажей строится на этапе 14.
  `PATCH …/analysis` (правки текста пользователем) персонажей не
  трогает — расширяет объект через `...session.videoAnalysis`.
- Тесты `analysis-response.spec.ts` (11): старое поведение breakdown
  (fences, массив, не-JSON, сломанный JSON, неожиданная форма) и
  нормализация персонажей. Всего по бэкенду: **182 теста / 20
  наборов**.
- Прогон на реальном видео с людьми в кадре — на стенде пользователя
  (в песочнице нет Gemini); формат ответа при `responseMimeType` —
  штатный для gemini-2.5-flash.

## Этап 14 — Frontend: экран выбора/замены персонажей (+ манифест)

- Фильтры/группы персонажей сверху (клик = «активен», подсветка цветом
  самого персонажа и его описания, мультивыбор) — §10.
- Форма справа при выборе персонажа — ТРИ варианта (§10, обновлено с
  учётом §12): фото («новый скин»), текст (предзаполненный данными
  `ProductItem`), ИЛИ выбор из персонажей бренда (Этап 7/9), если у
  проекта есть привязанный манифест.
- На этом же экране — редактирование снимка Манифеста бренда для ЭТОЙ
  генерации (фильтры/эффекты/стиль из Этапа 10), если манифест привязан
  — правки локальные для Session, манифест не меняется (§12).
- Экран генерации — без изменений в самом выборе (Lite/Standard,
  `frontend/src/App.tsx`, `VideoQuality`).

**Проверка:** выбрать 2 персонажей активными — одному назначить фото
персонажа бренда (без загрузки заново), другому оставить как есть;
поправить стиль манифеста только для этой генерации и убедиться, что
сам манифест не изменился.

**Сделано (этап 14).** Экран собран на шаге «Анализ» мастера — над
scene-breakdown, который остался как был (§10: «не меняя то, что уже
есть»). Потребовалась и небольшая backend-часть: решениям пользователя
по персонажам негде было храниться, а этап 15 должен их читать.

Backend — новый модуль `modules/casting/` (без таблиц, всё в
`Session.data.characterCasting`, умирает вместе с сессией):
- Типы `common/types/casting.types.ts`: `CharacterCast {characterId,
  active, order, replacement}`, `CastReplacement {kind: none|photo|text|
  brand, photoUrl, photoPathname, description, brandCharacterId,
  label}`, `CharacterCasting {casts, updatedAt}`.
- `GET/PUT /sessions/:id/characters` — список целиком. Сервер не
  доверяет клиенту: персонаж должен быть в `videoAnalysis.characters`;
  `order` пересчитывается плотно 1..n по относительному порядку
  активных, у неактивных 0 (именно `order` решает три слота
  `referenceImages`, §10.3); `kind=photo` может лишь СОХРАНИТЬ фото,
  загруженное этой сессией через confirm — URL от клиента не
  принимается; `kind=brand` принимает `photoUrl` только из снимка
  манифеста этой сессии — клиент не может заставить Veo скачать
  произвольную картинку.
- `POST /sessions/:id/characters/:cid/photo/{upload-url,confirm}` —
  «новый скин»: presigned PUT в Blob (`sessions/<sid>/characters/<cid>/
  photo.<png|jpg>`, PNG/JPEG ≤10 МБ — форматы входа Veo), confirm
  проверяет blob через `head`, активирует персонажа и ставит его в конец
  порядка.
- Тесты: `normaliseCasting` (порядок, дубли, чужие id, правила photo/
  brand/text), сервис (404, upload-url, confirm, чужой pathname,
  отсутствующий blob), DTO под реальным ValidationPipe. Всего по
  бэкенду: **194 теста / 22 набора**.

Frontend:
- `features/generation/CharacterCasting.tsx` — сверху чипы (один на
  персонажа, у каждого свой цвет из палитры 6; клик = активен,
  мультивыбор; тем же цветом подсвечивается описание персонажа ниже —
  левая полоса + фон + ring на сфокусированном), ниже описания с бейджами
  роли/значимости и статуса замены («фото · референс» / «фото · текстом» /
  «свой текст» / имя персонажа бренда), справа (на телефоне — ниже) форма
  для сфокусированного активного персонажа с вкладками «Как есть / Фото /
  Текст / Бренд» (последняя — только при манифесте с персонажами). Фото →
  presigned upload с прогрессом; Текст — предзаполнен описанием Gemini +
  «Держит и показывает товар «…» — описание» из текущего проекта
  (§10: правит черновик, не пишет с нуля); Бренд — список персонажей
  снимка манифеста с фото/описанием, выбор без повторной загрузки.
  Счётчик «фото-референсы N/3» и предупреждение при >3 (§10.3). Первый
  визит: все найденные персонажи активны по умолчанию и это сразу
  сохраняется — «форма опциональна» (§10), генерация без единого клика
  получает всех персонажей как есть.
- `lib/casting.ts` — чистые `toggleActive` (активация — в конец
  порядка; деактивация сохраняет замену), `withReplacement`,
  `photoSlots` (первые 3 по порядку), `defaultCasting`,
  `defaultTextFor`, палитра; тест `frontend/scripts/casting.test.ts` (9).
- `features/generation/BrandSnapshotEditor.tsx` — правка копии манифеста
  для ЭТОЙ генерации (§12): стиль + фильтры/эффекты (JsonField), «Сохранить»
  → `PATCH /sessions/:id/brand-manifest`; в подписи явно «сам манифест не
  меняется». Персонажи копии используются вкладкой «Бренд» выше.
- `Tabs` получил `compact` для узких панелей; `useWorkflow` —
  `setBrandManifest`; `GenerationWizard` рендерит оба блока над
  `AnalysisDisplay`, только когда анализ завершён и в нём есть ключ
  `characters` (старые анализы — без блока).
- Экран генерации (Lite/Standard) не тронут.

Проверено: backend jest 194/194, eslint; frontend tsc / eslint 0 warnings /
vite build / 4 unit-скрипта; Playwright на мок-API (YouTube-ссылка →
анализ с тремя персонажами): дефолтный кастинг, «Прохожий» снят +
ведущей назначен персонаж бренда (390px, тёмная), вкладка «Текст» с
предзаполнением (760px, светлая). По ходу найден и исправлен overflow
grid на телефоне (неявный auto-трек растягивался до max-content —
добавлен `grid-cols-1`).

## Этап 15 — Backend: генерация с `referenceImages` (Veo 3.1)

- `GenerationService`/`PromptService` — если для активного персонажа
  есть фото (загруженное или выбранное из персонажей бренда), передать
  его в вызов Veo как `referenceImages` (`referenceType: "asset"`).
- **Лимит 3 изображения на запрос — жёсткий лимит API (§10.2)**: если
  персонажей с фото больше трёх, в `referenceImages` уходят первые 3 (по
  порядку выбора на экране, §10.3), у остальных активных персонажей с
  фото для этого прогона используется их текстовое описание вместо
  фото — реализовать эту сортировку/усечение явно, не полагаться на
  API само по себе отбросить лишнее.
- Если фото не загружено/не выбрано — описание персонажа идёт в текст
  промпта, как раньше (несколько активных персонажей — все
  одновременно, без «главного», §10.3).
- Фото самого товара (`ProductItem.photoUrl`) как `referenceImage` —
  НЕ включать в v1 (открытый вопрос §10.4 спеки, требует отдельного
  продуктового решения — конкурирует за тот же лимит в 3 изображения).

**Проверка:** сгенерировать ролик с загруженным фото персонажа,
визуально сверить, что внешность из фото действительно повлияла на
результат (не просто описана словами); отдельно проверить случай 4+
активных персонажей с фото — лишние корректно падают на текстовое
описание, а не роняют запрос ошибкой API.

**Сделано (этап 15).** Один источник правды — чистый
`common/reference-plan.ts` (`buildReferencePlan`, `characterBriefText`,
`brandBriefText`), которым пользуются ОБА сервиса: `PromptService`
нумерует референс-изображения в тексте промпта, `GenerationService`
скачивает ровно эти изображения — номера, которые пользователь видит в
промпте, совпадают с тем, что получает Veo.

- Правило слотов (§10.2/§10.3): активные касты по `order`; у кого есть
  фото (загруженный «скин» или фото персонажа бренда) — занимает слот
  `referenceImages`, пока их <3; четвёртый и далее уходят текстом
  (описание замены или описание Gemini). Усечение явное, в коде — не
  надежда, что API отбросит лишнее. Неактивные персонажи попадают в
  промпт списком «must not appear».
- **Вынужденное решение по §10.4.** В `@google/genai`
  (`GenerateVideosConfig.referenceImages`) прямо сказано: при
  `referenceImages` поля `image`/`video`/`lastFrame` не поддерживаются.
  То есть как только появляется хоть одно фото персонажа, фото товара
  больше не может быть первым кадром, как сегодня — оно либо становится
  asset-референсом, либо исчезает из визуального входа вовсе. Выбрано
  первое: **фото товара занимает последний свободный слот**, персонажи —
  в приоритете (как требовал план); при трёх фото-персонажах товар
  описывается только текстом. Без фото-персонажей всё как раньше:
  legacy-путь «фото товара — первый кадр», `referenceImages` не
  передаётся. Это продуктовое решение, принятое из-за ограничения API, —
  вынесено в ТЗ §10.4 как «решено вынужденно, можно пересмотреть».
- `PromptService.generatePrompt` — в бриф для GPT добавлены секции
  «CHARACTERS TO KEEP» (каждый с внешностью и пометкой `[REFERENCE IMAGE
  N]`), «CHARACTERS TO REMOVE», «PRODUCT: reference image N…» и «BRAND
  STYLE GUIDE» (styleNotes + непустые filters/effects из снимка
  манифеста). Целевая модель в тексте — Veo 3.1 вместо Sora 2 (Sora
  давно заменён в GenerationService, текст промпта отставал); в формат
  добавлена строка `Characters: …`.
- §12.2 (стиль манифеста vs стиль референса) — решено предварительно:
  **дополняет; при конфликте побеждает бренд** — так и сформулировано в
  брифе. Пересмотр — по реальным примерам.
- `GenerationService.generateVideo` — два взаимоисключающих режима:
  legacy (`image` = первый кадр) и reference (`config.referenceImages`
  с `referenceType: ASSET`, до 3). Байты: свои pathnames через
  `BlobService.downloadBuffer`, фото персонажей бренда — по публичному
  URL из снимка (`fetchReference`). Состав референсов сохраняется в
  `GeneratedVideo.references[]` — экран результата показывает
  «Референс-изображения Veo: #1 …», аудит §11 (этап 16) сможет
  ссылаться на них.
- Тесты `reference-plan.spec.ts` (8): без кастинга — все как есть и
  legacy; кастинг без фото — legacy + omitted; порядок слотов + товар в
  последний слот; кап 3 — четвёртый текстом, товару слота нет;
  неизвестные id; тексты брифов. Всего по бэкенду: **202 теста / 23
  набора**.
- Не проверено в песочнице (нет Veo): (а) реальное влияние фото на
  внешность; (б) поддерживает ли `veo-3.1-lite-generate-preview`
  `referenceImages` так же, как полный Veo 3.1, и принимает ли reference-
  режим `aspectRatio: '9:16'` — если API откажет, ошибка придёт
  пользователю понятным текстом через существующий
  `extractErrorMessage`, а не молча. Оба пункта — первое, что стоит
  прогнать на стенде с ключом.

## Этап 16 — Backend: пост-генерационный аудит Gemini

Новый `backend/src/modules/video-audit/` (§11):
- `POST /sessions/:id/audit` — отправляет сгенерированное видео в
  Gemini с промптом на поиск артефактов (лишние конечности и т.п.).
- Ответ — brief (список найденных проблем) + предложенные правки текста
  промпта.
- Счётчик авто-итераций на Session (`AUDIT_AUTO_ITERATIONS_LIMIT`, этап
  1, по умолчанию 3, §11.1) — при превышении не блокирует, а просто
  явно предупреждает пользователя на фронте.
- Ручной ввод «указать на артефакт» (§11.3) — тот же эндпоинт/флоу
  правки, только текст проблемы приходит от пользователя, а не от
  Gemini.

**Проверка:** прогнать аудит на заведомо кривом сгенерированном ролике
(или намеренно упрощённом промпте, провоцирующем артефакт), убедиться,
что brief осмысленный и предложенная правка промпта релевантна.

**Сделано (этап 16).** Новый модуль `modules/video-audit/`; хранение —
`Session.data.videoAudit {history[], appliedFixes}`, без таблиц. Тот же
`GEMINI_API_KEY` и тот же путь Files API, что у анализа референса
(`GeminiFilesService` переиспользован).

- `POST /sessions/:id/audit` (пустое тело) — скачивает готовый ролик из
  Blob, грузит в Gemini Files API, `gemini-2.5-flash` в JSON-режиме с
  промптом-инспектором (только дефекты генерации: анатомия, лица,
  физика/непрерывность, товар, текст — не вкус и не маркетинг), файл
  Gemini удаляется после ответа. Ответ: `verdict` (`clean`/`issues`/
  `unknown`), `summary` по-русски, `issues[]` (severity, category,
  description, timecode|null), `promptFix {suggestedText — ПОЛНЫЙ
  переписанный промпт, rationale}`. Парсер (`audit-response.ts`)
  толерантный: вердикт выводится из списка проблем при противоречии,
  «clean» обнуляет фикс, не-JSON → `unknown` с сырым текстом; падение
  Gemini записывается как `status: 'failed'` с текстом ошибки, а не
  роняет запрос. История — новые сверху, до 20.
- `POST /sessions/:id/audit` с `{issue}` (§11.3, ручное «указать на
  артефакт») — без видео-вызова: пользователь — детектор, Gemini только
  переписывает промпт (текстовый вызов); в истории `source: 'user'`,
  одна проблема с текстом пользователя.
- `POST /sessions/:id/audit/apply {auditId, text?}` (§11.2) — фикс
  становится черновиком промпта ровно как `PromptService.updatePrompt`:
  `finalText`/`userEditedText` = текст, `approvedAt` сброшен → дальше
  существующие approve → generate. `text` позволяет прислать уже
  отредактированную версию. Инкрементирует `appliedFixes`.
- `GET /sessions/:id/audit` — история + `appliedFixes`, `limit`
  (`AUDIT_AUTO_ITERATIONS_LIMIT`, по умолчанию 3), `overLimit` — мягкий
  лимит §11.1: бэкенд только сообщает, фронт предупреждает, ничего не
  блокируется.
- Тесты: промпты и парсер (11), сервис на мок-Gemini (нет видео/промпта;
  полный путь с Files API и очисткой; ошибка Gemini → failed; ручной
  путь без видео; apply — 404/400, сброс approval, счётчик и
  `overLimit`; приоритет текста клиента), DTO. Всего по бэкенду: **219
  тестов / 26 наборов**. Типы и API-функции зазеркалены во фронтенде
  (`AuditState`, `getAudit/runAudit/applyAuditFix`) — экран — этап 17.
- Проверка на реальном кривом ролике — на стенде пользователя; формат
  вызова идентичен анализу референса, который уже работает.

## Этап 17 — Frontend: экран аудита и публикации

- Кнопка «Проверить на артефакты» → индикатор загрузки → brief →
  авто-форма правки в существующем `PromptEditor.tsx` → кнопка
  «Сгенерировать заново» (использует существующий флоу генерации,
  Этап 15, с обновлённым промптом).
- Кнопка «Указать самому» — открывает ту же форму правки, без
  авто-заполнения от Gemini.
- Кнопки «Скачать» (без изменений) и «Опубликовать» — на этом этапе
  «Опубликовать» либо скрыта, либо ведёт на заглушку («скоро») — сама
  публикация в YouTube/TikTok с модерацией не входит в этот план, см.
  Этап 18.

**Проверка:** полный ручной прогон: аудит → находит проблему → правка →
регенерация → повторный аудит чисто → скачивание.

**Сделано (этап 17).** Экран «Ролик готов» дополнен, существующие части
(плеер, сравнение с оригиналом, скачивание) не тронуты.

- `features/generation/AuditPanel.tsx` — карточка «Проверка на
  артефакты»: две кнопки — «Проверить на артефакты» (Gemini смотрит
  ролик) и «Указать самому» (§11.3 — раскрывает поле «Что не так в
  ролике?», отправляется как `{issue}` в тот же эндпоинт). Индикатор
  «Gemini смотрит ролик…» / «переписывает промпт…» — тот же `Busy`, что у
  анализа и генерации. Brief: вердикт (зелёный «Артефактов не
  обнаружено» / жёлтый «Gemini нашёл: N проблем»), summary, список
  проблем с бейджем серьёзности (критично / заметно / мелочь),
  таймкодом и категорией; неудавшаяся проверка — красным, ничего не
  блокирует. Предложенная правка: обоснование + раскрывающийся полный
  текст промпта + кнопка «Подставить в редактор и сгенерировать заново».
  История прежних проверок сворачивается («Предыдущие проверки (N)»).
- Лимит §11.1 — предупреждение, не запрет: бейдж «правок из аудита:
  N/3» в шапке карточки и жёлтый Alert перед кнопкой при `overLimit`
  («каждая регенерация оплачивается как отдельный прогон Veo»), кнопка
  остаётся активной.
- Регенерация (§11.2) — без нового флоу: `applyAuditFix` → сервер кладёт
  фикс в черновик промпта и сбрасывает approve → `useWorkflow.
  startRevision(prompt)` возвращает мастер на шаг «Промпт» с этим
  текстом в том же `PromptEditor` → «Утвердить промпт» → шаг «Генерация»
  (фото товара уже загружено, сразу карточка выбора Lite/Standard) →
  существующая генерация. Предыдущее видео на сервере переписывается
  новым рендером под тем же pathname.
- «Что дальше?»: «Скачать» (как было, открывает Blob-URL), «Опубликовать
  · скоро» — заглушка (disabled, подпись: поставит в очередь на
  модерацию в админке, не выложит напрямую — ТЗ §8, этап 18), «Ещё один
  ролик».
- Проверено: tsc, eslint 0 warnings, vite build; Playwright на мок-API
  сквозным прогоном ссылка → анализ → товар → промпт → утверждение →
  генерация → «готов» → аудит с тремя проблемами и правкой → «Подставить»
  → мастер на шаге промпта с новым текстом; отдельно чистый вердикт +
  открытая форма «Указать самому» (760px, светлая). Реальный аудит —
  на стенде пользователя (нет Gemini).

## Этап 18 — Публикация в YouTube/TikTok с модерацией

Разбит на две части по решению владельца продукта («делай очередь на
модерацию без OAuth, интеграции — отдельным ТЗ»):

- **18a — очередь модерации (сделано, ниже).** Кнопка «Опубликовать» в
  TMA ставит ролик в очередь; оператор в админке одобряет/отклоняет.
  Ничего не выкладывается.
- **18b — выгрузка в каналы (отдельное ТЗ — написано:
  `doc/PUBLISHING-AND-VOICEOVER-SPEC.md` §14, там же этапы и оценка).**
  OAuth-интеграция с YouTube Data API (`videos.insert`) и TikTok Content
  Posting API, воркер, который берёт APPROVED-заявки и переводит их в
  PUBLISHED/FAILED с внешней ссылкой. Точка расширения готова: статусы,
  поля `externalUrl`/`externalId`/`publishError`/`publishedAt`, снимок
  ролика и метаданных в самой заявке, теги с категорией товара.

**Сделано (этап 18a).**

Backend — новый модуль `modules/publication/`, миграция
`20260905210000_publication_requests`:
- Модель `PublicationRequest` (enum'ы `PublicationPlatform` YOUTUBE|TIKTOK,
  `PublicationStatus` PENDING|APPROVED|REJECTED|PUBLISHED|FAILED). Заявка
  — СНИМОК и переживает Session: сессии чистятся по TTL, очередь — нет,
  поэтому `sessionId` без FK, а `videoUrl`/`videoPathname`/`title`/
  `description`/`tags`/`category` скопированы при постановке. FK: автор
  Cascade, проект/товар SetNull, модератор SetNull. Индексы под очередь
  оператора и поиск по сессии.
- Пользователь (за `TelegramIdentityGuard`; сессия должна принадлежать
  вызывающему — анонимная → 403 «нужен владелец канала»):
  `POST /sessions/:id/publications {platform, title?, description?,
  tags?}` → PENDING; заголовок/описание по умолчанию — из товара, теги
  всегда дополняются категорией (ТЗ §8) и названием товара, дедуп без
  учёта регистра, `#` срезается; одна открытая (PENDING/APPROVED) заявка
  на сессию+платформу (409). `GET` — заявки сессии; `DELETE …/:requestId`
  — отозвать, только PENDING.
- Оператор (`AdminSessionGuard` + `isOperator`, как весь `/admin`):
  `GET /admin/publications?status=&page=&pageSize=` (+ `pending` —
  счётчик для бейджа независимо от фильтра), `GET /:id`,
  `POST /:id/approve` (PENDING→APPROVED, модератор и время
  фиксируются), `POST /:id/reject {reason}` (PENDING→REJECTED, причину
  видит автор).
- Тесты: снимок и теги, `toView`, владение/анонимность/чужая сессия,
  409, отзыв, список с фильтром и `pending`, approve/reject только из
  PENDING, DTO. Всего по бэкенду: **231 тест / 28 наборов**.

Admin (`admin/`): раздел «Модерация» в навигации,
`/publications` — фильтр по статусу (по умолчанию «ждёт решения»),
бейдж «ждут: N», таблица со встроенным плеером ролика (9:16), заголовком,
описанием, тегами, ссылками на сессию и скачивание; «Одобрить» с
подтверждением, «Отклонить» с полем причины; пагинация. Явная подпись:
одобрение = «ждёт выгрузки», не публикация. `next build` — ок.

TMA (`frontend/`): заглушка «Опубликовать · скоро» заменена карточкой
«Публикация» (`PublishPanel.tsx`): «Опубликовать» → форма (платформа
Pills YouTube/TikTok, заголовок ≤100, описание, теги через запятую — всё
предзаполнено из товара, подсказка про авто-тег категории) → «В очередь
на модерацию»; ниже — заявки по этому ролику со статусом (на модерации /
одобрено · ждёт выгрузки / отклонено + причина оператора / опубликовано),
«Отозвать» у PENDING; анонимному — подсказка про вход, скачивание не
затронуто. В `useWorkflow` добавлен `productCategory` из снимка сессии.

Проверено: backend jest 231/231, eslint; admin `tsc` + `next build`;
frontend tsc / eslint 0 warnings / vite build; Playwright на мок-API:
форма публикации и список заявок (PENDING + REJECTED с причиной);
миграция применена к локальному Postgres 16, проверены SetNull
модератора и Cascade автора. Сквозной прогон TMA → админка — на стенде
пользователя (`make up`), шаг 8 в doc/TELEGRAM-ADMIN.md §4.

## Этап 19 — Озвучка: минимум (ТЗ §13)

Добавлен после вопроса владельца «что с озвучкой» и решения «делай
минимум сейчас, учти описание товара (текстом / надиктованное)».

**Сделано (этап 19).**
- Backend `common/voiceover.ts` (чистый, 14 тестов): `detectLanguage`
  (по письму: uk/ru/kk по характерным буквам, he/ar/ka/ja/ko/zh/th/el по
  диапазонам, pl/de/tr по диакритике, латиница → en),
  `resolveVoiceoverLanguage` (выбор пользователя → язык страны →
  описание → en), `voiceoverBriefText` — секция «VOICE-OVER & DIALOGUE»
  в брифе GPT: язык всех реплик и надписей, «строй реплики из описания
  товара — оно набрано или надиктовано продавцом, не придумывай свойств»,
  описание цитируется дословно, «Brand voice: …» из снимка манифеста,
  реплики выписать в промпте дословно. Формат промпта: `Text overlay`
  и `Dialogue` — на требуемом языке, из описания.
- `ProductInformation.dialogueLanguage`; `SubmitProductInfoRequestDto`
  принимает `dialogueLanguage` (ISO 639-1[-region]). **Попутно исправлен
  баг этапа 10:** `submitProductInfo` ЗАМЕНЯЛ `productInformation`
  целиком и терял снимок товара (pathname фото, категорию, валюту, язык
  рынка) — теперь сливает поля (`product.service.spec.ts`).
- `BrandManifest.voiceNotes` (миграция `20260905220000_brand_manifest_
  voice_notes`, одна nullable-колонка) → DTO манифеста, view, снимок
  `BrandManifestSnapshot.voiceNotes`, `PATCH /sessions/:id/brand-manifest`.
- Аудит: категория `audio` в промпте-инспекторе + явное «LISTEN to the
  audio track».
- Frontend: `lib/voiceover.ts` (тот же детектор + список из 19 языков,
  `frontend/scripts/voiceover.test.ts`); на шаге «Товар» select «Язык озвучки»,
  предзаполненный по приоритету, с подсказкой источника («по стране
  проекта», «по языку описания», «ваш выбор») и отдельной подсказкой,
  когда описание на другом языке, чем страна; для анонимного пути язык
  переопределяется на лету по мере набора описания, пока пользователь
  не выбрал сам. Поле «Голос и тон озвучки» в редакторе манифеста и в
  копии манифеста на шаге «Анализ». `useWorkflow` хранит
  `marketLanguage`/`dialogueLanguage` из снимка сессии.
- Проверено: backend jest **247 / 30 наборов**, eslint; frontend tsc /
  eslint 0 warnings / vite build / 5 unit-скриптов; Playwright: шаг
  «Товар» с «Українська — определён по стране проекта», редактор
  манифеста с полем голоса. Не проверено в песочнице: как Veo реально
  озвучивает украинский/русский текст — первое, что стоит послушать на
  стенде.

## Этап 20 — Формат кадра: автоопределение и выбор (ТЗ §16)

**Сделано (этап 20).**
- Backend `common/aspect-ratio.ts` (чистый, 14 тестов): стандартный набор
  9:16 / 16:9 / 3:4 / 4:3 / 1:1 / 4:5, `aspectRatioFromSize` (snap ≤3 %,
  иначе сокращённая дробь), `normaliseAspectRatio` (W:H, WxH, W/H;
  введённые соотношения не сокращаются — 21:9 остаётся 21:9),
  `planRender` (цель → нативный кадр Veo + композиционная нота для
  центральной обрезки).
- `VideoFrame {width, height, aspectRatio, source: file|gemini|manual}` на
  `originalVideo` (оба варианта источника). `POST …/video/upload-url`
  принимает `width/height`; промпт анализа Gemini получил ключ `frame`
  (ориентация + ratio, про letterbox — ratio картинки), `parseFrame`
  терпимый (только ориентация → 9:16 / 16:9 / 1:1). При завершении
  анализа frame от Gemini записывается на `originalVideo`, если нет
  точного `file`.
- `POST /sessions/:id/generate {aspectRatio?}`: цель = явный выбор →
  frame референса → 9:16; в промпт Veo дописывается «Output format: …» и
  композиционная нота при не-нативном формате; на `GeneratedVideo` —
  `aspectRatio` / `renderedAspectRatio` / `reframePending`. Fallback:
  если с `referenceImages` Veo отвечает ошибкой про aspect ratio на 9:16
  — повтор в 16:9 с `reframePending` (закрывает риск, отмеченный на этапе
  15 и подтверждённый форумом Google AI). В бриф GPT добавлена строка
  «PICTURE FORMAT» по frame референса.
- Frontend: `lib/aspect-ratio.ts` (те же правила + `readVideoSize` через
  скрытый `<video>`, тест 11 случаев); `useWorkflow` читает размер файла
  до PUT и шлёт его, после анализа подхватывает frame от Gemini из
  сессии; `AspectRatioPicker` на шаге «Генерация» — сетка 4×2 стандартных
  форматов (★ у формата референса, подпись «референс — 3:4 (определил
  Gemini)»), «Свой» с полем W:H и валидацией, info-плашка про нативные
  16:9/9:16 и обрезку; на экране результата — «Формат: 3:4 — снято в 9:16
  с композицией под обрезку…».
- Проверено: backend jest **263 / 31 набор**, eslint; frontend tsc /
  eslint 0 / vite build / 6 unit-скриптов; Playwright: шаг «Генерация» с
  референсом 3:4 от Gemini (390px) и «Свой 21:9» (760px). Реальное
  поведение Veo при 9:16 + referenceImages — на стенде.

## Этап 21 — Своя сцена и выбор трёх слотов референсов (ТЗ §17)

**Сделано (этап 21).**
- Backend: `common/types/reference.types.ts` (`SceneAsset`,
  `ReferenceSelection`, `ReferenceCandidateView`, `ReferenceSlotsView`);
  `Session.data.scenes[]` и `referenceSelection`. `common/reference-plan.ts`
  переписан вокруг кандидатов: персонажи с фото / сцены / товар, явный
  выбор (валидируется по текущим кандидатам, дубли и неизвестные id
  отбрасываются, кап 3) или правило по умолчанию персонажи → сцены →
  товар; `sceneBriefText` для GPT; **`referenceMappingText`** — карта
  «Reference image N = …» + «не показаны картинкой: …», дописывается к
  промпту Veo в `GenerationService` (нумерация ушла из брифа GPT, чтобы
  смена слотов после написания промпта ничего не ломала).
- Новый модуль `modules/reference-assets/`: сцены (upload-url с новым
  `sc_<hex>` id, confirm через `head`, PATCH, DELETE с удалением blob и
  чисткой слота, лимит 5) и слоты (GET кандидаты+эффективные слоты, PUT
  ≤3 с проверкой id, DELETE → авто). Тесты: 11 по плану (в т.ч. сцены
  открывают reference-режим сами, пустой выбор → legacy), 6 по сервису.
  Всего по бэкенду: **272 теста / 32 набора**.
- Frontend: `ReferenceSlotsPanel` на шаге «Генерация» над выбором
  формата — сетка карточек 2×N (3×N от `sm`): превью, бейдж типа
  (персонаж / сцена / товар), название, текстовый fallback; номер слота
  на выбранных, «текстом» на остальных; «Авто» при ручном выборе; «Своя
  сцена» — инлайн-загрузчик (превью файла, название, описание,
  прогресс); у сцен — корзина. `GeneratedVideo.references` с `scene`,
  подпись результата «#N … (сцена)». `api.deleteWithBody` для DELETE с
  телом ответа.
- Проверено: backend jest 272/272, eslint; frontend tsc / eslint 0 /
  vite build; Playwright: авто-слоты (390px), ручной выбор + форма сцены
  (760px).

## Этап 22 — Постоянные сцены бренда (ТЗ §17.1)

Решение по открытому вопросу 17.1: сцена живёт и в манифесте, не только
в сессии. Зеркало `BrandCharacter` целиком — модель, API, снимок,
кандидаты слотов, UI.

**Сделано (этап 22).**
- Prisma: `model BrandScene` (`brand_scenes`, Cascade от манифеста),
  `BrandManifest.scenes[]`; миграция **11**
  `20260906000000_brand_scenes` (написана вручную, применена на чистом
  локальном Postgres — 13 таблиц). `prisma validate` OK.
- Backend `brand-manifest`: сервис переписан на общие приватные
  помощники `addAsset / updateAsset / removeAsset / createAssetPhotoUploadUrl
  / confirmAssetPhoto / findOwnAsset` с параметром `AssetKind`
  (`'characters' | 'scenes'`) — публичные методы персонажей сохранили
  имена, добавлены `addScene / updateScene / removeScene /
  createScenePhotoUploadUrl / confirmScenePhoto`; `scenePhotoPathname`.
  Роуты `POST/PATCH/DELETE /brand-manifests/:id/scenes[/:sid]`,
  `…/scenes/:sid/photo/upload-url|confirm`; DTO персонажей переиспользованы,
  regex pathname расширен до `(characters|scenes)`. `BrandManifestView.
  scenes[]`, `BrandManifestSummaryView.sceneCount`.
- Снимок: `BrandSceneSnapshot {sourceSceneId,label,photoUrl,description}`,
  `BrandManifestSnapshot.scenes?[]` (optional — старые сессии читаются
  как «без сцен»); `brandManifestSnapshotFrom` копирует сцены,
  `ProjectSessionService.createFromItem` включает `scenes` в запрос.
  Per-session редактирование сцен снимка не делалось — намеренно (ТЗ §17).
- `common/reference-plan.ts`: кандидаты `brand-scene:<id>` (только с
  фото, `origin: 'brand'`, источник — URL без pathname, `GenerationService`
  уже умеет fetch по URL), сцены без фото — текстовые `SceneBrief`;
  `ReferenceCandidateView.origin`, `SceneBrief.origin`; порядок по
  умолчанию персонажи → сцены сессии → сцены бренда → товар;
  `sceneBriefText` помечает «(the brand's permanent location)».
- Frontend: `ManifestScreen` — `CharactersBlock/CharacterRow`
  обобщены в `AssetsBlock/AssetRow` с таблицей текстов `ASSET_COPY`
  (персонаж / сцена), второй блок **«Сцены бренда»**; список манифестов —
  второй бейдж с числом сцен; `BrandSnapshotEditor` — подпись про сцены
  бренда; `ReferenceSlotsPanel` — бейдж «бренд» и без корзины у
  `origin: 'brand'`, счётчик «Своя сцена» считает только сцены сессии;
  `projects-api` — общие `addBrandAsset/…` + алиасы `addBrandScene /
  updateBrandScene / deleteBrandScene / uploadBrandScenePhoto`; типы.
- Тесты: reference-plan +4 (кандидаты/origin/URL-источник, порядок,
  тексты брифа, снимок без сцен), brand-manifest +5 (сцены пишутся в
  `brandScene`, 404 «Scene … not found», blob под `scenes/`, префикс
  confirm), snapshot +1, DTO +1. Всего по бэкенду: **281 тест / 32
  набора**, eslint 0.
- Проверено: frontend tsc / eslint 0 / vite build; Playwright: экран
  манифеста с блоком сцен (390px), форма добавления сцены (760px),
  мультичузер с карточкой сцены бренда «сцена · бренд» без корзины (760px).

## Этап 23 — Превью-кадры, аудитория, релевантность (ТЗ §18)

Четыре пожелания владельца продукта одной итерацией: кадры вместо
аватаров; аудитория товара по фото; аудитория и товар референса из
анализа; отдельный ИИ-вызов на релевантность с советом по промпту.

**Сделано (этап 23).**
- Analysis: промпт Gemini расширен до 6 ключей (`previewAt` у персонажей,
  `scenes[]`, `audience`, `promotedProduct`); `analysis-response.ts` —
  `seconds()` (число / «m:ss» / «7s»), `parseScenes` (previewAt по
  умолчанию — середина, зажим в диапазон, кап 12), `parseAudience`
  (синонимы пола на двух языках), `parsePromotedProduct`. Новый
  `analysis-previews.service.ts`: `POST /sessions/:id/analysis/previews/
  upload-url` (presigned PUT на каждый ключ, только ключи из анализа) и
  `…/confirm` (head по каждому, отсутствующие пропускаются, `previewUrl`
  в `videoAnalysis`). Типы `AnalysisScene`, `AudienceProfile`,
  `PromotedProduct` (`common/types/audience.types.ts`).
- Product: `ProductRecognitionService` просит и парсит `audience`
  (`parseAudienceBlock`); `ProductItem.audience Json?` — **миграция 12**
  `20260906060000_product_audience`; `persist()` не перетирает
  `source: 'user'`; `PATCH …/items/:id {audience}` через `AudienceInputDto`
  (nested, `null` → DbNull); `toItemView`/`productInformationFromItem`
  (`audienceOf`) копируют профиль.
- Новый модуль `modules/relevance/`: `relevance-response.ts`
  (`relevancePrompt`, `parseRelevanceResponse` со score-clamp и
  `verdictFor`, `relevanceBriefText`), сервис (текстовый Gemini JSON-вызов,
  `inputs`-флаги, `useInPrompt`), роуты `GET/POST/PATCH
  /sessions/:id/relevance`; `Session.data.relevance` (ключ в
  `SessionService.DATA_KEYS`). PromptService: секция **AUDIENCE FIT**.
- Frontend: `lib/frame-capture.ts` (`previewRequests`, `clampTime`,
  `previewSize`, `captureFrames` — video+canvas, сортировка по времени,
  4с таймаут на seek); `useWorkflow` держит File в `referenceFileRef`,
  после анализа `capturePreviews` → `uploadPreviewFrames`;
  `previewsStatus`. `CharacterCasting` — кадр в чипе и в карточке (+
  таймкод, спиннер во время захвата). Новый `AnalysisInsights` («Референс
  в цифрах»: лента сцен, аудитория, что продаёт). `AudienceCard` (+
  `lib/audience.ts`) на шаге «Описание» товара с формой правки. Новый
  `RelevancePanel` вверху шага «Промпт». Типы/API: `AudienceProfile`,
  `RelevanceState`, `uploadPreviewFrames`, `getRelevance/runRelevance/
  setRelevanceUseInPrompt`, `ItemInput.audience`.
- Тесты: backend +28 (parser 6, previews 5, recognition 3, project DTO/
  mapping 2, snapshot 1, relevance-response 7, relevance.service 4) —
  всего **309 / 35 наборов**, eslint 0; frontend unit-скрипты
  `frame-capture` (10) и `audience` (11) — всего 8 скриптов; tsc, eslint
  0, vite build. Playwright: кастинг с кадрами (390px), «Референс в
  цифрах» (760px), панель релевантности с раскрытой логикой (390px),
  карточка аудитории товара и её форма.
- Известные ограничения записаны в ТЗ §18.1 (нет превью для YouTube и
  после перезагрузки) и §18 «Открытые вопросы».

## Этап 24 — Сцены/массовка, оферта, библиотека, переименование (ТЗ §19–§21)

**Сделано (этап 24).**
- **Переименование** `viral2viral` → `viral4creators`: папка проекта,
  все 76 упоминаний в коде, конфигах, docker-compose (`name`,
  `POSTGRES_DB`, том), package.json обеих Next-аппов, тексты лендинга и
  шапки TMA, локальная БД, имя архива.
- **§19 (сцены и массовка):** седьмой ключ Gemini `extras[]` +
  `parseExtras`; `Session.data.analysisSelection` и
  `common/analysis-selection.ts` (`resolveSelection`, `scenesBriefText`,
  `extrasBriefText`); `GET/PUT /sessions/:id/analysis/selection`; в бриф
  GPT добавились SCENES TO DROP / SCENES TO KEEP / EXTRAS. Ключи превью
  расширены до `extra:e<N>`. Фронтенд: `lib/highlight.ts` (мягкое
  совпадение по словам и таймкодам), новый `SceneCasting` (сцены
  карточками, массовка чипами, крестик — снять), `AnalysisDisplay`
  подсвечивает строки активного фильтра и приглушает остальные,
  `CharacterCasting` теперь тоже поднимает фильтр наверх — один механизм
  на персонажей, сцены и массовку.
- **§20 (оферта и условия):** `doc/legal/offer.md` и
  `doc/legal/terms-of-use.md` (RU, версия в заголовке) — в них явно
  записано, что **Разборы принадлежат сервису** и включаются в
  Библиотеку, а Материалы и Результат остаются пользователю;
  `scripts/sync-legal.mjs` синхронизирует их в лендинг и TMA и сверяет
  версию с `TERMS_VERSION` бэкенда; общий `lib/legal-markdown.ts`;
  страницы `/legal/*` на лендинге и `#/legal/*` в TMA, ссылки в подвалах;
  `TermsGate` перед первым разбором; `POST /me/terms/accept` +
  `users.termsAcceptedAt/termsVersion`.
- **§21 (библиотека):** модель `AnalysisLibraryEntry` + **миграция 13**
  `20260906120000_analysis_library_and_terms` (13-я по счёту миграция,
  14 таблиц); `common/library.ts` (ключи источника, денормализация,
  объяснимое ранжирование с пересечением возрастных диапазонов);
  `modules/library/` — кеш (`findAnalysis`/`save`/`markUsed`),
  рекомендации (`GET /library/recommend`) и третий путь
  (`POST /sessions/:id/video/library`); `AnalysisService` спрашивает
  библиотеку до Gemini (для файла — по хешу байтов, до загрузки в Gemini)
  и кладёт результат после. Фронтенд: вкладка «Библиотека» в
  `VideoUpload` (первая для сессии из проекта), `LibraryPicker` со счётом
  и причинами, `pickLibraryEntry` в `useWorkflow`, бейдж «разбор из
  библиотеки» в карточке анализа.
- Тесты: backend +22 (extras 1, analysis-selection 3 + сервис 2,
  library 7 + сервис 7, legal 2) — всего **331 тест / 40 наборов**,
  eslint 0; frontend — новые скрипты `highlight` (11) и `legal-markdown`
  (14), всего 10 скриптов; tsc, eslint 0, vite build; landing tsc +
  `next build` (страницы `/legal/*` статические); admin tsc.
- Playwright: «Сцены и массовка» (390px), подсветка строки разбора по
  выбранной сцене (760px), снятые сцена и массовка, вкладка «Библиотека»
  с рекомендациями и счётом, экран согласия, страница оферты в TMA.

## Этап 25 — Приватность и модерация библиотеки (ТЗ §21.1/§21.3)

Закрывает два вопроса, которые открылись сразу после запуска библиотеки:
чужие загруженные файлы попадали в общую выдачу, а у оператора не было
способа убрать мусор.

**Сделано (этап 25).**
- Prisma: `enum LibraryVisibility {PUBLIC PRIVATE HIDDEN}`, поля
  `visibility`/`hiddenReason`/`moderatedAt`/`moderatedById` и индекс по
  видимости; **миграция 14** `20260906180000_library_visibility` — она же
  задним числом делает приватными все записи из загрузок.
- `Session.userId` наконец попал в TS-тип и в `toSession` (колонка была с
  этапа telegram-auth): без него нельзя было отличить «своё» от «чужого».
  Заодно ушла заглушка `userId: null` при записи в библиотеку.
- `LibraryService`: `canView` (публичное всем, приватное автору, скрытое
  никому), фильтр в `recommend` (`OR` для вошедшего, только PUBLIC для
  анонимной сессии), `get`/`applyToSession` проверяют доступ, кеш
  пропускает HIDDEN, `save` создаёт запись из загрузки как PRIVATE и не
  трогает решение оператора при повторном анализе. Админские методы
  `adminList` (фильтры + поиск + пагинация), `adminGet` (с самим
  разбором), `adminUpdate` (причина обязательна при скрытии, штамп
  модератора), `adminDelete`.
- `AdminLibraryController` под `AdminSessionGuard` + `assertOperator`;
  страница **«Библиотека»** в админке: таблица с видимостью, причиной,
  счётчиком использований, кнопки «Скрыть / Вернуть / В выдачу / Только
  автору / Удалить», просмотр разбора. `apiPatch` и корректная обработка
  204 в `apiDelete`.
- TMA: бейдж «только ваш» на приватной записи автора и честная строка про
  это в подписи вкладки.
- Тесты: +6 в библиотеке (canView, toAdminView, приватность в
  recommend/get/apply, кеш и HIDDEN, PRIVATE для загрузок, adminList,
  adminUpdate, adminGet/Delete) — всего **337 тестов / 40 наборов**,
  eslint 0. Проверки фронта, лендинга и админки — как обычно.

## Этап 26 — Жизненный цикл файлов (ТЗ §22)

Находка при разборе того, что уже сделано: `cleanupExpiredSessions()`
удаляла только строки. Готовые ролики, кадры-превью, фото-замены и
загруженные сцены оставались в Vercel Blob навсегда — растущий счёт и,
что важнее, чужой контент, до которого не дотянуться даже владельцу
(против §7.4 условий использования, написанных этапом 24).

**Сделано (этап 26).**
- `common/blob-paths.ts` — чистая функция `sessionBlobPathnames(session)`:
  единственное место, где перечислены файлы сессии (транзитный референс,
  готовый ролик, превью персонажей/сцен/массовки, фото-замены, свои
  сцены), плюс фильтр «только свой префикс» и `itemPhotoPathname`.
- `BlobService.deleteMany` (пачки по 50, best-effort) и `copyBlob`.
- `cleanupExpiredSessions` теперь: читает партию (500) истёкших сессий →
  собирает пути → удаляет строки по id с повторной проверкой времени →
  возвращает `{count, blobPathnames, hasMore}`; крон удаляет файлы и
  отдаёт `deletedBlobs`/`hasMoreSessions`. Порядок «строки, потом файлы»
  осознанный: при сбое остаётся мусор в хранилище, а не живая сессия с
  битыми ссылками.
- `deleteItem` / `deleteProject` убирают фото товаров (пути собираются до
  удаления строк).
- Библиотека копирует кадры-превью в `library/<sourceKey>/…` и хранит
  разбор уже со ссылками на копии — записи переживают уборку сессий.
- **`doc/STORAGE-AUDIT.md`**: таблица «путь → владелец → что удаляет»,
  описание уборки, честный список остатка (каскад манифеста, копии
  удалённых записей библиотеки, файлы сессий до этапа 26) и проверки на
  стенде.
- Тесты: +11 (blob-paths 5, уборка сессий 3, фото товаров 3) и +3 по
  копиям превью — всего **353 теста / 42 набора**, eslint 0.

## Этап 27 — Долг по файлам закрыт (ТЗ §22.1/§22.2)

Этап 26 честно записал три места, где файлы всё ещё оставались. Этап 27
их закрывает — целиком, чтобы «известный остаток» не превратился в
привычку.

**Сделано (этап 27).**
- `pathnameFromBlobUrl(url, prefix)` в `common/blob-paths.ts`: путь из
  публичного URL, но только внутри ожидаемого префикса — удаление по
  адресу из данных без такой проверки позволяло бы снести чужой файл.
  `itemPhotoPathname` теперь тонкая обёртка над ним; добавлен
  `libraryEntryPathnames`.
- `BrandManifestService.remove` собирает фото персонажей и сцен ДО
  удаления манифеста (каскад БД идёт мимо сервисных методов) и чистит их
  после.
- `LibraryService.adminDelete` убирает копии кадров записи под
  `library/<sourceKey>/…`.
- **Подметатель сирот**: `common/orphan-sweep.ts` (чистая функция
  `orphanSweepPlan` + `sessionIdOf`), `BlobService.listByPrefix` со
  сквозным курсором и `GET /api/cron/sweep-orphans` с `CRON_SECRET`,
  `limit`, `minAgeHours` и `dryRun`. В расписание не поставлен намеренно:
  удаление необратимо, поэтому запуск ручной, а ежедневный крон
  по-прежнему только `cleanup-sessions`.
- `doc/STORAGE-AUDIT.md` переписан: раздела «известный остаток» больше
  нет, вместо него — «каскады, идущие мимо сервисов» и описание метлы с
  рецептом запуска.
- Тесты: +11 (pathnameFromBlobUrl 5, libraryEntryPathnames 2, каскад
  манифеста 2, удаление записи библиотеки, orphan-sweep 5) — всего
  **363 теста / 43 набора**, eslint 0.

## Этап 28 — Сброс при смене референса и сквозная сверка

**Сделано (этап 28).**
- **Дефект:** подстановка нового референса (файл или YouTube-ссылка) не
  обнуляла состояние прошлого — кастинг, снятые сцены и массовку, выбор
  слотов и отчёт релевантности. Последствие не косметическое: отчёт от
  ПРОШЛОГО ролика продолжал уходить в бриф GPT секцией AUDIENCE FIT, то
  есть в платную генерацию попадали советы про другое видео. Правило
  вынесено в `common/session-reset.ts` и применяется всеми тремя путями
  (файл, ссылка, разбор из библиотеки). Товар, манифест, загруженные
  сцены и готовый ролик не трогаются.
- **Сквозная сверка** кода и документов после этапов 22–27. Найдено и
  починено:
  - `GET /api/health` был обещан в четырёх документах, печатался при
    старте и стоял пунктом приёмки — но не существовал. Добавлен
    (`modules/health`), отдаёт статус БД и uptime, наружу не выносит
    причину сбоя;
  - подпись «выгрузка в канал появится следующим этапом» в PublishPanel
    (это давно отдельное ТЗ) — исправлена;
  - README: несуществующий корневой `npm install`, `npm test` во
    фронтенде (там 10 скриптов `npx tsx`), ссылка на пустой
    `scripts/output/`, список модулей без `cron`/`telegram-login`/
    `video`/`health`, админка без модерации библиотеки, «Workflow» из
    девяти шагов старого MVP;
  - лендинг описывал продукт до этапа 10 — шаги, возможности и FAQ
    переписаны под то, что есть (библиотека, релевантность, фильтры,
    оферта, слоты, аудит);
  - `DATABASE-AUDIT.md`: заголовок «все 4 таблицы» при 14 и путаница в
    итогах между дополнениями;
  - «Итоговая сверка» и «Порядок реализации» в этом плане содержали
    цифры этапа 21 — обновлены;
  - чеклист приёмки назывался «этапы 1–21».
- **`doc/API.md`** — полный список маршрутов с указанием, кто может
  звать (открыто / идентичность / оператор / секрет крона). Сверка нашла
  восемь групп существующих, но нигде не описанных эндпоинтов; чтобы
  дрейф не повторялся, теперь правило: новый контроллер → строка в API.md.
- Тесты: +6 (сброс 2, VideoService 2, health 2) — всего **369 тестов /
  46 наборов**, eslint 0.

**Сделано (этап 29).**

Пять требований владельца продукта одним этапом: понятное логирование
сбоя базы, метла в суточном кроне, аудит светлой и тёмной темы,
повторный аудит лендинга и переключатель режимов.

- **Режимы Lite / Standard / Premium (ТЗ §23).** Матрица возможностей —
  одна на весь продукт, `backend/src/common/plans.ts`; бэкенд читает её,
  чтобы запрещать, интерфейс получает её целиком в `GET /api/me/plan` и
  рисует замки из неё. Копии матрицы в интерфейсе намеренно нет:
  разошедшаяся копия показывает кнопку, которую сервер потом запретит.
  - миграция 15 — `enum UserPlan`, `users.plan` (default `LITE`) и
    `users.planSince`; **всего 15 миграций, 14 таблиц**;
  - `PlanService` с `planOfUser` / `planOfSession` / `assert*`. Режим
    берётся у ВЛАДЕЛЬЦА сессии: маршруты `/sessions/**` открыты (§7.8),
    и брать режим у звонящего значило бы понижать Premium-пользователя
    на его же сессии;
  - проверки встроены в восемь сервисов (`library`, `relevance`,
    `video-audit`, `publication`, `brand-manifest`, `reference-assets`,
    `casting`, `generation`) и срабатывают ДО работы, а не после;
  - манифест бренда проверяется только при создании — уже описанный
    бренд остаётся рабочим в любом режиме;
  - `GET /api/me/plan` открыт, `PATCH` — за идентичностью: анонимный
    браузер обязан рисовать те же замки, но записывать режим ему некуда;
  - интерфейс: экран `#/plan` с тремя карточками, значок текущего режима
    в шапке, `LockedNote` на месте каждой закрытой возможности (вкладка
    «Библиотека», релевантность, аудит, публикация, слоты и свои сцены,
    фото-замена персонажа, создание манифеста), гашение непозволенных
    форматов кадра;
  - **найдено при разборе:** формат кадра мог прийти от референса (3:4 у
    файла) и оказаться закрытым — тогда генерация упиралась бы в 403
    ПОСЛЕ загрузки фото товара. Picker переводит на ближайший родной
    формат заранее;
  - **найдено при разборе:** качество рендера в мастере называлось «Lite»
    и «Standard» — ровно как режимы. Переименовано в «быстрое» и
    «кинематографичное» здесь и на лендинге: два разных выбора с
    одинаковыми словами на одном экране читаются как один;
  - все три режима **бесплатны**; `PLANS_BILLING_ENABLED=true` заранее
    запрещает самостоятельное переключение, так что появление оплаты не
    потребует правки правил доступа.
- **Диагностика сбоя базы (ТЗ §24).** `prisma/db-error.ts` разбирает
  ошибку `$connect()` в один из пяти видов (`unreachable`, `auth`,
  `timeout`, `tls`, `unknown`) и печатает две строки: что случилось — с
  адресом `host:port/db` и **без** учётных данных, которые Prisma
  раньше выводила в стектрейсе, — и что делать. Тот же разбор пишется в
  лог при `degraded` у `/api/health`.
- **Метла в суточном кроне.** `sweep-orphans` переведён в расписание
  (03:30 UTC, через полчаса после `cleanup-sessions` — чтобы видеть уже
  удалённые строки). Отчёт получил разбивку по видам файлов, число
  осиротевших сессий и возраст самого старого файла; сбой листинга прямо
  называет `BLOB_READ_WRITE_TOKEN`, сбой удаления не роняет прогон.
  `cleanup-sessions` теперь тоже сообщает, что недоудалённое заберёт
  метла, — раньше эта ошибка терялась молча.
- **Аудит светлой и тёмной темы.** Найден системный дефект: палитра
  SilverFinance тёмная по рождению, и два её тона на светлом фоне
  нечитаемы — акцент `#7dd3fc` давал ≈1.5:1 (все `text-accent`:
  подписи, ссылки, «Доступно в …»), вторичный текст `silver-400` —
  ≈2.6:1 (132 места: хинты, подзаголовки, счётчики). Оба тона стали
  переменными по темам (`--accent`, `--accent-on`, `--silver-400` в
  `index.css`): в светлой теме акцент темнеет до sky-600 (≈4.6:1),
  чернила НА акцентной заливке становятся белыми, вторичный текст —
  ≈4.8:1. Тёмная тема не изменилась ни на пиксель. Проверено попарными
  снимками шести экранов в обеих темах.
- **Повторный аудит лендинга.** Добавлены раздел «Режимы» (сравнение
  трёх пакетов, включая то, чего в пакете НЕТ) и «Подробнее о проекте» —
  восемь блоков о том, что скрыто за кнопками: из чего состоит разбор,
  зачем отдельная релевантность, как устроен манифест, что модель видит
  картинкой, приватность библиотеки и права на разборы, сроки хранения
  файлов. FAQ дополнен вопросами о стоимости, различиях режимов, сроках
  удаления файлов и правах на разборы. Починен якорный переход: липкая
  шапка перекрывала заголовок раздела (`scroll-padding-top`).
- Тесты: +19 (`plans` 6, `PlanService` 6, `plan-gates` 2,
  `PlanController` 5, `db-error` 4) — всего **393 теста / 51 набор**,
  eslint 0. Фронтенд: 11 unit-скриптов (добавлен `plan.test.ts`), tsc и
  vite build чисто.

**Сделано (этап 30).**

- **Пользователи в админке (ТЗ §25).** Этап 29 добавил `users.plan` и тем
  сделал заметной старую дыру: и режим, и флаг `isOperator` правились
  только через `psql`. Появился экран `/users`: поиск по `telegramId`,
  `@username` и имени сразу, фильтры по режиму и «только операторы»,
  счётчики активности (сессии, проекты, манифесты, разборы, заявки),
  смена режима, выдача и снятие прав оператора, карточка с 10 последними
  сессиями.
- **Правило, ради которого в сервис передаётся `actorId`:** оператор не
  может снять права с самого себя — иначе один клик оставляет админку без
  единственного человека, который мог бы это исправить, и флаг пришлось
  бы возвращать через `psql`, то есть ровно тем способом, от которого
  экран и избавляет. Снять права с ДРУГОГО оператора можно: иначе первый
  же ошибочно выданный флаг стал бы вечным. Повышение прав пишется в лог
  с обеими сторонами.
- **Сводка «сколько у нас кого» считается по всей базе, а не по
  выборке** — цифра под отфильтрованным списком читается как общая, и
  считай она по фильтру, врала бы каждый раз.
- **Удаления пользователя намеренно нет:** каскад уносит проекты,
  манифесты и заявки, а разборы библиотеки остаются без автора. Такое не
  делают кнопкой в строке списка.
- Тесты: +10 (`AdminUsersService`) — всего **403 теста / 52 набора**,
  eslint 0; admin `next build` чисто.

**Сделано (этап 31).**

- **Блокировка пользователя (ТЗ §25.3).** Третья ось рядом с режимом и
  правами оператора, с узким и осознанным смыслом: блокировка
  останавливает трату денег, а не отбирает результат. Запрещены все
  девять платных вызовов; вход, проекты, манифесты и готовые ролики
  остаются. **Режим при блокировке не меняется** — решение владельца
  продукта: заблокированный платель переедет на Lite сам, когда
  закончится оплаченный период. Причина блокировки дословно попадает в
  текст отказа пользователю, а снятие блокировки её стирает: причина,
  оставшаяся у разблокированного, потом читается как действующий запрет.
  Заблокировать самого себя нельзя — тот же класс ошибки, что и снятие
  собственных прав оператора.
- **Учёт расходов на ИИ (ТЗ §26).** Каждый платный вызов пишет строку в
  новую таблицу `ai_usage`: кто, что, сколько единиц, сколько денег и по
  какой версии прайса. Девять точек записи — разбор, релевантность,
  аудит, расшифровка, распознавание фото, промпт, генерация, поиск
  аналогов, поиск на YouTube. Миграция 16 (плюс три колонки блокировки в
  `users`) — **всего 16 миграций, 15 таблиц**.
- **Решения, из которых собран учёт:**
  - учёт не роняет работу — запись идёт после вызова, когда деньги уже
    потрачены, и целиком в try/catch: уронить на ней готовую генерацию
    значит взять деньги и не отдать результат;
  - модель без ставки даёт строку с `unpriced: true`, а не молчаливый
    ноль, и вкладка показывает такие вызовы отдельно — иначе новая
    модель, забытая в прайсе, тихо занижает сумму;
  - Veo пишется в момент ЗАПУСКА: занизить отчёт о расходах опаснее, чем
    завысить, — по нему планируют бюджет;
  - деньги в микродолларах целым числом; float-доллары по десяткам тысяч
    строк дают дрейф в той единственной цифре, которой обязаны верить;
  - строка расхода переживает и сессию (без FK), и пользователя
    (`SET NULL`).
- **Прайс** — `common/ai-pricing.ts`, одна таблица с версией и
  пояснением к каждой ставке, откуда она взята. Любая переопределяется
  переменной окружения **в долларах** (человек задаёт её, глядя на
  страницу прайса; заставлять его умножать на миллион — верный способ
  ошибиться в тысячу раз), мусор в переменной не обнуляет ставку.
  Ставки Gemini сверены с `ai.google.dev` 2026-09-06; ставки Veo и GPT-5
  на официальных страницах не нашлись и помечены как требующие проверки —
  вкладка показывает версию прайса рядом с суммой именно поэтому.
- **Вкладка «Расходы»**: итоги и срезы за 24ч/7д/30д, разбивка по
  провайдерам, операциям и моделям с долями, средние на пользователя и
  на сессию, расход анонимных сессий отдельной плиткой (он реален, но ни
  на кого не записан — подмешивать его в средний значит завышать топ по
  тратам), действующий прайс с пометкой переопределённых ставок. В списке
  пользователей расход идёт колонкой, в карточке — разбивкой по
  операциям; в список добавлены бейдж и фильтр «только заблокированные».
- Тесты: +12 (`ai-pricing`), +6 (блокировка в `PlanService`), +6
  (блокировка и расход в `AdminUsersService`) — всего **427 тестов /
  53 набора**, eslint 0.

**Сделано (этап 32).**

Продолжение этапа 31: расход стало видно — теперь его надо ограничить, а
пользователю сказать о его состоянии заранее.

- **Суточные потолки расхода (ТЗ §26.4).** До этого этапа самый дорогой
  вызов сервиса — генерация Veo — не был ограничен ничем: сто нажатий
  кнопки за вечер стоили сотню рендеров. Потолок задаётся **в деньгах, а
  не в штуках** (разбор десятисекундного ролика и трёхминутного стоят
  по-разному, Veo Standard дороже Lite почти втрое), свой у каждого
  режима, окно — сутки от полуночи UTC.
- **У анонимных потолок ОБЩИЙ на всех.** Персонального у них быть не
  может: у анонимного пути нет пользователя, а UUID сессии минтится
  бесплатно сколько угодно раз. Без общего потолка достаточно было бы
  выйти из аккаунта, чтобы обойти персональный, — дыра ровно в том
  месте, ради которого потолки и заводятся.
- **Пускаем, пока потолок не выбран целиком.** Цена вызова заранее
  неизвестна, поэтому последний вызов может выйти за край; резать
  генерацию посередине или угадывать её цену хуже. `0` — законное
  значение («платные вызовы запрещены»), мусор в переменной потолок не
  обнуляет: молча остановить сервис из-за опечатки хуже, чем работать по
  умолчанию из кода.
- **Одна проверка на девять вызовов** — `PlanService.assertCanSpend*`:
  сначала блокировка, потом лимит. Порядок важен: показать
  заблокированному «попробуйте завтра» значило бы соврать ему о том, что
  произойдёт завтра.
- **Пользователь узнаёт о своём состоянии заранее.** До этого этапа
  заблокированный видел красную ошибку после того, как выбрал референс и
  дождался начала разбора, — худший момент для такой новости.
  `GET /api/me/plan` теперь отдаёт блокировку и два признака лимита
  (`exhausted`, `nearlyExhausted`) **без сумм**, а `AccountNotice`
  показывает спокойное уведомление сверху на любом экране. Долларов там
  нет намеренно: «вы потратили $1.20 из $2.00» — это наша бухгалтерия, а
  не ответ на вопрос человека.
- **Кеш входных токенов (§26.1, закрыт).** Gemini и OpenAI считают
  повторно использованный вход дешевле и отдают его отдельным
  счётчиком, а сервис писал всё по полной ставке и завышал отчёт.
  Появилась колонка `cachedInputTokens` (миграция 17) и своя ставка в
  прайсе; кеш **вычитается** из обычного входа, а не добавляется
  строкой, — иначе один и тот же токен оплачивался бы дважды.
- **В админке** видно расход за сегодня против потолка в строке
  пользователя (красным, если упёрся), сами потолки отдельной таблицей
  на вкладке «Расходы» и то, сколько анонимные уже выбрали сегодня.
- Тесты: +10 (`spend-limits`), +5 (лимиты в `PlanService`) — всего
  **442 теста / 54 набора**, eslint 0. **17 миграций, 15 таблиц.**

**Сделано (этап 33).**

- **CI (ТЗ §27).** `.github/workflows/ci.yml`: четыре джобы — бэкенд
  (Prisma, миграции, типы, линт, 442 теста), фронтенд (типы, линт, 11
  unit-скриптов, сборка), матрица `admin`/`landing` (типы + `next
  build`) и репозиторий (юридические тексты). До этого этапа всё это
  запускал человек и только когда вспоминал.
- **Две проверки, которых песочница сделать не могла** — у неё нет сети
  до `binaries.prisma.sh`: миграции накатываются на живой Postgres 16, а
  `prisma migrate diff --exit-code` сверяет их со схемой. Миграции
  пишутся руками, поэтому расхождение схемы и SQL — самый вероятный
  способ уронить прод; раньше в конце каждого этапа стояла формулировка
  «провалидировать там, где есть сеть», теперь это делает CI на каждом
  пуше.
- **`scripts/check-docs.mjs`** сверяет числа в `doc/` (тесты, наборы,
  миграции, таблицы, unit-скрипты) с реальностью. Ровно этот класс
  ошибки всплывал на этапах 25, 28 и 30 и правился задним числом. Число
  тестов берётся из отчёта jest, а не считается регуляркой: `it.each` и
  тесты в циклах разворачиваются в рантайме, и «примерно столько» в
  отчёте о проверках хуже, чем ничего.
- **`make ci` и `make ci-docs`** — то же локально. `make ci` намеренно
  не запускает `tsc` на бэкенде: без сгенерированного клиента он выдаёт
  известный шум, и приучать себя игнорировать красный вывод хуже, чем не
  показывать его вовсе.
- Новых тестов нет — этап целиком про то, чтобы существующие запускались
  без участия человека. **442 теста / 54 набора, 17 миграций,
  15 таблиц** без изменений.

**Сделано (этап 34).**

Обещание с этапа 20 наконец выполнено: ролик в неродном для Veo формате
теперь действительно обрезается, а не сопровождается строчкой «появится
с медиа-воркером». Подход и протокол — из рабочего кода соседнего
проекта владельца (`vgffmpeg.service.ts` в atm-travel), который он
прислал референсом.

- **Кто режет:** хостед-ffmpeg (`verygoodffmpeg.com` по умолчанию, база
  и ключ — переменными окружения). У Vercel Functions ffmpeg нет и быть
  не может: рендер видео — не задача для функции с потолком в 300
  секунд, а свой воркер ради одной операции дороже, чем сервис, который
  только это и умеет.
- **Без ffprobe.** Размеры кадра от Veo серверу неизвестны, а второй
  проход ради них — лишний вызов и лишние деньги. `crop` принимает
  выражения от `iw`/`ih`, поэтому «наибольший прямоугольник целевого
  формата, вписанный в кадр» описан прямо в команде и работает для
  любого разрешения. Апскейла нет; размеры приводятся к чётным —
  libx264 с `yuv420p` нечётные не берёт и падает уже внутри задачи, где
  отладка дороже.
- **Обрезка не блокирует выдачу.** Ролик в родном формате отдан сразу,
  задача идёт следом и подменяет ссылку. Опрашивается тем же маршрутом,
  что и Veo: второй цикл опроса ради одной операции был бы лишним.
  Четыре честных состояния в интерфейсе вместо одного обещания: идёт,
  готово, не получилось (с причиной, остаётся родной кадр), не
  подключено на стенде.
- **Результат переносится в наш Blob** — ссылка чужого сервиса живёт
  ограниченное время и лежит в чужом хранилище, а по §22 у каждого файла
  один владелец. Новый путь добавлен в `blob-paths.ts`: без этой строки
  обрезанный файл утекал бы — ровно тот дефект, который чинил этап 26.
- **Родной кадр не удаляется** и доступен ссылкой: композиция под
  обрезку иногда «едет», и сравнить с оригиналом — единственный способ
  это увидеть.
- **Расход** пишется в журнал (§26) операцией `reframe`, провайдер
  `FFMPEG`; ставка приблизительная и помечена как требующая проверки.
- Тесты: +12 (`common/reframe`), +10 (`ReframeService`) — всего
  **464 теста / 56 наборов**, eslint 0.
- **Референс:** архив соседнего проекта владельца (`atm-travel`) — оттуда
  взяты форма запроса, конверт `data` в ответе, статус `succeeded` вместо
  `completed`, пустая строка в `error_message` и политика повторов. Это
  не догадки о чужом API, а поведение, проверенное на живом сервисе.

## Дальше (вне этого плана)

ТЗ на следующую итерацию — `doc/PUBLISHING-AND-VOICEOVER-SPEC.md` §14:
выгрузка одобренных роликов в YouTube/TikTok (OAuth-каналы, cron-воркер,
ограничения аудитов платформ — до аудита только приватные публикации).
Оценки — там же.

Вторая половина того ТЗ, «настоящая» озвучка, сделана этапами 35–37 —
сразу после этой записи и не так, как предлагалась: не своим
ffmpeg-воркером вне Vercel, а хостед-сервисом, и одной командой на
обрезку и звук вместе. Описание переехало в `PRODUCT-PROJECT-SPEC.md`
§15; в старом ТЗ осталась отсылка и список того, что в реализацию не
вошло.

---

## Этап 35 — настоящая озвучка (ТЗ §15)

**Сделано (этап 35).**

Закрыт открытый вопрос 13.1, висевший с этапа 19: реплики теперь может
читать выбранный голос, а не Veo. Провайдер — ElevenLabs, протокол взят
из рабочего кода соседнего проекта владельца, а не из догадок о чужом
API.

Главное свойство реализации названо в задаче прямо и выдержано:
**мягкий фоллбек**. Ключ не задан — не ошибка; продукт работает ровно
как до этого этапа, а интерфейс пишет об этом спокойной пометкой. В типе
ответа провайдера разведены «не настроено» и «сломалось» — показывать
их одинаково нечестно, потому что первое это состояние стенда, а второе
повод идти разбираться. Ни одного `throw` в провайдере нет: единственный
способ уронить генерацию из-за необязательного улучшения — бросить
исключение.

Три решения, которые стоили обсуждения:

1. **Один проход ffmpeg, а не два.** Обрезка кадра (этап 34) и
   наложение дорожки — операции над одним файлом. Двумя задачами это
   означало бы два счёта, два перекодирования и гонку за порядок, при
   которой «озвучка легла на необрезанный ролик» — обычный исход, а не
   редкий сбой. `common/postprod.ts` собирает одну команду под то, что
   нужно конкретному ролику; `modules/reframe` переименован в
   `modules/postprod`, `ReframeService` — в `PostProductionService`, и
   поля состояния в `GeneratedVideo` сменили имена вместе со смыслом
   (`reframeStatus` → `postStatus`): два статуса у одной операции рано
   или поздно разошлись бы.
2. **Текст озвучки — отдельная сущность.** GPT возвращает второй ключ
   `voiceoverScript`, текст показывается и правится на шаге «Промпт» до
   синтеза, с оценкой длительности речи. Разбор ответа терпимый: JSON →
   блок кода → ключ регуляркой → реплики из строки «Dialogue:» самого
   промпта. Последняя ступень даёт озвучку и промптам, сгенерированным
   до этого этапа.
3. **Провал синтеза не отменяет обрезку.** Наказывать за ненастроенный
   необязательный сервис операцией, которая от него не зависит, было бы
   странно: задача уходит, просто без звуковой дорожки.

Режим озвучки (`veo` / `voiceover` / `dub`) живёт в манифесте бренда и
замораживается в снимке — смена голоса задним числом не переозвучивает
уже отснятые ролики. В режимах со своим голосом бриф прямо запрещает
говорящие головы: рассинхрон губ и звука читается как брак и никаким
миксом не чинится.

Миграция 18 добавила `brand_manifests.voiceMode/ttsVoiceId/ttsModel` и
`ai_usage.characters` — у TTS счёт идёт за символы, и писать их в
колонку токенов значило бы врать в отчёте о деньгах.

Проверки: **59 наборов / 520 тестов** на бэкенде (было 56/464), eslint
0, `prisma validate`, все **18** миграций подряд на чистом Postgres 16
(**15** таблиц), frontend tsc + eslint + `vite build` + 11 unit-скриптов,
`next build` для admin и landing.

---

## Этап 36 — долги этапа 35 (ТЗ §15.5, §15.6)

**Сделано (этап 36).**

Три небольших долга, каждый из которых закрывает конкретную неловкость,
оставшуюся после этапа 35.

1. **Проба голоса** (закрыт вопрос 15.3). Послушать выбранный голос
   можно в манифесте, на своей фразе, до генерации ролика. Интересным
   здесь оказался лимит: суточный потолок расхода (§26.4) пробу не
   удержит — она стоит копейки, а нажать «Прослушать» двести раз подряд
   можно за минуту. Поэтому потолок отдельный и считается в НАЖАТИЯХ
   (30 в сутки), по журналу расходов, операцией `voiceover-preview` —
   своей, отличной от `voiceover`. Ответ отдаётся `data:`-URL, а не
   файлом в Blob: проба живёт секунды, и класть её в хранилище значило
   бы заводить мусор, за которым потом пойдёт подметатель (§22).
   Блокировка и бюджет проверяются РАНЬШЕ потолка на пробы —
   заблокированному незачем объяснять, сколько проб у него осталось.

2. **Сдвиг начала речи** (закрыта половина вопроса 15.2). `voiceDelayMs`
   существовал с этапа 35 и не использовался никем — дорожка всегда
   ложилась с нулевой секунды, поверх кадра-крючка, где по замыслу никто
   не говорит. Теперь сдвиг берётся из таймкода первой реплики, который
   модель УЖЕ пишет в тексте и который `speakableText` до этого просто
   выбрасывал в мусор. Это бесплатно: ни одного лишнего вызова. Вторая
   половина вопроса (реплики по битам) осталась открытой — она требует
   синтеза по фразе и цены, умноженной на число реплик.
   Таймкод за пределами ролика (`1:05` вместо `0:01.05` — обычная описка
   модели) игнорируется: сдвинуть на 65 секунд значит выдать немую
   восьмисекундную дорожку.

3. **Переключатель версий в плеере.** Исходник Veo был доступен ссылкой
   в новую вкладку, где рядом с ним ничего нет, — а «до и после» имеет
   смысл только когда их видно подряд. Теперь это переключатель над
   плеером, и скачивание идёт за ним: кнопка, отдающая не то, что сейчас
   играет, — ошибка, которую замечают уже после отправки.

Проверки: **60 наборов / 535 тестов** на бэкенде (было 59/520), eslint
0, `prisma validate`, все **18** миграций подряд на чистом Postgres 16
(**15** таблиц) — новых миграций этап не потребовал, frontend tsc +
eslint + `vite build` + 11 unit-скриптов, `next build` для admin и
landing.

---

## Этап 37 — долг I.1 из аудита (ТЗ §15.6, §26)

**Сделано (этап 37).**

Пять правок из раздела I.1 `doc/TODO.md` — те, что уже брали с владельца
деньги и ничего не отдавали взамен. Ни одна не добавляет продукту
функций; все пять чинят то, что было обещано и не работало.

1. **Постобработка доходит до пользователя** (А-2.1). Опрос статуса
   гасился на `status === 'complete'` — в ту секунду, когда задача
   обрезки и озвучки только создана. Этапы 34–36 на живом стенде не
   работали вовсе: файл ложился в Blob и не использовался ничем.
   Решение вынесено в `frontend/src/lib/video-polling.ts` отдельным
   модулем — именно потому, что ошибка была в этом решении, а внутри
   хука его нечем закрепить. Терминальных состояний теперь два уровня;
   ролик показывается сразу, как только снят.
2. **Захват работы одним запросом в базу** (А-2.2). Три наложившихся
   тика опроса оплачивали три синтеза и три задачи ffmpeg. Клиентского
   флага мало: на Vercel параллельные опросы приходят в разные
   экземпляры функции. `SessionService.claimPostProduction` делает
   условный `UPDATE` по JSONB (`postStatus IS NULL → 'pending'`) и
   честно отвечает, кто выиграл; проигравший не тратит ничего. Запрос
   проверен на живом Postgres: первый `UPDATE 1`, второй `UPDATE 0`.
   Побочный случай — захват без отправки задачи (процесс умер между
   ними) — закрывается сбоем с причиной, а не вечным «обрезаем…».
   Заодно `planWork` научился считать родной для Veo формат за «резать
   нечего»: иначе ролик 9:16 занимал бы постобработку и тут же её
   отменял.
3. **Пустой текст озвучки отключает озвучку** (А-2.5). Пустая строка
   сворачивалась в `undefined`, и постобработка откатывалась к тексту
   GPT: пользователь читал «пусто — ролик останется со звуком модели»,
   стирал реплики и получал ролик, озвученный ровно тем, что он удалил.
   Теперь «не передано» и «передано пустым» — разные вещи на всём пути.
4. **Утверждение промпта без гонки** (А-2.4). `onUpdate` уходил без
   `await` параллельно с `onApprove`; один из исходов — сессия в тупике,
   из которого нет выхода интерфейсом. Тип пропа изменён на
   `void | Promise<void>`, вызовы сериализованы.
5. **Счёт сессий с расходом — в базе** (А-1.1). `distinct` у Prisma 7
   дедуплицирует в JavaScript: на журнале в 800 тыс. строк отчёт тянул
   ~25 МБ в кучу функции ради одного числа. Заменено на
   `count(DISTINCT "sessionId")`.

Тестами закреплены все пять, включая три места, у которых спеков не было
вовсе: `SessionService` (захват), `AiUsageService` (отчёт и запись
расхода — до этапа 37 покрытие 10 %), `PromptService` (правка текста
озвучки). На фронтенде появился двенадцатый unit-скрипт —
`video-polling.test.ts`, регрессия ровно на находку А-2.1.

Проверки: **63 набора / 558 тестов** (было 60/535), eslint 0,
`prisma validate`, 18 миграций подряд на чистом Postgres 16 (15 таблиц) —
новых миграций этап не потребовал, frontend tsc + eslint + `vite build` +
**12** unit-скриптов, `next build` для admin и landing. Сквозной прогон
в Playwright подтверждает главное: ролик показывается сразу, а ссылка
подменяется следующим опросом — состояние, недостижимое до этой правки.

---

## Этап 38 — долг I.2 из аудита: закрыть двери (ТЗ §12.4, §20.1, §26.4)

**Сделано (этап 38).**

Пять дверей, каждая из которых была открыта не по злому умыслу, а
потому, что проверку поставили в интерфейсе или в одном из двух мест.

1. **`CRON_SECRET` в инструкции по деплою** (А-4.6). В списке переменных
   его не было, а `doc/API.md` тут же предупреждал, что без него
   `/api/cron/*` открыты — и один из этих маршрутов необратимо удаляет
   файлы из хранилища, с параметрами из строки запроса. Человек,
   поднимавший прод по инструкции, получал публичный URL, стирающий
   файлы. Добавлены он и ещё четыре пропущенные переменные, плюс
   проверка после деплоя: `curl` на маршрут крона должен вернуть 401.
2. **Картинки только из нашего хранилища** (А-2.11). Снимок манифеста
   правится клиентом целиком, а сервер потом скачивает названные там
   адреса. Проверялось только «это https-URL». Теперь `common/blob-url.ts`
   сверяет И хост, И префикс пути — одного пути мало, потому что
   `https://внутренний-сервис/brand-manifests/bm1/photo.jpg` имеет
   идеально правильный путь. Проверка стоит дважды: в DTO (понятное
   сообщение) и у самого `fetch` (её нельзя обойти, добавив новый
   маршрут записи). Сообщение об отказе одинаковое для всех причин —
   разные тексты превращают отказ в подсказку подбирающему.
3. **Постобработка под §26.4** (А-2.15). Обрезка и озвучка были
   единственными платными вызовами мимо проверки блокировки и бюджета.
   Отказ здесь, в отличие от остальных платных маршрутов, — не
   исключение, а пометка с причиной: ролик уже снят и отдан, и уронить
   ответ значит показать ошибку вместо готового ролика.
4. **Одна открытая заявка на публикацию** (А-1.4). Проверка и создание
   были двумя операциями, между которыми вклинивался второй запрос:
   двойной клик давал две карточки в очереди оператора, а с §14 дал бы
   две выгрузки на площадку. Теперь обе под одной транзакцией с
   `pg_advisory_xact_lock`.

   Правильная форма инварианта — частичный уникальный индекс, и он был
   первым выбором. От него пришлось отказаться сознательно: частичные
   индексы не выражаются в `schema.prisma`, а CI сверяет базу со схемой
   через `migrate diff`, и такой индекс читался бы как расхождение.
   Городить исключение в проверке ради одного индекса — плохой размен.
   Именно `xact`-блокировка, а не сессионная: за пулером (PgBouncer в
   режиме транзакций) соединение возвращается в пул сразу после
   коммита, и сессионная блокировка утекла бы на чужой запрос.
5. **Согласие с офертой проверяется на сервере** (А-2.16). На нём стоят
   права сервиса на Разборы и легитимность общей Библиотеки: разбор в
   обход галочки всё равно попадал в Библиотеку и предлагался другим.
   Анонимный проходит — строки пользователя у него нет, и заводить её
   ради галочки хуже для человека, чем сама галочка.

**Попутная находка, которой не было в аудите.** Проверяя, не сочтёт ли
`migrate diff` частичный индекс расхождением, обнаружилось, что этот шаг
CI не работает вовсе: `--from-url` и `--to-schema-datamodel` **удалены в
Prisma 7**, и шаг падал с «flag was removed». Самая ценная проверка в
файле — сверка написанных руками миграций со схемой — молча не
выполнялась. Флаги исправлены на `--from-config-datasource` и
`--to-schema`.

Проверки: **64 набора / 577 тестов** (было 63/558), eslint 0,
`prisma validate`, 18 миграций подряд на чистом Postgres 16 (15 таблиц) —
новых миграций этап не потребовал, frontend tsc + eslint + `vite build` +
12 unit-скриптов, `next build` для admin и landing.

---

## Этап 39 — долг I.3 из аудита: дефекты сценариев (ТЗ §7.9–§7.10, §16.2, §21.5, §22.5)

**Сделано (этап 39).**

Девять находок раздела I.3 — те, где продукт не терял деньги, но терял
пользователя: заводил в тупик, показывал пустоту вместо причины или
молча выбрасывал то, за что уже заплачено.

1. **Мастер продолжает с того места, где остановились** (А-2.7). Он
   всегда стартовал с шага «Видео», сколько бы состояния ни лежало в
   сессии: свернули Mini App на время рендера — вернулись на шаг 1, а
   готовый оплаченный ролик недостижим интерфейсом никак. Шаг
   восстанавливается по `status` сессии (`lib/session-step.ts`), и два
   правила делают восстановление безопасным: идущий рендер НЕ ведёт на
   экран с кнопкой «Сгенерировать» (это приглашение заплатить дважды), а
   вместо неё возобновляется опрос — иначе пользователь смотрит на
   спиннер, который никогда не сменится.
2. **Из сбоя разбора есть выход** (А-2.8). Пустая карточка без единой
   кнопки; уйти можно было только перезагрузкой, о которой нигде не
   сказано. Все три пути сбоя возвращают к выбору референса.
3. **Отказы выбора файла видны на экране** (А-2.12). «Формат не
   поддерживается» и «файл больше 100 МБ» уходили в `console.error`, и
   экран выглядел зависшим — пользователь жал ещё раз с тем же файлом.
4. **Сбой поиска аналогов отличается от «не найдено»** (А-2.13). §6.1
   специально спроектировала ответ с причиной, «чтобы пустая выдача
   из-за сбоя отличалась от “аналогов не найдено”» — а клиент причину
   выбрасывал. При истёкшем ключе SerpApi пользователь переснимал фото
   ещё три раза, каждый раз оплачивая распознавание.
5. **Заявка на публикацию переживает TTL сессии** (А-2.6). Заявка
   намеренно живёт дольше сессии, но ссылалась на файл, владелец
   которого — сессия: оператор в понедельник открывал пятничную заявку с
   битой ссылкой. Теперь у неё своя копия под `publications/<id>/`, она
   уходит вместе с заявкой при отзыве, а `videoUrl` и `videoPathname`
   наконец указывают на ОДИН файл — до этого пара противоречила сама
   себе.
6. **Аудит смотрит готовый ролик** (А-2.9). Gemini получал исходник Veo:
   другой кадр и, в режимах со своей озвучкой, другая звуковая дорожка —
   при том, что у аудита есть категория `audio`. Пока постобработка идёт,
   аудит просит подождать, а не тратит платный вызов на устаревший кадр.
7. **Обложки в библиотеке** (А-2.10). `library.save` вызывается внутри
   разбора, то есть до того, как браузер снимет кадры: обложка была
   `null` ВСЕГДА, и весь префикс `library/…` из §22 не использовался
   ничем. Сессия теперь помнит ключ своей записи, и подтверждение кадров
   их досохраняет — только кадры и обложку, вердикт оператора и
   приватность не трогая.
8. **Три вида файлов обрели владельца** (А-2.14): фото товара,
   загруженное прямо в сессию; голосовые записи описания (уборка товара
   пошла по префиксу — имена из отметки времени в базе не хранятся);
   копия ролика заявки.
9. **Параллельные правки сессии не теряются** (А-2.3). Оказалось у́же,
   чем выглядело в аудите: `updateSession` перечитывает сессию сам, а
   терялись правки только там, где вызывающий передавал ВЕСЬ прочитанный
   снимок — три места в `PromptService`. Между чтением и записью там до
   120 секунд (таймаут GPT-5), и всё, что пользователь менял на том же
   экране, откатывалось без следа. Пишутся затронутые ключи.

Проверки: **64 набора / 590 тестов** (было 64/577), eslint 0,
`prisma validate`, 18 миграций подряд на чистом Postgres 16 (15 таблиц),
frontend tsc + eslint + `vite build` + **13** unit-скриптов, `next build`
для admin и landing. Сквозной прогон в Playwright подтверждает главное:
загрузка страницы с одним лишь `sessionId` в localStorage открывает экран
готового ролика — состояние, недостижимое до этой правки.

---

## Этап 40 — остаток аудита: база, тесты, документы, вёрстка (I.4–I.7)

**Сделано (этап 40).**

Четыре последних раздела долга закрыты одним заходом. Три из них шли
параллельно — они не пересекаются по файлам.

### I.4. База (миграция 19)

Числа измерены на засеянной копии схемы, а не оценены; подробности в
`doc/DATABASE-AUDIT.md`, раздел «Обновление: этап 40».

- **Индексы `expiresAt`** на обеих таблицах входов. Уборка ходила по
  этому полю сканом — и не только по расписанию, а внутри КАЖДОГО входа,
  где удалять чаще всего нечего.
- **Составной индекс библиотеки** `(visibility, usageCount DESC,
  createdAt DESC)`: **8,99 мс → 0,25 мс, в 36 раз**, и читает 200 строк
  вместо 20 000. Таблица не чистится никогда, рост линейный.
- **Уборка сессий доходит до конца.** Прогон брал 500 строк и честно
  возвращал `hasMore`, но по этому флагу никто крон второй раз не дёргал,
  а расписание суточное: при 501+ истёкшей сессии в сутки очередь росла
  навсегда. Потолок в 20 партий и 120 секунд — крон на Vercel живёт 300,
  и лучше не доубрать остаток до завтра, чем быть убитым посередине.
- **Сняты три индекса**, под которые нет ни одного запроса. Это не
  поломка, а налог: ~5 МБ и замедление каждой вставки в журнал расходов —
  самого горячего пути записи в проекте.
- **Разведены два смысла у `ai_usage.userId IS NULL`.** Колонка означала
  и «вызов был анонимным», и «аккаунт удалили»: расход удалённого
  перетекал в ОБЩИЙ потолок анонимных и выбивал его для всех. Флаг
  ставится при вставке и больше не меняется.
- **Каскад для личного каталога.** Проекты и манифесты оставались с
  пустым владельцем — не «общие», а недостижимые ни одним запросом, с
  файлами, которых метла не подберёт. Библиотека и сессии остались на
  `SetNull` сознательно: разборы принадлежат сервису (§4 условий), а на
  ролики сессии может ссылаться заявка на публикацию.

### I.5. Тесты (+117 тестов, +6 наборов)

Закрыты все тринадцать пунктов. Ценность не в числе, а в том, что именно
закрыто: `generation.service` (единственный денежный шлюз на самый
дорогой вызов) был 0 %, крон-удаление файлов 0 %, HMAC-проверка подписи
Telegram 0 %, вход в админку 0 %, журнал расходов 10 %.

Три вещи стоит отметить отдельно:

- **`plan-gates`**: шесть недостающих возможностей из восьми. Файл в
  своей же шапке объявлял целью «поймать возможность, закрытую в таблице
  и нигде не проверенную» — и проверял две.
- **Подписи Telegram считаются в тесте через `crypto`**, а не
  подставляются константой: тест доказывает алгоритм, а не что файл не
  менялся.
- **`useAsync` на фронтенде** проверен через настоящий хук: у проекта нет
  ни DOM, ни тест-раннера во фронтенде, поэтому скрипт поднимает
  минимальный хост хука на том же шве, куда включаются настоящие
  рендереры. Мутационно проверено: удаление `if (id === run.current)`
  роняет тест.
- **Порог покрытия в CI** — пофайловый, а не общий процент по проекту:
  общий порог на директории `modules/plan` утащила бы вниз
  Nest-обвязка, недостижимая из юнит-тестов, и порог стал бы
  бессмысленным.

Настоящих дефектов тесты не вскрыли — код вёл себя ровно так, как
обещали его комментарии. Это проект с правильным кодом и неравномерно
распределёнными тестами, как и сказал аудит.

### I.6. Документы и вкладка «Настройки»

- **`PUBLISHING-AND-VOICEOVER-SPEC` §15** (150 строк про озвучку с
  несуществующими переменными и маршрутами) свёрнут в отсылку к
  реализации плюс таблицу «было в предложении → стало в реализации».
  Пять вещей, которые в предложении были и НЕ сделаны, сохранены — в
  первую очередь переозвучка без новой генерации Veo, главный
  экономический аргумент раздела.
- **Вкладка «Настройки» админки** узнала ключи этапов 31–38 и, что важнее,
  научилась ставить **жёлтый** там, где раньше было зелено: ненастроенная
  обрезка выглядела исправной, и человек искал проблему не там. Плюс
  ловит опечатку в имени ставки `AI_PRICE_*` — переменная задана и ни на
  что не влияет.
- **Спека на `env-settings`** двухуровневая: точечная (секреты не
  попадают в ответ) и общая — множество переменных, чьё значение видно
  наружу, обязано совпасть с явным allowlist'ом. Второй уровень падает и
  на утечке того, что сегодня секретом не считали.
- Числа и списки приведены к коду: 31 модуль, двенадцать точек записи
  расходов, четыре Vercel-проекта, семь вкладок админки, реальные
  маршруты публикаций в `API.md`.

### I.7. Вёрстка

- **Админка** больше не даёт горизонтальной прокрутки: было 797–949px
  при вьюпорте 320, стало `ok` на всех ширинах от 320 до 1440. Шапка
  переносится, все 11 таблиц получили собственный скроллер, у полей
  появились стили (селект смены режима был 19px против 33px у кнопки
  рядом), в CSS появился брейкпоинт — до этого их не было ни одного.
- **TMA**: тач-цели 24px → 44px в навигации, степпере и вкладках;
  заголовок карточки на 320px 126px → 246px; поле пробы голоса 134px →
  246px; ни одного элемента мельче 11px (было 27 мест по 9–10px).
- Вкладка выбора референса чинилась не сменой умолчания, а причиной:
  `Tabs` подтягивает активную вкладку в видимую часть и гасит край, за
  которым есть ещё вкладки — это работает для любого набора вкладок и
  любой ширины.

Проверки: **70 наборов / 711 тестов** (было 64/590), eslint 0 во всех
четырёх приложениях, `prisma validate`, все **19** миграций подряд на
чистом Postgres 16 (**15** таблиц), frontend tsc + eslint + `vite build` +
**14** unit-скриптов, `next build` для admin и landing. В CI появился
пофайловый порог покрытия.

**Долг по аудиту закрыт полностью.** Остались открытые вопросы владельца
и крупные направления из `doc/TODO.md` — то есть развитие, а не долг.

## Сквозной аудит после этапа 36

После этапа 36 проведён сквозной аудит по пяти направлениям — база
(индексы и внешние ключи, с реальными планами запросов на засеянном
Postgres), код против бизнес-логики ТЗ, вёрстка на адаптивность,
документация и тесты с покрытием. Результат — **`doc/AUDIT-2026-09-06.md`**;
работы выписаны в **`doc/TODO.md`** по приоритету, там же дорожная карта
продукта.

**Весь долг по аудиту закрыт на этапах 37–40** — отметки стоят в
`doc/TODO.md` и в самом аудите.

Коротко: TMA чиста по вёрстке на всех ширинах в обеих темах, права и
матрица режимов на сервере совпадают с ТЗ, внешние ключи и горячие
индексы в порядке. Найдено и требует правки: постобработка (этапы 34–36)
не доходит до пользователя, потому что фронтенд гасит опрос статуса ровно
на её старте; отчёт о расходах тянет весь журнал в память; инструкция по
деплою не называет `CRON_SECRET`, из-за чего маршрут, удаляющий файлы,
остаётся открытым; шесть из восьми проверок режима не закреплены тестами.

## Этап 41 — высокие находки повторного аудита

Девять находок повторного аудита помечены высокой серьёзностью
(`doc/AUDIT-2026-09-06-round2.md`); этап 41 закрывает их подряд, по одной
правке за раз. Остальные 55 находок остаются в `doc/TODO.md`, раздел I-Б.

**Сделано (этап 41).**

- **Б-2.1: в Veo уходит промпт, а не JSON-обёртка.**
  `PromptService.generatePrompt` клал в сессию сырой ответ модели, хотя
  с этапа 35 модель просят ответить объектом `{prompt, voiceoverScript}`
  и `parsePromptResponse` их честно достаёт — `parts.prompt` не
  использовался нигде. Пользователь редактировал JSON руками на экране
  «Промпт», а в Veo — самый дорогой вызов сервиса — уходила строка вида
  `{"prompt": "8 seconds; …"}`; в режимах со своей озвучкой реплики
  уезжали в Veo вторым экземпляром. Теперь `generatedText`, `finalText`,
  `characterCount` и модерация работают с разобранным промптом. Ответ не
  объектом остаётся сырым текстом — этот путь у `parsePromptResponse`
  был и раньше, и три новых теста закрепляют обе формы ответа.

- **Б-3.1 и Б-3.2: CSRF.** Проверка `Origin` переехала в
  `common/csrf.ts` и применяется теперь к обеим cookie, а не к одной
  админской. Пользовательская `user_session` в проде ставится с
  `SameSite=None` (API и приложение — разные домены), поэтому браузер
  прикладывал её к кросс-сайтовому form-POST, а форма уходит без
  preflight: страница злоумышленника могла принять оферту от имени
  вошедшего, завести проект, потратить деньги на пробу голоса. Проверка
  стоит там, где cookie становится личностью — в
  `TelegramIdentityMiddleware`, — и только на ней: `initData` и
  dev-заголовок браузер сам не пришлёт, а анонимный сценарий вообще
  не трогается. Заодно закрыт fail-open: незаданный `CORS_ORIGIN` в
  проде теперь означает отказ, а не выключение барьера (внешне всё
  работало, потому что у CORS есть умолчание `localhost:5173`). Вне
  прода поведение прежнее — иначе локальная работа без переменной стала
  бы невозможной. +12 тестов, включая первый набор на сам middleware
  (был ноль покрытия).

- **Б-1.1 и Б-1.2: файлы, которые больше некому было удалить.** Метла
  (`GET /api/cron/sweep-orphans`) ходит теперь по четырём префиксам, а
  не по одному: `sessions/`, `projects/`, `brand-manifests/`,
  `publications/`, у каждого своя таблица владельцев. Причина — каскад
  `users → projects/brand_manifests`, заведённый на этапе 40 ровно
  ради того, чтобы фото не оставались в хранилище: он сносит строки в
  обход сервисов с их уборкой блобов, и после него путей взять
  неоткуда вообще (при прежнем `SET NULL` осиротевшую строку можно
  было хотя бы найти запросом). Вторая причина — копия ролика заявки,
  которая удалялась только при отзыве PENDING: теперь её уносит и отказ
  оператора (сама заявка остаётся — автор должен видеть причину), а
  всё, что осталось от удалённых заявок, подбирает метла. Префикс
  `library/` в метлу сознательно не включён: его каталог — `sourceKey`
  с заменённым двоеточием, обратное преобразование неоднозначно, и
  ошибка означала бы удаление обложек у живых записей. Ответ маршрута
  получил разбивку `byScope` — по ней видно, ГДЕ течёт. +11 тестов.

- **Б-2.2: `librarySourceKey` переживает запись сессии.** Поле завели на
  этапе 39, писали в двух местах `AnalysisService` и читали в
  `AnalysisPreviewsService`, но в список `DATA_KEYS` не добавили — а
  `toData` собирает JSON строго по нему, то есть ключ стирался при
  КАЖДОЙ записи. Читалось поэтому всегда `undefined`, `refreshPreviews`
  не вызывался никогда, обложек в библиотеке не бывало вовсе, и весь
  префикс `library/…` из §22 оставался мёртвым — ровно тот дефект,
  который этап 39 и закрывал (А-2.10). Прежний тест этого не ловил,
  потому что подставлял поле прямо в фейковую сессию; теперь есть три
  проверки на круговорот через `updateSession` → `getSession`.

- **Б-4.1 и Б-4.2: админка.** Карточка деталей пользователя с длинным
  именем (в Telegram оно бывает до 64 символов без единого пробела)
  растягивала документ до 1597px, и кнопка «Закрыть» уезжала за экран —
  закрыть карточку без горизонтальной прокрутки было нельзя. Причина —
  flex-строка без `min-width: 0`; та же причина растягивала первую
  колонку таблицы с 940 до 1568px. Измерено после правки: документ
  равен вьюпорту на 320/390/768/1024, таблица — 822px внутри своего
  скроллера, кнопка «Закрыть» на x=283 при ширине окна 390. Заодно
  определён класс `.critical`: он использовался в девяти местах
  (причина блокировки, ошибка загрузки, перерасход суточного лимита) и
  правила не имел вовсе — тревога показывалась обычным белым текстом,
  тише соседней приглушённой нормы.

- **Б-1.3: рекомендации библиотеки перестали ходить сканом.** Составной
  индекс `(visibility, usageCount DESC, createdAt DESC)`, заведённый на
  этапе 40, обслуживал только запрос по ОДНОЙ видимости — то есть ветку
  анонимного зрителя, которая недостижима (библиотека доступна только
  Premium, а Premium — это вошедший). Живая ветка шла с `OR` и полным
  сканом. Условие разбито на два запроса, каждый со своим `take`,
  слияние — в коде; строка не может быть одновременно публичной и
  приватной, так что набор тот же. Измерено на 60 тыс. записей:
  **27–28 мс → 0,29 + 0,25 мс** (≈50×), причём время у `OR` росло бы
  линейно — таблица не чистится никогда. Дополнительный индекс под `OR`
  не помогает, проверено: мешает форма условия, а не отсутствие индекса.

**Итог этапа 41: 743 теста / 71 набор** (было 711/70), eslint 0, tsc
чист, `next build` админки зелёный. Все девять высоких находок закрыты;
остальные 55 остаются в `doc/TODO.md`, раздел I-Б.

## Этап 42 — средние находки повторного аудита

Шесть пунктов раздела I-Б.2: третья дверь, файлы товаров при удалении
проекта, три сценария «платит и не получает» и четыре внешних ключа без
индексов (двадцатая миграция).

**Сделано (этап 42).**

- **Б-3.4: чужой `sessionId` больше не ключ к чужому бюджету.** Модель
  «UUID сессии — предъявитель» (§7.8) законна для анонимного сценария и
  остаётся, но по этому же идентификатору доставались вещи, к сессии не
  относящиеся: вся сессия целиком с внутренним `userId` владельца,
  приватные записи его библиотеки, платные вызовы за счёт его дневного
  бюджета (у Premium до $30) и сброс кастинга чужой сессии вместе с
  presigned PUT в её префикс. Правило одно и живёт в одном месте —
  `SessionOwnerGuard`: **если у сессии есть владелец, запрос обязан
  прийти от него**. Гвард глобальный (маршрутов с `:sessionId`
  тринадцать в одиннадцати контроллерах — правило, размазанное по ним,
  разъедется на первом же новом) и ничего не делает, когда `sessionId` в
  запросе нет: ни одного лишнего запроса в базу на остальных маршрутах.
  Анонимная сессия работает как раньше, несуществующая отдаёт свой 404.
  +9 тестов.
- **Б-2.8: удаление проекта метёт префиксы товаров.** `deleteItem` с
  этапа 39 сметает `projects/<p>/items/<i>/` целиком — именно потому,
  что имена голосовых записей это отметки времени и в базе их нет. У
  `deleteProject` эта правка не появилась: он собирал только `photoUrl`,
  и загруженное, но не обработанное фото и нерасшифрованная запись
  переживали проект навсегда. Теперь оба пути ходят одной дорогой, а
  `deletePhotos` (уборка по списку) удалён: два способа делать одно и то
  же по-разному и есть та трещина, в которую утекли записи.
- **Б-2.3: повтор запроса не оплачивает второй рендер.**
  `generateVideo` не смотрел на `session.generatedVideo` вообще; сборка
  референсов и старт Veo не всегда укладываются в клиентский таймаут
  (120 с), и второй POST начинал вторую операцию, писал вторую строку
  расхода и затирал `generatedVideo` — первый, уже оплаченный рендер
  осиротевал вместе со своим `veoOperationName`. Идущая операция
  возвращается как есть, а не отдаётся 409: для пользователя это ровно
  то, чего он ждал, — экран продолжает опрашивать статус. Готовый и
  упавший рендер повтору не мешают: «сгенерировать ещё раз» — обычный
  сценарий. +2 теста.
- **Б-2.5: сбой рендера больше не отправляет на шаг 1.** `markFailed`
  ставит сессии тот же `status: 'error'`, что и сбой разбора, а ветка
  `'error'` вела к выбору референса (она писалась под А-2.8).
  Пользователь оказывался на первом шаге, хотя разбор и утверждённый
  промпт живы, — и новый референс их сбрасывал, запуская новый платный
  разбор. Упавший рендер теперь возвращает свой шаг, как и идущий.
- **Б-2.7: отказ постобработки виден всегда.** Отказ по дневному лимиту
  или блокировке приходит в `postError`, но при родном формате кадра его
  не показывала ни одна ветка: сообщения про обрезку молчат, а
  `voiceStatus` в этом случае не выставляется вовсе — строка «Озвучка:»
  оставалась пустой. Человек видел ролик со звуком модели и ни слова о
  причине. Добавлены обе недостающие подписи.
- **Б-1.4: четыре внешних ключа `SET NULL` без индексов** — миграция 20
  `20260908120000_fk_indexes`. Измерено на засеянной копии (60 тыс.
  заявок): FK-триггеры заявок при удалении проекта с тремя товарами —
  **1491,8 + 80,0 мс → 0,97 + 0,39 мс**, всё удаление проекта теперь
  2,9 мс. Цена — 3,6 МБ на таблицах, в которые пишут редко.

**Итог этапа 42: 755 тестов / 72 набора**, eslint 0, tsc чист, все **20**
миграций подряд на чистом Postgres 16 (15 таблиц, 53 индекса),
`prisma validate` проходит, фронтенд tsc + eslint + build + 14 скриптов
зелёные.

## Этап 43 — тесты на непокрытые ветки и документы, которые врали

Раздел I-Б.3: **Б-5.12–Б-5.20** (тесты) и **Б-5.1–Б-5.11** (документы),
плюс два кода-исправления, без которых документы остались бы неправдой.

**Сделано (этап 43).**

- **Тесты: +140, восемь новых наборов** (755 → 895 тестов, 72 → 81
  набор). Закрыты ветки, чьё удаление раньше не роняло ни одного теста:
  весь `analysis.service` (0 %, включая три пути удаления транзитной
  копии референса), переход PROCESSING → COMPLETE в
  `generation.service` (разбор ответа операции, оба `markFailed`,
  скачивание у Google, заливка в Blob, передача в постобработку),
  `ffmpeg-api.service` с его `withRetry` и `Idempotency-Key` (единственная
  защита от тройной оплаты флапающего запроса), весь вход в админку
  (`admin-auth.service`, `AdminSessionGuard` с проверкой `expiresAt`,
  HMAC Login Widget) и `telegram-login` целиком — третий, независимый
  механизм личности, у которого не исполнялась ни одна строка.
- **Б-5.9: удаление сессии оператором уносит и её файлы.** Единственный
  путь в проекте, нарушавший правило §22 «удаление владельца обязано
  удалить файл»: строку сносил, а ролик, обрезанную версию и дорожку
  оставлял. Порядок тот же, что у суточной уборки; сбой хранилища не
  отменяет удаление, остаток подберёт метла. +5 тестов.
- **Б-5.4: `GEMINI_MODEL` стала правдой.** Переменную читали два вызова
  из пяти, а разбор видео, релевантность и аудит держали модель зашитой
  строкой — при этом вкладка «Настройки» подписывала её как «модель для
  анализа видео» и показывала зелёное. Оператор, поставивший
  `gemini-2.5-pro`, был уверен, что платит за pro на самом дорогом из
  этих вызовов, а платил за flash. Источник теперь один —
  `common/gemini-model.ts`, подпись в админке говорит про все пять
  вызовов и про `unpriced` для модели вне прайса.
- **Б-3.9 и Б-5.7: у dev-обхода личности два предохранителя.** Раньше в
  TMA проверялся только `ALLOW_DEV_AUTH`, тогда как у админского
  dev-входа условий было два, — а `doc/DEPLOYMENT.md` успокаивал, что
  «двойной предохранитель и так закрывает». Теперь это правда: обход
  идёт через тот же `isDevAuthAllowed`.
- **Документы перестали врать** (Б-5.1, Б-5.2, Б-5.3, Б-5.5, Б-5.6,
  Б-5.8, Б-5.10): чеклист приёмки больше не числит несуществующие
  Playwright-проверки среди сделанных автоматически (их нет в
  репозитории вовсе — приёмщик, поверив, пропустил бы вёрстку целиком) и
  не требует недостижимого «всё зелено» во вкладке «Настройки»; README и
  `doc/CI.md` знают настоящие числа и **добавлены в `check-docs.mjs`**,
  чтобы разъехаться заново уже не могли; `LOCAL-DEVELOPMENT` получил семь
  переменных, которые бэкенд читает, а документ не знал; `VITE_ENV`
  убран отовсюду — его не читает ни одна строка фронтенда; описание
  уборки сессий приведено к тому, что делает код с этапа 40.

**Итог этапа 43: 895 тестов / 81 набор**, eslint 0, tsc чист,
`check-docs` (теперь и по README с CI.md) и `sync-legal` зелёные.

## Этап 44 — раздел «Копится»: то, что дорожает со временем

Последний открытый раздел долга повторного аудита (I-Б.4): расходный
журнал, два индекса, гонки в суточных лимитах, вёрстка помельче и
зависимости.

**Сделано (этап 44).**

- **Б-1.7: отчёт «Расходы» перестал сканировать журнал целиком.**
  Тринадцать агрегатов по таблице, которая не чистится никогда — 1,19 с
  на 800 тыс. строк, и время растёт линейно. Две правки: топ-10 теперь
  сортирует и режет БАЗА (`orderBy` + `take`; раньше в Node ехали все
  3 750 пользователей с расходом ради десяти строк на экране), а сам
  отчёт кешируется на минуту — оператор обновляет вкладку подряд, а
  цифры за минуту не меняются настолько, чтобы это меняло решения.
  Числа «сколько всего платящих» и «сколько потратили» считаются двумя
  агрегатами вместо полной выборки. +3 теста.
- **Б-1.5 и Б-1.6: два индекса сняты** — миграция 21
  `20260908160000_drop_unused_indexes`. `ai_usage(anonymous, createdAt)`
  планировщик не брал (24–30 мс по `createdAt` против 10,6 мс
  принудительно) при 43 МБ размера и налоге на каждую вставку;
  правильный ответ — частичный индекс `WHERE anonymous` (5,0 мс, 4,4 МБ)
  — не выражается в `schema.prisma`, а CI сверяет базу со схемой, и
  исключение в этой проверке дороже выигрыша. Честнее снять
  неработающий индекс, чем держать его ради вида. Второй,
  `analysis_library_visibility_idx`, — левый префикс составного из
  миграции 19. **21 миграция, 15 таблиц, 51 индекс** на чистом Postgres.
- **Б-1.9: суточные лимиты SerpApi и YouTube заняли слот атомарно.**
  Было check-then-act: читаем счётчик → платный вызов (секунды) →
  увеличиваем. Двадцать фото, загруженных разом, давали двадцать
  оплаченных поисков при остатке в один; у YouTube хуже — квота Google
  общая на весь деплой, и перебор одного человека выключал поиск всем.
  Теперь один запрос `INSERT … ON CONFLICT DO UPDATE … WHERE count <
  limit` (проверено на живом Postgres: третья попытка при лимите 2
  меняет ноль строк), слот занимается ДО вызова и возвращается, если
  счёта не было — кеш, отказ провайдера, транспортная ошибка.
- **Б-1.8: рекомендации библиотеки не тянут колонку `analysis`** —
  13 КБ JSON на запись × 200 кандидатов = 2,7 МБ, которые ехали по сети
  и парсились в Node, чтобы не быть прочитанными ни разу.
- **Б-1.10: комментарии перестали обещать больше, чем делает код.**
  `updateSession` по-прежнему переписывает колонку `data` целиком —
  правка этапа 39 сжала окно потери правки со 120 секунд до
  миллисекунд, но гонку не закрыла. Теперь это написано и в
  `session.service`, и в вызывающем `PromptService`.
- **Б-4.3–Б-4.13: вёрстка.** Лендинг: бургер (38×32) и главный CTA
  (37px) доведены до 44px, туда же — «← На главную» на странице оферты,
  ссылки между документами, «Открыть на YouTube», логотип, «FAQ» и
  «GitHub». Админка: кнопки, поля и селекты 33–35 → 44px, чекбоксы
  фильтров 13 → 20px с подписью-целью, ссылки в строках таблиц
  (16×75 и 48×30) растянуты на ячейку, `vertical-align: top` убрал
  ~150px пустоты на «Настройках». TMA: `Button` размера `md` был 36px
  (через него идут «Скачать», «Создать проект», «Прослушать»), ссылки
  подвала — 45×16.5, иконочные кнопки — до 16×16. Замерено после
  правок: **ни одной цели меньше 44×44** на лендинге, странице оферты,
  входе в админку, всех восьми страницах админки и на главных экранах
  TMA.
- **Б-4.6 и Б-4.7: контраст.** `silver-500` был константой для обеих
  тем (3.32–4.27 при норме 4.5) — теперь переменный, как `silver-400`:
  **5.06** в светлой, **4.58** в тёмной. Акцент в светлой теме
  потемнел до sky-700: белые чернила на заливке — **5.93** (было 4.1),
  сам акцент как текст — **5.58**.
- **Б-5.20: правило вместо обещания.** Половина пункта висела с этапа
  40: `try/catch`-проверку тогда переписали руками, но правила не
  завели. Включён `jest/no-conditional-expect` (плюс
  `no-identical-title` и `valid-expect`) — он ловит именно `expect`
  внутри `catch`/`if`, то есть тест, который останется зелёным, ничего
  не проверив. Одно живое нарушение нашлось сразу — в
  `dto-validation.spec` — и переписано.
- **Б-3.10: зависимости.** `npm audit fix` прогнан во всех четырёх
  приложениях: фронтенд чист. Оставшееся требует мажорных обновлений
  (`@nestjs/core`, `express`/`body-parser` в бэкенде; `next@14 → 15` в
  админке и лендинге) — это отдельная работа со своим прогоном, а не
  строчка в этапе; записано в `doc/TODO.md` с оценкой риска.

**Итог этапа 44: 898 тестов / 81 набор**, eslint 0 (с новыми
jest-правилами), tsc чист, 21 миграция подряд на чистом Postgres 16.

## Этап 45 — два служебных канала Telegram (ТЗ §28, TODO II.1)

Первый пункт раздела II TODO — и самый дешёвый из оставшихся: он
окупается до появления первого платящего, потому что до него о сбое
узнавали от пользователя.

**Сделано (этап 45).**

- **Канал ошибок и канал статистики.** Новый модуль `modules/notify`:
  `TelegramNotifyService` плюс две чистые функции — дедупликация
  (`alert-dedup.ts`) и фильтр секретов (`redact.ts`). Первая тревога
  уходит сразу, повторы копятся десять минут и складываются в одну
  сводку; сообщения идут очередью с паузой (Telegram отвечает 429 на
  всплеск); ни один метод не бросает — служебная функция не имеет права
  ломать продукт.
- **Что уже подключено.** Провал рендера Veo (`markFailed`) шлёт тревогу
  с отпечатком `veo:<код>` — провайдер падает сразу для всех, и три
  сотни одинаковых строк в канале равны нулю строк. Суточный отчёт —
  новый маршрут `GET /api/cron/report` (06:00 UTC, третий крон в
  `vercel.json`): числа берутся из уже существующих
  `admin-panel/telemetry` и отчёта расходов, по понедельникам
  добавляется недельная часть.
- **Секреты в канал не попадают.** Фильтр режет `Bearer`-токены, ключи
  по префиксам провайдеров (`sk-…`, `vercel_blob_rw_…`), подписи в
  ссылках и адреса почты, а длинный текст обрезает с пометкой. Канал
  читают в Telegram — пересланное сообщение или скриншот делают
  попавший туда секрет утёкшим.
- **Настройка — двумя переменными** (`TELEGRAM_ALERTS_CHAT_ID`,
  `TELEGRAM_STATS_CHAT_ID`): идентификаторы чатов, а не список
  операторов в базе — добавление человека делается правами внутри
  Telegram и не требует деплоя. Вкладка «Настройки» показывает оба
  канала и отдельно случай «чат задан, а токена бота нет».
- +21 тест (дедупликация, фильтр, поведение без настроек, отказ
  Telegram, содержимое отчёта).

**Итог этапа 45: 919 тестов / 82 набора**, eslint 0, tsc чист.

## Повторный сквозной аудит после этапа 40

После закрытия всего долга первого аудита проведён второй заход по тем же
направлениям плюс выделенная безопасность — **`doc/AUDIT-2026-09-06-round2.md`**,
**64 находки**, из них 9 высоких (в первой сводке было названо семь —
пересчёт по пометкам серьёзности даёт девять). Работы выписаны в `doc/TODO.md`,
раздел I-Б, по цене ошибки. Ничего не чинилось: документ — диагноз.

Главное, чему научил второй заход: **правка без теста на сквозной эффект
— это заявка о намерениях**. Две высокие находки из семи — не новые
дефекты, а правки этапов 39 и 40, которые стоят на месте и не работают:
`librarySourceKey` не входит в `DATA_KEYS`, поэтому обложек в библиотеке
как не было, так и нет; каскад `users → projects` уносит строки и
оставляет файлы — причём теперь их нельзя даже найти. Третья высокая —
регресс этапа 35: с тех пор как ответ GPT-5 стал JSON-объектом, в Veo
уходит вся обёртка целиком, а разобранный `parts.prompt` не используется
нигде.

Что при этом проверено и держится: правки этапов 37–40 физически на месте
(индексы, флаг `anonymous`, циклическая уборка, консультативная блокировка
заявок), схема и 19 миграций совпадают колонка в колонку, SSRF закрыт
двумя слоями, весь raw SQL параметризован, горизонтальной прокрутки нет
ни на одной из девяти ширин в трёх приложениях (286 замеров), 711 тестов
зелёные, покрытие выросло с 57,7 % до 66,2 %.

## Итоговая сверка (обновлена после этапа 80 — лента, лайки и репосты;
маршруты/контроллеры/миграции/таблицы пересчитаны заново на этапе 82 —
ИИ-консультант; счётчик тестов ниже по строке — всё ещё после этапа 80,
см. оговорку в самой строке)

- Backend: **214 маршрутов в 44 контроллерах** (число пересчитано
  заново `scripts/check-docs.mjs` при этапе 82 — предыдущая строка
  «189/39» держалась с этапа 80 и не учитывала прирост стадий 78б/79/81
  между тем сквозным подсчётом и этим; этап 82 (ИИ-консультант, §"Сделано
  (этап 82…)" выше) сам добавил ровно 2 контроллера
  (`AssistantController`, `AssistantAdminController`) и 6 маршрутов
  (`GET/POST /assistant/config,chat,event`, `GET/PATCH /admin/settings/assistant`,
  `GET /admin/assistant`); остаток разницы с «189/39» — из стадий,
  прошедших без обновления именно этой сводной строки, а не из этого
  этапа), eslint 0 ошибок по всем файлам, изменённым этапом
  (`--max-warnings 0`), `prisma validate` пройден локально (схема
  валидна); все **49** миграции подряд на чистом Postgres 16
  (**42** таблиц — этап 82 добавил ровно одну новую таблицу,
  `assistant_events`, и ровно одну миграцию,
  `20261027090100_assistant_event`, применённую и подтверждённую на
  локальном Postgres 16 этой же песочницы — `docker` здесь недоступен
  («no such file or directory» у демона), но нашёлся отдельно
  установленный кластер `postgresql-16` (`pg_lsclusters`, выключен по
  умолчанию — `sudo pg_ctlcluster 16 main start`), тем же способом, что
  описан в `doc/TELEGRAM-ADMIN.md` §5).
  **2067 теста / 146 наборов** (2051/145 после аудита кода трёх
  последних ТЗ + 16 тестов этапа 80 — см. новый абзац прироста ниже;
  этап 82 добавил свои тесты — минимум 56 в четырёх новых спек-файлах,
  реально исполненных в этой песочнице, плюс написанные-но-не-
  исполненные здесь `assistant.service.spec.ts`/`assistant.controller.spec.ts`/
  расширение `rate-limit.spec.ts` — но это число сюда намеренно НЕ
  прибавлено: без полного прогона `jest --json` по всей песочнице
  нельзя быть уверенным, что где-то по пути не изменился и общий счёт
  прочих наборов, а раздельный «56 зелёных» уже зафиксирован в
  собственном разделе этапа 82 выше)
  — число получено так же, как на всех
  прошлых этапах в этой песочнице: `npx prisma generate` по-прежнему
  заблокирован политикой прокси (403 на `binaries.prisma.sh`, не
  временная сеть), поэтому реальный прогон jest в песочнице видит
  меньше суток из-за той же цепочки нерешаемого импорта
  `@prisma/client` — актуальная база (2001/143 после этапа 77,
  подтверждённая прошлым прогоном) увеличена на подсчитанный прирост
  этапа 78 (43 новых теста в существующих спек-файлах + 1 новый
  спек-файл `common/workflow-funnel-cohort.spec.ts`, 5 тестов), а не
  пересчитана заново вручную по всем файлам — тот же приём, что и на
  предыдущих этапах, когда прямой прогон в песочнице недостоверен.
  Прогон вскрыл **17 падающих тестов и 5 наборов с провалами, не
  связанных с этапом 78** (`plan.controller.spec.ts`,
  `project.service.spec.ts`, `billing.service.spec.ts`,
  `analysis.service.spec.ts`, `marketing-consent.service.spec.ts`);
  два из них тут же исправлены отдельным внеплановым фиксом сразу после
  этапа 78 (см. ниже, «Внеплановый фикс (после этапа 78)») —
  `project.service.spec.ts` и `marketing-consent.service.spec.ts`
  проверяли устаревшее/неверное поведение теста, а не находили
  реальный баг продукта. Текущий долг сузился до **15 падающих тестов
  и 3 наборов** (`plan.controller.spec.ts`, `billing.service.spec.ts`,
  `analysis.service.spec.ts` — тот же долг предыдущих этапов, что
  зафиксирован после этапа 68/69/70/71/72б/73/74/75/76/77, этим
  фиксом не тронут). Ни один из файлов, изменённых на этапе 78, в
  оставшемся списке не появляется.

  Прирост с этапа 80 (2067/146) — 16 новых тестов сверх «Аудита кода
  трёх последних ТЗ» (2051/145, см. ниже): 11 новых тестов в
  существующем `shared-video.service.spec.ts` (4 новых `describe`-блока —
  `create — этап 80, блокировка`, `.listFeed`, `.like/unlike`,
  `.recordShare` — всего теперь 29 тестов в файле) плюс 5 тестов в
  новом файле `shared-video.controller.spec.ts` (единственный новый
  спек-файл этапа, отсюда 145→146 наборов) — `PublicSharedVideoController.feed`
  (3), `.share` (1), `SharedVideoLikeController` (1, покрывает и
  лайк, и снятие лайка одним сценарием).

  Прирост с этапа 78 (2044/144) до «Аудита кода трёх последних ТЗ»
  (2051/145, см. подробности ниже, раздел «Аудит кода трёх последних
  ТЗ») — 7 новых тестов в одном новом файле,
  `admin-panel.controller.spec.ts` (144→145 наборов); этап 79
  (визуальная «обучалка») между ними прошёл без изменений в backend-
  тестах — только фронтенд/словари/`check-docs.mjs`.

  Прирост с этапа 77 (2001/143) до
  этапа 78 (2044/144) — 43 новых теста в существующих спек-файлах
  (`catalog-batch-worker.service.spec.ts` — 9,
  `ab-test-worker.service.spec.ts` — 9,
  `catalog-batch.service.spec.ts` — 5, `ab-test.service.spec.ts` — 1,
  `admin-panel.service.spec.ts` — 9, `session.service.spec.ts` — 5)
  плюс 5 тестов в новом файле `common/workflow-funnel-cohort.spec.ts`
  (единственный новый спек-файл этапа, отсюда 143→144 наборов).

  Прирост с этапа 76 (1968/143) до этапа 77 (2001/143) — 33
  новых теста, все в существующих спек-файлах (новых файлов не
  заводилось — расширены `billing-renewal-worker.service.spec.ts`,
  `blob-paths.spec.ts`, `postprod.service.spec.ts`,
  `catalog-batch.service.spec.ts`, `ab-test.service.spec.ts`,
  `actors.service.spec.ts`, `generation.service.spec.ts`,
  `catalog-batch-worker.service.spec.ts`/`ab-test-worker.service.spec.ts`,
  `admin-users.service.spec.ts`, `user-voices.service.spec.ts`).

  Прирост с этапа 75 (1930/143) до этапа 76 (1968/143) — 38
  новых тестов, все в существующих спек-файлах (новых файлов не
  заводилось — расширены `stars-subscription-reconcile.service.spec.ts`,
  `catalog-batch-worker.service.spec.ts`/`ab-test-worker.service.spec.ts`,
  `generation.service.spec.ts`, `session.service.spec.ts`,
  `postprod.service.spec.ts`, `export.service.spec.ts`,
  `cron-jobs.service.spec.ts`/`cron.controller.spec.ts`/`admin-cron.service.spec.ts`,
  `brand-manifest.service.spec.ts`/`project-session.service.spec.ts`,
  `orphan-sweep.spec.ts`).

  Прирост с этапа 74 (1873/142) до этапа 75 (1930/143) — 57
  новых тестов, все в существующих спек-файлах (новых файлов один —
  `modules/export/export.service.spec.ts`, 25 тестов на `ExportService`
  целиком: резолв пресетов в форматы, оборачивание `PostProdError` в
  `BadRequestException`, оба пути создания дочерней сессии яруса B
  (проектная — полный seed; обычная — `createSession` без seed +
  отдельный `updateSession` для `productInformation`/
  `brandManifestSnapshot`), `syncStatus` для обоих ярусов); плюс новые
  тесты в `common/aspect-ratio.spec.ts` (6 — `aspectRatioFamily`,
  `presetByKey`/`PLATFORM_EXPORT_PRESETS`), `common/reframe.spec.ts`
  (5 — `planBatchReframe`: батч, пустой список, родной формат и
  дубликаты молча пропускаются), `modules/postprod/postprod.service.spec.ts`
  (15 — `startExport`/`pollExport`: гейт-проверки, отказ на чужом
  семействе кадра, один batched-submit с одной записью расходов,
  опрос — успех/провал/частичный ответ/сеть недоступна),
  `modules/publication/publication.service.spec.ts` (5 —
  `snapshotFromSession` предпочитает готовый `exportVariant` нужного
  семейства, откатывается на прежнее поведение, если такого нет),
  `common/blob-paths.spec.ts` (1 — файлы яруса A входят в
  `sessionBlobPathnames`, файл дочерней сессии яруса B — нет, чужой
  префикс) — точный итог подтверждён самим прогоном, а не подсчитан по
  тексту файлов.

  Прирост с этапа 73 (1817/141) до этапа 74 (1873/142) — 56
  новых тестов: новый спек-файл `common/cron-job-lock.spec.ts` (7 —
  прямые тесты `tryAcquireJobLock`/`releaseJobLock`), плюс новые тесты в
  `common/external-url-guard.spec.ts` (6 — потоковое ограничение
  размера тела, Д-3.2), `modules/catalog-batch/catalog-batch.service.spec.ts`
  (Д-1.2/Д-1.3/Д-2.2 — исключение DONE из busy-check, retry-эндпоинт,
  Serializable-транзакция с повтором при P2034),
  `modules/catalog-batch/catalog-batch-worker.service.spec.ts` (Д-2.5 —
  резюмируемость по состоянию сессии; Д-3.3 — джоб-уровневый замок),
  `modules/ab-test/ab-test-worker.service.spec.ts` (тот же Д-2.5/Д-3.3),
  `modules/product-feed-import/product-feed-import-worker.service.spec.ts`
  (Д-2.1 — productItemId фиксируется сразу; Д-2.4 — видимая причина
  провала прикрепления категории/фото; Д-3.2 — потоковый лимит без
  Content-Length; Д-3.3 — джоб-уровневый замок),
  `modules/cron/cron-jobs.service.spec.ts` (Д-2.3 — частичные счётчики
  в сообщении ошибки метлы), `modules/admin-panel/env-settings.spec.ts`
  (Д-3.4 — семь новых переменных в списке видимых значений) — точный
  итог подтверждён самим прогоном, а не подсчитан по тексту файлов.

  Прирост с этапа 72б
  (1747/137) до этапа 73 (1817/141) — 70 новых тестов в четырёх новых
  спек-файлах (`common/sound-check.spec.ts`,
  `modules/user-voices/user-voices.service.spec.ts`,
  `modules/user-voices/user-voices.controller.spec.ts`,
  `modules/user-voices/resemble-webhook-secret.spec.ts`), плюс новые
  тесты в `actors.controller.spec.ts` (саундчек аватара),
  `resemble.service.spec.ts` (`cloneVoice`/`getVoiceStatus`/
  `deleteVoice`), `tts.controller.spec.ts` (клонированные голоса не
  попадают в общий каталог — межпользовательская утечка, найденная и
  закрытая в процессе этой же стадии, не до неё), `plans.spec.ts`,
  `env-settings.spec.ts` — точный итог подтверждён самим прогоном, а не
  подсчитан по тексту файлов.

  Прирост с этапа 71
  (1682/134) до этапа 72 (1726/137) — 42 новых теста в трёх новых
  спек-файлах модуля `actors` (`hedra-client.service.spec.ts`,
  `actors.service.spec.ts`, `actors.controller.spec.ts`), плюс по
  одному новому тесту в `plans.spec.ts` и `ai-pricing.spec.ts`. Прирост
  с этапа 72 (1726/137) до этапа 72а (1745/137) — 21 новый тест в тех
  же трёх спек-файлах (без новых файлов, суммарное число наборов не
  выросло): чекбокс субтитров при запуске, обе фазы прожига в
  `getAvatarVideoStatus`, гонка замка `avatar-subtitle-burn` (в т.ч.
  проверка, что при проигранной гонке ffmpeg НЕ вызывается повторно),
  прямые тесты `avatarRenderExpired`/`avatarSubtitleExpired`. Прирост с
  этапа 72а (1745/137) до этапа 72б (1747/137) — 2 новых теста в том же
  `actors.service.spec.ts` (без новых файлов): прямая проверка обеих
  исправленных гонок Д-1/Д-2 через `mockImplementationOnce` на
  `sessions.getSession`.
  Прирост с этапа 68 (1567/131) — два новых файла:
  `modules/cron/cron-jobs.service.spec.ts` (новый, 17 — перенос
  существующих тестов `CronController` на новые имена методов, плюс
  поправка на пятую область метлы `shared-videos`, добавленную позже
  исходного теста), `modules/cron/admin-cron.service.spec.ts` (новый,
  11 — неизвестный jobKey, debug раскрывает/не раскрывает debugLog,
  `sweep-orphans` с `dryRun=debugMode` без cursor, FAILED-ветка, история);
  `modules/cron/cron.controller.spec.ts` переписан (был 24 теста —
  секрет-guard вперемешку с бизнес-логикой; стал 15 — только
  секрет-guard и делегирование, бизнес-логика уехала в
  `cron-jobs.service.spec.ts`) — точный итог подтверждён самим прогоном,
  а не подсчитан по тексту файлов.
  Frontend: tsc, eslint 0, vite build, **15** unit-скриптов
  (+ `i18n.test.ts`, этап 55). Admin и landing: tsc + `next lint` +
  `next build` — landing собирает пять локалей
  (`/ru`, `/uk`, `/en`, `/de`, `/es`) статически, включая блог
  (`/[locale]/blog`, `/[locale]/blog/[slug]`, `sitemap.xml`,
  `sitemap-news.xml`, `robots.txt`, `feed.xml`, `feed/[category]` —
  этап 58), плюс серверный по требованию `/video/[id]` (без `[locale]`
  — этап 60); admin — вкладки `/blog`, `/shared-videos`, `/payments`
  (этап 62) и `/marketing` (этап 63), расширенная `/users` (баланс
  кредитов, подписка); TMA — верхнеуровневые экраны `/channels`
  (этап 61), `/pricing` и `/credits` (этап 62); карточка согласия на
  рассылку на существующем экране `/plan` (этап 63, без нового
  верхнеуровневого маршрута).
- Этап 55 сделал `landing/` полностью мультиязычным (пять языков) и
  заложил ту же инфраструктуру во `frontend/` (TMA) — словари, роутинг
  по локали, переключатель, начальная локаль из явного выбора или
  `language_code` Telegram. Этап 56 закрыл хвост — перевёл оставшиеся
  45 файлов `components/*`/`features/*` TMA (37 новых namespace'ов,
  47 верхнеуровневых ключей во всех пяти словарях), включая числовые
  формы через `Intl.PluralRules` и цену через `Intl.NumberFormat(locale)`
  (ТЗ §37) — `frontend/` мультиязычен полностью, наравне с `landing/`.
  Этап 57 перенёс backend блога/новостей проекта "solar shop" —
  `BlogPost`/`BlogPostTranslation`, генератор черновиков из
  YouTube-трендов + Gemini, очередь перевода через Batch API xAI Grok,
  модерация, публичный API (см. раздел «Этап 57» выше). Этап 58 закрыл
  фронтенд той же работы — витрину блога на `landing/` (SSG +
  ревалидация, честная пометка непереведённых записей), вкладку
  модерации `/blog` в `admin/`, и продвижение (`sitemap.xml`,
  `sitemap-news.xml`, `robots.txt`, RSS по TODO §II.4, JSON-LD
  `NewsArticle`/`BreadcrumbList`, Open Graph/Twitter Card — см. раздел
  «Этап 58» выше, ТЗ §38); `backend/` этот этап не менял. Локализация
  ИИ-вывода продукта — этап 59 (ТЗ §35.5/§39, см. раздел «Этап 59» ниже).
- Этап 29 добавил режимы сервиса (§23), понятную диагностику сбоя базы
  (§24), метлу в суточное расписание (§22.3–22.4), исправил системный
  дефект светлой темы (акцент и вторичный текст были нечитаемы на белом)
  и переписал лендинг под текущий продукт. Этап 30 дал режимам и правам
  оператора рабочую поверхность в админке (§25) — до него и то и другое
  правилось только через `psql`. Этап 31 добавил блокировку (§25.3) и
  учёт расходов на ИИ (§26): до него сервис не знал, во что обходится
  каждый пользователь. Этап 32 ограничил этот расход суточными потолками
  (§26.4) — до него генерация не была ограничена ничем. Этап 33 завёл
  CI: те же проверки, но без участия человека, плюс `migrate diff`,
  который наконец сверяет написанные руками миграции со схемой. Этап 34
  закрыл §16.1: обрезка кадра до неродных для Veo форматов больше не
  обещание, а работающая операция. Этап 35 закрыл §15 и висевший с этапа
  19 вопрос 13.1: у бренда может быть свой голос, а обрезка и озвучка
  идут одной задачей ffmpeg — не двумя. Этап 36 добрал его долги: проба
  голоса до генерации, сдвиг дорожки к первой реплике и сравнение «до и
  после» прямо в плеере. Этап 37 закрыл первый раздел долга по аудиту —
  постобработка доходит до пользователя, оплачивается один раз, а
  стёртый текст озвучки означает то, что написано в подсказке. Этап 38
  закрыл второй: маршрут, удаляющий файлы, назван в инструкции; сервер
  скачивает картинки только со своих адресов; постобработка проходит
  проверку бюджета; заявка на публикацию не двоится; согласие с офертой
  проверяется не только интерфейсом. Этап 39 закрыл третий: мастер
  продолжает с того места, где остановились, из сбоев есть выход, а
  файлы, которые некому было убрать, обрели владельца. Этап 40 закрыл
  остаток — базу, тесты, документы и вёрстку админки, — и вместе с ним
  весь долг по аудиту.
- Этап 28 прошёл сквозную сверку кода и документов после этапов 22–27 и
  починил найденное: несуществовавший `GET /api/health` (был обещан в
  четырёх документах и в чеклисте приёмки), стейл-подпись про выгрузку в
  канал, лендинг и README, описывавшие продукт до этапа 10, неполный
  список модулей, расхождения в числах миграций и таблиц. Появился
  **`doc/API.md`** — полный список маршрутов, чтобы дрейф не повторялся.
- Что можно проверить только на стенде с ключами — собрано в
  **`doc/ACCEPTANCE-CHECKLIST.md`** по порядку зависимостей, с явно
  отмеченными рисками (Lite + referenceImages + 9:16, реальное влияние
  фото на внешность, звучание украинской/русской озвучки Veo).

## Этап 46 — движение камеры (ТЗ §29, TODO II.2)

Второй пункт раздела II и самый дешёвый приём в продукте: он ничего не
добавляет ни к счёту за генерацию, ни ко времени рендера — только к
брифу для модели, — а отличает «снятый» ролик от «сгенерированного»
сильнее, чем любая постобработка.

**Сделано (этап 46).**

- **Значение живёт в бренде.** Миграция 22
  (`20260908180000_camera_move`) добавляет
  `brand_manifests.cameraMove TEXT NOT NULL DEFAULT 'none'` — рядом с
  `voiceMode`, потому что почерк камеры узнаётся так же, как голос.
  Снимок бренда замораживает его вместе с остальным стилем; правится он
  и в манифесте (для серии), и в копии сессии (для одного ролика) —
  в отличие от голоса второе ничего не стоит.
- **Логика — одна чистая функция.** `common/camera-move.ts`:
  `normalizeCameraMove` (колонка TEXT без CHECK, значение может прийти
  из старой записи или ручной правки), `isNativeFrame` и
  `cameraBriefText`. Последняя просит меньшую амплитуду (~5% вместо
  10–15%), когда формат неродной: там кадр ещё и обрежут по центру
  (§16.1), и наезд сужает безопасную зону второй раз. Неизвестный
  формат считается неродным — срезать товар дороже, чем недодвинуть
  камеру.
- **При `none` в промпте о камере ни слова.** Пустая секция не
  безобидна: она занимает место в брифе и подталкивает модель придумать
  движение самой. Бриф вставляется в `extraSections` между режимом
  озвучки и форматом кадра — там же, где остальные «как снимать».
- **Два варианта, а не три.** Отъезд к общему плану и проезд вбок
  остались в TODO следующим шагом: выбор из трёх, два из которых никто
  не возьмёт, — это шум, а не выбор.
- **Интерфейс в двух местах.** Пилюли «Статичный кадр / Медленный
  наезд» в `ManifestScreen` (стиль бренда) и в `BrandSnapshotEditor`
  (копия для этого ролика); тексты вынесены в `lib/camera-move.ts` —
  два разных объяснения одной настройки читаются как две разные
  настройки. Подсказка говорит о результате, а не о механике: «наезд»
  сам по себе звучит технической деталью, ради которой никто не полезет
  менять настройку.
- **Попутно: пилюли не добирали до пальца.** Проверка нового
  переключателя на 390 пикселах показала 32 пиксела высоты — этап 44
  задал минимум в 44 кнопкам, но `Pills` с одной строкой текста
  складывались ровно в 32 и мимо той правки прошли. Починено в самом
  компоненте, а не на экране: это чинит заодно выбор озвучки, формата
  кадра и все остальные пилюли продукта.
- **Проверено.** 23 юнита на чистую функцию (нормализация, молчание при
  `none`, уменьшенная амплитуда и её объяснение, запрет подмены наезда
  рывковым зумом) и четыре на промпт — что бриф доезжает до модели, что
  в неродном формате он другой и что сессия без манифеста (созданная до
  этапа 46) генерируется по-старому. Все 22 миграции накатаны на чистую
  базу: 15 таблиц, 51 индекс, колонка с `DEFAULT 'none'`.

## Третий сквозной аудит после этапа 46

Третий заход по шести направлениям —
**`doc/AUDIT-2026-09-07-round3.md`**, **84 находки, 15 высоких**. Работы
выписаны в `doc/TODO.md`, раздел I-В, по цене ошибки. Ничего не
чинилось: документ — диагноз.

Первые два захода находили дефекты в коде. Третий нашёл **класс
дефектов, общий для всего бэкенда: сервис написан так, будто процесс
живёт между запросами.** Тринадцать записей журнала расходов, очередь
служебных каналов, дедупликация тревог, кеш отчёта, замки от двойной
оплаты — всё опирается на то, что инстанс Vercel доживёт до конца
работы, которую сам же и отпустил. На стенде это незаметно: там один
процесс, и он не замерзает. В проде это значит, что суточные потолки
расхода обходятся тридцатью одновременными запросами, а канал ошибок
может молчать — и ни то, ни другое не оставит следа.

Второе, чему научил третий заход: **сценарий надо проходить целиком, а
не по частям.** Переход «проект → генерация» не работает вообще (В-1.1)
— мастер выбрасывает снимок товара и манифеста на первом же рендере,
потому что проверяет живость сессии вызовом, который на сессии без
разбора отвечает 400. Ни один из 946 тестов этого не поймал: дефект
живёт на стыке фронтенда и кода ошибки бэкенда, а по разные стороны
стыка всё правильно.

Третье: **три защиты, чьё удаление не роняет ни одного из 946 тестов** —
`assertOperator` (вход в админку), условие `WHERE count < limit` (квоты
SerpApi и YouTube) и привязка расхода к владельцу сессии. Покрытие в
76,4 % не говорит о том, покрыты ли те строки, ради которых написан весь
остальной код.

## Этап 47 — serverless-класс третьего аудита (ТЗ §30, TODO I-В)

Тезис третьего аудита перепроверен по коду до начала работ и
подтвердился во всех четырёх точках: 13 `void this.aiUsage.record` и
ноль `await`; очередь с `setTimeout(...).unref()` в
`telegram-notify.service.ts`; `Map` дедупликации в поле экземпляра;
`return { sent: true }` в `/cron/report` безусловно. Одно уточнение к
цифре аудита: «$96 против $30» получается с `quality: 'standard'`
(0,4 $/с), с моделью по умолчанию тридцать одновременных рендеров
стоят $36 — тоже больше любого потолка, но множитель 2,7× давал именно
неохраняемый параметр (В-2.6), и он закрыт здесь же.

**Сделано (этап 47).**

- **Тринадцать `void` → `await`** (В-2.1). Правило записано на самом
  `record()`: вызывающий обязан ждать, потому что строка расхода — это
  то, по чему считаются потолки. Проверено тестами «ответ уходит
  только после записи» на трёх самых дорогих путях (Veo, разбор,
  промпт) и на пробе голоса — том самом месте, где запись была
  последней строкой перед `return`.
- **Запись сессии — одним `UPDATE … SET data = data || $patch`**
  (Б-1.10, В-2.9). Чтения перед записью нет; `undefined` в правке
  пишется как `null` явно, иначе `JSON.stringify` выбросил бы ключ и
  «стереть» превращалось бы в «не менять». Служебные ключи вне
  `DATA_KEYS` (замки) строка сохраняет. SQL проверен на живом Postgres
  до того, как попал в код.
- **Замки `claimWork`/`releaseWork`** (В-2.2, В-2.3, В-3.1) — условный
  `UPDATE` по `data.workLocks.<kind>` с TTL; протухший замок считается
  свободным. Генерация занимает замок после быстрой проверки
  записанного рендера (быстрый путь Б-2.3 остался), разбор — после
  проверок денег и согласия (иначе отказ по лимиту оставлял бы замок на
  пять минут), промпт — перед вызовом GPT-5. Проигравшему — 409 с
  русским текстом. Разбор больше не пишет `FAILED` поверх чужого
  готового результата — сверяет `analysisId`.
- **Служебные каналы без очереди** (В-2.5, В-2.10 частично).
  `alert`/`stat`/`report` — `async`, вызывающий ждёт, потолок ответа
  Telegram пять секунд, метод отдаёт `boolean`. Дедупликация — таблица
  `alert_states` (миграция 23) и один `INSERT … ON CONFLICT …
  RETURNING`, атомарный для всех экземпляров; забытые отпечатки убирает
  суточная уборка. `/cron/report` отвечает `sent` по факту. Сводка по-
  прежнему уходит с первой тревогой после окна — если тревог больше не
  было, её не будет; это записано в §28.3 как известное ограничение.
- **Фильтр секретов чинит `\b`** (В-3.3): имя переменной захватывается
  целиком, добавлены префикс `AIza` и `key=` в ссылках; в канал уходит
  восемь символов идентификатора сессии вместо полного UUID (В-3.5).
- **Метла до конца курсора** (В-2.4): каждая область — до `cursor ===
  null` под потолками в 40 страниц и 120 секунд; в ответе `complete` и
  `pages` по областям; курсор из query по-прежнему продолжает область
  сессий. Тест: сирота на третьей странице находится и удаляется.
- **`quality: 'standard'` под признаком пакета** (В-2.6):
  `fullQualityVideo`, закрыт для Lite, показан в списке возможностей
  на экране «Режимы».
- **Проверено.** 978 тестов / 83 набора (+32), eslint 0, tsc чист; все
  23 миграции накатаны на чистый Postgres — 16 таблиц, 52 индекса;
  frontend tsc чист.

**Что осталось из того же класса и почему.** Кеш отчёта расходов в поле
экземпляра (В-2.12) — ускоряет, а не защищает; потолки квот SerpApi и
YouTube, читаемые в конструкторе (В-2.13), — меняются раз в жизнь. Оба
записаны в §30.2 как осознанные.

## Этап 48 — сценарий проходится целиком (ТЗ §7.11, TODO I-В)

Второй по цене ошибки пункт третьего аудита после serverless-класса:
четыре места, где пользователь терял работу или упирался в тупик, и
одно — где продукта не было вовсе.

**Сделано (этап 48).**

- **«Проект → генерация» проходится** (В-1.1). Живость сохранённой
  сессии проверяется `GET /sessions/:id`, а не статусом разбора, который
  на сессии без разбора отвечает 400; идентификатор сбрасывается только
  на 404/403. Проверено Playwright-пробой: при `GET /analysis = 400` новая
  сессия НЕ создаётся, а поле поиска YouTube получает «обувь Кроссовки
  Zoom» из снимка товара.
- **Возврат во время разбора возобновляет опрос** (В-1.2): опрос
  вынесен в `startAnalysisPolling`, живёт в ref, гасится при уходе с
  мастера и при повторном запуске (В-5.7), первый тик — сразу. Проба:
  два опроса, переход на «Анализ готов» с манифестом бренда.
- **Провал рендера оставляет кнопку «Сгенерировать ещё раз»** (В-1.3);
  пока запрос идёт без ответа — карточка «Отправляем задачу в Veo…»
  вместо пустого места (В-5.5). «Ещё один ролик» сбрасывает сессию
  перед перезагрузкой (В-1.4).
- **Сообщения сервера доходят** (В-5.2): 14 `error.message` в хуке
  мастера → `errorMessage()`, 19 английских строк переведены, отказ
  квоты аналогов на сервере — по-русски; в `errorMessage()` для ответов
  без конверта — русские заготовки по коду, текст axios не показывается.
  Проба: 403 с конвертом даёт на экране «Дневной лимит расхода исчерпан
  …», а не «Request failed with status code 403».
- **«Сохранить» на разборе ждёт ответа** (В-5.4): `onEdit` — промис,
  кнопка с `loading`, шаг переключается только после успеха.
- **Корневой `ErrorBoundary`** (В-5.3) в `main.tsx` с двумя выходами;
  `SceneCasting` переживает ответ без `scenes`. Побочно: два оставшихся
  `console.log` с идентификатором сессии убраны (В-5.20).
- **Проверено.** tsc и eslint чистые в обоих приложениях, `vite build`,
  14 unit-скриптов, 978 backend-тестов; пять Playwright-проб сценариев
  (`/tmp/shots/wiz48.mjs`, вне репозитория — см. открытый вопрос 27.1).

## Этап 49 — защиты без тестов и двери на входе (ТЗ §25.5, TODO I-В)

**Сделано (этап 49).**

- **Три защиты закреплены тестами** (В-6.1, В-6.2, В-6.3): `assertOperator`
  — оператор проходит, вошедший без флага и удалённый пользователь
  получают 403; квоты SerpApi и YouTube — `usage-quota.spec.ts`
  проверяет сам SQL (`ON CONFLICT … WHERE count < ?`, лимит из
  конфигурации, умолчание при мусоре в переменной, `GREATEST(… , 0)` при
  возврате), плюс живой Postgres при лимите 2; `record()` без `userId`
  берёт владельца у сессии и пишет `anonymous: false`. Мёртвые
  `canSearch`/`recordSearch` удалены — они были путём в обход
  атомарного `reserve`. Три файла добавлены в `coverageThreshold`.
- **Предохранители уборки проверяются честно** (В-6.9): ровно
  `CLEANUP_MAX_PASSES` партий, а не «меньше пятидесяти»; отдельный тест
  на бюджет времени с подменой часов.
- **Вторая линия SSRF покрыта** (В-6.10): `fetchReference` — свой путь
  без сети, чужой URL и `http://` отклоняются до `fetch`, не-2xx —
  понятный отказ.
- **`OriginGuard` на входе и выходе** (В-3.2, В-3.6): `telegram-login/*` и
  `admin/auth/*` проверяют `Origin` сами. Пять тестов, включая «прод без
  списка — отказ».
- **Ничья сессия привязывается к вошедшему** (В-3.4) первым опознанным
  запросом в `SessionOwnerGuard` — условным `UPDATE`, с перечитыванием
  при проигранной гонке.
- **Проверено.** 1013 тестов / 85 наборов (+35), пороги покрытия
  держатся, eslint 0, tsc чист.

## Этап 50 — вёрстка, проверяемая замером (ТЗ §31, TODO I-В)

**Сделано (этап 50).**

- **Таблицы админки с телефона** (В-5.1; Б-4.5 был помечен закрытым и не
  был): `min-width: 720px` у таблиц и `break-word` вместо `anywhere`. Замер
  на 320/390/768: ряд «Модерации» 177 px вместо 1004, «Пользователей» 101
  вместо 661, документ не шире вьюпорта, прокрутка внутри обёртки, кнопки
  действий на месте. Узкие таблицы («Телеметрия», «Расходы», «Настройки»)
  помечены `.table-narrow`.
- **Списки админки** (В-5.10–В-5.14, В-5.23): поколение запроса, сброс
  ошибки, «Повторить» на трёх страницах, одна загрузка вместо двух копий в
  модерации; шапка не мигает на переходах (`loading` только при первой
  проверке); обрыв сети до `/admin/auth/me` — «Нет связи с сервисом» с
  повтором; `handle()` переживает ответ шлюза без конверта. Проба:
  500 → «Повторить» → таблица; страница 2 (медленно) + страница 3 (быстро)
  → через 3 с в таблице по-прежнему страница 3.
- **Активная вкладка админки** (В-5.18) — цвет, вес, `aria-current`.
- **404 в админке и на лендинге** (В-5.16) — по-русски, на своём фоне, со
  ссылкой назад.
- **Мобильное меню лендинга** (В-5.15): `Escape`, клик вне, фокус внутри —
  проба: 9 из 9 `Tab` остаются в меню, `Escape` и клик вне закрывают.
- **Касания в TMA** (В-5.8): `.input` и `Button sm` — 44, текстовые кнопки,
  чипы, иконочные кнопки (ширина 44), логотип. 24 замера по шести экранам
  в двух темах на 320/390 — **0 целей меньше 44×44** (было 34).
- **Контраст на собственной подложке** (В-5.9): заливки 20 %, чернила
  -700/-800 в светлой и -400 в тёмной теме у бейджей, чипов персонажей,
  плашек; `silver-500` в тёмной теме поднят до тона `silver-400`, в светлой
  — до #54607a. Те же 24 замера — **0 пар ниже 4,5** (единственное
  срабатывание — градиентный логотип с `color: transparent`, ложное).
- **Доступные имена** (В-5.19): селекты и поиск в админке, поле пробы
  голоса, выпадающий список стран (`aria-expanded`, `Escape`), кнопки
  листания «← Назад» / «Вперёд →».
- **Проверено.** tsc, eslint, сборки трёх приложений; Playwright-пробы
  `/tmp/shots/{tma50,admin50,admin50b,landing50}.mjs`.

## Этап 51 — данные, которые растут (ТЗ §32, TODO I-В)

**Сделано (этап 51).** Замеры — на засеянной базе третьего аудита
(300 тыс. сессий, 60 тыс. заявок), до и после миграции 24.

- **`sessions.generationStatus`** (В-4.1): колонка с индексом вместо
  фильтра по JSON-пути; ведётся тем же `UPDATE`, что пишет `data`. Провалы
  рендера: **2 608 мс тёплым кешем / 47 157 мс холодным → 36 мс**
  (27 272 строки по индексу). Заполнение существующих строк — один проход
  в миграции (17 с на 300 тыс., секунды на штатном объёме).
- **Индексы `sessions(status)` и `publication_requests(createdAt)`**
  (В-4.5): пункт «Все» в модерации **194 мс → 0,24 мс**; воронка по
  статусам — по индексу.
- **Списки без колонки `data`** (В-4.4): `common/session-summary.ts` —
  сырой запрос с двумя JSON-путями и nullable-фильтрами; список сессий и
  карточка пользователя. **237 КБ → 3,8 КБ на страницу в 20 строк.**
  Проверено тестами: `data` целиком не выбирается, фильтры — параметры.
- **Чистка библиотеки** (В-4.6): `LibraryService.pruneUnused` в суточной
  уборке — `usageCount = 0`, старше `LIBRARY_UNUSED_TTL_DAYS` (180), не
  `HIDDEN`; партия 200, строки раньше файлов, сбой хранилища не отменяет
  удаление строк, `0` выключает. Переменная — в `.env.example`,
  `.env.docker.example`, `DEPLOYMENT.md`, вкладке «Настройки».
- **Потолок уборки сессий записан** (В-4.3): 10 000 в сутки, в
  `LOCAL-DEVELOPMENT.md` и ТЗ §32.
- **Проверено.** 1022 теста / 86 наборов (+9), пороги покрытия держатся,
  eslint 0, tsc чист; 24 миграции на чистый Postgres — 16 таблиц, 55
  индексов.

## Этап 52 — у ожидания есть дедлайн; у мастера — дорога назад (ТЗ §33)

**Сделано (этап 52).**

- **Дедлайны** (В-2.7, В-2.8): рендер — 20 минут от `initiatedAt`
  (`renderExpired`, провал `VIDEO_GENERATION_TIMEOUT`, `retryable`);
  постобработка — 15 минут от нового поля `postStartedAt`
  (`postProductionExpired`; записи без метки — 35 минут от старта рендера).
  Проверено: просроченный рендер закрывается сбоем без опроса Veo, сетевая
  икота до дедлайна не хоронит оплаченную работу, даты из JSON приходят
  строками и всё равно считаются, мусор в поле — не повод хоронить.
- **`deleteBlob` пишет warn** (В-2.11) вместо `catch(() => undefined)`.
- **Сводка подавленных тревог в суточном отчёте** (В-2.10):
  `TelegramNotifyService.suppressedSummary` — за сутки, по убыванию, до
  десяти отпечатков. Порог покрытия на этом файле поймал непокрытый метод
  до того, как его поймал бы аудит.
- **Мастер: степпер ведёт назад** (В-1.5): `goToStep` + `selectableSteps`
  из `stepTargets(state)`; Playwright-проба: с «Анализа» на «Видео» и
  обратно, шаг без данных недоступен.
- **Режим озвучки и голос в копии манифеста** (В-1.6): `VoicePicker`
  вынесен в общий компонент, `VOICE_MODE_HINT` — в `lib/voice-mode.ts`;
  `BrandSnapshotEditor` шлёт `voiceMode`/`ttsVoiceId`.
- **Расшифровка сохраняется сразу** (В-1.7): `updateItem` в момент
  получения текста; при сбое сохранения — честная подсказка нажать
  «Сохранить».
- **Проверено.** 1030 тестов / 86 наборов (+8), пороги держатся, eslint 0
  в обоих приложениях, tsc чист, `vite build`, проба `wiz52.mjs`.

## Этап 53 — документы, которые не врут, и CI, который проверяет (ТЗ §27.4, TODO I-В)

Раздел 6 третьего аудита (документы и CI) целиком: 22 находки, ни одной
высокой, но все одного класса — документ утверждает то, чего в коде нет,
и никто этого не замечает, потому что проверяет человек. Смысл этапа не
в том, чтобы поправить 22 строки, а в том, чтобы следующее расхождение
поймал скрипт, а не четвёртый аудит.

**Сделано (этап 53).**

- **Переменные окружения сверяются с кодом** (В-6.6, В-6.14, В-6.15):
  `check-docs.mjs` собирает все `process.env.*`/`import.meta.env.*` из
  четырёх приложений и требует, чтобы каждая была описана в
  `DEPLOYMENT.md` и присутствовала в `.env.docker.example`. Нашлось девять
  недокументированных (`GEMINI_MODEL`, `OPENAI_GPT_MODEL`,
  `OPENAI_API_BASE_URL`, `FFMPEG_API_BASE_URL`, `PORT`, синоним
  `GOOGLE_GEMINI_API_KEY`, `VITE_DEV_USER_ID`, `NEXT_PUBLIC_DEV_USER_ID`,
  семейство `DAILY_SPEND_LIMIT_USD_*`) — все описаны. Сейчас 42
  переменные, все сходятся.
- **Число маршрутов в README — из кода** (В-6.17): 109 маршрутов в 27
  контроллерах считаются по декораторам; строка в README проверяется.
  `CI.md` вошёл в сверку тестов и миграций (В-6.16).
- **Один клиент Gemini** (В-6.11): `common/gemini-client.ts` —
  `geminiApiKey()` / `createGeminiClient()`; семь `new GoogleGenAI({})`
  заменены, два необязательных (распознавание товара, расшифровка
  голоса) остаются `null` без ключа. Тесты: клиент, `GeminiFilesService`
  (ожидание `PROCESSING → ACTIVE` на поддельных таймерах).
- **CI проверяет то же, что руки** (В-6.5, В-6.12, В-6.18): один шаг
  jest с покрытием вместо двух прогонов; `next lint --max-warnings 0` для
  `admin/` и `landing/` (eslint + `eslint-config-next` заведены, оба чисты
  с первого прогона); `npm audit --audit-level=high --omit=dev` в каждой
  задаче, совещательно; `make ci` повторяет `ci.yml` шаг в шаг.
- **Чеклист приёмки догнал проект** (В-6.4): раздел 6m «Второй и третий
  аудит: этапы 41–53» — двери, serverless-инварианты, сценарий целиком,
  вёрстка, база, дедлайны, документы. До этого он обрывался на этапе 40.
- **Мелочь, которая врала** (В-6.8, В-6.19–В-6.26): `CI.md` больше не
  обещает скриншотные тесты; README перечисляет все документы `doc/`;
  комментарий в `dev-login.ts` и `configuration.ts` соответствует коду;
  `format`/`test:e2e` в `package.json` указывают на существующие файлы;
  ручные скрипты и образцы переехали в `scripts/manual/` с README,
  `scripts/output/` удалён; сообщение про `DEV_USER_ID` в настройках
  объясняет, что это за пользователь; «Открытые вопросы (§27)» стоят в
  §27, а не после §28.
- **Проверено.** 1038 тестов / 88 наборов (+8), пороги держатся, eslint 0
  в четырёх приложениях, tsc чист, `vite build`, `next lint` ×2,
  `check-docs` зелёный по всем шести проверкам, `sync-legal --check`.

## Этап 54 — хвост аудитов: двери, которые закрываются сами (ТЗ §34, TODO I-В.3–I-В.4)

Пять находок второго аудита, дожившие до третьего без изменений, и пять
низких третьего. Общее у них — правило держалось на человеке (задать
переменную, не забыть пересчёт), и этап переводит его в код.

**Сделано (этап 54).**

- **Крон без секрета закрыт** (Б-3.3): `cron-secret.ts` — одна проверка
  вместо трёх копий; нет `CRON_SECRET` → 503, кроме dev-стенда
  (`isDevAuthAllowed`, те же два предохранителя, что у dev-входа);
  сравнение `timingSafeEqual`; GET остаётся — Vercel Cron умеет только
  его. Строка `CRON_SECRET` в «Настройках» говорит правду о новом правиле.
  Тесты: правило целиком (`cron-secret.spec.ts`), контроллер — «секрет не
  задан и это не dev-стенд — 503, ни одного удаления».
- **Расширение ключа — из MIME** (Б-3.5): `EXTENSION_BY_MIME`, `fileName`
  в путь не попадает (`MaxLength(255)` в DTO); тест с
  `../../../etc/passwd.mp4/..%2F..%2Fx` → `sessions/s1/original.mov`.
- **Фильтр исключений не выдаёт чужое** (Б-3.6): `HttpException` уходит
  как есть (массив `ValidationPipe` склеивается), всё остальное — одна
  фраза + `requestId`, подробности в лог с тем же кодом; тексты OpenAI и
  ElevenLabs — только в лог. `http-exception.filter.spec.ts`.
- **Ограничение частоты в базе** (Б-3.7): `common/rate-limit.ts` —
  `@RateLimit({name, limit, windowSec})` + `RateLimitGuard`, таблица
  `rate_limits` (миграция 25), `INSERT … ON CONFLICT … RETURNING count`;
  на входах 10/мин, на `POST /api/sessions` 30/мин; 429 с `Retry-After`;
  отказ базы пропускает. Атомарность доказана на живом Postgres (1, 2, 3
  параллельно; новое окно — 1). Уборка окон старше часа в суточном
  кроне. `helmet` без CSP в `main.ts`.
- **Самостоятельный режим не поднимает потолок** (Б-3.8):
  `users.planSelfService`, `UserAccess.spendPlan`, `spendPlanOf()` в
  `common/plans.ts`; `setPlan` ставит флаг, назначение оператором снимает;
  админка подписывает «выбран сам, потолок Lite» и показывает потолок по
  `spendPlan`. Существующие строки — `false`, поведение не меняется.
- **Потолки квот читаются на каждом вызове** (В-2.13): геттер вместо поля
  конструктора в обоих сервисах квот.
- **Автор записи библиотеки не затирается** (В-2.14): `update` без
  `userId`/`sessionId`.
- **`videos.list` в журнале, слот квоты — по факту тарификации**
  (В-2.15): `calls: 2` в одной строке `ai_usage`; `release()` только если
  Google запрос не посчитал (сеть или исчерпанная квота деплоя) —
  `chargedByGoogle()` на переведённом исключении.
- **Цена аналога — только в валюте проекта** (В-4.7): клиент подставляет
  одним нажатием лишь совпадающую валюту (чужая — пунктиром, для
  ориентира), сервер проверяет `priceSource: 'ANALOG'` против аналогов
  товара и отвечает 400 на «$19 в проект с UAH».
- **Триграммный поиск по библиотеке** (В-4.9): `pg_trgm` + три GIN на
  `analysis_library` (`title`, `category`, `sourceKey`), выражены в
  `schema.prisma` (`postgresqlExtensions`); замер 73,9 мс → 0,39 мс на
  60 тыс. записей. `users` не индексируется: на 3 000 строк seq scan
  быстрее (2,5 против 3,3 мс).
- **Проверено.** 1065 тестов / 91 набор (+27), пороги держатся, eslint 0,
  tsc чист, `prisma validate`, все **25** миграций подряд на чистом
  Postgres 16 (**17** таблиц, 60 индексов), `vite build`, `next lint`,
  `check-docs`, `sync-legal --check`.

## Этап 55 — мультиязычность: инфраструктура и лендинг (ТЗ §35, TODO II.3–II.5)

По запросу пользователя (перенос блога/новостей из проекта "solar shop" —
см. §35.1) продукт становится мультиязычным: пять языков — ru/uk/en/de/es.
Этап закрывает первый, самый безопасный по объёму кусок: сам механизм
(словари, роутинг по локали, переключатель) и полный перевод `landing/` —
единственного приложения, где объём текста укладывается в один этап
целиком. Полный перевод экранов `frontend/` (TMA) — этап 56; перенос
блога и локализация ИИ-вывода — этапы 57–59 (см. §35 и цепочку ниже).

**Сделано (этап 55).**

- **Архитектура — паттерн из "solar shop", а не с нуля.** Исследован
  реальный блог-модуль присланного проекта (`apps/api/src/articles/*`,
  `apps/web/src/lib/i18n.ts` + `[locale]`-сегмент + словари JSON +
  middleware) — рабочая, проверенная в проде схема на том же Next.js 14
  App Router, что уже использует `landing/`. Перенесена сама СХЕМА
  (locales/defaultLocale, `[locale]`-сегмент, словари, редирект по
  cookie), не код блога — тот относится к этапу 57 и требует отдельного
  решения по источнику контента (см. §35.1 и открытые вопросы).
- **`landing/` полностью мультиязычен.** `src/lib/i18n.ts` (locales,
  `defaultLocale='ru'`), `src/lib/get-dictionary.ts`,
  `src/dictionaries/{ru,uk,en,de,es}.json` — весь текст лендинга (hero,
  фичи, шаги, тарифы, подробности, дорожная карта, FAQ, футер, шапка,
  404) на пяти языках, включая уже переведённый пункт дорожной карты про
  саму мультиязычность. `src/middleware.ts` — редирект на
  `/{locale}/...` по cookie `NEXT_LOCALE` (без cookie — всегда `ru`,
  никакого угадывания по Accept-Language/geo-IP, тот же принцип, что и в
  источнике). `src/app/[locale]/layout.tsx` — `generateStaticParams` на
  все пять локалей, `generateMetadata` (title/description/OG/hreflang) по
  словарю. `src/components/LocaleSwitcher.tsx` — переключатель, пишет
  cookie и остаётся на том же пути под новым префиксом.
- **Юридические документы — сознательно вне локализации.** `/legal/offer`
  и `/legal/terms-of-use` (реальный Договор оферты и Условия
  использования, сгенерированные из `doc/legal/*.md` с пометкой
  «требует проверки юристом перед публикацией») остаются одной
  редакцией — русской — независимо от локали интерфейса и НЕ живут под
  `[locale]` вовсе (см. `middleware.ts`). Машинный перевод юридического
  текста без профессиональной проверки — это не снятие языкового
  барьера, а добавленный юридический риск; на неродной локали у ссылок
  на оферту/условия — честная пометка об этом (`footer.legalNoticeOtherLocale`).
- **`frontend/` (TMA) — инфраструктура и первый слой экранов.**
  `src/lib/i18n.ts`/`get-dictionary.ts`/`i18n-context.ts` (файл без JSX,
  тот же приём, что `plan-context.ts`, — `react-refresh/only-export-components`
  не спорит с экспортом хука и контекста из одного модуля) +
  `src/dictionaries/*.json`. Начальная локаль: явный выбор
  (`localStorage`) → `language_code` из `initDataUnsafe` Telegram (это
  настройка человека в самом Telegram-клиенте, не угадывание вроде
  Accept-Language) → `ru`. Переведены: шапка (вкладки, тег-лайн),
  подвал (Оферта/Условия/Режимы), «страница не найдена»,
  `ErrorBoundary` — граница ошибок рендерится СНАРУЖИ `I18nProvider`
  (`AppRoot.tsx`) и читает свой словарь из `localStorage` напрямую, а не
  через контекст: у экрана аварии не должно быть той же точки отказа,
  что и у дерева, которое, возможно, упало. `LanguageSwitcher.tsx` — в
  шапке, `<select>`, а не `Pills` (пять вариантов пилюлями не помещаются
  рядом с режимом и входом на 390px).
- **Оставлено следующему этапу — явно, не забыто.** Экраны
  `features/*`/`components/*` (45 файлов с русским текстом) переводятся
  этапом 56: перенос всего разом рискует внести ошибки без пошаговой
  проверки, а инфраструктура уже готова принять переводы по мере
  готовности каждого экрана.
- **Проверено.** Лендинг: `tsc --noEmit`, `next lint --max-warnings 0`,
  `next build` — все пять локалей (`/ru`, `/uk`, `/en`, `/de`, `/es`)
  собираются статически, `/legal/*` вне локали не задет. Frontend:
  `tsc --noEmit`, `eslint --max-warnings 0`, полный прогон
  `scripts/*.test.ts` (существующие наборы без изменений + новый
  `i18n.test.ts` — валидность локали, разбор `language_code` с регионом
  и без, честный `null` для неподдерживаемого языка вместо тихой
  подмены).

## Этап 56 — мультиязычность: полный перевод экранов TMA (ТЗ §37, TODO II.3–II.5)

Закрывает хвост, оставленный этапом 55 явно: 45 файлов `components/*`/
`features/*` с русским текстом. Инфраструктура (словари, роутинг по
локали, начальная локаль) уже готова с этапа 55 — этот этап только
наполняет словари и подключает `useI18n()`/чистые функции-хелперы к
оставшимся экранам, без изменения поведения.

**Сделано (этап 56).**

- **Все 45 файлов переведены на пять языков.** Компоненты (`AccountNotice`,
  `VideoPlayer`, `TermsGate`, `TelegramLoginButton`, `ImageUpload`,
  `LibraryPicker`, `AnalysisDisplay`, `AudienceCard`, `ProductInput`,
  `PromptEditor`, `VideoUpload`, `YoutubeSearch`) и экраны фич
  (`legal/LegalScreen`, `plan/PlanScreen`, `projects/*` — список,
  создание, деталь, товар, форматирование, `brand/*` — манифесты,
  голос, JSON-поля, `generation/*` — разбор, формат кадра, снимок
  бренда, релевантность, персонажи и сцены, аудит, публикация, слоты
  референсов, мастер генерации целиком). 37 новых namespace'ов в
  `dictionaries/{ru,uk,en,de,es}.json`, добавленных к 10 существующим с
  этапа 55 — итого 47 верхнеуровневых ключей во всех пяти файлах.
- **Чистая логика получает переводы параметром, не зовёт хук.**
  `genderLabel`/`cameraMoveOptions`/`cameraMoveHint`/`voiceModeHint`/
  `parseJsonObject`/`itemLabel`/`defaultTextFor` — все теперь принимают
  объект переведённых строк `t` от вызывающего компонента вместо
  собственного захардкоженного словаря (тот же приём, что `lockLabel` в
  `lib/plan.ts` уже использовал). См. §37.1.
- **Числовые формы через `Intl.PluralRules`.** «в 1 проекте / в 2
  проектах» и подобные — по-русски и по-украински четыре формы, по
  остальным трём языкам две; хелпер `pluralForm()` в
  `ManifestsListScreen.tsx`/`ManifestScreen.tsx` берёт нужную форму
  через `Intl.PluralRules(locale).select(n)`. `lib/get-dictionary.ts`
  получил отдельный тип `PluralForms` для таких ключей словаря — иначе
  TypeScript требовал бы от английского/немецкого/испанского словарей
  те же четыре формы, которых в этих языках не бывает. См. §37.2.
- **Цена — по локали интерфейса.** `formatPrice()` форматирует число
  через `Intl.NumberFormat(locale)` вместо жёстко зашитого `'ru-RU'`;
  валюта (`project.currency`) как была своя у страны продажи, так и
  осталась — от локали интерфейса она не зависит. См. §37.3.
- **Найдено и исправлено попутно.** Сигнатура `itemLabel()` менялась в
  файле, который переводил один параллельный кусок работы; вызовы
  функции лежали в двух других файлах, переводимых другим куском —
  несовместимость всплыла на `tsc --noEmit`, а не в рантайме, и была
  исправлена сразу. Обновлены и юнит-тесты, у чьих функций изменилась
  сигнатура (`scripts/casting.test.ts`, `scripts/plan.test.ts`,
  `scripts/json-object.test.ts`) — те же случаи, тот же переведённый
  текст фикстурой, но через параметр, а не импорт константы.
- **Проверено.** `tsc --noEmit`, `eslint --max-warnings 0`, `vite build`,
  полный прогон всех **15** `scripts/*.test.ts` (существующие наборы —
  без изменения проверяемого поведения, только сигнатур вызовов).

## Этап 57 — блог: модели, источник контента, перевод ИИ-конвейером (ТЗ §36, TODO §II.3–II.4)

Первый кусок переноса блога/новостей из "solar shop" (§35.1): backend
целиком — Prisma-модели, генератор черновиков из YouTube-трендов с
разбором Gemini, очередь перевода через xAI Grok Batch API (см.
уточнение ниже — было отдельным разделом до этого этапа, теперь часть
его), CRUD/модерация, публичный API витрины. Публичные страницы,
админ-модерация UI и sitemap-news — этап 58 (API под них уже готов).

**Реконсиляция имён.** `doc/TODO.md` §II.3 определяет модель как
`BlogPost` (не `Article`, как в "solar shop" и в более ранних черновиках
этого документа) — TODO написан раньше и специфичен для этого продукта,
принято его имя: `BlogPost`/`BlogPostTranslation`, а не
`Article`/`ArticleTranslation`. Переносится СХЕМА и архитектура
"solar shop" (§35.2), не его имена и не его контент — источник контента
здесь другой: не RSS "solar shop", а `YoutubeSearchService` + разбор
Gemini (TODO §II.3/§II.4), по прямому решению, зафиксированному раньше
в этом документе.

**Сделано (этап 57).**

- **Grok Batch API** (по прямому запросу пользователя «использовать
  Grok AI как и в Solar shop batch mode для перевода статей» —
  отменяет решение этапа 55 о синхронных вызовах Gemini/GPT-5 под
  крон-бюджетом): `backend/src/modules/grok/grok-batch.service.ts` —
  порт `grok-batch.service.ts` из "solar shop" почти дословно
  (submitBatch/getBatchStatus/getBatchResults, вложенный
  `state.num_pending` как признак готовности вместо сравнения
  `num_success`/`num_requests`, эндпоинт `/results` с пагинацией, разбор
  `chat_get_completion.choices[0].message.content`); axios вместо
  нативного `fetch` оригинала — под стиль `SerpApiLensService`.
  `grok-translation-prompt.ts` — `LOCALE_LANGUAGE_NAMES` (явные названия
  языков, не голые ISO-коды — промпт-находка солар-шопа про `uk` →
  «United Kingdom» вместо украинского) и `buildArticleTranslationPrompt`.
  `common/ai-pricing.ts`: провайдер `'GROK'`, операции `'translate'` и
  `'blog-analysis'` заведены; ставка в `MODEL_RATES` для Grok сознательно
  не добавлена (не сверена, придумывать нельзя — открытый вопрос 35.5) —
  вызовы честно лягут в журнал расходов как `unpriced: true`.
- **Prisma-схема** (`backend/prisma/migrations/20260912090000_blog/`):
  `BlogPost` (slug, status DRAFT/APPROVED/PUBLISHED/REJECTED, source
  YOUTUBE_TREND/MANUAL, category, поля YouTube-источника, score +
  scoreReasoning от Gemini, originalLocale, title/bodyHtml, поля
  модерации), `BlogPostTranslation` (postId+locale уникальны, status
  PENDING/QUEUED/READY/FAILED, batchJobId), `GrokBatchJob` (xaiBatchId,
  status SUBMITTED/COMPLETED/FAILED, requestCount), и отдельная
  `BlogYoutubeSearchUsage` (день→счётчик) — своя таблица, а не переиспользование
  `rate_limits` (чистится по часу, не по суткам) или `YoutubeSearchUsage`
  (требует настоящего `userId`).
- **`BlogGenerationService`** (`blog-generation.service.ts`) — суточный
  генератор: `YoutubeSearchService.searchTrending()` (новый метод, не
  переиспользует `search()` — тот завязан на `userId` для квоты
  пользователя) по каждой категории из `BLOG_CATEGORIES`, под свой
  бюджет `BlogYoutubeBudgetService`; отбор кандидатов — чистая функция
  `selectBlogCandidates` (без дублей, по порогу и числу просмотров);
  разбор Gemini на релевантность — чистые функции
  `buildBlogAnalysisPrompt`/`parseBlogAnalysisResponse`; черновик
  заводится только если `score >= BLOG_MIN_SCORE_TO_DRAFT`, статус
  всегда `DRAFT` — ничего не публикуется само (TODO §II.3: «Это не
  автопостинг»). Бюджет времени 180 с — тот же приём, что у
  `CronController` (крон живёт 300 с на Vercel).
- **`BlogTranslationService`** (`blog-translation.service.ts`) — три
  идемпотентных шага одного прогона: (1) опрос уже поданных
  `GrokBatchJob` — готовность по `pendingCount===0`, результат
  раскладывается по переводам чистой функцией
  `applyTranslationBatchResults` (не пришедший результат — честный
  `FAILED`, а не забытый `QUEUED`); (2) `ensurePendingTranslations` —
  заводит недостающие `PENDING`-строки на все локали кроме оригинала
  (`skipDuplicates`); (3) `submitPendingBatch` — до
  `BLOG_TRANSLATE_BATCH_LIMIT` ожидающих переводов одной пачкой xAI.
  Расход (`operation: 'translate'`) пишется на каждый обработанный
  элемент готовой пачки независимо от исхода — ДОПУЩЕНИЕ (биллинг xAI
  Batch API может оказаться попачечным, не потранзакционным — сверить
  при первом реальном прогоне, см. открытый вопрос ниже).
- **`BlogService`** — CRUD/модерация тем же паттерном, что
  `PublicationService`/`LibraryService` (DRAFT→APPROVED→PUBLISHED,
  REJECTED с обязательной причиной, `moderatorId`/`moderatedAt`).
  Правка текста уже одобренной/переведённой статьи сбрасывает её
  `READY`/`QUEUED`-переводы обратно на `PENDING` — иначе после правки
  заголовка на витрине молча висел бы перевод старого текста. Публичное
  чтение (`publicList`/`publicGetBySlug`) возвращает
  `isRequestedLocale: boolean` — не готовый перевод честно помечен, а
  не подменён оригиналом молча (тот же урок, что и в §35.1 про `uk` →
  «United Kingdom»: солар-шоп однажды оставил перевод молча
  английским).
- **API**: `GET /blog`, `GET /blog/:slug` (публичные, без гварда) и
  `admin/blog` (список/деталь/создать вручную/править/
  approve/reject/publish/unpublish/удалить — `AdminSessionGuard` +
  `AdminPanelService.assertOperator`, тот же паттерн, что
  `AdminLibraryController`).
- **Крон**: `GET /api/cron/blog` — генерация, затем перевод,
  последовательно, ОДНИМ маршрутом (не двумя): число крон-джобов,
  которое допускает текущий тариф Vercel, не проверено (см. открытый
  вопрос ниже), экономить слоты стоит уже сейчас; оба шага сами следят
  за своим бюджетом времени. `backend/vercel.json` — новая запись,
  ежедневно в 04:00 UTC (до генерации отчёта в 06:00 и до уборки в
  03:00/03:30, чтобы не пересекаться по нагрузке).
- **Найдено и исправлено попутно.** `AdminLibraryController`
  (`library.controller.ts`, §21.1) существовал, но никогда не
  регистрировался ни в одном `@Module` — его маршруты реально отвечали
  404, хотя `admin/src/lib/endpoints.ts` их вызывает, а `doc/API.md`/
  `doc/LOCAL-DEVELOPMENT.md` документируют как рабочие. Обнаружено при
  переносе того же паттерна модерации на блог, исправлено в
  `library.module.ts`.
- **Открытые вопросы (см. также ТЗ §35.5/§36):** биллинг xAI Batch API
  — попачечный или потранзакционный — не сверен на реальном аккаунте;
  лимит числа крон-джобов на используемом тарифе Vercel не проверен.
- **Проверено.** Прайм-функции блога (`blog-slug`, `blog-candidate-selection`,
  `blog-analysis-prompt`, `blog-translation-apply`) и порт Grok Batch
  API (`grok-batch.service.spec.ts`, `grok-translation-prompt.spec.ts`)
  — 49 тестов, все зелёные независимо от Prisma (93 → 98 наборов,
  1089 → 1125 тестов; `blog-youtube-budget.service.spec.ts`, 7 тестов,
  корректен по коду и по прецеденту с `usage-quota.spec.ts`, но
  выполнить в песочнице нельзя — тот же класс ошибки, что и у остальных
  Prisma-сервисов, см. ниже). Сервисы, работающие через Prisma
  (`BlogService`, `BlogGenerationService`, `BlogTranslationService`,
  `BlogYoutubeBudgetService`) написаны и типизированы, но не
  выполнялись в песочнице: `binaries.prisma.sh` заблокирован, `prisma
  generate` не работает, и `PrismaService` в скомпилированном виде не
  видит ни моделей `blogPost`/`blogPostTranslation`/`grokBatchJob`/
  `blogYoutubeSearchUsage`, ни `$transaction`/`$executeRaw` — тот же
  класс ошибки, что уже стоит на 45 наборах бэкенда (не новый, проверено
  повторным прогоном `product-analog/usage-quota.spec.ts`). `npx tsc
  --noEmit` не добавил ошибок сверх этого класса; `npx eslint
  --max-warnings 0` по всем изменённым файлам — 0; `check-docs.mjs`
  зелёный после обновления счётчиков ниже (26 миграций / 21 таблица,
  121 маршрут / 28 контроллеров, 98 наборов).

## Этап 58 — блог: публичные страницы, админ-модерация, sitemap-news (ТЗ §38, TODO §II.3–II.5)

Вторая часть переноса блога/новостей (§35/§36): API готов с этапа 57,
этот этап — целиком фронтенд, `backend/` не тронут ни единой строкой.
Два потребителя одного и того же публичного `GET /blog`/`GET
/blog/:slug`: `admin/` (модерация) и `landing/` (витрина + продвижение).

**Сделано (этап 58).**

- **`admin/` — вкладка `/blog`.** `lib/types.ts`/`lib/endpoints.ts` —
  типы и 8 тонких обёрток (`listBlogPosts`, `getBlogPost`,
  `createBlogPost`, `updateBlogPost`, `approveBlogPost`,
  `rejectBlogPost`, `publishBlogPost`, `unpublishBlogPost`,
  `deleteBlogPost`), 1:1 к маршрутам `AdminBlogController`. `app/blog/page.tsx`
  — фильтр по статусу (по умолчанию DRAFT) и категории, форма «+ Ручная
  запись», таблица черновиков/публикаций с действиями по текущему
  статусу, разворачиваемая деталь с формой правки (заголовок/категория/
  тело) и предупреждением, что правка сбрасывает переводы на PENDING, и
  под-таблица переводов по всем локалям. `AdminNav.tsx` — пункт «Блог»
  рядом с «Библиотека» (§38.1).
- **`landing/src/lib/blog-api.ts`** — серверный (без клиентского кода
  вообще) fetch-слой к публичной витрине: `listBlogPosts`,
  `listAllBlogPosts` (постраничный обход для sitemap/RSS/
  generateStaticParams, потолок 50 страниц), `getBlogPost`. Каждый вызов
  — `next: { revalidate: BLOG_REVALIDATE_SECONDS }` (900 с), сетевые
  ошибки перехватываются в `null`, а не роняют сборку (§38.2).
- **`landing/src/dictionaries/{ru,uk,en,de,es}.json`** — новый namespace
  `blog` (16 ключей: заголовки, honesty-пометка, пагинация, CTA) и
  `header.blogLabel`; `Header.tsx` — ссылка на `/${locale}/blog`.
  `globals.css` — новая секция «Блог/новости» (~15 классов: сетка
  карточек, статья, честная пометка `.blog-notice`, встройка YouTube).
- **`app/[locale]/blog/page.tsx`** и **`app/[locale]/blog/[slug]/page.tsx`**
  — SSG + `revalidate` (§38.2), НЕ клиентский fetch на каждый заход
  (TODO §II.3). `generateStaticParams` у `[slug]` получает уже
  разрешённый родителем `locale` через `{ params }` и добывает слаги
  через `listAllBlogPosts()`. Честная пометка `isRequestedLocale`
  (§38.3): `.blog-notice` в UI, `robots: { index: post.isRequestedLocale,
  follow: true }` в метаданных — не индексировать оригинал ПОД ЧУЖИМ
  языком, но не прятать страницу от краулера целиком. Встройка YouTube
  по `videoId` через `youtube-nocookie.com`, обложка — прямая ссылка на
  `thumbnailUrl` (§38.6, права на чужие ролики).
- **`lib/content.ts`** — `SITE_URL` (новая, абсолютный адрес лендинга —
  впервые понадобился этому проекту, §38.4) и `SITE_NAME`.
- **Продвижение (TODO §II.5, §38.4):**
  - `app/sitemap.ts` (конвенция Next, `/sitemap.xml`) — статика всех
    пяти локалей + `/legal/*` + все записи блога по всем локалям.
  - `app/sitemap-news.xml/route.ts` — ОТДЕЛЬНЫЙ файл (схема Google News
    не входит в `MetadataRoute.Sitemap`), только записи не старше двух
    суток, `<news:publication>`/`<news:publication_date>`/`<news:title>`.
  - `app/robots.ts` (конвенция Next, `/robots.txt`) — ссылки на оба
    sitemap-файла.
  - `lib/rss.ts` (общий XML-сборщик) + `app/feed.xml/route.ts` (общая
    лента) + `app/feed/[category]/route.ts` (по категории) — TODO
    §II.4. Порог «оценка Gemini высокая» уже применён на бэкенде
    (`BLOG_MIN_SCORE_TO_DRAFT`, этап 57) — повторной фильтрации по
    `score` на фронтенде нет и не может быть (`PublicBlogPostListItem`
    его не отдаёт, §36.4). Локаль — `defaultLocale`, переопределяется
    `?locale=`.
  - JSON-LD `NewsArticle`+`BreadcrumbList` на `[slug]/page.tsx` — все
    `url`/`item` абсолютные через `SITE_URL`; Open Graph/Twitter Card на
    обеих страницах блога.
  - Честная оговорка про Google News (организационная заявка, не
    гарантия от самого файла) — зафиксирована в ТЗ §38.4 и
    `doc/ACCEPTANCE-CHECKLIST.md`, не только в TODO.
- **`middleware.ts`** — новое исключение `feed` в матчере (§38.5):
  `/feed/[category]` без точки в пути не ловится общим `.*\..*`, как
  `sitemap-news.xml`/`feed.xml` (у тех есть точка в имени).
- **Docker/env.** `landing/.env.example` — `API_BASE_URL` (БЕЗ
  `NEXT_PUBLIC_` — сервер, а не браузер, ходит за блогом, см. §38.2) и
  `SITE_URL`. `docker-compose.dev.yml` — `landing`-сервис получил оба
  (`API_BASE_URL=http://backend:3000/api` — DNS-имя сервиса, не
  `localhost`, потому что запрос идёт из контейнера, а не из браузера;
  `depends_on: backend`, которого раньше не было — сервис от него
  реально не зависел, пока не начал ходить в его API). `doc/DEPLOYMENT.md`
  §4 — обе переменные добавлены в шаги Vercel-деплоя, уточнено, что
  `CORS_ORIGIN` трогать всё равно не нужно (запрос сервер-сервер, не из
  браузера — ровно та причина, что раньше объясняла «CORS трогать не
  нужно» вообще, только раньше был отдельный корректный повод —
  «лендинг статический», а не тот, что подразумевает текущий).
- **Проверено.** `admin/`: `npx tsc --noEmit`, `npx eslint --max-warnings
  0`, `next build` — чисто, `/blog` в списке маршрутов. `landing/`: то
  же самое — чисто, `/feed.xml`, `/feed/[category]`, `/robots.txt`,
  `/sitemap-news.xml`, `/sitemap.xml`, `/[locale]/blog`,
  `/[locale]/blog/[slug]` все собираются (при недоступном на сборке
  бэкенде — честно с пустым списком, не падением). `check-docs.mjs` —
  зелёный (новые `process.env.*`, `API_BASE_URL`/`SITE_URL`,
  задокументированы в `landing/.env.example` и
  `docker-compose.dev.yml`; счётчики миграций/таблиц/тестов не менялись
  — backend не тронут). `backend/`: не менялся, отдельная проверка не
  требовалась.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §38).**
  Разбивка RSS по локали отдельными файлами — только `?locale=`.
  Og-image-заглушка для ручных записей без `thumbnailUrl`. Реальная
  подача заявки в Google Publisher Center — организационный шаг вне
  кода.

## Этап 59 — локализация ИИ-вывода продукта под язык пользователя (ТЗ §35.5, §39)

Закрывает открытый вопрос 35.2: разбор референсного ролика, распознавание
товара по фото, отчёт о релевантности и пост-генерационный аудит ролика
теперь отвечают на UI-локали пользователя (ru/uk/en/de/es), а не жёстко
по-русски или по эвристике без связи с интерфейсом. Veo-промпт/озвучка/
диалог ролика намеренно вне области — их язык определяется рынком
рекламы, а не языком интерфейса продавца (ТЗ §39).

**Сделано (этап 59).**

- **`backend/src/common/locale.ts`** (новый) — `SUPPORTED_LOCALES`,
  `DEFAULT_LOCALE`, `isSupportedLocale`, `normalizeLocale`,
  `LOCALE_LANGUAGE_NAMES`, `languageNameForLocale` (явное имя языка,
  находка §35.1 — «Ukrainian», не «uk»); вынесены из
  `grok/grok-translation-prompt.ts` (единственного места, где раньше
  жили), который теперь их реэкспортирует — существующие вызовы и тесты
  не тронуты.
- **`Session.locale`** — новое опциональное поле в
  `common/types/session.types.ts`, хранится в существующей JSON-колонке
  `Session.data` (миграция Prisma не нужна), проставляется один раз при
  создании сессии (`SessionService.createSession`) и остаётся неизменным
  весь её срок жизни; при отсутствии — `normalizeLocale()` даёт `'ru'`
  (обратная совместимость со старыми клиентами и уже созданными
  сессиями). Точки входа: `POST /sessions` (`CreateSessionRequestDto`,
  новый) и `POST /projects/:id/items/:itemId/sessions`
  (`CreateSessionFromItemDto`, новый) — оба `@IsOptional() @IsIn(SUPPORTED_LOCALES)`.
- **`AnalysisService`** (§39.2 — кэшируется в `LibraryService`, поэтому
  особый случай: пост-перевод, а не прямая генерация). Новый
  `analysis/analysis-translation.ts` — `buildAnalysisTranslationPrompt`
  (текстовый, дешёвый, отдельный вызов Gemini) + `applyAnalysisTranslation`
  (терпимый парсер по стабильным `id` в `characters`/`scenes`/`extras`,
  никогда не бросает — при сбое тихий откат на английский оригинал).
  Каноническая англоязычная генерация и кэш `AnalysisLibraryEntry` не
  меняются; перевод применяется только к копии, отдаваемой запросившей
  сессии, и никогда не пишется обратно в библиотеку. Новая операция учёта
  расхода `'analysis-translate'` (`common/ai-pricing.ts`,
  `admin/src/lib/money.ts`) — отдельной строкой от дорогой `'analysis'`.
- **`ProductRecognitionService`** — прямая генерация на целевом языке:
  `dto/process-photo-request.dto.ts` получил `locale?`
  (`ProcessPhotoRequestDto`), `product-analog.service.ts` прокидывает его
  в `product-recognition.service.ts`. `title` остаётся на языке оригинала
  упаковки (имя собственное); `category`/`audience.summary/interests`
  всегда следуют UI-локали — старый фолбэк «язык упаковки, иначе русский»
  убран.
- **`RelevanceService`** — `relevance-response.ts`: `relevancePrompt`
  получил параметр `languageName` (дефолт `'Russian'` — старое поведение
  для вызовов без явной локали, включая существующие тесты),
  `parseRelevanceResponse` — параметр `locale` (только для фолбэка «модель
  не дала summary», пятиязычный словарь `NO_SUMMARY_FALLBACK`). Сервис
  берёт `session.locale` и передаёт оба. `promptAdvice`/`adjustments`
  теперь тоже локализованы — включая то, что они ЗАТЕМ идут в англоязычный
  Veo-брифинг через `relevanceBriefText()` (осознанный компромисс, §39.3).
- **`VideoAuditService`** — `audit-response.ts`: `auditPrompt`/
  `manualFixPrompt` получили `languageName` (тот же дефолт-фолбэк
  `'Russian'`), `parseAuditResponse` — `locale` (фолбэки
  `EMPTY_RESPONSE_FALLBACK`/`CLEAN_FALLBACK`/`ISSUES_FOUND_FALLBACK`, по
  пять языков каждый). `promptFix.suggestedText` остаётся нетронутым (тот
  же язык/формат, что у исходного промпта — уходит обратно в Veo, не
  читается человеком). Хардкод `` `Пользователь указал: ${issue}` ``
  заменён на пятиязычный `USER_REPORTED_PREFIX` в самом сервисе.
- **Frontend** — `lib/i18n.ts` без изменений (только читается):
  `services/api.ts`: `createSession(locale?)` шлёт `{ locale }` в теле;
  `hooks/useWorkflow.ts` — вызывает с
  `readStoredLocale() ?? defaultLocale`; `services/projects-api.ts` —
  `uploadAndProcessPhoto` и `createSessionFromItem` добавили то же поле
  `locale` в тело запроса.
- **Новые тесты** — `common/locale.spec.ts` (8) и
  `analysis/analysis-translation.spec.ts` (7): 1125 → 1140 тестов, 98 → 100
  наборов (два новых чисто-логических модуля этого этапа, без Prisma —
  единственные новые файлы этапа, которые можно было реально прогнать в
  этой песочнице).
- **Проверено.** `backend/`: `npx tsc --noEmit` — 201 ошибка, все те же,
  что и до этого этапа (заблокированный `binaries.prisma.sh` в песочнице,
  без Prisma-клиента), новых ошибок нет; `npx eslint --max-warnings 0` на
  всех изменённых файлах — чисто после автоформатирования. Точечный
  прогон `jest` по изменённым модулям (`grok-translation-prompt`,
  `relevance`, `video-audit`, `product-analog.service`, `analysis`) — 46
  тестов прошли, 6 наборов падают на компиляции ИМЕННО из-за той же
  Prisma-заглушки (не из-за правок этапа), включая `session.service.ts`/
  `library.service.ts`, которые правки этапа не затрагивали по существу.
  `admin/`: `npx tsc --noEmit` — чисто (правка только в `money.ts`).
  `frontend/`: `npx tsc --noEmit`, `npx eslint --max-warnings 0` — чисто.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §39).**
  Отдельная ИИ-аннотация проекта из числа кандидатов §35.5 — по факту
  реализации такого поля в коде не нашлось (39.1). Смена локали сессии
  ПОСЛЕ её создания — не поддержана, локаль фиксируется один раз (39.2).

**Сделано (этап 60).**

- **Prisma**: enum `SharedVideoStatus { PENDING PUBLISHED REJECTED }` +
  модель `SharedVideoPage` (снимок без FK на `Session`, своя копия видео
  и фото товара под префиксом `shared-videos/<id>/`, поля
  `viewCount`/`firstGenerationCount` — миграция
  `20260913090000_shared_video_pages`; **27 миграций, 22 таблицы**.
- **`common/orphan-sweep.ts`** — новый scope `'shared-videos'`
  (`SWEEP_PREFIX`, `sweepFileKind` для видео/фото/прочего);
  `cron.controller.ts.liveOwners()` — ветка по
  `prisma.sharedVideoPage.findMany`.
- **Найденный попутный дефект (§40.8 SPEC)**: `SessionService.toSession()`
  никогда не читал `data.locale` обратно — вся локализация этапа 59
  фактически не работала. Исправлено вместе с добавлением нового поля
  `Session.sharedFromPageId` (оба — в `DATA_KEYS` и в `toSession()`).
- **Новый модуль `backend/src/modules/shared-video/`** —
  `shared-video.service.ts` (`create`/`listForSession`/`withdraw`/
  `getPublic`/`fork`/`markConverted`/`list`/`get`/`approve`/`reject`,
  consultative lock `` `shared-video:${sessionId}` ``, best-effort
  `keepOwnCopy`/счётчики), `shared-video.controller.ts` (три контроллера:
  владелец под `TelegramIdentityGuard`, публичный без гварда — `GET
  /shared-video/:id` и `POST /shared-video/:id/fork`, операторский под
  `AdminSessionGuard`), `shared-video.module.ts`.
- **`GenerationService`** — best-effort
  `sharedVideos.markConverted(session.sharedFromPageId)` сразу после
  `GeneratedVideo.status = COMPLETE`.
- **Frontend (TMA)** — `services/api.ts.forkSharedVideo()`,
  `services/projects-api.ts` (`createSharedVideo`/`listSharedVideos`/
  `withdrawSharedVideo`), новая карточка `ShareVideoPanel.tsx` рядом с
  `PublishPanel.tsx` на экране готового ролика (тот же гейт
  `'publication'`), `useWorkflow.ts` — диплинк `?fromShared=<id>` на
  старте сессии вызывает форк вместо обычного создания.
- **`landing/`** — `lib/shared-video-api.ts` (server-only, `revalidate:
  300`), `app/video/[id]/page.tsx` (БЕЗ `[locale]`-сегмента —
  зафиксированная локаль снимка, `generateMetadata()` с Open Graph/
  Twitter Card/JSON-LD `VideoObject`), `components/ShareButtons.tsx`
  (`navigator.share` + фолбэк на буфер обмена), стили в `globals.css`,
  `middleware.ts` — маршрут `/video` исключён из редиректа на
  `[locale]` (та же причина, что у `/legal`).
- **`admin/`** — вкладка `/shared-videos` (копия скелета
  `/publications`: фильтр по статусу, таблица с превью, инлайн-форма
  причины отказа; для `PUBLISHED` — ссылка на живую страницу лендинга и
  счётчики `viewCount`/`firstGenerationCount`), пункт в `AdminNav.tsx`,
  `NEXT_PUBLIC_LANDING_URL` в `.env.example`.
- **Новые тесты** — `shared-video.service.spec.ts` (18) +
  `orphan-sweep.spec.ts` (+1, новый scope): 1140 → **1159 тестов**,
  100 → **101 набор**.
- **Проверено.** `backend/`: `npx tsc --noEmit` — новые ошибки только
  той же природы, что и старые 201 (заблокированный `binaries.prisma.sh`
  в песочнице — `sharedVideoPage`/`Prisma`/`Session` как несуществующие
  члены сгенерированного клиента), логических ошибок нет; `npx eslint
  --max-warnings 0` на изменённых файлах — чисто после автоформатирования;
  `orphan-sweep.spec.ts` (без Prisma-зависимости) реально прогнан — 12/12.
  `frontend/`, `landing/`: `npx tsc --noEmit`, `npx eslint --max-warnings
  0` — чисто; `landing/`: `npx next build` — успешно, новый маршрут
  `/video/[id]` (`ƒ`, серверный по требованию) собирается наравне с
  остальными. `admin/`: `npx tsc --noEmit`, `npx eslint --max-warnings 0`,
  `npx next build` — чисто, `/shared-videos` в списке маршрутов сборки.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §40 SPEC)**.
  Кнопка «Нравится» из исходной постановки TODO.md — не реализована
  (40.1). Извлечение кадра-постера из видео для OG-изображения — не
  реализовано, вместо него фото товара (40.2). Отдельная кнопка
  «Опубликовать в свой Telegram-канал» — не заведена, есть только
  общий `navigator.share` (40.4).

**Сделано (этап 61).**

- **Prisma**: `enum ChannelStatus { ACTIVE REVOKED EXPIRED }`,
  `enum PublicationPrivacy { PRIVATE UNLISTED PUBLIC }`, модель
  `PublishingChannel` (userId, platform — переиспользован существующий
  `PublicationPlatform`, новый enum не понадобился; externalId, title,
  avatarUrl, `accessTokenEnc`/`refreshTokenEnc`/`expiresAt`/`scopes`,
  status, `@@unique([platform, externalId])`). На `PublicationRequest` —
  `channelId`/`attempts`/`nextAttemptAt`/`uploadJobId`/`privacy`. На
  `Project` и `BrandManifest` — `youtubeChannelId`/`tiktokChannelId`
  (канал по умолчанию) — миграция `20260914090000_publishing_channels`;
  **28 миграций, 23 таблицы**.
- **`backend/src/common/token-crypto.ts`** (новый) — `encryptToken`/
  `decryptToken`, AES-256-GCM, ключ `CHANNEL_TOKEN_KEY` (32 байта
  base64), проверка формата ключа лениво при первом вызове.
- **Новый модуль `backend/src/modules/publishing-channel/`** —
  `oauth-state.util.ts` (HMAC-подписанный `state`, TTL 10 минут),
  `google-oauth.service.ts`/`tiktok-oauth.service.ts` (сырой `axios`,
  без `googleapis` — по конвенции проекта), `publishing-channel.service.ts`
  (`buildAuthUrl`/`handleCallback`/`disconnect`/`ensureFreshToken`/
  `listForUser`), `publishing-channel.controller.ts` (identity:
  `POST /channels/oauth/:platform/start`, `GET /channels`,
  `DELETE /channels/:id`; публичный: `GET /channels/oauth/:platform/
  callback` — редиректит браузер обратно в TMA через `TMA_PUBLIC_URL`,
  новое поле конфигурации `publishing.tmaUrl`), `publishing-channel.module.ts`.
- **Новый модуль `backend/src/modules/publishing/`** —
  `youtube-upload.service.ts` (resumable-сессия одним PUT, `uploadJobId`
  как форензик-след, идемпотентность по `externalId`),
  `tiktok-upload.service.ts` (`init`/`uploadBytes`/`pollStatus`,
  `publish_id` сохраняется как `uploadJobId` СРАЗУ после `init` — до
  `uploadBytes` — чтобы обрыв сети не открыл вторую сессию; приватность
  захардкожена `SELF_ONLY` — платформенное ограничение для
  неаудированных приложений), `publish-worker.service.ts` (`runBatch()`:
  до `PUBLISH_CRON_BATCH` заявок `APPROVED` с каналом и просроченным
  `nextAttemptAt`, per-row try/catch — одна упавшая заявка не
  останавливает батч; бэкофф `2^attempts` минут, `FAILED` после
  `PUBLISH_MAX_ATTEMPTS`), `publishing.module.ts`. Новый крон-роут
  `GET /api/cron/publish` (`cron.controller.ts`), `backend/vercel.json`
  — `{"path": "/api/cron/publish", "schedule": "*/2 * * * *"}`
  (**требует план Vercel Pro** — Hobby не запускает крон чаще раза в
  сутки, зафиксировано в `doc/DEPLOYMENT.md`).
- **`PublicationService.approve()`** — новый DTO
  `ApprovePublicationRequestDto` (`channelId?`, `privacy?`), новый
  приватный `resolveChannelId()` (явный `channelId` → канал проекта →
  канал бренд-манифеста → единственный ACTIVE-канал автора этой
  платформы → `null`, заявка остаётся APPROVED без канала — это не
  ошибка выгрузки). Новый публичный `retry()` (FAILED → APPROVED, сброс
  backoff) + `POST /admin/publications/:id/retry` — добавлен как
  естественное расширение при работе над одобрением, т.к. кнопка
  «Повторить» в разделе 11 плана этапа требовала маршрут, которого не
  было явно перечислено в бэкенд-части плана.
- **`admin/`** — `/publications`: одобрение через инлайн-форму
  (приватность select, необязательный `channelId` текстом — не
  выпадающий список, эндпоинта «каналы произвольного пользователя» в
  админке нет), новая колонка «Выгрузка» (нет канала / ждёт воркера /
  опубликовано со ссылкой / опубликовано без публичной ссылки — TikTok
  / ошибка с текстом и кнопкой «Повторить»); `types.ts`/`endpoints.ts` —
  новые поля `PublicationRequest`, `PublishingChannel`,
  `retryPublication()`.
- **Frontend (TMA)** — новый экран `features/channels/ChannelsScreen.tsx`
  (`#/channels`, верхнеуровневый маршрут — как `#/plan`, ссылка в
  подвале, три вкладки навигации и так упираются в ширину 390px):
  список каналов, кнопки «Подключить YouTube»/«Подключить TikTok»
  (`POST /channels/oauth/:platform/start` → `window.location.href`),
  «Отключить». `services/projects-api.ts` — `listChannels`/
  `startChannelOAuth`/`disconnectChannel`. `PublishPanel.tsx` —
  подсказка под платформой теперь отражает реальный статус подключения
  канала (было — статичный текст «канал проекта»), ссылка на экран
  «Каналы», текст `publishError` для `FAILED`-заявок (раньше — только
  бейдж без текста), предупреждение «канал не подключён» для
  `APPROVED`-заявок без `channelId`. Все 5 словарей локализации
  (`ru`/`uk`/`en`/`de`/`es`) обновлены: новый раздел `channelsScreen`,
  переформулирован `publishPanel.hint`/`approvedNote` (выгрузка больше
  не «отдельное ТЗ», а автоматическая).
- **Новые тесты** — `common/token-crypto.spec.ts` (8),
  `publishing-channel/google-oauth.service.spec.ts` (9),
  `publishing-channel/tiktok-oauth.service.spec.ts` (9),
  `publishing-channel/publishing-channel.service.spec.ts` (16),
  `publishing-channel/oauth-state.util.spec.ts` (7),
  `publishing/publish-worker.service.spec.ts` (11),
  `publication.service.spec.ts` (+10 — разрешение канала §14.2 и
  `retry`): 1159 → **1229 тестов**, 101 → **107 наборов**.
- **Проверено.** `backend/`: `npx tsc --noEmit` — новые ошибки только
  той же природы, что и старая база (заблокированный
  `binaries.prisma.sh` в песочнице — `publishingChannel` и новые поля
  как несуществующие члены сгенерированного клиента), логических ошибок
  нет; `npx eslint src --max-warnings 0` — чисто на всём `backend/src`
  (не только на изменённых файлах). Чисто-логические новые наборы без
  Prisma-зависимости реально прогнаны в песочнице:
  `token-crypto.spec.ts` — 8/8. `admin/`: `npx tsc --noEmit`, `npx
  eslint --max-warnings 0`, `npx next build` — чисто, `/publications`
  в списке маршрутов сборки. `frontend/`: `npx tsc --noEmit`, `npx
  eslint src --max-warnings 0`, `npx vite build` — чисто, новый экран
  `/channels` собирается.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §14
  SPEC)**. Аудит соответствия у Google/TikTok — организационный шаг вне
  кода; до него TikTok принудительно `SELF_ONLY` (14.1). Автообложка
  ролика (кадр из видео) — не реализована, площадки генерируют превью
  сами (14.2). Перевод `title`/`description` под язык канала — не
  реализован, публикуется как введено в форме (14.3).

**Сделано (этап 62).**

- **Prisma**: enum'ы `PaymentMethod{STARS WAYFORPAY}`,
  `PaymentPurpose{SUBSCRIPTION CREDIT_PACK}`,
  `PaymentStatus{PENDING SUCCEEDED FAILED REFUNDED}`,
  `SubscriptionStatus{ACTIVE PAST_DUE CANCELED}`,
  `CreditLedgerReason{PURCHASE CONSUME REFUND ADMIN_ADJUST}`; модели
  `Payment` (`@@unique([method, providerRef])` — идемпотентность против
  повторной доставки вебхука), `Subscription` (`userId @unique` — одна
  активная подписка на пользователя, `recTokenEnc`, `cancelAtPeriodEnd`),
  `CreditLedger` (`delta`, `@@unique([generatedVideoId, reason])` —
  идемпотентный резерв/возврат по одной попытке рендера) — миграция
  `20260916090000_billing`; **29 миграций, 26 таблиц**.
- **`backend/src/common/billing-pricing.ts`** (новый) — таблица цен
  подписок/пакетов кредитов в XTR и в минорных единицах WayForPay,
  плейсхолдеры с env-переопределением, тем же приёмом, что
  `spend-limits.ts`.
- **`backend/src/modules/credit-ledger/`** (новый) —
  `CreditLedgerService.balanceOf`/`reserveForGeneration` (атомарная
  транзакция: баланс > 0 → `INSERT CONSUME delta=-1`)/
  `refundIfReserved`/`grant`. Инжектится независимо в `generation` и в
  `billing`, `PlanService`/`AiUsageService` не изменены.
- **`backend/src/modules/billing/`** (новый) —
  `telegram-webhook-secret.ts` (fail-closed, по образцу
  `cron-secret.ts`), `stars-invoice-payload.util.ts`,
  `telegram-stars.service.ts` (`createInvoiceLink`/
  `answerPreCheckoutQuery`/`refundStarPayment`), `wayforpay.service.ts`
  (подписанная форма покупки + проверка вебхука + регулярный платёж по
  `recToken`), `billing.controller.ts` (`POST
  /billing/checkout/subscription|credit-pack`, `POST
  /billing/webhook/telegram|wayforpay`), `billing.service.ts`.
- **`backend/src/modules/billing-renewal/`** (новый) —
  `wayforpay-renewal.service.ts` (списание по `recTokenEnc`, backoff
  при отказе), `stars-subscription-reconcile.service.ts` (сверка
  `currentPeriodEnd` без вебхука продления → `PAST_DUE` → `CANCELED`),
  `billing-renewal-worker.service.ts`. Новый крон-маршрут `GET
  /api/cron/billing-renew` (`cron.controller.ts`), `backend/vercel.json`
  — `{"path": "/api/cron/billing-renew", "schedule": "0 5 * * *"}`
  (раз в сутки — Vercel Pro для НЕГО не требуется, в отличие от
  `/api/cron/publish` этапа 61).
- **`generation.service.ts`** — `generateVideo()` резервирует кредит
  ПЕРЕД суточным лимитом (`reserveForGeneration` → при отказе старый
  путь `assertCanSpendUser`), `markFailed()` — best-effort
  `refundIfReserved`.
- **`plan.service.ts`** — `setPlan(userId, 'LITE')` при включённой
  оплате ставит `cancelAtPeriodEnd: true` вместо мгновенного
  понижения; `setPlan(userId, 'STANDARD'|'PREMIUM')` отклоняется с
  указанием на `/billing/checkout/subscription`; новый
  `applyPurchasedPlan(userId, plan)` (только из вебхуков). `stateOf()`
  расширен `subscription`/`credits` — читает их напрямую через Prisma,
  без импорта `billing`. **Найденный и исправленный попутный дефект**:
  `plan.controller.ts` объявлял `PlanStateView` без полей
  `subscription`/`credits`, хотя `stateOf()` их уже возвращал — тип
  собирался благодаря структурной типизации TS (excess-property check
  не применяется к переменным), но интерфейс был неполным; исправлено
  добавлением полей.
- **Admin**: `admin-users.service.ts` — `subscriptionsFor()`,
  `cancelSubscription()`, `toSummary()` несёт `credits`/`subscription`;
  `admin-billing.service.ts` (новый) — `listPayments`/`refund` (Stars —
  реальный вызов, WayForPay — только пометка `REFUNDED`, см. открытый
  вопрос 41.5 SPEC); `admin-panel.controller.ts` — `POST
  users/:id/cancel-subscription`, `GET payments`, `POST
  payments/:id/refund`. `admin/src/app/payments/page.tsx` (новый) —
  таблица оплат с фильтрами и возвратом; `admin/src/app/users/page.tsx`
  — колонка «Кредиты / подписка», кнопка «Отменить подписку».
- **Frontend TMA**: `services/billing-api.ts` (новый) —
  `getBillingPrices`/`startSubscriptionCheckout`/
  `startCreditPackCheckout`/`submitWayForPayForm` (POST-форма, не
  редирект — WayForPay подписывает набор полей, голый `window.location.href`
  их не унёс бы)/`pollPlanState`. `lib/telegram.ts` —
  `openStarsInvoice()` (`Telegram.WebApp.openInvoice`). Новый маршрут
  `#/credits` (`features/credits/CreditsScreen.tsx`) — покупка пакетов
  кредитов, отдельно от `#/plan` (доступна и на Lite). `PlanScreen.tsx`
  — кнопки покупки подписки (Stars/WayForPay), статус подписки, баланс
  кредитов, отмена подписки. `App.tsx` — `?billingReturn=1` после
  WayForPay-редиректа: снимает параметр, опрашивает `/me/plan` с
  бэкоффом. Все 5 словарей (`ru/uk/en/de/es`) расширены синхронно
  (`planScreen`, новый `creditsScreen`), сверено скриптом на совпадение
  ключей.
- **Конфигурация**: `backend/.env.example`, `.env.docker.example`,
  `docker-compose.dev.yml` (`x-backend-env`) — новые переменные
  секции «Оплата» (§41 SPEC).
- **Проверка**: `npx tsc --noEmit` в `backend/` — без новых ошибок
  сверх известного ограничения песочницы (не сгенерирован
  Prisma-клиент под `Payment`/`Subscription`/`CreditLedger`); `npx eslint
  --max-warnings 0` — чисто. Точечный `jest` для чисто-логических
  модулей (`credit-ledger.service.spec.ts` и т. п.) в этой песочнице не
  прогоняется — ts-jest типизирует и исходный файл под тестом, а не
  только сам спек, и падает на тех же отсутствующих полях
  `PrismaService`, что и `tsc` без сгенерированного клиента (подтверждено
  прямым запуском `npx jest`); `npx tsc --noEmit` остаётся единственной
  надёжной автоматической проверкой в песочнице для billing-модулей.
  `admin/`: `npx tsc --noEmit`, `next build` — чисто, `/payments`
  собирается. `frontend/`: `npx tsc --noEmit`, `npx eslint --max-warnings
  0`, `npx vite build` — чисто, новые маршруты `/plan`/`/credits`
  собираются.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §41
  SPEC)**. Точные цены подписок/пакетов — плейсхолдеры (41.1). Реальный
  статус мерчант-аккаунта WayForPay (regular payments) — вне кода
  (41.2). Юридические требования SCA для ЕС — не исследовано (41.3).
  Живой курс для `amountMicroUsd` — фиксированный в коде, не биржевой
  (41.4). Автоматизация возврата средств по WayForPay — только пометка
  статуса, реальный возврат вручную в кабинете WayForPay (41.5).

**Сделано (этап 63).**

- **Prisma**: `User.marketingConsentAt`/`marketingConsentRevokedAt`
  (две даты, не булев флаг — по образцу `termsAcceptedAt`),
  `SharedVideoPage.featuredInBroadcastAt` +
  `@@index([status, featuredInBroadcastAt])`; enum
  `MarketingDeliveryStatus{PENDING SENT FAILED SKIPPED}`, модели
  `MarketingBroadcast` (`sharedVideoPageIds: String[]` — снимок id, без
  FK) и `MarketingDelivery` (`@@unique([broadcastId, userId])` —
  идемпотентность против повторной сборки выпуска,
  `@@index([status, nextAttemptAt])`) — миграция
  `20260916090000_marketing_broadcast`; **30 миграций, 28 таблиц**.
  Проверено применением всех 30 миграций подряд к реальному локальному
  Postgres 16 в этой песочнице (найден в окружении в этом этапе — новая
  возможность верификации, сильнее прежней ручной сверки SQL).
- **`configuration.ts`** — секция `marketing`
  (`frequencyDays`/`pageCount`/`cronBatch`/`maxAttempts`/`landingUrl`),
  все поля со значениями по умолчанию.
- **`backend/src/modules/marketing/`** (новый) —
  `marketing-consent.service.ts` + `.controller.ts` (`GET/POST
  /me/marketing-consent`, `POST /me/marketing-consent/revoke`, за
  `TelegramIdentityGuard`, по образцу `legal.service.ts`, но без версии
  документа), `marketing-broadcast.service.ts`
  (`MarketingBroadcastService.runDaily()` — сборка выпуска раз в
  `frequencyDays` дней + доставка партии с бэкоффом `2^attempts` минут,
  формула буквально та же, что `PublishWorkerService.recordFailure`,
  этап 61; авто-отписка одной транзакцией при ответе Telegram `bot was
  blocked`), `marketing.module.ts`.
- **`cron.controller.ts`** — новый маршрут `GET
  /api/cron/marketing-broadcast`; `backend/vercel.json` — `{"path":
  "/api/cron/marketing-broadcast", "schedule": "0 7 * * *"}` (раз в
  сутки, седьмой крон-слот — тот же приём экономии, что у `/cron/blog`,
  этап 57: сборка выпуска и доставка партии в ОДНОМ маршруте).
- **Admin**: `admin-marketing.service.ts` (новый) —
  `listBroadcasts()` — история выпусков со сводкой доставки на каждый
  (`groupBy` по `status`) и текущим числом активных подписчиков;
  `admin-panel.controller.ts` — `GET /admin/marketing/broadcasts`.
  `admin/src/app/marketing/page.tsx` (новый) — read-only таблица;
  `AdminNav.tsx` — пункт «Рассылка».
- **Frontend TMA**: `services/marketing-api.ts` (новый) —
  `getMarketingConsent`/`acceptMarketingConsent`/
  `revokeMarketingConsent`, тот же паттерн `isUnauthorized`, что у
  остальных identity-маршрутов. `PlanScreen.tsx` — новая карточка
  «Рекламный канал» после карточек режимов (подписаться/отписаться, с
  confirm на отписку, как у `cancelSubscription`), появляется только у
  идентифицированного пользователя. Все 5 словарей (`ru/uk/en/de/es`)
  расширены новым `marketingConsent`, сверено скриптом на совпадение
  ключей (найденные расхождения — только ожидаемое исключение
  `PluralForms`, задокументированное в `get-dictionary.ts`, самого
  `marketingConsent` среди них нет).
- **Конфигурация**: `backend/.env.example` — секция «Рассылка:
  рекламный канал» (`MARKETING_BROADCAST_FREQUENCY_DAYS`/
  `MARKETING_BROADCAST_PAGE_COUNT`/`MARKETING_CRON_BATCH`/
  `MARKETING_MAX_ATTEMPTS`, все со значениями по умолчанию в коде);
  `LANDING_PUBLIC_URL` (новая, для ссылок в сообщении рассылки) — в
  `.env.docker.example` и захардкожена в `docker-compose.dev.yml`
  (`x-backend-env`, `http://localhost:3003`), тем же приёмом, что
  `API_PUBLIC_URL`/`TMA_PUBLIC_URL` этапа 61 — не секрет, а адрес
  самого стенда.
- **`doc/legal/terms-of-use.md`** — новый пункт 7.5: рассылка
  добровольна, отписка в один клик, блокировка бота снимает согласие
  автоматически. `TERMS_VERSION`/шапка документа НЕ менялись (не
  форс-переприятие).
- **Найденный и исправленный попутный дефект (не связан с этим
  этапом)**: `marketing-broadcast.service.spec.ts` в черновике не
  восстанавливал `process.env.TELEGRAM_BOT_TOKEN` после тестов,
  устанавливающих его в `'bot-token'` — в реальном прогоне (не в этой
  песочнице, где сам файл не компилируется из-за отсутствующего
  Prisma-клиента) это протекло бы в `env-settings.spec.ts` того же
  Jest-воркера. Исправлено сохранением/восстановлением исходного
  значения в `afterAll`, по образцу `ffmpeg-api.service.spec.ts`.
- **Проверка**: `npx tsc --noEmit` в `backend/` — без новых ошибок
  сверх известного ограничения песочницы (не сгенерирован
  Prisma-клиент под `MarketingBroadcast`/`MarketingDelivery`); `npx
  eslint --max-warnings 0` — чисто. Новые `*.spec.ts`
  (`marketing-consent.service.spec.ts`,
  `marketing-broadcast.service.spec.ts`,
  `admin-marketing.service.spec.ts`) написаны и типятся, но не
  прогоняются в этой песочнице по той же причине, что billing-спеки
  этапа 62 (`tsc`/`eslint` — единственная надёжная автопроверка здесь).
  `admin/`: `npx tsc --noEmit`, `npx eslint --max-warnings 0`, `next
  build` — чисто, `/marketing` собирается. `frontend/`: `npx tsc
  --noEmit`, `npx eslint --max-warnings 0`, `npx vite build` — чисто,
  новая карточка на `/plan` собирается. `node scripts/check-docs.mjs` —
  0 расхождений.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §42
  SPEC)**. Согласие НЕ гейтит бесплатный доступ технически — механизм
  принуждения решается отдельно (42.1). Отбор контента для выпуска —
  полностью автоматический, без ручной кураторской подборки оператором
  (42.2). Проактивное обнаружение блокировки бота через `my_chat_member`
  — не реализовано, только реактивная проверка при попытке отправки
  (42.3). Формат сообщения — простой текст со ссылками, не
  `sendMediaGroup` с превью-картинками (42.5).

**Сделано (этап 64 — исправление высоких находок аудита 2026-09-08, см.
§43 SPEC; отдельный файл отчёта не сохранился в репозитории — находка
Д-6.6 пятого аудита, `doc/AUDIT-2026-09-09-round5.md`).**

- **Г-4.1 (база).** 8 ручных миграций несли `updatedAt` без `DEFAULT
  now()` там, где Prisma-схема его ожидает (расхождение всплыло бы при
  `prisma migrate diff` против схемы) — добавлен дефолт в самих файлах
  миграций, без новой миграции поверх (миграции этих таблиц ещё не
  накатывались в проде).
- **Г-2.1/2.2/2.5/2.7 (деньги, подписки).** Подтверждение оплаты
  Stars/WayForPay синхронизировано с продлением `Subscription` в одной
  транзакции — расхождение «платёж зафиксирован, подписка не продлена»
  закрыто.
- **Г-2.3 (деньги, кредиты).** Кредит, списанный на старт генерации,
  возвращается при сбое самого СТАРТА (до того, как Veo начал
  рендерить) — раньше деньги терялись без единого рендера.
- **Г-2.4 (деньги, WayForPay).** Ответы `Declined`/`Expired` (не только
  `Approved`) обрабатываются explicit-веткой вместо попадания в
  постоянный `FAILED` без права повтора тем же `orderReference`.
- **Г-2.11 (деньги, публикация).** `publish-worker.service.ts` (этап
  61) захватывает заявку атомарным `UPDATE ... WHERE status = ...
  RETURNING` перед выгрузкой — конкурентный крон/ручной триггер больше
  не может опубликовать один и тот же ролик дважды.
- **Г-3.1/3.2 (безопасность, блог).** HTML блога (этап 57/58)
  санитайзируется перед рендером; JSON-LD (`NewsArticle`) собирается
  через `JSON.stringify` с экранированием `</script>` вместо
  конкатенации строк — закрыт путь инъекции через ИИ-сгенерированный
  текст статьи.
- **Г-3.3 (безопасность, платежи).** `recToken`/`cardPan`/`authCode`
  вычищаются из `Payment.rawPayload` перед записью — вебхук WayForPay
  хранится без токенизированных платёжных полей.
- **Г-1.1/1.2 (продукт, шеринг).** Переход «сделать такой же» с
  публичной страницы (этап 60) больше не заводит цикл редиректа.
- **Г-1.3 (продукт, Stars).** Статус `pending` от Telegram Stars
  (оплата прошла, подтверждение идёт) обрабатывается как успех, не как
  отказ — для покупки кредитов и подписки, тем же приёмом, что раньше
  был исправлен для генерации.
- **Г-1.4 (продукт, OAuth).** Авторизация YouTube (этап 61) открывается
  через `WebApp.openLink`, не `window.open`; исправлен адрес возврата
  колбэка.
- **Г-1.5 (продукт, WayForPay).** Экран оплаты после редиректа обратно
  в TMA показывает однозначный результат («оплачено» / «не прошло»)
  вместо бессрочного спиннера.
- **Г-5.1 (мультиязычность, слой ошибок).**
  `frontend/src/hooks/useWorkflow.ts` — все ~14 мест с русским текстом
  ошибки переведены на `dict.wizardErrors.*`/`dict.errors`, `dict`
  добавлен в зависимости соответствующих `useCallback` (13 мест,
  `react-hooks/exhaustive-deps`).
- **Г-5.2 (мультиязычность, сервер).** `common/locale.ts` — новые
  `localeFromHeader`/`localeFromRequest` (парсинг `Accept-Language`,
  дефолт `ru` при отсутствии заголовка или пустых mock-заголовках в
  тестах). `plansFor(locale)` (`common/plans.ts`) и `creditPacks(locale,
  env)`/`creditPackById(packId, locale, env)` (`common/billing-pricing.ts`)
  переводят `summary`/`title` под локаль, не трогая
  `title`/`features`/цены; заодно исправлен реальный дефект —
  `creditPackById` раньше передавал `env` вторым позиционным
  аргументом туда, где `creditPacks` ждала `locale`. `plan.controller.ts`/
  `billing.controller.ts` читают локаль из запроса и передают в сервисы.
  `HttpExceptionFilter` — 500-й текст ошибки теперь тоже на локали
  запроса (`internalErrorMessage(locale)`, `INTERNAL_ERROR_MESSAGE`
  оставлен экспортом для обратной совместимости старых тестов).
  `frontend/src/services/api.ts` — интерцептор отправляет заголовок
  `Accept-Language` с ФАКТИЧЕСКИ отрисованной локалью
  (`initialLocale(...)`, та же функция, что резолвит `I18nContext`), а
  не только с явно сохранённой пользователем (`readStoredLocale()` —
  `null`, пока переключатель не тронут вручную).
- **Г-6.1 (документы/код).** `admin-panel/env-settings.ts` — проверка
  `PAYMENT_TOKEN_KEY` считает переменную в порядке только когда она
  задана И имеет верный формат (`set && validFormat`), не когда она
  просто отсутствует (`!set || validFormat`).
- **Г-6.2/Г-6.3 (документы).** Счётчик тестов в четырёх документах
  (`IMPLEMENTATION-PLAN.md`, `ACCEPTANCE-CHECKLIST.md`, `README.md`,
  `CI.md`) сверен на статическую оценку 1407/122 с объяснением, почему
  это оценка, а не факт (см. §43.6 SPEC). `DEPLOYMENT.md` — добавлен
  недостававший блок переменных блога (`GROK_API_KEY`,
  `GROK_MODEL`, `BLOG_CATEGORIES` и 4 остальных, этап 57).
- **Г-6.4 (юр. документы + код).** `billing.service.ts` —
  `startSubscriptionCheckout()`/`startCreditPackCheckout()` вызывают
  `LegalService.assertAccepted(userId)` первой строкой (тот же приём,
  что уже стоял перед анализом, этап 24b/38) — оплата больше не
  проходит для пользователя, не принявшего оферту.
  `billing.module.ts` — явный `imports: [LegalModule]` (модуль не
  `@Global()`, в отличие от остальных зависимостей billing).
  `doc/legal/offer.md`/`terms-of-use.md` — версия `2026-09-08`
  (`TERMS_VERSION` синхронно бампнут в `legal.service.ts`,
  `sync-legal.mjs` перегенерировал `legal-content.ts` в `frontend/` и
  `landing/`); тексты дополнены разделами про подписки/пакеты
  кредитов/14-дневный отказ/Stars/WayForPay (оферта §6), YouTube/TikTok
  OAuth и API Services disclosures (условия §8), публичные страницы и
  блог/ИИ-разметку (оферта §5.7, условия §9), категории данных и
  трансграничную передачу (условия §7.6–7.9), новый §13 оферты
  «Открытые вопросы» — см. §43.7 SPEC. `PlanScreen.tsx`/
  `CreditsScreen.tsx` — ссылки на оферту/условия под кнопками оплаты
  (паттерн `TermsGate.tsx`), новый ключ `legalNotePrefix` в
  `planScreen`/`creditsScreen` всех 5 словарей.
- **Проверка.** `backend/`: `npx tsc --noEmit` (отфильтровано от
  известного ограничения песочницы без Prisma-клиента) — чисто; `npx
  eslint --max-warnings 0` на всех изменённых файлах — чисто. Реально
  прогнаны в песочнице (не упираются в Prisma-клиент):
  `plans.spec.ts`, `billing-pricing.spec.ts` (новый),
  `http-exception.filter.spec.ts`, `env-settings.spec.ts` — все
  проходят. `frontend/`: `npx tsc --noEmit`, `npx eslint --max-warnings
  0`, `npm test` (весь набор `scripts/*.test.ts`), `npx vite build` —
  чисто. `landing/` и `admin/`: `npx tsc --noEmit`, `next lint`, `next
  build` — чисто, включая страницы `/legal/offer`/`/legal/terms-of-use`
  на перегенерированном `legal-content.ts`. `node
  scripts/check-docs.mjs` — 0 расхождений. `node scripts/sync-legal.mjs
  --check` — версии синхронны.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §43
  SPEC).** Реквизиты исполнителя в оферте §12 — плейсхолдеры, платные
  функции формально не готовы к продакшену до их заполнения (43.1).
  Экран явного согласия на немедленное исполнение цифрового контента —
  текст в оферте есть, интерфейса нет (43.2). Украинский и англо-ЕС
  переводы документов — не сделаны машинным переводом умышленно, чтобы
  не выдать плохой юридический перевод за готовый (43.3).

**Сделано (этап 65 — пакетная генерация по каталогу, ТЗ §44, TODO
§III.5, см. §44 SPEC).**

- **Prisma/миграция.** `CatalogBatchRun`/`CatalogBatchItem` +
  `CatalogBatchItemStatus`, обратные связи на `Project`/`ProductItem`/
  `User`. Ручная миграция `20260917090000_catalog_batch_generation` —
  31 миграция, 30 таблиц после неё. Верифицирована применением ВСЕХ 31
  миграции подряд к реальному локальному Postgres 16 в песочнице
  (`postgresql-16` оказался установлен) — впервые в этом проекте
  миграции проверены не только чтением, а настоящим накатом на живую
  базу; `npx prisma migrate diff` по-прежнему недоступен (`403` на
  `binaries.prisma.sh`, тот же известный предел песочницы, даже с
  `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1`).
- **`configuration.ts`.** Секция `catalogBatch: { cronBatch,
  maxAttempts }` (`CATALOG_BATCH_CRON_BATCH`, по умолчанию 10;
  `CATALOG_BATCH_MAX_ATTEMPTS`, по умолчанию 5) — тот же вид, что у
  `publishing`/`marketing`.
- **`backend/src/modules/catalog-batch/`.** `CatalogBatchService`
  (`create()` — план → исходная сессия → её разбор в библиотеке →
  проверка/защитная полнота товаров → защита от повторного запуска →
  `$transaction`; `getStatus()` — живое чтение статуса рендера из
  сессии, без своей копии состояния) + `CatalogBatchController`
  (`POST`/`GET :batchId` за `TelegramIdentityGuard`) +
  `CatalogBatchWorkerService` (`runBatch()` — claim-цикл по образцу
  `PublishWorkerService`/`MarketingBroadcastService`, пять шагов на
  строку: сессия → перенос разбора → промпт → одобрение → старт
  рендера) + `CatalogBatchModule` (явный `imports:
  [ProjectSessionModule, LibraryModule, PromptModule,
  GenerationModule]` — ни один не `@Global()`). DTO:
  `StartCatalogBatchRequestDto`. `GET /api/cron/catalog-batch-run` в
  `cron.controller.ts`, восьмой крон-слот в `vercel.json`
  (`*/2 * * * *`).
- **Бэкоффа-бага, пойманного и исправленного до прогона.** Первая
  версия `recordFailure` писала `status: exhausted ? 'FAILED' :
  'PENDING'` — вернула бы retry-строку в `PENDING` и следующий тик
  (который отбирает ВСЕ `status:'PENDING'` без учёта `nextAttemptAt`)
  подхватил бы её немедленно, полностью обнуляя задержку бэкоффа.
  Исправлено сверкой с `MarketingBroadcastService.recordFailure`: и
  retry, и terminal ветки пишут `status: 'FAILED'`, различие —
  исключительно через `nextAttemptAt` (см. §44.3 SPEC).
- **Тесты.** `catalog-batch.service.spec.ts` (16 кейсов — план, поиск
  исходной сессии, проверка полноты/защита от повторного запуска,
  `getStatus` с живым чтением рендера) и `catalog-batch-worker.service.
  spec.ts` (11 кейсов — выборка, пять шагов подряд, claim, backoff vs
  terminal FAILED, изоляция ошибок между строками), по образцу
  `publish-worker.service.spec.ts`. Как и все Prisma-задевающие спеки в
  этом проекте, не компилируются в самой песочнице (`ts-jest` типизирует
  файл-объект тестируемого модуля против несгенерированного
  `PrismaService`, а не против моков) — тот же предел, что у
  `publish-worker.service.spec.ts`, проверено сравнением: он падает
  той же ошибкой. `npx tsc --noEmit`/`eslint --max-warnings 0` по всему
  затронутому коду — чисто.
- **Admin.** `/catalog-batches` — read-only список партий (проект,
  инициатор, сводка `pending/generating/done/failed` через `groupBy` на
  каждую партию отдельно), по образцу `/marketing` (этап 63).
  `AdminCatalogBatchService` + маршрут `GET /admin/catalog-batches` в
  `admin-panel.controller.ts`.
- **Frontend.** Точка входа — `CatalogBatchPanel` НЕ на `ProjectScreen`
  (отклонение от первоначального плана этапа — см. §44.5 SPEC), а на
  экране результата генерации (`GenerationWizard`, рядом с
  `PublishPanel`/`ShareVideoPanel`): решение по месту при реализации,
  задокументированное в SPEC. `CatalogBatchStartScreen` (выбор товаров,
  `#/projects/:id/catalog-batch/start/:sourceSessionId`) и
  `CatalogBatchProgressScreen` (статус партии с опросом раз в 8с,
  `#/projects/:id/catalog-batch/:batchId`) — два новых маршрута в
  `lib/router.ts` (+2 кейса в `scripts/router.test.ts`).
  `services/catalog-batch-api.ts`, новый namespace `catalogBatch` во
  всех 5 словарях (20 ключей, сверено скриптом — ключи идентичны во
  всех локалях).
- **Конфигурация.** `backend/.env.example`/`.env.docker.example` —
  `CATALOG_BATCH_CRON_BATCH`/`CATALOG_BATCH_MAX_ATTEMPTS`, обе
  закомментированы с умолчаниями (тот же приём, что у
  `MARKETING_CRON_BATCH`); `docker-compose.dev.yml` НЕ тронут — тот же
  прецедент, что у `MARKETING_CRON_BATCH`/`PUBLISH_CRON_BATCH`
  (опциональные тюнинговые переменные с безопасными умолчаниями из
  кода в стенд не попадают).
- **Проверка.** `backend/`: `npx tsc --noEmit` (отфильтровано от
  известного ограничения песочницы) — чисто; `npx eslint --max-warnings
  0` на всех новых/изменённых файлах — чисто. `frontend/`: `npx tsc
  --noEmit`, `npx eslint --max-warnings 0`, `npm test` (весь набор
  `scripts/*.test.ts`, включая расширенный `router.test.ts`), `npx vite
  build` — чисто. `admin/`: `npx tsc --noEmit`, `next lint` (через
  eslint), `next build` — чисто, включая новую страницу
  `/catalog-batches`. `node scripts/check-docs.mjs` — 0 расхождений
  (154 маршрута / 33 контроллера, 31 миграция / 30 таблиц, 1434 теста /
  124 набора — число тестов точное для этого этапа: 27 новых `it(` без
  `it.each`, не оценка).
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §44
  SPEC).** Точка входа только с экрана результата ПОСЛЕ генерации, не
  отдельная кнопка на `ProjectScreen` (44.4/44.5). Нет partial-review
  промпта до последнего товара партии (44.2). Нет оптовой скидки за
  партию — списание кредит-на-кредит, как за обычную генерацию (44.3).

**Сделано (этап 66 — A/B-варианты одного ролика, TODO §III.6, см. §45
SPEC).**

- **Решения владельца продукта (через AskUserQuestion).** Парные
  варианты (каждый ролик — своя уникальная пара хук+CTA, не полная
  матрица «хук × CTA»). Фиксировано 3 варианта на запуск, без выбора
  пользователем.
- **Prisma/миграция.** `AbTestRun`/`AbTestVariant` + `AbTestVariantStatus`,
  обратные связи на `Project`/`User`. Ручная миграция
  `20260919090000_ab_test_variants` — 32 миграции, 32 таблицы после
  неё. Верифицирована применением ВСЕХ 32 миграций подряд к реальному
  локальному Postgres 16 в песочнице, тем же методом, что на этапах
  64/65.
- **`common/ai-pricing.ts`.** Новая операция `'ab-variants'` — отдельная
  строка в отчёте расходов §26, тот же провайдер/цена, что у
  `'prompt'`.
- **`PromptService`.** Два новых метода: `generateAbVariants(sessionId,
  count)` — ОДИН синхронный вызов GPT-5 на весь запуск (не по одному на
  строку, ключевое архитектурное отличие от `catalog-batch`, где каждая
  строка — другой товар и требует своего вызова), просит модель вернуть
  JSON-массив `count` объектов `{hookLabel, ctaLabel, prompt,
  voiceoverScript}`, держа раскадровку/камеру/персонажей/темп/цвет
  идентичными исходному одобренному промпту; `seedPrompt(sessionId,
  text, voiceoverScript?)` — пишет уже готовый текст без обращения к
  GPT-5, работает и на сессии без `generationPrompt` вовсе (в отличие
  от `updatePrompt`), нужен воркеру для дочерних сессий. Новый
  `common/ab-variant-response.ts` — терпимый разбор JSON-ответа модели
  (```json-обёртка, bare-массив), тем же приёмом, что у разбора ответа
  `generatePrompt`. `WORK_KINDS` (`common/session.service.ts`) — новый
  вид работы `'ab-variants'`, отдельный от `'prompt'` (сборка вариантов
  не блокирует и не блокируется обычным редактированием промпта той же
  сессии).
- **`backend/src/modules/ab-test/`.** `AbTestService` (`create()` — план
  → исходная сессия (владелец/проект/`VIDEO_COMPLETE`/`generatedVideo`/
  `librarySourceKey`/`productItemId`) → одобренный промпт-источник
  (новая проверка, специфичная для этого этапа) → запись в библиотеке →
  единственный вызов `generateAbVariants` → `$transaction`; `getStatus()`
  — живое чтение статуса рендера из сессии, без своей копии состояния,
  тот же приём, что у `CatalogBatchService.getStatus`) +
  `AbTestController` (`POST`/`GET :runId` за `TelegramIdentityGuard`) +
  `AbTestWorkerService` (`runBatch()` — claim-цикл по образцу
  `CatalogBatchWorkerService`, но БЕЗ вызова GPT-5 в воркере — текст уже
  готов, воркер только сеет его через `seedPrompt`, одобряет и стартует
  рендер) + `AbTestModule` (явный `imports: [ProjectSessionModule,
  LibraryModule, PromptModule, GenerationModule]`). DTO:
  `StartAbTestRequestDto`. `GET /api/cron/ab-test-run` в
  `cron.controller.ts`, девятый крон-слот в `vercel.json`
  (`*/2 * * * *`).
- **Ошибка, пойманная при написании кода (не при прогоне).** Литеральная
  подстрока `` `*/2 * * * *`. `` внутри JSDoc-комментария
  (`cron.controller.ts`) преждевременно закрывала блок комментария на
  собственном `*/`, каскадом порождая свыше 100 не связанных с этим
  синтаксических ошибок TypeScript до конца файла. Исправлено
  переформулировкой без буквальной подстроки `*/`.
- **Тесты.** `ab-test.service.spec.ts` (16 кейсов — план, поиск исходной
  сессии, все проверки источника включая специфичные для этапа
  ошибки — не одобрен промпт, нет привязанного товара, — состав
  транзакции, терпимость к неполному набору вариантов от модели,
  `getStatus` с живым чтением рендера) и `ab-test-worker.service.
  spec.ts` (11 кейсов — выборка, шаги подряд с `seedPrompt` вместо
  `generatePrompt`, claim, backoff vs terminal FAILED, изоляция ошибок
  между строками), по образцу `catalog-batch-*.spec.ts`. Плюс 13 новых
  кейсов в уже существующем `prompt.service.spec.ts` на
  `generateAbVariants`/`seedPrompt` (лок/claim отдельным видом работы,
  терпимость к неполному ответу модели, учёт расхода отдельной
  операцией, работа `seedPrompt` без предсуществующего
  `generationPrompt`). Как и все Prisma-задевающие спеки в этом
  проекте, не запускаются в самой песочнице под `jest` — подтверждено
  не только сравнением класса ошибки (как на этапе 65), но и прямым
  прогоном: `npx jest src/modules/ab-test/...` и контрольный запуск
  давно существующего `catalog-batch.service.spec.ts` падают одной и
  той же ошибкой (`PrismaClient`/`Prisma` отсутствуют в
  несгенерированном `@prisma/client`) — это предел песочницы, не
  дефект нового кода. `npx tsc --noEmit`/`eslint --max-warnings 0` по
  всему затронутому коду — чисто (отфильтровано от того же известного
  класса ошибок).
- **Admin.** `/ab-tests` — read-only список запусков (проект, инициатор,
  исходная сессия, сводка `pending/generating/done/failed` через
  `groupBy` на каждый запуск отдельно), по образцу `/catalog-batches`
  (этап 65). `AdminAbTestService` + маршрут `GET /admin/ab-tests` в
  `admin-panel.controller.ts`.
- **Frontend.** `AbTestPanel` — та же точка встраивания в
  `GenerationWizard`, что и `CatalogBatchPanel` (рядом с ней), но БЕЗ
  отдельного экрана выбора и без ограничения на LINE/число товаров —
  кнопка сама вызывает `POST .../ab-test` и переходит на
  `AbTestProgressScreen` (`#/projects/:id/ab-test/:runId`, статус с
  опросом раз в 8с, карточки хук/CTA вместо фото/названия товара) — один
  новый маршрут в `lib/router.ts` (+1 кейс в `scripts/router.test.ts`).
  `services/ab-test-api.ts`, новый namespace `abTest` во всех 5
  словарях (14 ключей — проверено программно: множества ключей
  идентичны во всех пяти локалях).
- **Конфигурация.** `backend/.env.example`/`.env.docker.example` —
  `AB_TEST_CRON_BATCH`/`AB_TEST_MAX_ATTEMPTS`, обе закомментированы с
  умолчаниями (тот же приём, что у `CATALOG_BATCH_CRON_BATCH`).
- **Проверка.** `backend/`: `npx tsc --noEmit` (отфильтровано от
  известного ограничения песочницы) — чисто; `npx eslint --max-warnings
  0` на всех новых/изменённых файлах — чисто. `frontend/`: `npx tsc
  --noEmit`, `npx eslint --max-warnings 0`, `npm test` (весь набор
  `scripts/*.test.ts`, включая расширенный `router.test.ts`), `npx vite
  build` — чисто. `admin/`: `npx tsc --noEmit`, `next lint` (через
  eslint), `next build` — чисто, включая новую страницу `/ab-tests`.
  `node scripts/check-docs.mjs` — 0 расхождений (158 маршрутов / 34
  контроллера, 32 миграции / 32 таблицы, 1474 теста / 126 наборов —
  число тестов точное для этого этапа: 40 новых `it(` без `it.each`, не
  оценка).
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §45
  SPEC).** Хук/CTA — цельный текст от GPT-5, не структурные поля, значит
  дословное совпадение раскадровки между вариантами не гарантировано
  технически (45.1). Нет отметки «победителя» или статистики показов
  (45.2). Повторный запуск с той же исходной сессии не блокируется —
  осознанно, TODO этого не требует (45.4).

**Сделано (этап 67 — жёстко вшитые субтитры, TODO §Уровень 2.7, см. §46
SPEC).**

- **Решения владельца продукта (через AskUserQuestion).** Несколько
  пресетных тем на бренд (`classic`/`bold`/`minimal`), не одна
  универсальная и не полная кастомная типографика. Все три режима
  озвучки, best-effort для Veo — субтитры доступны и без реального
  выравнивания речи (Veo не делает отдельного вызова синтеза).
- **Prisma/миграция.** `BrandManifest.subtitlesMode`/`subtitleTheme` —
  две новые колонки на уже существующей таблице, ручная миграция
  `20260923090000_subtitles`. **33 миграции, 32 таблицы** после неё
  (было 32/32) — новых таблиц нет. Не проверена на реальном Postgres в
  этой сессии (тот же известный предел песочницы — нет сети до
  `binaries.prisma.sh`, см. ниже про тесты); SQL — два `ALTER TABLE ADD
  COLUMN ... DEFAULT`, синтаксически идентичен всем предыдущим ручным
  миграциям этого проекта.
- **`common/veo-duration.ts` (новый).** `VIDEO_DURATION_SECONDS = 8`
  вынесена из приватной константы `generation.service.ts` — обратный
  импорт из `postprod.service.ts` дал бы цикл (`generation.service.ts`
  уже импортирует `PostProductionService`).
- **`common/subtitles.ts` (новый).** `SUBTITLES_MODES`/`SubtitlesMode`/
  `normalizeSubtitlesMode()`, `SUBTITLE_THEMES`/`SubtitleTheme`/
  `normalizeSubtitleTheme()` — companion-файл по образцу
  `voice-mode.ts`/`camera-move.ts`. `SUBTITLE_THEME_FORCE_STYLE` — три
  готовые строки `force_style` для фильтра ffmpeg `subtitles=`.
  `SubtitleCue`/`SubtitleAlignment` — типы. `buildSrt(cues)` — сборка
  `.srt` с санитизацией (`{`, `}`, `\` вырезаются — синтаксис
  ASS-оверрайдов, который libass распознаёт даже внутри `.srt`, а
  реплики пишет GPT-5).
- **`common/voiceover-script.ts`.** `speakableLines()` выделена из
  `speakableText()` (построчные реплики нужны отдельно — единица
  субтитрового блока). Новые `cueTimings(script, alignment)` —
  подстрочный поиск реплик в пословном выравнивании ElevenLabs с
  интерполяцией пропусков (`fillGaps`); `heuristicCueTimings(script,
  startSeconds, totalSeconds)` — пропорциональное по символам
  распределение для `veo` (эвристика, решение владельца продукта).
- **`tts/elevenlabs.service.ts`.** `synthesize()` принимает
  `timestamps?: boolean` — при `true` зовёт `/with-timestamps` вместо
  обычного эндпойнта, разбирает `{audio_base64,
  normalized_alignment}` (НЕ `alignment` — синхронизирован с реально
  произнесённым текстом после нормализации провайдера). Обычный вызов
  не изменился.
- **Сквозной паттерн поля манифеста.** `brand-manifest.types.ts`
  (`BrandManifestView`/`BrandManifestSnapshot`), обе DTO
  (`brand-manifest-request.dto.ts`/`update-brand-snapshot.dto.ts`,
  `@IsIn` от общих констант), `brand-manifest.service.ts`
  (`ManifestRow`/маппинг/нормализация), `project-session/snapshot.ts`
  (заморозка в снимок), `project-session.service.ts`
  (`applySnapshotEdit()`) — все 8 точек, что и у `cameraMove`.
- **`common/postprod.ts`.** Третья необязательная операция того же
  прохода. `PostProdOptions` — `subtitlesInputKey`/`subtitleForceStyle`;
  `PostProdPlan.subtitles: boolean`. Видеофильтр: кроп есть → субтитры
  прицепляются ПОСЛЕ кропа в той же цепочке через запятую; кропа нет,
  но субтитры есть → новая ветка, фильтр на исходном потоке; маппинг
  (`-map "[v]"`) и кодек (`libx264`, не `-c:v copy`) теперь ключуются
  от «кроп ИЛИ субтитры», не только от кропа — субтитры тоже требуют
  перекодирования. «Нечего делать» — теперь три условия, не два.
- **`postprod/postprod.service.ts`.** `Work` — `subtitlesMode`/
  `subtitleTheme`; `planWork()` разъединяет «нужен текст» от «нужен
  синтез» (`usesOwnVoice(voiceMode) || subtitlesMode === 'on'`) — в
  режиме `veo` синтеза нет, но текст для субтитров есть всегда.
  `synthesize()` передаёт `timestamps: wantsSubtitles &&
  usesOwnVoice(voiceMode)`, возвращает `alignment` дальше. Новый
  приватный `buildSubtitles(sessionId, work, alignment?)` — считает
  `cues` (`cueTimings` при наличии alignment, иначе
  `heuristicCueTimings`), собирает `.srt`, заливает в Blob
  (`sessions/<id>/subtitles.srt`), возвращает `subtitleStatus`. Провал
  сборки не отменяет ни кроп, ни голос — «ухудшение, а не поломка», как
  у `voiceStatus`.
- **`common/types/generation.types.ts`.** `GeneratedVideo` — 5 новых
  полей: `subtitlesMode`, `subtitleStatus` (`skipped`/`burned`/
  `failed`), `subtitleError`, `subtitlePathname`, `subtitleUrl` — в
  JSON `session.data`, миграции не требуют.
- **Frontend.** Типы зеркалятся вручную в ТРЁХ местах, не в двух, как
  предполагал план — обнаружена независимая третья копия
  `GeneratedVideo` в `services/api.ts` (её реально использует
  `GenerationWizard.tsx` через `hooks/useWorkflow.ts`, а не копию из
  `types/index.ts`); все три обновлены. Новый
  `frontend/src/lib/subtitle-theme.ts`. `ManifestScreen.tsx`'s
  `StyleForm` и `BrandSnapshotEditor.tsx` — по два новых
  `<Field><Pills/></Field>` (тумблер + тема, тема видна только при
  `'on'`). `GenerationWizard.tsx` — третий статус-абзац результата
  (кроп/голос/субтитры), скрыт при `subtitlesMode !== 'on'`. Все 5
  словарей — новый неймспейс `subtitleTheme` + ключи в `manifestScreen`/
  `brandSnapshotEditor`/`generationWizard` (сверено программно — набор
  новых ключей идентичен во всех пяти локалях).
- **Тесты.** Новый `common/subtitles.spec.ts` (25 кейсов — нормализация,
  `buildSrt`: формат таймкодов, санитизация фигурных скобок/бэкслеша,
  выброс пустых после санитизации блоков, сквозная нумерация). Расширены:
  `common/voiceover-script.spec.ts` (+11 — `cueTimings`: дословное
  совпадение, интерполяция непойманной реплики, ни одна не нашлась,
  пустой вход, конец последней реплики = конец озвучки;
  `heuristicCueTimings`: пропорция по символам, граница ролика, сдвиг
  первой реплики, одна реплика на весь диапазон, пустой текст, разметка
  не попадает), `common/postprod.spec.ts` (+6 — субтитры без кропа
  (перекодирование), фильтр на исходном потоке, субтитры без ключа не
  создают задачу, субтитры+кроп в одной цепочке ПОСЛЕ кропа,
  субтитры+кроп+голос вместе, обратная совместимость без субтитров),
  `modules/tts/elevenlabs.service.spec.ts` (+5 — `timestamps: true` на
  `/with-timestamps` с разбором `alignment`, обычный вызов без
  timestamps, не-JSON ответ, отсутствие `audio_base64`, отсутствие
  alignment не роняет успех), `modules/postprod/postprod.service.spec.ts`
  (+9 — `subtitlesMode: off` не вызывает сборку, ранний пропуск при
  «нечего делать» помечает `subtitleStatus: skipped`, `veo`+`on` —
  эвристика без TTS, `voiceover`+`on` передаёт `timestamps: true`,
  `voiceover`+`off` не передаёт, реальный тайминг из alignment ложится в
  `.srt`, провал сборки не отменяет кроп/звук, пустой текст — skipped с
  причиной, родной формат без голоса, но с субтитрами — задача всё
  равно уходит).
  **Впервые в этом проекте — прямой прогон `jest --json`, не оценка по
  тексту.** `npx prisma generate` в песочнице по-прежнему заблокирован
  (403 от `binaries.prisma.sh` — подтверждено через
  `curl $HTTPS_PROXY/__agentproxy/status`: это отказ политики прокси, не
  временная сеть), но временный локальный `ts-jest`-конфиг с
  `isolatedModules: true` (не часть проекта, не закоммичен) пропускает
  ТОЛЬКО проверку типов при импорте несгенерированного `@prisma/client`
  — рантайм-подсчёт тестов от этого не меняется. Итог: **1495 тестов /
  127 наборов** (было 1474/126), из них **19 падают, но НЕ из-за этапа
  67** — например `plan.controller.spec.ts` ожидает вызов `stateOf` с
  одним аргументом, получает два (похоже на дрейф после добавления
  локали в более ранней мультиязычной работе). Это долг предыдущих
  этапов, сознательно не тронут в рамках этапа 67 — задокументирован
  здесь как находка. `npx tsc --noEmit`/`eslint --max-warnings 0` по
  всему затронутому коду (`backend/`, `frontend/`) — чисто (отфильтровано
  от известного класса ошибок несгенерированного Prisma-клиента).
- **Frontend, помимо тестов.** `npx tsc --noEmit`, `npx eslint
  --max-warnings 0` на все затронутые файлы — чисто.
- **Конфигурация.** Новых переменных окружения не требуется — субтитры
  не заводят ни воркер, ни крон, только используют уже настроенные
  `FFMPEG_API_KEY`/`VOICE_API_KEY`.
- **Admin.** Не тронут — редактирование манифеста бренда только в TMA,
  админка показывает лишь агрегатный счётчик проектов.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §46
  SPEC).** Подстрочный поиск реплики — не побайтовое выравнивание,
  интерполяция для непойманных строк (46.1). Veo-эвристика может
  заметно разойтись со звуком — принятый риск, не баг (46.3).
  `doc/API.md` не получил новых полей — документ не описывает тела
  запросов вовсе, ни для одного поля манифеста (46.4).

**Сделано (этап 68 — товарный фид, импорт каталога по ссылке, TODO
§Уровень 2 п.8, см. §47 SPEC).**

- **Решения владельца продукта (через AskUserQuestion).** Один
  универсальный механизм — фид по ссылке в формате YML или CSV, а не
  отдельная интеграция под Shopify/WooCommerce/«Мой склад» (4+ разных
  OAuth/API-контракта). Разовый импорт (снимок каталога на момент
  запуска), не периодическая синхронизация остатков/цен.
- **`common/photo-limits.ts` (новый).** `MAX_PHOTO_BYTES` вынесена из
  приватной константы `product-analog.service.ts` — тот же приём, что
  `VIDEO_DURATION_SECONDS`→`common/veo-duration.ts` на этапе 67.
- **Зависимость `fast-xml-parser`.** Новая, чистый JS, без нативных
  зависимостей — для разбора YML (XML с вложенностью `<offer>`/
  `<categories>`, ручной regex-разбор означал бы заново писать
  XML-парсер похуже готового).
- **`common/external-url-guard.ts` (новый).** SSRF-защита для ссылки,
  которую подставляет пользователь (не наш код) — противоположность
  `blob-url.ts`'s `isOwnBlobUrl()`. `assertPubliclyRoutableUrl(url)`:
  только `http:`/`https:`, резолвит хост через `dns.promises.lookup(host,
  {all: true})`, отклоняет любой резолвящийся адрес из приватных/
  служебных диапазонов IPv4 (10/8, 172.16/12, 192.168/16, 127/8,
  169.254/16 включая метаданные облака, carrier-grade NAT, TEST-NET,
  multicast/reserved) и IPv6 (`::1`, `fe80::/10`, `fc00::/7`,
  IPv4-mapped-обёртки). Вызывается дважды — при создании запуска и
  повторно перед скачиванием в воркере.
- **`common/product-feed.ts` (новый).** `detectFeedFormat` — по
  содержимому (`<` в начале), не только по `Content-Type`.
  `parseYmlFeed` — через `fast-xml-parser`, название (с фоллбеком на
  `model`), цена (терпима к запятой/валютным символам), валюта,
  описание (включая CDATA), фото, категория через лукап
  `<categories><category id>`. `parseCsvFeed` — свой построчный разбор
  с кавычками (без библиотеки), автоопределение разделителя, синонимы
  заголовков на ru/uk/en. Парсер только читает, не судит — строка без
  названия/цены всё равно возвращается, решение пропустить её — за
  воркером импорта.
- **Prisma/миграция.** `ProductFeedImportRun`/`ProductFeedImportItem` —
  точное зеркало claim/бэкофф-формы `CatalogBatchRun`/`CatalogBatchItem`
  (этап 65), с добавленными на самом `Run` агрегатами
  `totalRows`/`importedCount`/`skippedCount`/`failedCount`
  (инкрементируются воркером по ходу — не живой `groupBy` при каждом
  опросе статуса, единственное архитектурное отличие от
  `CatalogBatchRun`). Ручная миграция `20260930090000_product_feed_import`.
  **34 миграции, 34 таблицы** (было 33/32). Не проверена на реальном
  Postgres в этой сессии — тот же известный предел песочницы (403 от
  `binaries.prisma.sh`, см. тесты ниже).
- **`config/configuration.ts`.** `project.lineItemLimit` дефолт
  `20`→`500` (продавец с 300 позициями физически не поместился бы при
  дефолте 20; env-оверрайд как был, так и остался рабочим). Новый блок
  `productFeedImport: {cronBatch: 50, maxAttempts: 5, maxFeedBytes:
  8 МБ}` — по образцу `catalogBatch`.
- **`modules/product-feed-import/` (новый модуль).**
  `product-feed-import.service.ts` — `create()` (гейт плана `'library'`,
  проверка владения проектом и `type === 'LINE'`, быстрый
  `assertPubliclyRoutableUrl`, создание запуска), `getStatus()`/`list()`
  (счётчики читаются как есть из строки запуска, без пересчёта).
  `product-feed-import-worker.service.ts` — `runTick()`: `runFetchPhase()`
  (claim запуска, скачивание с лимитом байт, разбор, `createMany` строк,
  перевод в `IMPORTING`; сетевой сбой — бэкофф `2^attempts` минут,
  SSRF-отказ/пустой фид/лимит байт — терминальный `FAILED` сразу) и
  `runImportPhase()` (claim пакета строк, проверка обязательных полей и
  валюты, `ProjectService.addItem()` — переиспользуется как есть вместе
  с проверкой лимита, точечный `prisma.productItem.update` для
  категории/фото в обход DTO — `ProductItemRequestDto` их не содержит,
  тот же приём, что `ProductAnalogService.persist()`; «Line limit
  reached» от `addItem()` пропускает одним `updateMany` ВСЕ оставшиеся
  строки запуска, не по одной; сбой скачивания фото не отменяет
  позицию — «ухудшение, а не поломка»; запуск переводится в `DONE`,
  когда не осталось необработанных строк). `product-feed-import.controller.ts` —
  `POST/GET .../feed-imports`, `GET .../feed-imports/:id`, за
  `TelegramIdentityGuard`. `product-feed-import.module.ts`.
- **Крон.** `GET /api/cron/feed-import-run` — десятый слот, тот же ритм
  (1-2 минуты), что `catalog-batch-run`/`ab-test-run`;
  `backend/vercel.json` — новая запись расписания.
- **Frontend.** `FeedImportPanel.tsx` (новый) — вход на `ProjectScreen`
  для LINE-проекта, гейт `useFeature('library')`, показывается
  независимо от количества уже заведённых позиций (в отличие от
  `CatalogBatchPanel`, которой нужен хотя бы один заполненный товар) —
  продавец с каталогом обычно НАЧИНАЕТ с фида. `FeedImportStartScreen.tsx`
  (поле ссылки) → `FeedImportProgressScreen.tsx` (поллинг 8с, счётчики,
  список причин пропуска до 50 строк). Новые маршруты
  `feed-import-start`/`feed-import` в `lib/router.ts` (без литерала
  `'start'`, различаются наличием четвёртого сегмента — тот же приём,
  что `ab-test`). Новые типы во `types/index.ts`, новый
  `services/product-feed-import-api.ts`. Словари всех 5 локалей — новый
  неймспейс `feedImport` (26 ключей, сверено вручную — автоматической
  проверки соответствия ключей между локалями в проекте нет: `Dictionary`
  выводится ТОЛЬКО из `ru.json`, остальные локали проходят через `as
  Dictionary`, приведение типов, а не структурную проверку).
- **Admin.** `admin/src/app/feed-imports/page.tsx` (новый) +
  `admin-feed-import.service.ts` — read-only список запусков, по образцу
  `catalog-batches`/`ab-tests`, но БЕЗ `groupBy` по строкам на каждый
  запуск (сводка уже лежит на самой строке `ProductFeedImportRun`) —
  простой `findMany`. Новый пункт навигации, новые типы/endpoint во
  `admin/src/lib/`.
- **Тесты.** Новые `common/product-feed.spec.ts` (22 кейса — форматы,
  YML: имя/model-фоллбек/цена с запятой/CDATA/лукап категории/массив и
  одиночный offer/битый XML/нет shop, CSV: запятая/точка-с-запятой/
  кавычки/украинские синонимы/пустые строки/BOM/незнакомый заголовок),
  `common/external-url-guard.spec.ts` (21 кейс — схема, DNS-отказ,
  8 заблокированных диапазонов IPv4, 4 диапазона IPv6, публичные
  адреса, смешанный список с одним приватным), `product-feed-import.service.spec.ts`
  (11 — гейт плана, тип проекта, SSRF-отказ на создании, 404 на чужой/
  несуществующий запуск, сводка/список), `product-feed-import-worker.service.spec.ts`
  (18 — фаза 1: claim, успех, SSRF-отказ, пустой фид, превышение
  байтового лимита, сетевой сбой с бэкоффом и без; фаза 2: claim, нет
  обязательных полей, несовпадение валюты, успешный импорт с
  категорией, достижение лимита с массовым пропуском остатка, отказ по
  другой причине без массового пропуска, непредвиденная ошибка с
  бэкоффом, перевод в DONE и его отсутствие при незавершённых строках).
  **72 новых теста** в четырёх новых файлах. Тот же приём, что на этапе 67: временный локальный
  `ts-jest`-конфиг с `isolatedModules: true` (не часть проекта, не
  закоммичен) — `npx prisma generate` в песочнице по-прежнему
  заблокирован (403 от `binaries.prisma.sh`, тот же отказ политики
  прокси). Дополнительно потребовалось замокать САМ модуль
  `project/project.service.ts` в спеке воркера (`jest.mock('../project/
  project.service', () => ({ ProjectService: class {} }))`) — в отличие
  от `catalog-batch-worker.service.spec.ts`, воркер фида напрямую
  импортирует `ProjectService` (переиспользует `addItem()`), а этот файл
  делает РАНТАЙМ-импорт `Prisma` из `@prisma/client` (не только типы),
  так что просто замокать `PrismaService` недостаточно — падает само
  разрешение модуля раньше, чем jest успевает подставить мок. Итог:
  **1567 тестов / 131 набор** (было 1495/127), из них **20 падают, но НЕ
  из-за этапа 68** — на один больше прежних 19 (см. этап 67):
  `catalog-batch-worker.service.spec.ts` сравнивает `error.name` (для
  `ForbiddenException` без явного `name`, где ожидание тестом писалось
  на `error.constructor.name`) — тот же класс дрейфа, что и у
  `plan.controller.spec.ts`, долг предыдущих этапов, не тронут в рамках
  этапа 68. `npx tsc --noEmit`/`eslint --max-warnings 0` по всему `src/`
  бэкенда — чисто (отфильтровано от известного класса ошибок
  несгенерированного Prisma-клиента). `npx tsc --noEmit`/`eslint
  --max-warnings 0` во `frontend/`, `next build`/`eslint` в `admin/` —
  чисто; `tsc`/`eslint` в `landing/` — чисто (не тронут этим этапом).
  `node scripts/check-docs.mjs`/`sync-legal.mjs --check` — прогнаны,
  расхождения зафиксированы и исправлены в этом же обновлении документов.
- **Не сделано в этом этапе (сознательно, см. открытые вопросы §47
  SPEC).** DNS-rebinding между SSRF-проверкой и фактическим скачиванием —
  принятый остаточный риск, IP-pinned fetch не делается нигде в проекте
  (47.1). Фото из фида — без AI-распознавания категории/аудитории,
  заведомо беднее ручного пути через `ProductAnalogService` (47.3).
  Реальная миграция на живом Postgres — не прогнана в этой сессии (тот
  же предел песочницы, что и на этапе 67).

**Сделано (этап 69 — админка: вкладка «Кроны», реестр + ручной запуск +
debug, доп. ТЗ «Кроны в админке», аналогично Solar Shop, см. §69 SPEC).**

- **Запрос состоял из двух частей — первая уже была сделана.**
  Вкладка env-переменных (безопасно, аналогично Devil's Advocate)
  оказалась полностью реализована ещё на этапе 40 (`env-settings.ts`,
  `GET /admin/settings`, `admin/settings/page.tsx`) — этот этап её не
  трогал, только список кронов + ручной запуск + debug (аналогично
  Solar Shop) был новой работой.
- **Решения владельца продукта (через AskUserQuestion).** Семантика
  debug — по каждому из десяти кронов отдельно, решает Claude (не
  единое правило: результаты кронов viral4creators — уже компактные
  объекты счётчиков, не массивы по элементу, как у Solar Shop). История
  прогонов — да, новая таблица `CronRunLog` + ручная миграция.
- **Extract-method, а не дублирование.** Вся бизнес-логика десяти
  кронов переехала из `CronController` в новый `CronJobsService` (10
  методов `runX()`, тот же конструктор из 15 зависимостей, что был у
  контроллера) — единственный источник истины на двух вызывающих:
  настоящий крон Vercel (`CronController`, секрет) и ручной запуск из
  админки (`AdminCronController`, сессия). Поведение настоящего крона
  не изменилось ни на бит.
- **Почему новые маршруты живут в `CronModule`, а не в
  `AdminPanelModule`.** `CronModule` уже импортирует `AdminPanelModule`
  (за телеметрией для `/cron/report`) — обратный импорт создал бы цикл
  `AdminPanelModule → CronModule → AdminPanelModule`. Решение: новые
  `AdminCronController`/`AdminCronService` — тоже в `modules/cron/`,
  `AdminAuthModule` (лист графа модулей) довешен в импорты `CronModule`
  без единого цикла.
- **Prisma/миграция.** `CronRunLog` — id/jobKey/triggeredBy/debugMode/
  status(`RUNNING`|`SUCCESS`|`FAILED`, без `PARTIAL` — ни у одного из
  десяти результатов нет отдельного булева «частичный провал»)/
  startedAt/finishedAt/durationMs/summary/debugLog(`Json?`, только при
  debugMode)/errorMessage, индекс `(jobKey, startedAt)`, без FK на
  `users` (у настоящего крона Vercel нет пользователя). Ручная миграция
  `20261007090000_cron_run_log`. **35 миграций, 35 таблиц** (было
  34/34). Не проверена на реальном Postgres в этой сессии — тот же
  известный предел песочницы, что на этапах 64-68.
- **Debug-семантика — таблица решений, не одно правило.** `report` —
  `summary` = сам текст отчёта. `blog` — `summary` собирает обе половины
  по числовым полям. Шесть плоских результатов (`publish`,
  `billing-renew`, `marketing-broadcast`, `catalog-batch-run`,
  `ab-test-run`, `feed-import-run`) — `summary` строится обобщённо по
  числовым полям, `debugLog` при debug = весь объект. `cleanup-sessions`
  — debug ничего не скрывает и не добавляет (крон и так трогает только
  явно истёкшее). `sweep-orphans` — **единственный, где debug меняет
  ПОВЕДЕНИЕ**: маппится на `dryRun: true` (единственная из десяти
  операций, где случайный клик необратим — удаляет файлы Vercel Blob
  безвозвратно); `cursor` из ручного запуска никогда не передаётся.
- **`modules/cron/` — новые/изменённые файлы.** `cron-jobs.service.ts`
  (новый) — извлечённая логика. `cron.controller.ts` — схлопнут до
  секрет-проверки + делегата. `admin-cron.service.ts` (новый) —
  `JOB_REGISTRY` (10 записей, тексты из доккомментариев
  `cron.controller.ts`), `getRegistry()`, `getHistory(jobKey?, limit)`,
  `run(jobKey, triggeredBy, debugMode)`. `admin-cron.controller.ts`
  (новый) — `GET /admin/cron/registry`, `GET /admin/cron/history?jobKey=`,
  `POST /admin/cron/:jobKey/run?debug=`, все под `AdminSessionGuard` +
  `assertOperator`; ручной запуск дополнительно под `RateLimitGuard`
  (`{name: 'admin-cron-run', limit: 5, windowSec: 15}` — та же защита
  от спам-кликов по кнопке, дёргающей платные внешние API, что у Solar
  Shop). `cron.module.ts` — `AdminAuthModule` в импортах, оба новых
  класса в `controllers`/`providers`.
- **Admin frontend.** `admin/src/app/cron/page.tsx` (новый) — карточка
  на джоб, бейдж последнего статуса (переиспользованы три готовых
  `badge-status-*`, новый CSS не заводился), разворачиваемый `<pre>` с
  debugLog, красный блок `errorMessage` при FAILED, чекбокс debug +
  кнопка «Запустить»; у `sweep-orphans` — отдельная подпись про смысл
  debug. Вёрстка на существующих классах (`.page`/`.card`/`.muted`), НЕ
  Tailwind (в отличие от Solar Shop). `admin/src/lib/types.ts` —
  `CronJobInfo`/`CronRunLog`. `admin/src/lib/endpoints.ts` —
  `getCronRegistry()`/`getCronHistory(jobKey?)`/`runCronJob(jobKey,
  debug)`. `AdminNav.tsx` — новая ссылка `/cron` → «Кроны».
- **Тесты.** `cron-jobs.service.spec.ts` (новый, 17 — перенос
  существующих тестов `CronController` на новые имена методов: партии/
  бюджет уборки, dryRun и пять областей метлы — исходный тест ожидал
  четыре, добавилась `shared-videos`, отчёт, делегирование продления
  подписок). `admin-cron.service.spec.ts` (новый, 11 — неизвестный
  jobKey, debug раскрывает/не раскрывает debugLog, `sweep-orphans` с
  `dryRun=debugMode` без cursor, FAILED-ветка, запись/чтение истории).
  `cron.controller.spec.ts` переписан (было 24 теста вперемешку с
  бизнес-логикой, стало 15 — только секрет-guard и делегирование). Тот
  же приём, что на этапах 67-68: временный локальный `ts-jest`-конфиг с
  `isolatedModules: true` (не часть проекта, не закоммичен) —
  `npx prisma generate` в песочнице по-прежнему заблокирован (403 от
  `binaries.prisma.sh`). Три новых/переписанных файла дополнительно
  мокают `session.service.ts`/`admin-panel.service.ts`/
  `blog-generation.service.ts`/`blog-translation.service.ts`/
  `project/project.service.ts` целиком — все пять рантайм-импортируют
  перечисления `@prisma/client` транзитивно через `CronJobsService`, тот
  же класс проблемы, что потребовал мокать `ProjectService` на этапе 68.
  Итог: **1610 тестов / 133 набора** (было 1567/131), из них **20
  падают и 9 наборов не запускаются — не из-за этапа 69** (тот же
  список, что после этапа 68: `plan.controller.spec.ts`,
  `catalog-batch-worker.service.spec.ts`, `project.service.spec.ts` и
  другие; ни один из трёх файлов этапа 69 в списке не появляется).
  `npx tsc --noEmit`/`eslint --max-warnings 0` по `backend/src/modules/cron/`
  — чисто (отфильтровано от известного класса ошибок несгенерированного
  Prisma-клиента: `this.prisma.cronRunLog`/`.session`/`.project` и т.д.).
  `npx tsc --noEmit`/`eslint --max-warnings 0`/`next build` в `admin/` —
  чисто, маршрут `/cron` собирается. `frontend/`, `landing/` не тронуты
  этим этапом.
- **Не сделано в этом этапе.** Реальная миграция на живом Postgres — не
  прогнана в этой сессии (тот же предел песочницы). Долг предыдущих
  этапов (20 падающих тестов, 9 не запускающихся наборов) — сознательно
  не тронут, не относится к этому этапу.

**Сделано (этап 70 — Resemble AI как второй провайдер синтеза речи,
`doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md`, решение §5.2 ТЗ, см. §48 SPEC).**

- **Переключаемый провайдер синтеза.** `TtsProvider` (`tts.types.ts`)
  получил `readonly providerKey: string`. `TtsModule` вместо прямой
  инжекции `ElevenLabsService` регистрирует DI-токен `TTS_PROVIDER` —
  фабрика-реестр (`{elevenlabs, resemble}[TTS_PROVIDER env] ?? eleven`,
  неизвестное значение — тихий откат на ElevenLabs, не падение), рассчитан
  на будущие провайдеры (Cartesia, §5.2а ТЗ) без переделки модуля.
  `TtsController` и `PostprodService` перешли на
  `@Inject(TTS_PROVIDER) private readonly tts: TtsProvider`.
- **`ResembleService`** (новый файл, по образцу `ElevenLabsService`,
  тот же принцип мягкого фоллбека — ни одного `throw`): синтез —
  `POST https://f.cluster.resemble.ai/synthesize` (без `project_uuid` —
  необязателен, не нужен продукту), лимит 3000 символов (не 5000, как у
  ElevenLabs), ответ — JSON с `audio_content` в base64 и
  `audio_timestamps.graph_chars/graph_times` в том же ответе (защитный
  разбор — любое расхождение формы даёт субтитры без тайминга, не
  падение; точная семантика пары `graph_times[i]` подтверждена только
  документацией, не вызовом с реальными числами — открытый пункт
  аудита ниже). Каталог голосов — `GET https://app.resemble.ai/api/v2/voices`
  (другой хост). Нет захардкоженного голоса по умолчанию (в отличие от
  ElevenLabs) — без `RESEMBLE_VOICE_ID`/голоса бренда синтез Resemble
  пропускается с понятной причиной.
- **Пометка провайдера на голосе.** `BrandManifest.ttsProvider String?`
  (миграция `20261014090000_brand_manifest_tts_provider`, колонка на
  существующей таблице — таблиц не прибавилось) — проставляется
  СЕРВИСОМ (не клиентом) при каждом изменении `ttsVoiceId`, и в
  `BrandManifestService`, и в `applySnapshotEdit()` (снимок бренда
  внутри сессии редактируется отдельно от `BrandManifest`, без этой
  правки поле там осталось бы устаревшим). `BrandManifestSnapshot`/
  `snapshot.ts` замораживают `ttsProvider` вместе с `ttsVoiceId`.
  Guard в `PostprodService` (перед вызовом `tts.synthesize()`):
  несовпадение `work.ttsProvider` и активного `tts.providerKey` —
  `voiceStatus: 'failed'` с понятной причиной синтеза, без платного
  вызова заведомо обречённой попытке; `null` (старые записи) — пропуск
  проверки. `aiUsage.record()` в обоих местах — `` `${providerKey}-tts` ``
  вместо захардкоженного `'elevenlabs-tts'`.
- **Деньги и конфигурация.** `ai-pricing.ts` — ключ `resemble-tts`
  (ставка с пометкой «ПРОВЕРИТЬ» — Resemble не публикует её на
  `resemble.ai/pricing` напрямую). `env-settings.ts` — три новые
  переменные (`TTS_PROVIDER`, `RESEMBLE_API_KEY`, `RESEMBLE_VOICE_ID`),
  `.env.docker.example`, `doc/DEPLOYMENT.md`, `doc/API.md`.
- **Фронтенд.** `VoicePicker.tsx` — предупреждение при рассинхроне
  сохранённого `ttsProvider` и активного провайдера каталога (текст —
  во всех пяти словарях); проброшено из `ManifestScreen.tsx` и
  `BrandSnapshotEditor.tsx`. `VoiceCatalogue`/`VoiceCatalogueResponse`
  получили поле `provider`.
- **Аудит реализации (сразу после кода, по прямому запросу).** (а)
  Грепнут весь `backend/src` на `'elevenlabs-tts'`/прямую инжекцию
  `ElevenLabsService` — новых мест не нашлось, оба вызова
  `aiUsage.record` уже переведены на `${providerKey}-tts`, все
  потребители — по токену. (б) `TTS_PROVIDER=resemble` без
  `RESEMBLE_API_KEY` проверен тестами `resemble.service.spec.ts` —
  деградирует мягко (`skipped: true`), как и ElevenLabs без ключа. (в)
  Точная форма пары `graph_times[i]` (старт/конец, не
  старт/длительность) остаётся неподтверждённой реальным вызовом
  (нет доступа к живому `RESEMBLE_API_KEY` из песочницы) — код уже
  защищён на случай ошибки (см. выше), это открытый пункт для первого
  реального прогона на проде, не блокирующий. (г) Прогон полного
  jest вскрыл и исправил два реальных дефекта, найденных ИМЕННО
  проверкой этого этапа: `env-settings.ts` понижал регистр значения
  `TTS_PROVIDER` перед показом (`raw.toLowerCase()`), из-за чего
  переменная окружения, заданная не строчными буквами, отображалась
  в панели искажённой — разделено на `raw` (для отображения) и
  `normalized` (для сверки со списком известных значений); и
  `snapshot.spec.ts` — доэтапный (не относящийся к Resemble) пробел:
  тест `brandManifestSnapshotFrom` не перечислял поля
  `subtitlesMode`/`subtitleTheme`, которые функция уже проставляет по
  умолчанию (`'off'`/`'classic'`) — не всплывало, пока jest не
  запускался в этой сессии; дополнено.
- **Проверка.** `npx tsc --noEmit`/`eslint --max-warnings 0` в
  `backend/` и `frontend/` — чисто (тот же класс несгенерированного
  `@prisma/client`, что и на всех этапах с 64 — новых ошибок,
  относящихся к `tts`/`resemble`/`providerKey`/`TTS_PROVIDER`, нет).
  Полный jest тем же приёмом, что на этапах 67-69 (временный локальный
  `ts-jest`-конфиг с `isolatedModules: true`, не часть проекта, не
  закоммичен — `npx prisma generate` в песочнице по-прежнему
  заблокирован, 403 от `binaries.prisma.sh`): **1651 тестов / 134
  набора** (было 1610/133 — новый `resemble.service.spec.ts` плюс
  тесты на автозаполнение/сброс `ttsProvider` и рассинхрон провайдера в
  шести изменённых спек-файлах), из них **19 падают и 8 наборов не
  запускаются — не из-за этапа 70** (`analysis.service.spec.ts`,
  `project.service.spec.ts`, `billing.service.spec.ts`,
  `catalog-batch.service.spec.ts`, `ab-test-worker.service.spec.ts`,
  `catalog-batch-worker.service.spec.ts`,
  `marketing-consent.service.spec.ts`, `plan.controller.spec.ts` — тот
  же долг предыдущих этапов, что зафиксирован после этапа 68/69; ни
  один файл этапа 70 в списке не появляется). `node scripts/check-docs.mjs`
  — 0 расхождений после этой правки.
- **Не сделано в этом этапе (сознательно, по ТЗ и плану).** Клонирование
  голоса пользователя (`POST /api/v2/voices`, вебхук `callback_uri`,
  `UserVoice`) — п. 32 TODO, отдельный будущий этап. Cartesia — не
  реализуется (§5.2/5.2а ТЗ). Реальная накатка миграции на живой
  Postgres — не прогнана в этой сессии (тот же предел песочницы, что и
  все предыдущие этапы).

**Сделано (этап 71 — исправление высоких находок пятого аудита,
`doc/AUDIT-2026-09-09-round5.md`, TODO §I-Д.1, см. §71 SPEC).** По
прямому запросу владельца продукта: «исправь высокие из последнего
полного аудита». Семь распознанных высоких (восемь пунктов аудита —
Д-1.4/Д-5.1 одна и та же находка; сам аудит отдельно называет Д-3.1
«высокой», но TODO.md изначально завёл её в раздел «Средние» и
посчитал «6 высоких» — поправлено заодно в этом же этапе).

- **Д-1.1 — воркер сам досматривает статус рендера.** Корень: единственное
  место, реально опрашивающее Veo и продвигающее статус
  (`GenerationService.getVideoStatus`), вызывалось только поллингом
  ОТКРЫТОГО экрана мастера — `CatalogBatchWorkerService`/
  `AbTestWorkerService.runBatch()` выбирали только `PENDING`/просроченный
  `FAILED`, к уже стартовавшим `GENERATING`-строкам крон никогда не
  возвращался. Правка (симметрично в обоих файлах): новый приватный метод
  `advanceGenerating()` — claim (тот же паттерн `updateMany` с
  `lockedUntil`, что у остальных строк) → `getVideoStatus(sessionId)` →
  `COMPLETE && postStatus !== 'pending'` → `DONE`; `FAILED` → `FAILED` с
  причиной; иначе — снять замок, тик вернётся; сбой самого вызова
  `getVideoStatus` — залогировать и снять замок, не уронить весь тик.
  Вызывается ПЕРВОЙ строкой `runBatch()`, три новых поля результата
  (`renderChecked`/`renderCompleted`/`renderFailed`). Побочный эффект:
  20-минутный дедлайн зависшего рендера (В-2.8) теперь срабатывает и для
  партий/A-B, раз воркер начал вызывать `getVideoStatus`.
  `CatalogBatchService.getStatus()`/`AbTestService.getStatus()` не
  тронуты — их пассивное чтение осталось безобидной подстраховкой.
- **Д-1.4 / Д-5.1 — подтверждение для «метлы».** `admin/src/app/cron/page.tsx`:
  `runJob('sweep-orphans')` теперь спрашивает `window.confirm()` с
  текстом, зависящим от Debug (dry-run — «ничего не удалится» / реальный
  прогон — явное предупреждение о безвозвратном удалении), тот же приём,
  что у остальных деструктивных экранов админки.
- **Д-3.1 — редирект-safe SSRF-guard.** Новая функция
  `fetchPubliclyRoutable(url, init, maxRedirects=5)` в
  `external-url-guard.ts`: `fetch(url, {..., redirect: 'manual'})`, на
  каждом хопе редиректа — заново `assertPubliclyRoutableUrl()` для нового
  адреса, прежде чем следовать по нему; больше `maxRedirects` подряд —
  отказ. `product-feed-import-worker.service.ts` — оба места
  (`fetchAndParse`, `downloadFeedPhoto`) переведены с
  `assertPubliclyRoutableUrl()` + голый `fetch()` на эту функцию.
- **Д-4.1 — индекс `createdAt`.** `@@index([createdAt])` на
  `CatalogBatchRun`/`AbTestRun`/`ProductFeedImportRun` (рядом с уже
  существующим `@@index([projectId])`, не вместо него — тот же приём, что
  `publication_requests`, этап 51, В-4.5). Миграция
  `20261015090000_history_run_createdat_indexes`.
- **Д-4.3 — настоящий Vercel Cron тоже пишет `CronRunLog`.**
  `AdminCronService.run()` НЕ тронут (11 тестов, глотает ошибку в
  FAILED-строку, не бросает) — вместо рефакторинга под общий метод
  добавлен отдельный `CronJobsService.runAndLog<T>(jobKey, triggeredBy,
  debugMode, task)`, который, в отличие от `run()`, ПЕРЕБРАСЫВАЕТ ошибку
  (сохраняя текущее поведение `cron.controller.ts` — необработанная
  ошибка джоба уходит в 500). Общая сводка (`summarizeCounters`/
  `buildRunSummary`) вынесена в новый чистый модуль `cron-run-summary.ts`,
  переиспользуется обоими сервисами. Все десять маршрутов
  `/api/cron/*` обёрнуты в `runAndLog(jobKey, VERCEL_CRON_TRIGGERED_BY,
  debugMode, () => this.jobs.runX())`; для `sweep-orphans` `debugMode`
  отражает реальный `dryRun` query-параметр. Доккомментарий
  `CronRunLog.triggeredBy` в `schema.prisma` поправлен (больше не
  утверждает, что сюда попадают только ручные запуски).
- **Д-5.2 — кнопка «Повторить».** Обе точки рендера ошибки на вкладке
  «Кроны» получили `<button onClick={() => void load()}>Повторить</button>`,
  тем же текстом/структурой, что `catalog-batches`/`ab-tests`/
  `feed-imports`/`users`/`library`.
- **Д-6.1 — чеклист приёмки покрыл этапы 64–70.** `doc/ACCEPTANCE-
  CHECKLIST.md` — семь новых разделов (6w–6ac): долг четвёртого аудита
  (этап 64), пакетная генерация (65), A/B-варианты (66), жёсткие субтитры
  (67), импорт фида включая новый редирект-фикс (68), вкладка «Кроны»
  включая три фикса этой же стадии (69), Resemble AI (70).
- **Д-6.2 — число миграций в `TELEGRAM-ADMIN.md` больше не отстаёт молча.**
  Текст переписан без привязки к номеру этапа (`сейчас N, актуальное
  число всегда видно в backend/prisma/migrations/`) в обоих местах, плюс
  две новые проверки в `scripts/check-docs.mjs` — закрывает не только
  сегодняшнее число, но и сам повторяющийся класс дефекта (В-6.17 раунда
  3).
- **Побочный найденный баг (не из аудита), исправлен по ходу верификации
  Д-1.1.** `catalog-batch-worker.service.spec.ts` и
  `ab-test-worker.service.spec.ts` — тест на нератраибл-ошибку
  (`ForbiddenException`) подделывал её через `Object.assign(new
  Error(...), {name: 'ForbiddenException'})`, а сам сервис отличает
  нератраибл-ошибки по `error.constructor.name` (совпадает с реальными
  классами `@nestjs/common`, но НЕ с такой подделкой, у которой
  `constructor.name` остаётся `'Error'`) — оба теста были в списке
  «падающих, не связанных с этапом» ещё с этапа 70. Исправлено заменой
  на локальный `class ForbiddenException extends Error {}`.
- **Проверка.** `npx tsc --noEmit` в `backend/` и `admin/` — чисто (тот же
  класс несгенерированного `@prisma/client`, что и на всех этапах с
  64 — новых ошибок в изменённых файлах нет, кроме одной доэтапной,
  не связанной с этим этапом, в `plan-gates.spec.ts`). `eslint
  --max-warnings 0` в `backend/` и `next lint` в `admin/` — чисто. `next
  build` в `admin/` — маршрут `/cron` собирается. Полный jest (тот же
  временный `isolatedModules`-конфиг, не закоммичен): **1682 тестов / 134
  набора** (было 1651/134 — новые тесты на `advanceGenerating` в обоих
  воркерах, на `fetchPubliclyRoutable` в `external-url-guard.spec.ts` и
  двух интеграционных в `product-feed-import-worker.service.spec.ts`, на
  `CronJobsService.runAndLog` и на обёртку каждого маршрута
  `CronController` в `runAndLog`), из них **17 падают и 6 наборов не
  запускаются — не из-за этапа 71** (`analysis.service.spec.ts`,
  `project.service.spec.ts`, `billing.service.spec.ts`,
  `catalog-batch.service.spec.ts`, `marketing-consent.service.spec.ts`,
  `plan.controller.spec.ts` — тот же долг предыдущих этапов; было 19/8 на
  этапе 70, минус два теста, исправленных попутно выше, минус ещё
  разница в подсчёте «не запускающихся» — `catalog-batch-worker.service.spec.ts`
  и `ab-test-worker.service.spec.ts` из списка ушли полностью, ни один
  файл этапа 71 в списке не появляется). Применены все 37 миграций
  подряд к чистой локальной Postgres 16 (`\d` подтверждает три новых
  индекса на `createdAt`). `node scripts/check-docs.mjs` — 0 расхождений.
  `node scripts/sync-legal.mjs --check` — без изменений (эта стадия не
  трогает юридические тексты).
- **Не сделано в этом этапе.** Средние и низкие находки пятого аудита
  (§I-Д.2/I-Д.3 TODO.md) — владелец продукта попросил только высокие,
  средние/низкие остаются долгом на будущее.

**Сделано (этап 72 — пилот говорящего AI-аватара: Hedra Character-3 +
Resemble, `doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md`, см. §50 SPEC).** По
прямому запросу владельца продукта («сможешь реализовать одним
проходом?», по уже согласованному и самостоятельно проаудированному
ТЗ) — полный проход: тип, HTTP-клиент, сервис, DTO, контроллер, модуль,
тесты, `PlanFeature`/цена, страница админки, документы.

- **Модуль `modules/actors/`.** `ActorsService`, `HedraClientService`,
  `ActorsController` (`@Controller('admin/actors')`), `ActorsModule`
  (импортирует `StorageModule`, `AiUsageModule`, `AdminPanelModule`,
  `AdminAuthModule`), подключён в `app.module.ts`.
- **`AvatarVideo` и `characterIndex`.** Новый `common/types/actors.types.ts`.
  Персонаж референсится ИНДЕКСОМ в `session.brandManifestSnapshot.characters[]`,
  не `BrandCharacter.id` — снимок не гарантирует непустой
  `sourceCharacterId` (тот же паттерн, что `CastReplacement.brandCharacterId`
  в `casting.types.ts`). Хранение — существующее поле `Session.data`
  (JSONB), без новой миграции: `avatarVideo` в `DATA_KEYS`, новый вид
  работы `'avatar-generate'` в `WORK_KINDS` (`session.service.ts`).
- **`HedraClientService`.** `submit()`/`status()` по образцу
  `FfmpegApiService` (retry на 429/5xx, отказ на 4xx), с поправками под
  реальный контракт Hedra: ответ не завёрнут в `data`, создание задачи —
  `202`. Id задачи в ответе читается защитно (`job_id ?? jobId ?? id`)
  — точное имя поля не подтверждено прямым вызовом (ключа Hedra в
  песочнице нет).
- **Порядок трат в `ActorsService`.** Сперва `ResembleService.synthesize()`
  (напрямую, не через DI-токен `TTS_PROVIDER` — пилот жёстко требует
  Resemble; `TtsModule.exports` расширен `ResembleService`, модуль уже
  `@Global()`). Синтез не удался → Hedra не вызывается, трата не
  записана. Синтез удался → `aiUsage.record('voiceover')` пишется
  СРАЗУ, до Hedra; если Hedra после этого откажет — трата на озвучку НЕ
  откатывается (тот же принцип, что у Veo: деньги потрачены в момент
  старта платного вызова). `AVATAR_RENDER_DEADLINE_MS = 20 минут`,
  `avatarRenderExpired()` — та же структура, что у Veo-пути.
- **Admin-only контроллер, `PlanService` в обход.** `POST
  /admin/actors/:sessionId/generate`, `GET /admin/actors/:sessionId/status`,
  `AdminSessionGuard` + `assertOperator()` перед делегацией — тот же
  приём, что `AdminCronController`/`AdminCronService`. Новый
  `PlanFeature.avatarLipsync` (десятый флаг) — `false` на всех трёх
  тарифах через общую запись `ALL`, только для будущего отключения
  через `featureDeniedMessage`.
- **Цена.** `common/ai-pricing.ts`: провайдер `'HEDRA'`, операция
  `'avatar-generation'`, ставка `'hedra-character-3'` — по секундам
  (`0.033 USD/сек`, §3.2 ТЗ).
- **Админка.** `admin/src/app/actors/page.tsx` — форма запуска, авто-опрос
  статуса каждые 4с, карточка результата; пункт «AI-аватар (пилот)» в
  `AdminNav`. Стиль — классы `cron/page.tsx`, новых не заведено.
- **Не сделано в этом этапе.** Жёсткие субтитры для аватар-видео (§3.2,
  шаг 6 ТЗ) — сам документ помечает шаг опциональным.
  `AvatarVideo.subtitleStatus` заведён, но всегда `'skipped'` в этом
  проходе — осознанное сужение объёма. **Пересмотрено этапом 72а сразу
  следом** — см. ниже: реализовано явным чекбоксом.

**Сделано (этап 72а — субтитры пилота аватара явным чекбоксом, доп. к
этапу 72, см. §50 SPEC «Дополнение»).** По прямой правке владельца
продукта сразу после этапа 72: «субтитры на всех пайплайнах должны
включаться явным чекбоксом — не всем они нужны» — у Veo-пути это уже
так (`subtitlesMode`, этап 67), у пилота аватара недоставало того же
переключателя.

- **Чекбокс и второй проход ffmpeg.** `GenerateAvatarRequestDto.subtitles?: boolean`,
  `false` по умолчанию. `.srt` собирается сразу на шаге синтеза Resemble
  (`cueTimings`/`buildSrt`, тот же код, что у Veo-пути), прожигается
  ВТОРЫМ, ОТДЕЛЬНЫМ проходом ffmpeg ПОСЛЕ Hedra (не тем же проходом, что
  у Veo — там файл для наложения уже есть, здесь Hedra ещё должна его
  создать). Провал любого шага — деградация, не отказ рендера (тот же
  принцип, что у всей постобработки Veo). Свой дедлайн прожига
  (`AVATAR_SUBTITLE_DEADLINE_MS`, 10 минут), отдельный от дедлайна самой
  Hedra — `avatarRenderExpired()` перестаёт применяться, как только
  Hedra уже отдала файл (`renderedUrl` задан).
- **Гонка отправки задачи ffmpeg — найдена и закрыта при верификации.**
  Без замка два конкурентных опроса статуса, оба увидевшие пустой
  `subtitleJobId`, оба отправили бы СВОЮ задачу ffmpeg и оба списали бы
  расход — тот же класс гонки, что `claimPostProduction` уже закрывает
  для Veo (этап 37). Закрыто новым видом работы
  `'avatar-subtitle-burn'` в `WORK_KINDS` (тот же приём, что у
  `'avatar-generate'`), замок — вокруг отправки, не вокруг всего опроса.
  Заодно: сырой файл Hedra (`renderedUrl`) теперь сохраняется сразу по
  скачивании, а не только вместе с исходом фазы 2 — иначе проигрыш
  гонки замка терял бы уже скачанный и перезалитый файл.
- **Админка.** Чекбокс «Вшить субтитры» на `/actors`, статус субтитров
  отдельной строкой в карточке результата. `AvatarVideo` (и клиентское
  зеркало в `admin/src/lib/types.ts`) пополнен полями темы/пути/URL/
  ошибки/id и времени старта задачи прожига.
- **Проверка.** `npx tsc --noEmit`/`eslint --max-warnings 0` в `backend/`
  — чисто. `npx tsc --noEmit`/`next lint`/`next build` в `admin/` —
  чисто, маршрут `/actors` собирается (4.73 kB / 92.1 kB First Load JS).
  Полный jest (тот же временный `isolatedModules`-конфиг, не
  закоммичен): **1745 тестов / 137 наборов** (было 1726/137 после этапа
  72 — 21 новый тест: чекбокс при запуске, обе фазы прожига в
  `getAvatarVideoStatus`, гонка замка `avatar-subtitle-burn`, прямые
  тесты дедлайнов), из них те же **17 падают / 6 наборов не
  запускаются**, что на этапе 71/72 — регрессий нет (сверено `grep -E
  "^FAIL"`, тот же список файлов). Новой миграции не требуется. `node
  scripts/check-docs.mjs` — 0 расхождений после обновления чисел в
  документах. `node scripts/sync-legal.mjs --check` — без изменений.

**Сделано (этап 72б — детальный аудит пилота аватара и исправление его
высоких находок, `doc/AVATAR-PIPELINE-AUDIT-2026-09-09.md`, доп. к
этапам 72/72а, см. §50 SPEC «Дополнение»).** По прямому запросу
владельца продукта сразу следом за 72а: «после провести аудит
последнего пайплайна детально». Независимый подчинённый агент прочитал
весь модуль `modules/actors/` целиком и вернул находки с точными
ссылками на строки; каждая лично перепроверена автором чтением того же
кода на диске. Итог — 6 находок, 2 высокие, обе исправлены и покрыты
тестами до публикации аудита (тот же порядок, что закрытие высоких
находок пятого аудита на этапе 71).

- **Д-1 (высокая) — второй заход гонки могла отправить платную задачу
  ffmpeg дважды.** Замок `'avatar-subtitle-burn'` (закрытый ещё при
  реализации 72а) защищает только ОДНОВРЕМЕННЫЙ захват — если другой,
  более быстрый опрос уже успел отправить задачу, записать
  `subtitleJobId` и снять замок ДО того, как замок достался нашему,
  более медленному опросу, устаревший в памяти `current` (прочитанный
  из БД в начале обработки HTTP-запроса, ДО чужой записи) всё ещё
  показывал `subtitleJobId: null` — вторая задача уходила в ffmpeg.
  Правка: `advanceSubtitleBurn`, уже под замком, но ДО платного вызова
  `ffmpeg.submit()`, перечитывает сессию из БД заново и проверяет
  `subtitleJobId` на этом свежем снимке, а не на устаревшем `current`
  — раз отправка доступна только из-под этого же эксклюзивного замка,
  окно между свежей проверкой и платным вызовом уже ничем не может быть
  нарушено.
- **Д-2 (высокая) — устаревший снимок дедлайна мог необратимо стереть
  уже готовый и оплаченный ролик.** Та же корневая причина
  (`SessionService.updateSession` — замена ЦЕЛОГО значения ключа, не
  глубокое слияние; `current` читается один раз в начале опроса и несёт
  устаревший снимок через все внешние вызовы), другое проявление: более
  медленный опрос, вычисливший `avatarRenderExpired(current) === true`
  по снимку ДО завершения, мог записать `FAILED` ПОВЕРХ уже
  записанного другим, более быстрым опросом `COMPLETE` с настоящим
  `downloadUrl` — а поскольку терминальные статусы отдаются сразу без
  дальнейшей обработки, потеря необратима. Правка: новый приватный
  метод `writeIfStillCurrent(sessionId, expected, next)` — перед КАЖДОЙ
  финализирующей записью (`finalize`, `markFailed`, запись
  `renderedUrl`, запись `COMPLETE` после успешного прожига) перечитывает
  сессию и пишет, только если она всё ещё совпадает с тем, что
  вызывающий код ожидал изменить; при несовпадении отдаёт то, что
  реально в БД, вместо отката на устаревшее состояние.
- **Д-3 (средняя) — дубль в локальном учёте расходов при гонке.**
  Закрыта автоматически как следствие Д-1 (второй `ffmpeg.submit()`
  структурно невозможен → второй `aiUsage.record('reframe')` тоже не
  происходит), отдельной правки не потребовалось.
- **Д-4 (низкая) — недоказанная гарантия дедупликации в
  `FfmpegApiService`.** Докомментарий `submit()` безусловно утверждал,
  что повтор запроса не создаёт вторую задачу/счёт благодаря
  `Idempotency-Key` — при том что собственный шапочный докомментарий
  файла эту гарантию НЕ числит среди проверенных на живом API. Правка:
  докомментарий переписан явно как недоказанное предположение,
  добавлено указание, что защита от двойной отправки — забота
  вызывающего кода (замок + свежее чтение, как теперь и делает
  `advanceSubtitleBurn`), а не заголовка.
- **Д-5 (низкая, не исправлено).** `AvatarVideo.costMicroUsd` называется
  как общая стоимость ролика, а считает только рендер Hedra (по
  докомментарию, намеренно); поле нигде не выводится в админке.
  Переименование/показ в UI — не «дёшево и локально», отложено до
  стадии, когда пилот выйдет за пределы admin-only.
- **Д-6 (низкая) — недостижимый `try/catch`.** `try/catch` вокруг
  `planPostProduction()` в `advanceSubtitleBurn`, скопированный из
  `postprod.service.ts`, где он действительно достижим — в этой точке
  вызова недостижим (`subtitlesInputKey: 'subs'` — всегда непустая
  константа, `targetAspectRatio` не передаётся). Убран, добавлен
  комментарий-объяснение.
- **Тесты на сами гонки.** До этого этапа ни один тест не мог выразить
  «между двумя чтениями сессии кто-то другой её изменил» — мок
  `sessions.getSession` в `actors.service.spec.ts` был статичным
  (`mockResolvedValue`, один и тот же объект на каждый вызов).
  `build()`-хелпер переведён на изменяемое состояние (`updateSession`
  реально обновляет то, что вернёт следующий `getSession` — та же
  top-level-key-replace семантика, что у настоящего `SessionService`);
  для Д-1 и Д-2 добавлены целевые тесты через `mockImplementationOnce`
  (первое чтение — устаревший снимок, второе — уже изменённое
  «конкурентным» опросом состояние), без необходимости в реальном
  параллелизме внутри теста.
- **Проверка.** `npx tsc --noEmit`/`eslint --max-warnings 0` в
  `backend/` — чисто (тот же класс несгенерированного `@prisma/client`,
  новых ошибок в изменённых файлах нет). Полный jest: **1747 тестов /
  137 наборов** (было 1745/137 после этапа 72а — 2 новых теста на сами
  гонки Д-1/Д-2, без новых спек-файлов), из них те же **17 падают / 6
  наборов не запускаются**, что на этапах 71/72/72а — регрессий нет
  (сверено `grep -E "^FAIL"`, тот же список файлов). Новой миграции не
  требуется (правка не задевает схему). `node scripts/check-docs.mjs` —
  0 расхождений после обновления чисел. `node scripts/sync-legal.mjs
  --check` — без изменений.
- **Не сделано в этом этапе.** Д-5 (переименование/показ `costMicroUsd`)
  — задокументирована как открытый пункт, не исправлена (см. выше).
  Дебаунс кнопки «Проверить статус» и рейт-лимит на `GET
  .../status` в админке — отмечены аудитом как то, что делало гонки
  Д-1/Д-2 правдоподобными на практике, но сама правка гонок в бэкенде
  снимает цену ошибки (потерянная запись/двойной платёж), которую эти
  два UI-фикса закрывали бы; отдельно не делаются в этой стадии.

**Сделано (этап 73 — саундчек Gemini, регламент «товар в кадре» у
аватара, клонирование голоса, TODO пп.13/32, см. §51 SPEC).** Три
независимых приоритета выбраны владельцем продукта одним
`AskUserQuestion` из короткого списка идей («Звуковой отчёт Gemini
(Рекомендовано)», «Товар в кадре у аватара — регламент», «Клонирование
голоса»); реализованы одним проходом, каждый — со своей верификацией.

- **Саундчек (Veo и аватар).** Общая чистая логика вынесена в
  `backend/src/common/sound-check.ts`
  (`soundCheckPrompt`/`parseSoundCheckResponse`/`appendSoundCheck`),
  используется раздельно двумя вызывающими сторонами: `VideoAuditService.
  runSoundCheck()` (Veo, тарифный гейт `audit`, `Session.data.soundCheck`
  с `subject: 'veo'`, маршруты `GET/POST /sessions/:id/sound-check`
  через новый `SoundCheckController` в `video-audit.controller.ts`) и
  `ActorsService.runSoundCheck()` (Hedra-аватар, admin-only, `subject:
  'avatar'`, маршруты `GET/POST /admin/actors/:sessionId/sound-check`).
  Вердикт (`human`/`synthetic`/`ambiguous`/`unknown`) ничего не
  блокирует — информационная подсказка, как и обычный аудит артефактов.
  Фронтенд: новый `SoundCheckPanel.tsx` (TMA, рядом с `AuditPanel`) и
  секция «Проверить звук» на `/actors` (админка).
- **«Товар в кадре» у аватара — регламент, не код.** Владелец продукта
  явно отклонил вариант с AI-генерацией/композитингом изображения
  персонажа с товаром (Hedra не даёт API-параметра для такого
  композитинга — перепроверено документацией, не предположение) и
  выбрал регламентную меру: обязательный чекбокс
  «Персонаж на исходном фото уже держит товар в кадре» на `/actors`
  перед «Запустить рендер», не отмечен по умолчанию, сбрасывается при
  смене id сессии или индекса персонажа, блокирует кнопку запуска, пока
  не отмечен. Чисто фронтовая правка, без изменений схемы/бэкенда —
  `doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md` §3.6/§5.2 обновлены пометкой
  «РЕШЕНО этапом 73».
- **Клонирование голоса через Resemble AI.** Новая модель `UserVoice`
  (миграция `20261016090000_user_voices`, статусы
  `TRAINING`/`READY`/`FAILED`), новый модуль `modules/user-voices/`
  (`UserVoicesService`/`UserVoicesController`/`UserVoicesWebhookController`),
  presigned-Blob поток загрузки образца (тот же приём, что у фото
  персонажа/сцены бренда — НЕ multipart, в проекте `FileInterceptor`
  нигде не используется), асинхронное обучение у Resemble
  (`ResembleService.cloneVoice()`/`getVoiceStatus()`/`deleteVoice()`),
  готовность — вебхуком (`POST /voices/webhook/resemble?secret=...`,
  секрет в query-параметре — у Resemble нет отдельного поля под секрет
  заголовка) или poll-фоллбеком в `GET /voices`. Новый `PlanFeature`
  `voiceCloning` (Standard и выше, отдельный от `brandManifest` —
  решение открытого вопроса §3.6.1 `AI-ACTORS-NO-REFERENCE-SPEC.md`),
  лимит 3 голоса на пользователя без учёта FAILED-попыток (§3.6.2),
  обязательное поле `consent` на каждый клон (§3.6.3). Новая операция
  цены `voice-clone`/`resemble-voice-clone` (`ai-pricing.ts`, `perCall:
  2 USD`, оценка из вторичного источника). Фронтенд: блок «Мои
  клонированные голоса» прямо в `VoicePicker.tsx` (запись через
  MediaRecorder или загрузка файла, лейбл, согласие, список со
  статусами, удаление) — READY-голос подставляется как обычный
  `BrandManifest.ttsVoiceId`, кнопка выбора активна только когда
  стендовый `TTS_PROVIDER=resemble` (однопровайдерная архитектура,
  §4.1 `TTS-PROVIDER-ALTERNATIVES-SPEC.md`).
- **Находка и починка в рамках той же стадии, не отдельный аудит.**
  `GET /voices` у Resemble отдаёт голоса НА ВЕСЬ аккаунт — общий
  `RESEMBLE_API_KEY` у всех подписчиков означал бы, что клон одного
  пользователя со своей личной подписью светится в общем каталоге `GET
  /tts/voices` у любого другого. Закрыто в `TtsController.voices()`:
  общий каталог исключает любой `voiceId`, для которого есть строка
  `UserVoice.resembleVoiceId` — собственные клоны видны их владельцу
  только через `GET /voices`.
- **Env.** `RESEMBLE_WEBHOOK_SECRET` (новая) и `API_PUBLIC_URL` (уже
  существовавшая для OAuth-колбэков/вебхука WayForPay — переиспользована
  для `callback_uri` Resemble, не заведена вторая переменная под тот же
  смысл). Обе — в `doc/DEPLOYMENT.md` и `GET /admin/settings` (группа
  «Клонирование голоса»).
- **Проверка.** `npx tsc --noEmit`/`eslint --max-warnings 0` — чисто в
  `backend/`, `frontend/`, `admin/` (тот же класс несгенерированного
  `@prisma/client`). Полный jest в `backend/`: **1817 тестов / 141
  набор** (было 1747/137 после этапа 72б — 70 новых тестов, 4 новых
  спек-файла: `common/sound-check.spec.ts`,
  `modules/user-voices/user-voices.service.spec.ts`,
  `modules/user-voices/user-voices.controller.spec.ts`,
  `modules/user-voices/resemble-webhook-secret.spec.ts`, плюс новые
  тесты в `actors.controller.spec.ts`, `resemble.service.spec.ts`,
  `tts.controller.spec.ts` (утечка каталога), `plans.spec.ts`,
  `env-settings.spec.ts`), из них те же **17 падают / 6 наборов не
  запускаются**, что и на этапе 72б — регрессий нет (`grep -E
  "^FAIL"`, тот же список файлов). Новая миграция добавляет ровно одну
  таблицу (**36** таблиц всего). `frontend/`: `tsc`, `eslint`, `vite
  build`, полный `npm run test` (включая `i18n.test.ts` — новые ключи
  `soundCheckPanel`/`myVoices` и `planScreen.featureLabels.voiceCloning`
  проверены на совпадение формы во всех пяти локалях). `admin/`: `tsc`,
  `next lint`, `next build`. `node scripts/check-docs.mjs` — 0
  расхождений после обновления чисел. `node scripts/sync-legal.mjs
  --check` — без изменений (этап не трогает юридические тексты).

**Сделано (этап 74 — исправление средних и низких находок пятого
аудита, `doc/AUDIT-2026-09-09-round5.md`, см. §52 SPEC).** Все находки
уровня «высокая» этого аудита были закрыты этапом 71; здесь — оставшиеся
16 средних и 5 низких, плюс формализация в реестре уже фактически
закрытой Д-6.6 (несуществующий `AUDIT20260908round4.md`, в тексте оба
места давно честны, просто пункт не был отмечен `[x]`). Одним проходом,
без выделения под-этапов — находки мелкие и независимые.

- **Партии каталога и A/B — денежные гонки и точечный повтор.**
  Busy-check при создании партии (Д-1.2) теперь исключает и `DONE`, не
  только `PENDING`/`GENERATING` — перезапуск партии после частичного
  провала не пытается заново оплатить уже готовые товары. Гонка МЕЖДУ
  разными партиями с пересекающимся списком товаров (Д-2.2) закрыта
  оборачиванием busy-check+вставки в `$transaction({isolationLevel:
  'Serializable'})` с автоповтором до трёх раз на `P2034` — составной
  частичный индекс сознательно не заводился (не выражается в
  `schema.prisma`, тот же довод, что у `20260908160000_drop_unused_indexes`).
  Новый маршрут `POST /projects/:id/catalog-batch/:batchId/retry`
  (Д-1.3) повторяет либо все `FAILED`-строки партии, либо одну по
  `productItemId`, с кнопками «Повторить»/«Повторить все ошибки» на
  экране прогресса. Ретрай после сбоя ЗАПИСИ статуса (узкое окно,
  Д-2.5) больше не повторяет вслепую все шаги заново — `processOne()`
  обоих воркеров (партия, A/B) резюмируется по фактическому состоянию
  сессии (`generationPrompt.approvedAt`/`generatedVideo`), так что GPT-5
  не оплачивается второй раз, хотя Veo от этого и был защищён раньше.
- **Джоб-уровневый TTL-замок кронов (Д-3.3).** Новая модель
  `CronJobLock` (миграция `20261017090000_cron_job_lock`) и
  `common/cron-job-lock.ts` (`tryAcquireJobLock`/`releaseJobLock`,
  `create()` затем P2002-фоллбек на условный `updateMany()`) — оборачивает
  `runBatch()`/`runTick()` целиком у всех трёх воркеров (партия, A/B,
  импорт фида). Не advisory-лок транзакционной области, как у
  publication/credit-ledger/billing — там под замком весь цикл с
  сетевыми вызовами, а не пара быстрых запросов, и session-scoped
  `pg_advisory_lock` не гарантирует одно физическое соединение под
  PgBouncer в transaction-pooling режиме.
- **Импорт товарного фида — идемпотентность и видимая ошибка.**
  `ProductFeedImportItem.productItemId` теперь пишется СРАЗУ после
  успешного `addItem()`, до финальной записи статуса строки (Д-2.1) —
  транзиентный сбой между заведением товара и фиксацией строки больше
  не создаёт дубликат при следующем тике. Провал `attachCategoryAndPhoto`
  (Д-2.4) больше не растворяется бесследно в `.catch(() => undefined)` —
  логируется и пишет видимую причину на строку импорта.
- **Потоковый лимит размера тела ответа (Д-3.2).** Новая
  `readBodyWithLimit()` в `common/external-url-guard.ts` читает тело
  чанками через `res.body.getReader()` и вызывает `reader.cancel()`, как
  только пройденный объём превышает лимит, с фоллбеком на
  `res.arrayBuffer()` + постпроверку, когда `res.body` недоступен —
  `Content-Length`-проверка осталась быстрым предпроверочным путём, не
  единственной гарантией (источник может не прислать заголовок при
  chunked-передаче или занизить его при сжатии).
- **`CronRunLog` и индексы истории (Д-2.3, Д-4.2, Д-4.6, Д-4.4).**
  Сообщение брошенной ошибки в обоих catch-блоках `runSweepOrphans()`
  теперь несёт частичные счётчики (просмотрено/удалено/запланировано) —
  упавшая «метла» после частичного реального удаления больше не пишет
  `FAILED` без единого числа о случившемся. Новый `@@index([startedAt])`
  на `CronRunLog` (рядом с существующим `@@index([jobKey, startedAt])`) и
  `@@index([productItemId])` на `CatalogBatchItem` (обычные, не
  частичные индексы — та же логика, что у Д-2.2) — обе миграции чисто
  аддитивные (`20261017090000_cron_job_lock`,
  `20261018090000_d42_d46_indexes`). Известное ограничение — три новые
  таблицы истории (партии, A/B, импорт фида) растут без чистки —
  задокументировано в `doc/DEPLOYMENT.md` и доккомментарии
  `CronJobsService.runCleanupSessions()` как осознанно принятый риск при
  текущем Premium-only масштабе, без функциональной правки.
- **UX поллинга прогресса (Д-5.3).** Все три экрана прогресса (партия,
  A/B, импорт фида) теперь переставляют таймер следующего опроса и в
  `.catch()`, не только в `.then()` — одна транзиентная сетевая ошибка
  больше не останавливает поллинг навсегда.
- **Настройки админки (Д-3.4).** Семь переменных окружения этапов 65–68
  (`CATALOG_BATCH_CRON_BATCH`, `CATALOG_BATCH_MAX_ATTEMPTS`,
  `AB_TEST_CRON_BATCH`, `AB_TEST_MAX_ATTEMPTS`,
  `PRODUCT_FEED_IMPORT_CRON_BATCH`, `PRODUCT_FEED_IMPORT_MAX_ATTEMPTS`,
  `PRODUCT_FEED_IMPORT_MAX_BYTES`) добавлены в группу «Товар / Проект»
  вкладки «Настройки» тем же паттерном (`isPositiveInt`), что у соседних
  тюнинговых переменных.
- **N+1 в двух списках админки — пересмотрено, не изменено (Д-4.5).**
  Партии и A/B оставлены как есть: параллельный веер из `pageSize`
  быстрых `groupBy` не входит в число реальных проблем при
  Premium-only масштабе; решение и путь денормализации на манер
  `ProductFeedImportRun` задокументированы прямо в коде обоих сервисов
  (`AdminCatalogBatchService.listBatches()`,
  `AdminAbTestService.listRuns()`).
- **Документы (Д-6.3–Д-6.9, формализация Д-6.6).** `doc/API.md` —
  «девять» → «десять» маршрутов секрет-гейта (два места); README —
  список документации дополнен четырьмя пропущенными файлами, раздел
  Features дополнен пунктами по всем этапам после очереди публикации;
  `doc/TODO.md` — счётчик раздела III («29» → «35» направлений), пункт
  35 отделён от чужого заголовка «актёры без референса» и добавлен в
  дорожную карту («Горизонт 2»), сам «Горизонт 2» отмечен «почти
  достигнутым» (три из четырёх пунктов уже ✅); находка Д-6.6 отмечена
  закрытой в реестре явно, без изменения текста (уже был честным).
- **Проверка.** `npx tsc --noEmit`/`eslint --max-warnings 0` — чисто в
  `backend/` (тот же класс несгенерированного `@prisma/client`). Полный
  jest в `backend/`: **1873 теста / 142 набора** (было 1817/141 после
  этапа 73 — 56 новых тестов, см. параграф «Прирост» в «Итоговой
  сверке» выше за точным списком спек-файлов), из тех же **17 падают /
  5 наборов не запускаются** — на один набор МЕНЬШЕ, чем на этапе 73:
  `catalog-batch.service.spec.ts` выпал из списка долга, потому что сам
  этот этап его и починил (Д-1.2/Д-2.2), а не оставил падающим. Обе
  новые миграции применены на локальном Postgres 16 подряд со всеми
  существующими через `psql -f` (`prisma migrate` по-прежнему блокирован
  403 песочницы на `binaries.prisma.sh`) — `\d` подтверждает новую
  таблицу `cron_job_locks` и оба новых индекса. `node
  scripts/check-docs.mjs` — после этого блока и последующих точечных
  правок README/ACCEPTANCE-CHECKLIST/CI.md/TELEGRAM-ADMIN.md (ниже) — 0
  расхождений. `node scripts/sync-legal.mjs --check` — без изменений
  (этап не трогает юридические тексты).

**Сделано (этап 75 — автоэкспорт одной генерации под несколько площадок
сразу, TODO §III п.35, закрывает «Горизонт 2» дорожной карты, см. §53
SPEC).** Полное ТЗ — `doc/MULTI-FORMAT-EXPORT-SPEC.md`, черновик с семью
открытыми вопросами; четыре архитектурно значимых решены владельцем
продукта через `AskUserQuestion` этой стадии (оба яруса сразу, только
обрезка без чёрных полей, один billing-charge на весь батч, переиспользо-
вать `customAspectRatio`), остальные три взяты как есть из собственных
рекомендаций документа (точка запуска — постфактум, не чекбоксы на
генерации; Instagram/Facebook — файл без интеграции публикации; YouTube
и YouTube Shorts остаются одним значением `PublicationPlatform`).

- **Два яруса.** Ярус A — `aspectRatioFamily()` (обёртка над `veoFrameFor`,
  `common/aspect-ratio.ts`) делит форматы на семейства `9:16`/`16:9`;
  `planBatchReframe()` (`common/reframe.ts`) собирает несколько команд
  `crop` под один batched-вызов `FfmpegApiService.submit()`;
  `PostProductionService.startExport()`/`pollExport()` — гейт-проверки
  (ролик готов, сервис настроен, нет второго батча в процессе, все
  цели одного семейства), одна запись `AiUsageService.record()` на весь
  батч, опрос переносит готовые файлы в свой Blob. Ярус B —
  `ExportService.startRerender()` (новый модуль `modules/export`):
  проверяет семейство (иначе подсказывает дешёвый путь), не дублирует
  уже запрошенный неупавший формат, требует одобренный промпт; создаёт
  дочернюю сессию (полный `SessionSeed` для проектных сессий; для
  «простых» — `createSession()` без seed + `updateSession()` с
  `productInformation`/`brandManifestSnapshot` копией, не ссылкой) тем
  же приёмом, что `CatalogBatchWorkerService`/`AbTestWorkerService.processOne()`,
  без крона — синхронно по явному запросу; `PostProdError` (обычный
  `Error`) оборачивается в `BadRequestException` на границе контроллера.
- **Данные.** `GeneratedVideo.exportJobId`/`exportVariants: ExportVariant[]` —
  денормализованный массив внутри уже существующей JSON-колонки, без
  новой модели Prisma и миграции.
- **Три маршрута.** `POST /sessions/:id/export` (ярус A, резолвит
  пресеты `PLATFORM_EXPORT_PRESETS` в форматы), `POST
  /sessions/:id/export/rerender` (ярус B), `GET
  /sessions/:id/export/status` (двигает оба яруса, ярус B — опрашивая
  `GenerationService.getVideoStatus()` каждой незавершённой дочерней
  сессии, тот же принцип «не заводить второй цикл опроса», что у
  `poll()` основной постобработки) — все под `:sessionId`, глобальный
  `SessionOwnerGuard` защищает без своей настройки; оба яруса — под
  существующим `PlanFeature.customAspectRatio`.
- **Побочный фикс публикации.** `PublicationService.snapshotFromSession()`
  сравнивает семейство, нужное площадке, с семейством реально
  отрендеренного кадра — при расхождении предпочитает завершённый
  `exportVariant` нужного семейства файлу сессии; нет такого — прежнее
  поведение.
- **Побочный фикс уборки.** `common/blob-paths.ts`: файлы яруса A
  (`sessions/{id}/export-*.mp4`) добавлены в `sessionBlobPathnames()` —
  без этой строки удаление сессии оставляло бы их немедленным сиротой
  до следующего прохода метлы, тот же класс дефекта, что этап 26 когда-то
  закрывал целиком (файл яруса B в этот список не входит и не должен —
  он лежит под префиксом ДОЧЕРНЕЙ сессии, которая удаляется сама по
  себе своим циклом).
- **Фронтенд (TMA).** `ExportPanel.tsx` на экране готового ролика:
  чекбоксы яруса A с одной кнопкой «Экспортировать», отдельные кнопки
  «Перерендерить» на каждый пресет яруса B — разные виджеты, не один
  список, чтобы лишняя галочка не заказывала платный рендер случайно.
  Свой самопланирующийся `setTimeout`-опрос статуса внутри панели (тот
  же приём, что `AbTestProgressScreen`/`CatalogBatchProgressScreen`,
  включая устойчивость к сетевой икоте, Д-5.3), не второй канал в
  `useWorkflow` — автоэкспорт запрашивается уже после того, как общий
  опрос генерации сам остановился. Панель скрыта, пока
  `postStatus === 'pending'` — резать нечего, пока не завершилась
  основная постобработка. Строки словаря — во всех пяти локалях.
- **Проверка.** `npx tsc --noEmit`/`eslint --max-warnings 0` — чисто в
  `backend/` и `frontend/`. Полный jest в `backend/`: **1930 тестов /
  143 набора** (было 1873/142 после этапа 74 — 57 новых тестов, см.
  параграф «Прирост» в «Итоговой сверке» выше за точным списком
  спек-файлов), из тех же **17 падают / 5 наборов не запускаются**, не
  связанных с этим этапом. `frontend/`: `npm run build` и `npm test`
  (20 unit-скриптов, включая расширенный `aspect-ratio.test.ts`)
  зелёные. Новая миграция не нужна. `node scripts/check-docs.mjs` — 0
  расхождений после обновления чисел маршрутов/тестов в README,
  ACCEPTANCE-CHECKLIST, CI.md, этом файле, API.md, TODO.md. `node
  scripts/sync-legal.mjs --check` — без изменений.

**Сделано (этап 76 — исправление высоких находок шестого аудита,
`doc/AUDIT-2026-09-10-round6.md`, см. §54 SPEC).** По прямому запросу
владельца продукта: «чиним высокие в одном проходе» — в отличие от
пятого раунда (этап 71/74), высокие и средние/низкие не разносились по
разным стадиям здесь вообще не планировалось: все 8 высоких находок
шестого аудита (Е-1.1, Е-1.2, Е-2.1, Е-2.2, Е-2.3, Е-4.1, Е-5.1, Е-5.2)
закрыты одной стадией.

- **Е-1.1 — CAS вместо безусловной записи в `StarsSubscriptionReconcileService.reconcile()`.**
  Оба `update` заменены на `prisma.subscription.updateMany({ where: {
  id, currentPeriodEnd: <снимок> }, data })` — тот же приём, что уже
  использует `WayForPayRenewalService.charge()` (Г-2.7); задержанный
  вебхук `successful_payment`, продливший подписку между чтением
  снимка и записью кроном, больше не откатывается назад.
- **Е-1.2 — суточный лимит и транзиентный сбой Veo не убивают строку
  партии/A-B навсегда.** `isDailyLimit = error instanceof
  DailySpendLimitExceededException` проверяется в обоих воркерах ПЕРЕД
  `NON_RETRYABLE_NAMES.has(errorName)` — суточный лимит теперь всегда
  ретраится с завтрашнего сброса, а не уходит в `FAILED` навсегда.
  `GenerationService.startVeoGeneration()` заворачивает транзиентные
  коды (429/5xx) `ApiError` SDK `@google/genai` в новый
  `ServiceUnavailableException` вместо `BadRequestException` —
  `ServiceUnavailableException` не входит в `NON_RETRYABLE_NAMES`,
  проходит обычным бэкоффом.
- **Е-2.1 — вид работы `'export'` в `WORK_KINDS`.** `PostProductionService.startExport()`
  (ярус A) и `ExportService.startRerender()` (ярус B) обёрнуты в
  `claimWork(sessionId, 'export', TTL)`/`releaseWork` — тем же приёмом,
  что документирован в `ffmpeg-api.service.ts` как образцовый для
  `advanceSubtitleBurn`; двойной клик «Экспортировать»/«Перерендерить»
  больше не теряет один из двух `exportVariants` при записи.
- **Е-2.2 — дедлайн для `pollExport` (ярус A).** Новая константа
  `EXPORT_DEADLINE_MS = POSTPROD_DEADLINE_MS` (15 минут) в
  `postprod.service.ts`; просроченный/недоступный `exportJobId`
  закрывается сбоем варианта(ов) вместо бесконечного `pending` —
  `startExport` снова принимает новый запрос сразу после дедлайна.
- **Е-2.3 — крон-аналог `advanceGenerating()` для яруса B.**
  `ExportService.runSyncTick()` — досматривает статус дочерних
  рендеров независимо от того, открыт ли экран прогресса. Проведена
  через ту же инфраструктуру, что остальные девять кронов:
  `CronJobsService.runExportSyncRun()` → `GET
  /api/cron/export-sync-run` (`cron.controller.ts`, одиннадцатый слот,
  `backend/vercel.json`, каждые 1-2 минуты) → запись в
  `JOB_REGISTRY`/`switch` `admin-cron.service.ts`. Та же находка того
  же прохода, что нашёл Д-1.1 пятого аудита — рецидив на новом коде
  (этап 75), закрыт тем же паттерном.
- **Е-4.1 — клонированный голос помечается своим настоящим
  провайдером.** `manifestDataFromDto()`
  (`brand-manifest.service.ts`)/`applySnapshotEdit()`
  (`project-session.service.ts`) получили параметр `isResembleClone =
  false`: при `true` пишут `ttsProvider: 'resemble'` вместо
  `activeProviderKey` (провайдера, активного на стенде прямо сейчас).
  Асинхронный поиск «это мой клон?» (`prisma.userVoice.findFirst`, тот
  же приём, что `excludeClonedVoices()` в `tts.controller.ts`) сделан
  вызывающими методами (`create()`/`update()`/`updateSnapshot()`) ДО
  вызова чистой функции — сама функция остаётся синхронной. Фронтенд:
  `VoicePicker.tsx` — кнопка «Выбрать» у клонированного голоса
  физически `disabled`, если активный провайдер не Resemble.
- **Е-5.1 — индексы на `User` (реверс решения этапа 54).** `@@index([createdAt])`
  плюс три GIN-триграммных индекса (`telegramId`/`username`/`firstName`)
  — по образцу `analysis_library`; аудит прямо утверждает, что решение
  этапа 54 (не индексировать `users` — тогда маленькая) больше не
  держится. Миграция `20261019090000_user_createdat_trgm_indexes`.
- **Е-5.2 — блоб-префикс `users/` в «метле».** `'users'` — шестая
  область `SWEEP_SCOPES`, `SWEEP_PREFIX.users = 'users/'`,
  `sweepFileKind()` относит `voices/*` к `voice`,
  `CronJobsService.liveOwners()` — ветка `prisma.user.findMany`.
  Честная оговорка (в коде и здесь): ловит только файлы УДАЛЁННОГО
  пользователя, не файлы живого пользователя, не довёдшего
  клонирование до `confirmClone()` — аудит отдельно предлагал TTL для
  этого более узкого случая, вне объёма Е-5.2.
- **Проверка.** Полный jest в `backend/` (`jest.config.sandbox.json`,
  `isolatedModules`): **1968 тестов / 143 набора** (было 1930/143 после
  этапа 75 — 38 новых тестов, все в существующих спек-файлах, новых
  файлов не заводилось), из тех же **17 падают / 5 наборов не
  запускаются** (`analysis.service.spec.ts`, `plan.controller.spec.ts`,
  `project.service.spec.ts`, `billing.service.spec.ts`,
  `marketing-consent.service.spec.ts`) — подтверждено `git diff --stat`,
  что ни один из этих файлов этапом 76 не тронут; тот же долг
  предыдущих этапов. `npx tsc --noEmit`/`eslint --max-warnings 0` — чисто
  в `backend/` и `frontend/` по всем файлам, изменённым этой стадией
  (тот же класс несгенерированного `@prisma/client`, что на всех этапах
  с 64). Все 41 миграция (включая новую) применены по порядку на
  локальный Postgres 16 через `psql` — без ошибок, `\d users`
  подтверждает четыре новых индекса. `prisma validate` (фейковый
  schema-engine) — схема валидна. `node scripts/check-docs.mjs`/`node
  scripts/sync-legal.mjs --check` — см. «Итоговая сверка» ниже.
- **Не сделано в этом этапе.** Средние и низкие находки шестого аудита
  (Е-1.3–Е-1.6, Е-2.4–Е-2.7, Е-3.1–Е-3.2, Е-4.2–Е-4.3) — владелец
  продукта попросил только высокие в этом проходе; остаются долгом на
  будущее, тем же порядком, что после этапа 71 (закрыто отдельной
  стадией 74).

**Сделано (этап 77 — исправление средних и низких находок шестого
аудита, `doc/AUDIT-2026-09-10-round6.md`, см. §55 SPEC).** Продолжение
этапа 76 тем же порядком, что пятый раунд (высокие → этап 71, средние/
низкие → отдельная стадия 74): все 12 оставшихся находок (Е-1.3–Е-1.6,
Е-2.4–Е-2.7, Е-3.1–Е-3.2, Е-4.2–Е-4.3) разобраны — 10 закрыты кодом, 2
(Е-3.2, Е-4.3) сознательно НЕ тронуты по итогам разбора, с обоснованием
ниже.

- **Е-1.3 — джоб-уровневый замок для `BillingRenewalWorkerService.runBatch()`.**
  `tryAcquireJobLock`/`releaseJobLock` (`JOB_KEY = 'billing-renew'`) —
  рецидив класса Д-3.3 пятого аудита на четвёртом кроне: `runBatch()`
  оборачивает переименованный `runBatchLocked()`, возвращает нулевой
  результат, если замок уже занят другим прогоном, вместо того чтобы
  читать подписки параллельно с другим тиком.
- **Е-1.4 — узкое окно между стартом Veo и записью сессии больше не
  тонет в автоматическом возврате кредита.** Новый `VeoOperationOrphanedError`
  (`generation.service.ts`, наследует `InternalServerErrorException`) —
  бросается, если Veo уже реально приняла запрос (получено
  `operation.name`, то есть деньги, скорее всего, уже потрачены), а
  запись `aiUsage.record`/`updateSession` после этого упала.
  `startGeneration()` больше не зовёт `refundIfReserved` для этого
  конкретного класса ошибки — баланс остаётся списанным намеренно,
  разбор ручной (иначе либо оплаченный рендер повисает ни к чему не
  привязанным, либо обычный повтор пользователя платит за ВТОРОЙ
  настоящий рендер того же ролика). `CatalogBatchWorkerService`/
  `AbTestWorkerService.NON_RETRYABLE_NAMES` дополнены именем этого
  класса — по той же причине автоматический бэкофф-ретрай строки
  партии/A-B тоже недопустим (там `videoStarted` смотрит именно на
  сохранённый `session.generatedVideo`, которого как раз и нет).
- **Е-1.5 — ручная правка баланса кредитов оператором.**
  `AdminUsersService.adjustCredit()` (новый метод, вызывает уже
  реализованный с этапа 62 `CreditLedgerService.adminAdjust()`) +
  `POST /admin/users/:id/credit-adjust` (`AdjustCreditDto`, `delta:
  number`, `@IsInt() @NotEquals(0)`) + кнопка «Кредиты» на `/users`
  (`window.prompt` для дельты, `window.confirm` перед отправкой, тот
  же приём, что у причины блокировки). Правка пишется в лог оператором
  и итоговой дельтой — тот же принцип, что у смены режима/блокировки.
- **Е-1.6 — таймингово-безопасное сравнение подписи WayForPay.**
  `WayForPayService.verifyServiceCallback()` — новая `safeEqual()`
  (модульная функция, дословно повторяет приём `stars-invoice-payload.util.ts`:
  при несовпадении длины буферов вызывает `timingSafeEqual` на себе
  же, чтобы не выдать длину секрета через ранний `return`, затем уже
  честное сравнение при равных длинах).
- **Е-2.4 — `CatalogBatchService.retry()` больше не обходит busy-check
  между партиями.** Полностью переписан: `Promise<{retried, skippedBusy}>`,
  Serializable-транзакция + retry на `P2034` (тот же приём, что
  `create()`), исключает из повтора товары, занятые ДРУГОЙ активной
  партией. Фронтенд (`CatalogBatchProgressScreen.tsx`) показывает
  информационный алерт с числом молча пропущенных строк — новый ключ
  словаря `retrySkippedBusy` во всех пяти локалях.
- **Е-2.5 — `AbTestService.create()` защищена от конкурентного
  создания.** Новый `assertNotBusy()` (busy = есть вариант НЕ в статусе
  `FAILED` для этого `sourceSessionId`) вызывается дважды: один раз ДО
  дорогого вызова GPT-5 (`generateAbVariants`, экономит деньги при
  явном повторном клике) и второй раз внутри новой Serializable-
  транзакции прямо перед вставкой (та же гонка «прочитать свободно →
  вставить», что Д-2.2 пятого аудита у `CatalogBatchService.create()`).
- **Е-2.6 — `blob-paths.ts` знает про файлы субтитров и аватар-пайплайна.**
  `sessionBlobPathnames()` дополнен: `generatedVideo.subtitlePathname`
  (основной пайплайн) и весь блок `avatarVideo` (`voiceoverPathname`
  напрямую, `renderedUrl`/`downloadUrl` через `pathnameFromBlobUrl`,
  `subtitlePathname`) — раньше эти файлы не входили ни в один список
  уборки при удалении сессии, только в более грубую суточную метлу по
  префиксу владельца (до ~1 суток задержки).
- **Е-2.7 — ранние выходы `PostProductionService.start()` больше не
  теряют `subtitlesMode`/`subtitleStatus`.** Обе ветки («ffmpeg не
  настроен» и «бюджет/блокировка») получили `subtitlesMode:
  work.subtitlesMode, subtitleStatus: 'skipped'` в `save()` — раньше
  оставляли эти поля `undefined`, экран результата не мог отличить
  «субтитры не заказывались» от «отказались молча».
- **Е-3.1 — `ActorsService.runSoundCheck()` под `claimWork`.** Новый вид
  работы `'avatar-sound-check'` в `WORK_KINDS`; метод захватывает замок
  ДО платного вызова Gemini (Files + generateContent), снимает в
  `finally`, и перечитывает сессию непосредственно перед финальной
  записью — тот же паттерн «захват + свежее чтение», что уже применён
  для `avatar-generate`/`avatar-subtitle-burn`. Рецидив того же класса
  гонки на третьем платном пути пилота аватара.
- **Е-4.2 — лимит клонов голоса защищён от параллельных запросов.**
  `UserVoicesService.confirmClone()` — проверка (`count < MAX_USER_VOICES`)
  и создание TRAINING-строки теперь ОДНОЙ транзакцией под
  `pg_advisory_xact_lock` по userId (тот же приём, что
  `CreditLedgerService.reserveForGeneration()`); сама строка и есть
  резерв слота — она создаётся ДО платного вызова Resemble, поэтому
  видна count() параллельного запроса даже пока Resemble ещё не
  ответила. Результат Resemble (успех/отказ) теперь ОБНОВЛЯЕТ эту же
  строку, а не создаёт вторую.
- **Е-3.2 и Е-4.3 — разобраны, код НЕ менялся.** Е-3.2 сам аудит
  прямо называет сознательным решением, не дефектом — фиксируем это
  здесь как явное решение, а не молчаливый пропуск. Е-4.3 (единственная
  защита от replay Telegram initData — 24-часовое окно `auth_date`, без
  таблицы «уже использованных hash») разобрана намеренно глубже, чем
  остальные средние/низкие пункты — аудит сам пометил её «эмпирически
  не проверено» и предложил направление, а не готовое решение. Чтение
  `telegram-identity.middleware.ts`/фронтендового `getAuthHeaders()`
  (`frontend/src/lib/telegram.ts`) подтверждает: один и тот же
  `initData` из `Telegram.WebApp.initData` прикладывается ЗАГОЛОВКОМ НА
  КАЖДЫЙ запрос всю жизнь открытой Mini App-сессии — это не
  одноразовый обмен на токен, а сам механизм идентичности, легитимно
  переиспользуемый десятки/сотни раз подряд. Из этого следует, что оба
  направления, предложенные аудитом, вредны здесь конкретно:
  таблица «уже использованных hash» сломала бы обычную работу продукта
  на ВТОРОМ же запросе сессии (initData не одноразовый), а укороченное
  окно для денежных операций не закрывает реальный риск (утёкший
  initData реплеится с той же лёгкостью в начале окна, как и в конце
  — «свежесть» относительно `auth_date` не меняется от того, когда
  именно внутри сессии он используется), но добавляет частые ложные
  отказы легитимным пользователям, оставившим Mini App открытым дольше
  окна. Решение: не реализовывать ни одно из двух предложенных
  направлений; фиксируем это как разобранный и сознательно принятый
  риск, не долг.
- **Проверка.** Полный jest в `backend/` (`jest.config.sandbox.json`,
  `isolatedModules`): **2001 тест / 143 набора** (было 1968/143 после
  этапа 76 — 33 новых теста: `billing-renewal-worker.service.spec.ts`,
  `blob-paths.spec.ts`, `postprod.service.spec.ts`,
  `catalog-batch.service.spec.ts`, `ab-test.service.spec.ts`,
  `actors.service.spec.ts`, `generation.service.spec.ts`,
  `catalog-batch-worker.service.spec.ts`,
  `ab-test-worker.service.spec.ts`, `admin-users.service.spec.ts`,
  `user-voices.service.spec.ts` — новых спек-файлов не заводилось), из
  тех же **17 падают / 5 наборов не запускаются**
  (`analysis.service.spec.ts`, `plan.controller.spec.ts`,
  `project.service.spec.ts`, `billing.service.spec.ts`,
  `marketing-consent.service.spec.ts`) — тот же долг предыдущих этапов
  (зафиксирован после этапов 68/69/70/71/72б/73/74/75/76), ни один из
  этих файлов этапом 77 не тронут. `npx tsc --noEmit`/`eslint
  --max-warnings 0` — чисто в `backend/` по всем файлам, изменённым
  этой стадией (тот же класс несгенерированного `@prisma/client`).
  `admin/`: `npx tsc --noEmit`, `next lint --max-warnings 0`, `next
  build` — маршрут `/users` собирается с новой кнопкой. `frontend/`:
  `npx tsc --noEmit`, eslint, `vite build`, все 15 unit-скриптов —
  зелёные. Новая миграция не нужна — ни одна из 10 закрытых находок не
  меняет схему. `node scripts/check-docs.mjs` — 0 расхождений после
  обновления чисел тестов (README, ACCEPTANCE-CHECKLIST, CI.md, этот
  файл) и маршрутов/контроллеров (README — новый `POST
  /admin/users/:id/credit-adjust`, 183 вместо 182). `node
  scripts/sync-legal.mjs --check` — без изменений (эта стадия не
  трогает юридические тексты).

**Внеплановый фикс (после этапа 77) — неверная типизация Prisma-транзакций
ломала реальную сборку на Vercel.** Реальный деплой (`npm run build` с
по-настоящему сгенерированным `@prisma/client`, не песочница) упал с 39
ошибками `tsc` — `Argument ... is not assignable`/`No overload matches
this call` на каждом interactive-transaction вызове проекта. Корень: 13
мест по всему бэкенду типизировали callback-параметр `$transaction` как
`tx: typeof this.prisma` — полный тип `PrismaService` (со своими
NestJS-полями `logger`/`onModuleInit`/`onModuleDestroy`/`$on` и др.),
тогда как реальный объект транзакции Prisma — это `Omit<PrismaClient,
'$connect' | '$disconnect' | '$on' | '$use' | '$extends'>`, у него этих
полей физически нет. В песочнице это не ловилось никогда — `@prisma/client`
здесь не генерируется (`403` на `binaries.prisma.sh`), а стаб-клиент
типизирует всё как `any`; ошибка была видна только там, где Prisma
действительно генерируется — то есть в CI/на Vercel, а не локально за все
предыдущие 77 этапов.

Правка (везде одним и тем же приёмом): у callback'ов, переданных напрямую
в `$transaction(async (tx) => ...)`, явная аннотация типа параметра
`tx` просто убрана — TypeScript контекстно выводит правильный тип сам,
без риска разойтись с версией Prisma. Там, где `tx` передаётся дальше в
отдельный приватный метод как явный параметр (не может быть выведен из
контекста) — тип `Prisma.TransactionClient` (официально экспортируемый
Prisma тип ровно для этого случая) вместо `typeof this.prisma`.
Затронутые файлы: `user-voices.service.ts`, `blog.service.ts`,
`publication.service.ts`, `credit-ledger.service.ts`, `billing.service.ts`
(два `$transaction`-вызова и приватный `applySuccessfulPayment(tx: ...)`),
`shared-video.service.ts`, `ab-test.service.ts` (`$transaction`-вызов и
приватный `assertNotBusy(..., tx: ... = this.prisma)`),
`product-feed-import-worker.service.ts`, `catalog-batch.service.ts` (два
вызова). Ни один из фиксов не меняет поведение в рантайме — только
типизацию; `shared-video.service.ts`'s второй заявленный в логе Vercel
`error` (`toView(await this.keepOwnCopy(row))`, `any[]` вместо
`SharedVideoRow`) был не отдельным дефектом, а тем же самым корнем: когда
перегрузка `$transaction` не резолвится из-за несовместимого `tx`,
TypeScript в некоторых случаях откатывается к сигнатуре
array-перегрузки (`$transaction(arg: PrismaPromise<any>[])`) и выводит
результат как `any[]` — фикс типа `tx` исправил и это заодно, без
отдельной правки.

Проверка: полный jest в `backend/` — те же **2001/143**, из тех же
**17 падают/5 наборов** (тот же долг, не задет). `eslint --max-warnings
0` по всем девяти изменённым файлам — чисто (после `--fix` для
форматирования, которое сдвинулось из-за укоротившейся сигнатуры
callback'а). `grep -rn "tx: typeof this.prisma" src` — пусто, паттерн
закрыт полностью, не только в местах, где он был замечен изначально.
`node scripts/check-docs.mjs`/`node scripts/sync-legal.mjs --check` —
без расхождений. Реальную проверку `tsc` с настоящим сгенерированным
клиентом в песочнице повторить нельзя (та же сетевая блокировка) —
уверенность в фиксе только из чтения точного текста ошибок Vercel и
понимания официального типа Prisma, а не из локального перепрогона
`tsc`; следующий реальный деплой — единственная стопроцентная проверка.

**Внеплановый фикс №2 (сразу после №1) — Node.js 20→24 и вторая волна
ошибок сборки Vercel: узкий Prisma `select` присвоен более широкому
структурному типу «Row».** Отдельно от типизации транзакций Vercel
показал ещё две вещи.

Во-первых, предупреждение о том, что Node.js 20.x устарел и деплои
после 2026-10-01 не соберутся — `backend/package.json`'s `"engines":
{"node": "20.x"}` перебивал настройку "24.x" в Project Settings Vercel
(`engines.node` в `package.json` имеет приоритет над дашбордом).
Исправлено на `"24.x"`; заодно — чисто для консистентности, не
обязательно для самой ошибки — подняты все прочие упоминания
`node:20-alpine`/`NODE_VERSION: '20'` до 24: `.github/workflows/ci.yml`,
все четыре dev-only `Dockerfile.dev` (`backend`/`frontend`/`admin`/
`landing` — по их же комментарию "Not used for Vercel deployment"), и
два места в `doc/DOCKER.md`.

Во-вторых — новый, отдельный от транзакций класс ошибок `tsc` (18 штук
в логе): Prisma-запрос с намеренно сужающим `select`/`include.select`
(обычно ради производительности — не тянуть тяжёлое поле) присваивался
переменной или параметру функции, типизированному ПОЛНЫМ структурным
интерфейсом «XxxRow», требующим больше полей, чем реально выбрано. В
песочнице это тоже не ловится никогда (тот же стаб `@prisma/client`,
что и у бага транзакций выше) — видно только на настоящей сборке.
Пользователь смог прислать только хвост лога (два примера,
`library.service.ts:407` и `project.service.ts:149`) — на просьбу
прислать лог целиком дважды пришёл тот же обрезанный фрагмент, поэтому
вместо правки по полному списку ошибок был проведён ручной аудит: `grep
-rn "interface \w*Row\b"` по всему `backend/src` (25 файлов), сужено до
файлов, где рядом есть `select: {` (18 файлов), и каждый прочитан и
сверен вручную — узкий `select` сверен построчно с требуемыми полями
интерфейса «Row» и с тем, какие поля реально читает каждая
функция-потребитель.

Найдено и исправлено два случая:

- `library.service.ts`'s `candidates()` — `select` сознательно
  исключает `analysis` (комментарий на месте: "без `select` Prisma
  тянет и колонку `analysis` ... 13 КБ JSON на запись, при 200
  кандидатах это 2,7 МБ"), но результат был типизирован полным
  `LibraryRow`, требующим `analysis`. Исправлено на `Omit<LibraryRow,
  'analysis'>` — и у `candidates()`, и у `toRankable()`/`toView()`
  (обе функции подтверждённо никогда не читают `.analysis`); остальные
  вызовы `toView()` с полным `LibraryRow` остаются совместимы
  структурно (набор с большим числом полей подходит туда, где
  требуется меньше).
- `project.service.ts`'s `listProjects()` — читает товары через
  `include: { items: { select: { id, price, description } } }`, но
  `toProjectSummaryView()` был типизирован полным `ProjectRow` (его
  `items` — полный `ItemRow[]`). Исправлено на `Omit<ProjectRow,
  'items'> & { items?: Pick<ItemRow, 'price' | 'description'>[] }` —
  единственное, что реально читает функция (счётчик товаров и
  `isItemComplete({price, description})`); `toProjectView()` (другая
  функция, использующая тот же `ProjectRow` с полными `items` из
  `ITEMS_INCLUDE`) не тронута и остаётся корректной — полный `ItemRow`
  структурно подходит туда, где требуется урезанный `Pick`.

Оставшиеся 16 из заявленных 18 ошибок отдельно не идентифицированы (без
полного лога невозможно узнать точные номера строк) — но обе найденные
точки используются каждая в нескольких местах (`candidates()` → и
`toRankable`, и `toView`, в цикле ранжирования; `listProjects()` →
`.map(toProjectSummaryView)`), и `tsc` в реальности печатает отдельную
ошибку на каждое место использования несовместимого типа, а не одну на
объявление — поэтому два первопричинных дефекта вполне могли и
породить все 18 строк лога. Остальные 16 файлов из списка (`interface
\w*Row` + рядом `select:`) прочитаны и сверены вручную построчно — во
всех остальных узкий `select` либо точно соответствует интерфейсу
«Row» (админ-панель: `admin-ab-test`/`admin-catalog-batch`/
`admin-feed-import`/`admin-marketing.service.ts`; `legal.service.ts`;
`marketing-consent.service.ts`; `marketing-broadcast.service.ts`), либо
запрос использует `include` без сужающего `select` (значит скаляры
всегда полные — безопасное направление: интерфейсу с МЕНЬШИМ числом
полей всегда можно присвоить объект с БОЛЬШИМ, компилятор это
разрешает без ошибки) — `admin-billing.service.ts`,
`product-analog.service.ts`, `blog.service.ts`, `project-session.
service.ts`, `publication.service.ts`, `publish-worker.service.ts`,
`brand-manifest.service.ts` (там же — намеренный двойной `as unknown as
AssetDelegate` для делегатов characters/scenes, полностью обходящий
структурную проверку), `shared-video.service.ts`, `publishing-channel.
service.ts`, `ab-test-worker.service.ts`, `product-feed-import.
service.ts`, `catalog-batch-worker.service.ts` (эти два воркера, кстати,
уже содержат `advanceGenerating()` — досмотр статуса рендера у уже
стартовавших `GENERATING`-строк, находка Д-1.1 пятого аудита — тот
фикс на момент этого аудита оказался уже сделан).

Проверка: `eslint --max-warnings 0` на оба изменённых файла — чисто.
Полный jest в `backend/` — те же **2001/143**, из тех же **17
падают/5 наборов** (тот же долг, не задет — упавший `project.service.
spec.ts` про лимит 20 товаров в `addItem()`, не про изменённые
`listProjects()`/`toProjectSummaryView()`). `node scripts/check-docs.
mjs`/`node scripts/sync-legal.mjs --check` — без расхождений. Как и в
фиксе №1, настоящий `tsc` с сгенерированным клиентом в песочнице не
прогнать — уверенность из чтения точного текста ошибок и структурного
анализа типов, не из локального `tsc`; следующий реальный деплой —
единственная стопроцентная проверка, и она же покажет, остались ли ещё
ошибки за пределами присланного пользователем хвоста лога.

**Внеплановый фикс №3 — третья волна: нестрого типизированные
JS-объекты записывались в Json-колонки и в аргументы `data:` Prisma
напрямую.** На этот раз пользователь прислал полный, не обрезанный
текст ошибки `tsc` (с настоящими сгенерированными типами
`AnalysisLibraryEntryCreateInput`/`UpdateInput` из `node_modules/.
prisma/client`), что впервые в этой серии фиксов позволило увидеть
точный ожидаемый Prisma-тип, а не только реконструировать его по
аналогии.

Корень: `library.service.ts`'s `save()` и `refreshPreviews()` кастовали
разобранный ИИ-объект `VideoAnalysis` в `analysis: ... as unknown as
Record<string, unknown>` перед тем, как передать его в `create`/
`update` Json-колонки `analysis`. `Record<string, unknown>` не
удовлетворяет реальному входному типу Prisma для Json-поля
(`Prisma.InputJsonValue` — рекурсивно только JSON-safe значения, не
произвольный `unknown`); в песочнице это не ловится (стаб-клиент типизирует
всё как `any`), а на настоящей сборке — две ошибки `tsc`. Правка (в
обоих местах): каст на `Prisma.InputJsonValue` вместо `Record<string,
unknown>` — тот же приём, что уже был в `common/session.service.ts`'s
`data: seeded as Prisma.InputJsonValue` (единственное в кодовой базе
готовое правильное решение той же задачи, найденное через `grep` по
`InputJsonValue` и переиспользованное дословно).

Заодно, читая соседний код на тот же класс ошибок, нашёл и исправил ещё
один случай — не Json-колонку, а сам параметр `tx` интерактивной
транзакции: `product-analog.service.ts`'s `persist()` типизировал
callback `$transaction` явным собственным интерфейсом `PersistTx`
(методы `deleteMany`/`createMany`/`update` с `args: unknown`) —
ДОСЛОВНО тот же корневой баг, что и «Внеплановый фикс №1» (39 ошибок),
просто с другим именем типа, из-за чего его не находил `grep -rn "tx:
typeof this.prisma"` в первом раунде: `$transaction`'s разрешение
перегрузки не резолвится с произвольным структурным интерфейсом так же
хорошо, как с контекстным выводом, и на реальном клиенте это тоже упало
бы. Доккомментарий интерфейса дословно утверждал "with a generated
client, Prisma's real TransactionClient satisfies it" — то самое
неверное допущение, которое и породило фикс №1. Правка: аннотация `tx:
PersistTx` убрана (TypeScript выводит правильный тип из контекста сам,
как и в девяти файлах фикса №1), интерфейс `PersistTx` удалён целиком
(использовался ровно один раз); `itemData: Record<string, unknown>`,
передаваемый в `tx.productItem.update({data: itemData})`, приведён
явным касом к `Prisma.ProductItemUpdateInput`; `data.analogs.map(...)`,
передаваемый в `tx.productAnalog.createMany({data: ...})`, — к
`Prisma.ProductAnalogCreateManyInput[]` (оба каста — `as unknown as X`,
тот же безопасный двойной приём, что и у `analysis` выше; поля сверены
построчно со `schema.prisma`'s `model ProductAnalog` — `title`,
`sourceUrl`, `price`, `currency`, `thumbnailUrl`, `relevanceRank` — все
совпадают, каст не маскирует реальный дефект данных).

Искал такой же паттерн (нестрого типизированный `Record<string,
unknown>`/собственный структурный интерфейс, идущий в `data:` живого
Prisma-вызова) по всем Json-колонкам схемы (`Session.data`,
`ProductItem.audience`, `BrandManifest.filters`/`effects`,
`Payment.rawPayload`, `CronRunLog.debugLog`) — остальные пять уже
писались правильно (`Prisma.InputJsonValue`/`Prisma.DbNull`/`as
object` — та же практика, что теперь и в `library.service.ts`) и правки
не потребовали. Также проверил все прочие `$transaction(async (tx) =>`
по бэкенду (`grep -rn "\$transaction(async ("`) — после этой правки
`product-analog.service.ts` был последним местом с явной аннотацией
параметра `tx`, все остальные уже используют контекстный вывод.

Проверка: `eslint --max-warnings 0` на оба изменённых файла — чисто.
Полный jest в `backend/` — те же **2001/143**, из тех же **17
падают/5 наборов** (тот же долг). `node scripts/check-docs.mjs`/`node
scripts/sync-legal.mjs --check` — без расхождений. Настоящий `tsc` с
генерируемым клиентом по-прежнему недоступен в песочнице — но на этот
раз впервые ожидаемый Prisma-тип был виден в присланном пользователем
логе буквально (не реконструирован по документации), что даёт больше
уверенности, чем в фиксах №1/№2; следующий реальный деплой подтвердит
это окончательно.

**Внеплановый фикс №4 — четвёртая волна (12 ошибок): пропущенный
экземпляр бага №2 плюс новый класс — `groupBy`'s `by` без `as const`.**
Пользователь прислал ещё один полный текст ошибки `tsc` с двумя
примерами.

Первый пример — `brand-manifest.service.ts:239`, `remove()`:
```
const [characters, scenes]: [AssetRow[], AssetRow[]] = await Promise.all([
  this.prisma.brandCharacter.findMany({ ..., select: { photoUrl: true } }),
  this.prisma.brandScene.findMany({ ..., select: { photoUrl: true } }),
]);
```
Это ДОСЛОВНО тот же баг, что «Внеплановый фикс №2» (узкий `select`
присвоен более широкому структурному типу) — и этот КОНКРЕТНЫЙ участок
кода уже читался при аудите фикса №2 (файл был в списке проверенных),
но был по ошибке пропущен: аудит фикса №2 сосредоточился на находках
"select vs. более широкий именованный интерфейс" в ОДИНОЧНЫХ
переменных, а этот случай — тот же дефект внутри `[X[], Y[]]`-кортежа
у `Promise.all`, и его не заметили. Отдельный `grep` теперь по всему
`backend/src` на паттерн `]: [...Row[]` подтвердил — это был
единственный необнаруженный экземпляр (два других похожих места,
`library.service.ts:565` и `blog.service.ts`'s `RowWithTranslationsPartial`/
`PublicListRow`, при повторной проверке подтверждены корректными: там
запрос вообще без `select` — полный ряд, не уже). Исправлено тем же
приёмом — `Pick<AssetRow, 'photoUrl'>[]` вместо `AssetRow[]` в обоих
элементах кортежа.

Второй пример — `credit-ledger.service.ts:61`, `balancesFor()` —
**новый класс ошибки**, впервые встреченный в этой серии: `tsc`
отверг сам АРГУМЕНТ вызова `groupBy({ by: ['userId'], where: {...},
_sum: { delta: true } })` с криптическим "Type ... is missing the
following properties from type '{...}[]': length, pop, push, concat,
и ещё 29" — известный (задокументированный в issues самой Prisma)
эффект: `by: ['userId']`, будучи ЛИТЕРАЛОМ массива внутри объекта
аргумента, TypeScript в некоторых версиях widen'ит до `string[]`
вместо кортежа литералов `readonly ["userId"]`, а сложный
условный/перегруженный тип аргумента `groupBy` не резолвится с
широким `string[]` — и в одной из веток резолюции компилятор
сверяет объект ещё и с типом массива (отсюда `length`/`pop`/`push` в
сообщении). В песочнице это не ловится по тем же причинам, что и все
предыдущие три волны (стаб-клиент). Фикс — задокументированный в
экосистеме Prisma: `by: ['userId'] as const`.

Раз баг — в самом ЛИТЕРАЛЕ `by: [...]`, а не в чём-то специфичном для
`credit-ledger.service.ts`, `grep -rn "groupBy("` по всему `backend/src`
нашёл ещё десять мест с точно тем же паттерном без `as const` — все
исправлены тем же способом, не дожидаясь, пока пользователь пришлёт
ошибку по каждому отдельно (тот же принцип, что и с Node 20→24 в фиксе
№2 — находка одна, а `as const` ничего не меняет в поведении, значит
дешевле поправить все сразу, чем ждать ещё волны частичных логов):
`ai-usage.service.ts` (5 вызовов — `by: ['userId']` ×3, `by: [field]`,
`by: ['operation']`), `admin-ab-test.service.ts`, `admin-catalog-batch.
service.ts`, `admin-marketing.service.ts` (все три — `by: ['status']`
внутри `Promise.all`-цикла по строкам списка), `admin-panel.service.ts`
(`by: ['status']`), `admin-users.service.ts` (`by: ['plan']`).

Проверка: `eslint --max-warnings 0` на все восемь изменённых файлов —
чисто. Полный jest в `backend/` — те же **2001/143**, из тех же **17
падают/5 наборов** (тот же долг). `node scripts/check-docs.mjs`/`node
scripts/sync-legal.mjs --check` — без расхождений. Как и в фиксах
№1–3, настоящий `tsc` с сгенерированным клиентом в песочнице
недоступен — уверенность в фиксе `groupBy` опирается на
задокументированное поведение Prisma+TypeScript (`as const` на `by` —
общеизвестное решение именно этой ошибки), а не на локальный
перепрогон; в фиксе `AssetRow`/`Pick` — на тот же принцип, что уже
подтверждён деплоем после фикса №2. Следующий реальный деплой —
единственная стопроцентная проверка на оба.

**Внеплановый фикс №5 — пятая волна (11 ошибок), первая ПОЛНАЯ (не
обрезанная) сборка с настоящим Prisma 7.10.0: `as const` для `groupBy`
не сработал, плюс ещё один пропущенный экземпляр бага №1 и ещё один
экземпляр бага №3.** Пользователь впервые прислал лог, где сам Vercel
написал «Found 11 error(s)» и все 11 действительно перечислены — это
дало возможность закрыть волну целиком, а не по частям, как раньше.

Главная неожиданность: **фикс №4 (`by: [...] as const`) не помог ни в
одном из девяти мест, где `groupBy` сочетается с `where` или более чем
одним агрегатом (`_sum`+`_count` вместе)** — только два места, где
`groupBy` использовался в САМОМ простом виде (`{by, _count}`, без
`where`), реально собрались. Прогнал через веб-поиск документированные
issues самой Prisma (prisma/prisma#17297, #6494, #7183) — вывод: это
НЕЗАКРЫТЫЙ баг генерации типов `groupBy` (не версия TypeScript — в
проекте уже 5.9.3, выше требуемого Prisma 5.4+): сложный внутренний
пересекающийся тип части перегрузок `groupBy` требует, чтобы переданный
объект аргумента ОДНОВРЕМЕННО удовлетворял форме массива — отсюда
буквальная фраза в ошибке "missing … length, pop, push, concat, and 29
more" (Prisma сверяет объект с `Array.prototype`). Официально
подтверждённого фикса нет — авторы issues предлагают либо `@ts-ignore`,
либо явный `any` на аргументе. Применено второе — `as any` прямо на
объекте аргумента (с `eslint-disable-next-line
@typescript-eslint/no-explicit-any`, единственный такой прецедент в
файле — `prompt.service.ts`, — уже был в кодовой базе), у ВСЕХ девяти
всё ещё падающих мест: `admin-ab-test.service.ts`,
`admin-catalog-batch.service.ts`, `admin-marketing.service.ts` (все
три — `by`+`where`+`_count`), `ai-usage.service.ts` (пять мест — три
`by`+`where`+`_sum`(+`_count`), одно `by`+`_sum`+`_count` без `where`,
одно `by`+`where`+`_sum`+`_count`+`orderBy`+`take` — даже с `orderBy`,
который по некоторым issues должен был помочь, не помогло),
`credit-ledger.service.ts`. Форма ВОЗВРАЩАЕМОГО значения по-прежнему
проверяется существующим явным касом (`as Array<...>`) — `any` отключает
проверку только самого аргумента, не того, что код делает с результатом.
Два места (`admin-panel.service.ts`, `admin-users.service.ts`), где
`groupBy` использован в минимальной форме без `where`, уже собрались
после фикса №4 и не тронуты.

Второй пропущенный экземпляр бага №1 (39-ошибочная волна,
`tx: typeof this.prisma`) — на этот раз не в самом колбэке
`$transaction`, а в СИГНАТУРЕ обычного метода: `credit-ledger.
service.ts`'s `grant(userId, delta, paymentId, tx?: typeof this.prisma)` —
вызывается из `billing.service.ts`'s `applySuccessfulPayment` (уже
типизированной правильно в фиксе №1) с настоящим `tx:
Prisma.TransactionClient`, и эти два типа несовместимы (`typeof
this.prisma` здесь — `PrismaService`, у него лишние поля
`logger`/`onModuleInit`/`$on` и др., которых у реального транзакционного
клиента нет). `grep -rn "typeof this.prisma"` по всему `backend/src`
подтвердил — других экземпляров не осталось. Правка та же, что и у
остальных подобных: `Prisma.TransactionClient` вместо `typeof
this.prisma`.

Третий пропущенный экземпляр бага №3 (Json/строгий Prisma input,
`analysis`/`PersistTx`) — `brand-manifest.service.ts`'s `create()`:
`manifestDataFromDto()` возвращает `Record<string, unknown>` (так и
должно быть — та же функция используется в `update()`, где ЛЮБОЕ поле
может отсутствовать при частичной правке), но при СОЗДАНИИ спред этого
объекта в `data: { userId, ...manifestDataFromDto(...) }` не даёт
Prisma статически убедиться, что обязательный `title` присутствует
(хотя `create()` проверяет `dto.title` рантаймом на пять строк выше) —
`BrandManifestUncheckedCreateInput` требует `title` НЕОБЯЗАТЕЛЬНЫМ не
бывает, и это единственное отличие от `update()`, чей `UpdateInput` весь
из необязательных полей и потому такую проверку молча пропускает («weak
type» — TypeScript не идёт вглубь per-property для целиком
опционального целевого типа, когда у источника есть индексная
сигнатура). Правка — каст `as unknown as Prisma.BrandManifestUncheckedCreateInput`
только у вызова в `create()`; `update()` не тронут (в логе не упал —
подтверждает, что там действительно другая, менее строгая проверка).

Проверка: `eslint --max-warnings 0` на все шесть изменённых файлов —
чисто (в т.ч. девять новых `eslint-disable-next-line`). Полный jest в
`backend/` — те же **2001/143**, из тех же **17 падают/5 наборов**
(тот же долг). `node scripts/check-docs.mjs`/`node
scripts/sync-legal.mjs --check` — без расхождений. В отличие от
фиксов №1–4, на этот раз лог был ПОЛНЫМ (Vercel сам написал точное
число ошибок, и все перечислены) — это первая волна, где можно
утверждать с уверенностью, что закрыты ВСЕ показанные ошибки, а не
только показанный образец; настоящий `tsc` в песочнице по-прежнему
недоступен, так что подтверждение — только следующий реальный деплой.

**Внеплановый фикс №6 — настоящий краш Nest при старте на проде (не
build-time, а рантайм): `LibraryModule` не импортировал
`StorageModule`.** В отличие от всех пяти предыдущих волн (все — ошибки
`tsc` на реальном сгенерированном Prisma-клиенте, никогда не видимые в
песочнице), эта — обычный краш NestJS при поднятии графа модулей на
самом старте контейнера: `Nest can't resolve dependencies of the
LibraryService (PrismaService, SessionService, ?, PlanService). Please
make sure that the argument BlobService at index [2] is available in
the LibraryModule context.`

Причина: `LibraryService` внедряет `BlobService` третьим параметром
конструктора уже давно (этап 26, копии кадров-превью под собственным
префиксом библиотеки — метод `copyPreviews`), а `BlobService`
предоставляется и экспортируется только `StorageModule`
(`storage.module.ts`: `providers: [BlobService], exports: [BlobService]`).
`LibraryModule` импортировал `AdminAuthModule`/`AdminPanelModule`, но
никогда — `StorageModule`, то есть DI-граф Nest не мог найти
`BlobService` для `LibraryService`. Почему это не ловилось ни разу за
всю историю правок (ни в одной из пяти предыдущих волн, ни в обычных
прогонах `jest`): `library.service.spec.ts` мокает `BlobService`
напрямую руками (`new LibraryService(prismaMock, sessionsMock,
blobMock, plansMock)`), полностью минуя реальную регистрацию модулей —
юнит-тест никогда не поднимает настоящий `LibraryModule` и потому
никогда не проверяет его список `imports`. Только настоящий запуск
`nest start`/продакшен-контейнера строит граф модулей целиком и падает
на этой нехватке.

Правка: в `library.module.ts` добавлен `import { StorageModule } from
'../storage/storage.module';` и `StorageModule` добавлен в `imports`
(`imports: [AdminAuthModule, AdminPanelModule, StorageModule]`), с
доккомментарием, объясняющим причину и почему её не ловили тесты.

Системная проверка (тот же принцип, что после каждого предыдущего
класса багов — grep всех `$transaction`, всех `groupBy`, всех
Json-полей на запись): написан разовый скрипт, статически
разбирающий каждый `@Module(...)` в `backend/src/modules/` —
конструктор каждого провайдера каждого модуля сверяется с тем, что
все внедряемые им локальные провайдеры либо объявлены в том же
модуле, либо экспортируются каким-то ИМПОРТИРУЕМЫМ модулем (либо тот
модуль `@Global()`). Скрипт подтверждённо ловит именно этот баг (при
временном откате правки — единственная находка: `LibraryModule` /
`BlobService`); на текущем дереве (после правки) — «NO ISSUES FOUND»,
других экземпляров того же класса («провайдер внедряет чужой сервис,
но его модуль не импортирован») в проекте не осталось.

Проверка: `eslint --max-warnings 0` на `library.module.ts` — чисто.
Полный jest в `backend/` — те же **2001/143**, из тех же **17
падают/5 наборов** (тот же долг, без изменений). `node
scripts/check-docs.mjs`/`node scripts/sync-legal.mjs --check` — без
расхождений. Настоящий запуск Nest в песочнице недоступен (тот же
класс ограничения, что и с `tsc` на сгенерированном Prisma-клиенте), так
что итоговое подтверждение — следующий реальный деплой/старт
контейнера.

**Внеплановый фикс №7 — второй реальный краш Nest при старте, другой
механизм: цикл импортов между `tts.module.ts` и `tts.controller.ts`
обнулял DI-токен `TTS_PROVIDER`.** Пользователь прислал следующий
рантайм-лог сразу после фикса №6, тоже не `tsc`, а настоящий провал
поднятия графа модулей: `Nest can't resolve dependencies of the
TtsController (?, PlanService, AiUsageService, PrismaService). ...
argument dependency at index [0] is available in the TtsModule
context`, и строкой выше — собственная диагностика Nest: `Nest
encountered an undefined dependency. This may be due to a circular
import or a missing dependency declaration.`

Причина — НЕ пропущенный импорт модуля (как в фиксе №6), а классический
цикл CommonJS-require между ДВУМЯ файлами: `tts.module.ts` импортировал
`TtsController` из `./tts.controller` (для `controllers:
[TtsController]`) СТРОКОЙ РАНЬШЕ, чем в том же файле объявлялся `export
const TTS_PROVIDER = Symbol(...)`; а `tts.controller.ts` импортировал
`TTS_PROVIDER` обратно из `./tts.module`. При старте: Node начинает
исполнять `tts.module.ts`, доходит до импорта контроллера ДО строки с
`TTS_PROVIDER`, тот требует `tts.module.ts` обратно — получает частично
заполненный `exports`-объект, где `TTS_PROVIDER` ещё `undefined` —
декоратор `@Inject(TTS_PROVIDER)` в `TtsController` захватывает это
`undefined` НАВСЕГДА (декораторы выполняются один раз, синхронно, в
момент определения класса). Проверено воспроизведением МЕХАНИЗМА в
изоляции (два маленьких `.js`-файла, повторяющих точно такой же
порядок `require`/объявления, без Nest и без TypeScript): «сломанная»
версия действительно захватывает `undefined` (и Node сам явно
предупреждает: «Accessing non-existent property 'TTS_PROVIDER' of
module exports inside circular dependency»), «исправленная» — тот же
самый символ, что и после полной загрузки модуля.

В песочнице это не ловилось по той же причине, что и фикс №6: спеки
`TtsController` и всех потребителей токена создают их вручную (`new
TtsController(ttsMock, ...)`), минуя настоящую загрузку файлов Node и
настоящую систему DI Nest.

Правка — стандартный для NestJS способ разрывать такие циклы: вынести
токен в отдельный файл, ни от кого из потребителей не зависящий.
Новый `backend/src/modules/tts/tts-provider.token.ts` содержит только
`export const TTS_PROVIDER = Symbol('TTS_PROVIDER');` с подробным
доккомментарием о причине. `tts.module.ts` импортирует токен оттуда же,
что и все четыре потребителя, которые раньше брали `TTS_PROVIDER` из
`tts.module.ts`: `tts.controller.ts` (тот самый, что и вызывал цикл),
`project-session.service.ts`, `brand-manifest.service.ts`,
`postprod.service.ts` — ни один из них не создаёт цикл с новым файлом
токена, потому что файл токена ни от кого из них не зависит.

Системная проверка (тот же принцип, что и после каждого предыдущего
класса багов): написан второй разовый скрипт, строящий граф импортов
всего `backend/src` (без `.spec.ts`) и находящий ЛЮБУЮ пару файлов,
импортирующих друг друга напрямую (двухфайловый цикл — необходимое
условие для этого класса бага, независимо от Nest). До правки скрипт
находил ровно один такой цикл — `tts.module.ts` ↔ `tts.controller.ts`;
после правки — «Found 0 direct 2-file import cycles» по всему проекту:
других мест с этим же классом уязвимости не осталось.

Проверка: `eslint --max-warnings 0` на все шесть изменённых/новых
файлов — чисто. Полный jest в `backend/` — те же **2001/143**, из тех
же **17 падают/5 наборов** (тот же долг, без изменений). `node
scripts/check-docs.mjs`/`node scripts/sync-legal.mjs --check` — без
расхождений. Настоящий запуск Nest в песочнице по-прежнему недоступен,
но сам механизм (частично исполненный `exports`-объект при цикле
CommonJS-require) — факт языка/платформы, не Nest, и он воспроизведён и
подтверждён напрямую, а не только по аналогии с логом.

**Внеплановый фикс №8 — не баг в коде: на проде не были применены
несколько последних Prisma-миграций, из-за чего настоящий Vercel Cron
стал падать на КАЖДОМ маршруте.** Пользователь прислал рантайм-лог:
`GET /api/cron/feed-import-run → 500 PrismaClientKnownRequestError:
Invalid \`prisma.cronRunLog.create()\` invocation: The table
\`public.cron_run_logs\` does not exist in the current database.` —
одновременно с более ранним скриншотом логов `viral-backend`, где на
`/api/cron/publish`, `/api/cron/catalog-batch-run`,
`/api/cron/ab-test-run`, `/api/cron/export-sync-run` шли `503
ServiceUnabailableException` (см. предыдущее сообщение пользователя в
этой же сессии).

Модель `CronRunLog` и миграция, создающая таблицу `cron_run_logs`
(`backend/prisma/migrations/20261007090000_cron_run_log/migration.sql`),
в репозитории есть и написаны корректно — `schema.prisma` и SQL-файл
совпадают один в один. Отдельно подтверждено (`grep` по
`cron.controller.ts`/`cron-jobs.service.ts`), что реальный код уже
реализует фичу «Кроны» из этапа 69/Д-4.3 (план
`scalable-sprouting-hopper.md`, пункт 6): КАЖДЫЙ из десяти маршрутов
`CronController` оборачивает свой `runX()` в
`this.jobs.runAndLog('<jobKey>', VERCEL_CRON_TRIGGERED_BY, ..., ...)`,
а `runAndLog()` (`cron-jobs.service.ts`) первой строкой делает
`this.prisma.cronRunLog.create({...})` — то есть ЛЮБОЙ настоящий тик
Vercel Cron, для любого из десяти джобов, теперь начинается с записи в
таблицу `cron_run_logs`. Если этой таблицы нет на реальной базе — падают
ВСЕ десять крон-маршрутов одновременно, что и объясняет одним корнем
оба явления, которые до этого выглядели как два разных бага (503 на
`publish`/`catalog-batch-run`/`ab-test-run`/`export-sync-run` и 500 на
`feed-import-run`).

Корень — не код, а процесс деплоя. `backend/package.json`:
`"build": "prisma generate && nest build"` — Vercel на каждый деплой
только генерирует Prisma Client (чтобы типы совпадали с `schema.prisma`)
и собирает Nest; `prisma migrate deploy` в build-команде НЕ вызывается
ни разу. Применение миграций на реальную базу — задокументированный
РУЧНОЙ шаг (`doc/PRISMA-SUPABASE.md`, раздел «Настройка реального
Supabase-проекта», пункт 5): `cd backend && npx prisma migrate deploy`
с `DIRECT_URL` (прямое подключение к Supabase, порт 5432 — пулер порта
6543 для миграций официально ненадёжен). Судя по ошибке, этот шаг не
выполнялся на проде как минимум с миграции `20261007090000_cron_run_log`
— а после неё в репозитории добавлено ещё пять миграций
(`20261014090000_brand_manifest_tts_provider`,
`20261015090000_history_run_createdat_indexes`,
`20261016090000_user_voices`, `20261017090000_cron_job_lock`,
`20261018090000_d42_d46_indexes`,
`20261019090000_user_createdat_trgm_indexes`), которые, вероятно, тоже
не применены и рано или поздно проявятся тем же классом ошибки в своих
местах (голоса пользователей, джоб-локи кронов, индексы).

Это НЕ фикс кода — исправление не может быть внесено этой сессией:
у песочницы нет ни сетевого доступа к реальной базе Supabase, ни
`DATABASE_URL`/`DIRECT_URL` от неё. Требуется, чтобы пользователь сам
выполнил `npx prisma migrate deploy` (команда идемпотентна — применяет
только ещё не применённые миграции по порядку, ничего не откатывает и
не трогает уже применённые). Как системную защиту от повторения этого
же класса проблемы в будущем — стоит рассмотреть добавление
`prisma migrate deploy` в build-команду Vercel (риск: билд-контейнер
Vercel должен иметь доступ к `DIRECT_URL` во время сборки, и провалившаяся
миграция тогда будет блокировать весь деплой, а не только конкретный
эндпоинт) — вынесено на решение пользователя, не сделано автоматически.

**Дополнение (тот же день, по явной просьбе пользователя): автоматизация
внесена.** `backend/package.json`: `"build": "prisma generate && nest
build"` → `"build": "prisma generate && prisma migrate deploy && nest
build"`. Теперь КАЖДЫЙ деплой (Preview и Production) сам накатывает ещё
не применённые миграции перед сборкой Nest — тот же самый разрыв больше
не сможет накопиться молча. Требование к окружению: `DIRECT_URL` должен
быть задан в Vercel Environment Variables (он и так входит в список 88
переменных, описанных в `DEPLOYMENT.md`, но раньше был нужен только для
ручного локального `migrate deploy` — теперь без него будет падать сам
билд, а не только рантайм). Риск, названный выше (упавшая миграция
блокирует весь деплой), принят пользователем сознательно — это ожидаемо
безопаснее, чем текущее поведение «билд проходит, а прод рушится на
реальном трафике позже». `prisma migrate deploy` идемпотентна и
безопасна при параллельных запусках (advisory lock через
`_prisma_migrations`) — два билда подряд (например, Preview и
Production от одного пуша) не конфликтуют. Изменение — однострочная
правка `build`-скрипта, полный jest/eslint-цикл не даёт новых
результатов сверх обычного (сборка/CI-конфигурация, не бизнес-логика);
`check-docs.mjs`/`sync-legal.mjs --check` — без расхождений
(`doc/PRISMA-SUPABASE.md` обновлён тем же изменением, раздел
«Настройка реального Supabase-проекта»).

**Внеплановый фикс №9 — UX-правки админки по просьбе пользователя:
фильтр «Настройки» и двухуровневое меню.** Не баг — два самостоятельных
пожелания, полученных после того, как реальный вход через Telegram
наконец заработал и оператор впервые увидел живую админку целиком.

Первое: на вкладке «Настройки» (`admin/src/app/settings/page.tsx`)
список переменных окружения вырос настолько, что даже при полном
порядке на экране десятки строк «Корректно» затрудняют поиск
единственной проблемной. Добавлен переключатель наверху страницы —
`<select>` с двумя пунктами: «Все настройки» / «Только требуется
внимание», тем же паттерном, что фильтр статуса на вкладке «Сессии»
(`app/sessions/page.tsx`), а не новый визуальный компонент. Фильтрация
полностью на клиенте (`useState<'all' | 'attention'>`, без похода на
бэкенд) — `EnvCheckResult.ok` уже приходит с сервера на каждую строку.
В режиме «Только требуется внимание» из каждой группы остаются только
строки с `!ok`; группа, полностью прошедшая проверку, пропадает из вида
целиком (иначе висел бы пустой заголовок раздела); если после фильтра
не осталось ни одной группы — сообщение с подсказкой переключиться
обратно на «Все настройки».

Второе: шапка админки (`admin/src/components/AdminNav.tsx`) к этому
этапу дошла до шестнадцати плоских ссылок и переносилась на две строки
уже на обычной ширине окна — это как раз то, что видел оператор:
`admin-sandy-eight-75.vercel.app/settings` со всеми разделами в шапке.
Список сгруппирован в пять пунктов верхнего уровня: «Сессии» — самый
частый экран, оставлен отдельной ссылкой; «Контент» (Модерация,
Публичные страницы, Библиотека, Блог); «Коммерция» (Пользователи,
Оплата, Рассылка, Расходы); «Генерация» (Пакетная генерация,
A/B-варианты, Импорт фида, AI-аватар); «Система» (Кроны, Телеметрия,
Настройки) — четыре из них теперь выпадающие группы. Открытие/закрытие —
клик по кнопке группы (не hover — админку открывают с телефона, hover
там не работает, тот же довод уже был в комментариях к таблицам этого
файла), закрытие по клику мимо меню, по Escape и автоматически при
переходе на другую страницу (`useEffect` на `pathname`). Активная
группа (когда открытый маршрут — один из её пунктов) подсвечена тем же
акцентным цветом, что и активная одиночная ссылка, но без нижнего
подчёркивания `box-shadow` внутри выпадающего списка — там оно смотрелось
как строка таблицы, а не как вкладка. `aria-haspopup`/`aria-expanded` на
кнопке группы и `aria-current='page'` на пунктах внутри — тот же уровень
доступности, что был у плоского списка (В-5.18).

Порядок ссылок внутри каждой группы не менялся — тот же, что был в
исходном плоском `LINKS`. Группировка — по смыслу разделов, не по
частоте использования; если продукт вырастет ещё, следующий кандидат на
пересмотр — сама разбивка на четыре группы, а не отказ от вложенности.

Тесты: у `admin/` нет jest — верификация тем же составом, что и на всех
предыдущих правках фронтенда: `npx tsc --noEmit` — чисто; `next lint
--max-warnings 0` — без предупреждений; `next build` — все 20 маршрутов
собираются, включая `/settings`. `check-docs.mjs`/`sync-legal.mjs
--check` — без расхождений (правка не трогает числа, которые они
сверяют). Бэкенд не менялся.

**Сделано (этап 78 — событийная воронка и когортная конверсия по
воркфлоу, `doc/WORKFLOW-FUNNEL-SPEC.md` и
`doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md`).** Владелец продукта
попросил реализовать оба ТЗ одним проходом — они работают с одной и той
же моделью данных (`WorkflowStageEvent`), первое читает её как
СОБЫТИЙНЫЙ счётчик за окно, второе — как КОГОРТУ, стартовавшую в окне;
разделять реализацию на два прохода означало бы дважды проектировать
одну и ту же таблицу и её точки записи.

- **Общая модель (родительское ТЗ §3.1).** Новый append-only
  `WorkflowStageEvent` (`workflow_stage_events`, миграция
  `20261020090000_workflow_stage_events`): `id, workflow WorkflowKind,
  entityId, fromStage String?, stage, occurredAt`. `WorkflowKind`
  (`SESSION | CATALOG_BATCH_ITEM | AB_TEST_VARIANT`) — одна таблица на
  все три воркфлоу вместо трёх отдельных, никаких внешних ключей на
  `entityId` (сознательно — сущность может быть удалена, история
  переходов должна пережить удаление). Два индекса —
  `[workflow, stage, occurredAt]` (обе выборки: и воронка, и когорта
  фильтруют по этой тройке) и `[workflow, stage, fromStage]` (разбивка
  провалов по источнику). Существующие статусные колонки
  (`Session.status`/`CatalogBatchItem.status`/`AbTestVariant.status`)
  остаются источником ТЕКУЩЕГО состояния — эта таблица только
  добавляет историю, не заменяет ничего.
- **`logWorkflowStage()` (`common/workflow-stage-events.ts`) —
  общая точка записи.** Best-effort: сама ловит свои ошибки и никогда
  не бросает — потеря одного события воронки не должна ронять платный
  тик крона или ответ API. Вызывается на каждом реальном переходе
  статуса, во всех трёх воркфлоу: `SessionService.createSession()`
  (первое событие, `fromStage: null`) и `updateSession()` (только при
  РЕАЛЬНОЙ смене статуса, `fromStage` — статус ДО патча, взятый из той
  же CTE `old`, что обновляет строку, — без лишнего чтения);
  `CatalogBatchService.create()` (по одному событию на каждую реально
  созданную строку партии, id — из `findMany` после `createMany`,
  поскольку `createMany` их не возвращает), `.getStatus()`
  (оппортунистическая синхронизация при живом опросе экрана
  прогресса), `.retry()` (`fromStage` всегда `'FAILED'`);
  `CatalogBatchWorkerService` (claim → `GENERATING`, `fromStage` — из
  реального `status` захваченной строки, не всегда `'PENDING'`, как
  могло бы показаться — просроченный `FAILED` тоже возвращается в
  работу; `advanceGenerating()` → `DONE`/`FAILED`; `recordFailure()` —
  `fromStage` тоже из `status` строки, а не жёстко `'GENERATING'`,
  потому что рендер может провалиться и ДО того, как строка успела
  дойти до `GENERATING`); симметрично `AbTestService`/
  `AbTestWorkerService` (без `retry` — у A/B его нет).
- **`AdminPanelService.getWorkflowFunnel(window)` (родительское ТЗ
  §4–§5).** `window: 'hour'|'day'|'week'|'month'` → `[from, to)`.
  Три раздельных ветки сырого SQL (по одной на воркфлоу — у каждого
  свой путь `JOIN` к владельцу-пользователю: `sessions` напрямую;
  `catalog_batch_items → catalog_batch_runs`; `ab_test_variants →
  ab_test_runs`), `COUNT(DISTINCT e."entityId")::int` на каждую стадию
  и `COUNT(DISTINCT <владелец>."userId")::int` на уникальных
  пользователей; отдельный запрос — разбивка провалов по `fromStage`.
  Это СЧЁТЧИК СОБЫТИЙ за окно, не когорта — числа на соседних стадиях
  намеренно не обязаны идти по убыванию (родительское ТЗ §3.3):
  сущность могла пройти стадию до начала окна или после его конца.
- **`AdminPanelService.getWorkflowCohortConversion(window)`
  (когортное ТЗ §2–§4).** Когорта — сущности с `fromStage: null`
  (первое событие), попавшие в окно; CTE `cohort` фиксирует
  `entityId`+`cohortStart`, затем один `JOIN` считает, сколько из этой
  когорты дошло до каждой стадии и среднее время от старта
  (`EXTRACT(EPOCH FROM ...)`, явно приведённое к `::float8` — Postgres
  возвращает `numeric`, не `double precision`, проверено напрямую
  через `pg_typeof()` на локальном Postgres; без каста Prisma отдал бы
  строку вместо числа). Три метрики на стадию: `pctOfCohort`,
  `pctOfPrevious` (не оценка «монотонного падения» — намеренно НЕ
  ограничена сверху единицей: обход промежуточной стадии, например
  прямой переход в `error` из более ранней стадии, чем непосредственно
  предыдущая, может дать >100%, и это не баг данных, а честная картина
  — когортное ТЗ §4.1 отдельно предупреждает об этом), и
  `avgDurationFromStartMs`. Пустая когорта (`cohortSize: 0`) —
  короткое замыкание, второй запрос не выполняется вовсе. `matured`/
  `maturesAt` — по горизонтам `SESSION_COHORT_HORIZON_MS` (90 минут)/
  `BATCH_COHORT_HORIZON_MS` (4 часа) из `common/workflow-funnel-cohort.ts`
  (константы и `isCohortMatured()` уже существовали в проекте до этого
  этапа — переиспользованы, не продублированы).
- **Два новых маршрута.** `GET /admin/workflow-funnel?window=` и `GET
  /admin/workflow-funnel/cohort-conversion?window=` — оба за
  `assertOperator`, невалидный/отсутствующий `window` молча падает на
  `'day'` (тот же снисходительный приём, что у остальных query-параметров
  админки).
- **Админка: вкладка «Воронка» (`admin/src/app/funnel/page.tsx`),
  добавлена в группу «Система».** Один переключатель режима
  («Событийная воронка» / «Когортная конверсия») вместо двух вкладок —
  оба режима читают одну и ту же таблицу под разными углами, и
  когортное ТЗ §3.1 отдельно требует, чтобы оператор не путал одно с
  другим: подписи и поясняющий текст над таблицей меняются в
  зависимости от режима, а не остаются общими. Событийный режим —
  горизонтальная диаграмма стадий со стрелками и отдельным блоком
  провалов по источнику; когортный — таблица с колонками «% от
  когорты»/«% от предыдущей»/«среднее время от старта» и предупреждение
  «ещё не завершена», если `matured: false`. `formatPct()` намеренно не
  обрезает значения выше 100%.
- **Не сделано в этом этапе.** Отдельная историческая витрина по
  конкретной сущности (например, «путь именно этого ролика по всем
  стадиям с таймстампами») — оба ТЗ описывают только агрегаты за окно/
  по когорте, поштучный путь сущности не запрашивался и не входит ни в
  одно из двух ТЗ. Алертинг/уведомления при аномальной доле провалов —
  не упомянут ни в одном из ТЗ, отдельная возможная стадия на будущее.
- **Проверка.** `npx tsc --noEmit`/`eslint --max-warnings 0` — чисто в
  `backend/` по всем изменённым и новым файлам (тот же класс
  несгенерированного `@prisma/client`, что на всех этапах с 64; один
  найденный по пути и почищенный `--fix` формат-дефект в
  `publication.service.spec.ts`, файле, которого этот этап не касается
  по существу). Полный jest в `backend/` (`jest.config.sandbox.json`,
  `isolatedModules`) — актуальная база 2001/143 (подтверждённая после
  этапа 77) увеличена на подсчитанный по факту прирост этапа 78: **43
  новых теста в существующих спек-файлах**
  (`catalog-batch-worker.service.spec.ts` — 9,
  `ab-test-worker.service.spec.ts` — 9, `catalog-batch.service.spec.ts` —
  5, `ab-test.service.spec.ts` — 1, `admin-panel.service.spec.ts` — 9,
  `session.service.spec.ts` — 5) плюс **новый спек-файл**
  `common/workflow-funnel-cohort.spec.ts` (5 тестов) — итог **2044
  теста / 144 набора** (см. «Итоговая сверка» за полным разбором
  прироста). Прямой прогон всех новых сьютов в песочнице недостоверен
  (`Cannot find module '.prisma/client/default'` — тот же
  транзитивный импорт `@prisma/client`, что блокирует уже
  существовавшие спек-файлы этих же модулей); специфика для этого
  этапа проверена иначе — каждый кусок сырого SQL (кастинг `::int`/
  `::float8`, каст enum-параметра `::"WorkflowKind"` при сравнении с
  параметром против буквального литерала в тексте запроса для
  каждого отдельного воркфлоу) прогнан вручную через `psql` на
  локальном Postgres 16 до переноса в TypeScript; сама миграция
  применена и подтверждена через `\d workflow_stage_events`. Мимоходом
  найдены (но НЕ исправлены — вне объёма этого этапа, файлы этапом 78
  не затронуты) два пред-существующих проваленных теста, устойчиво
  воспроизводящихся в изоляции без единого нового файла этого этапа:
  `project.service.spec.ts` («allows the 20th item and rejects the
  21st…») и `marketing-consent.service.spec.ts` («активная подписка →
  ставит revokedAt»). `admin/`: `npx tsc --noEmit`, `next lint
  --max-warnings 0`, `next build` — маршрут `/funnel` собирается.
  `node scripts/check-docs.mjs` — 0 расхождений после обновления чисел
  тестов/наборов/миграций/таблиц/маршрутов в README, ACCEPTANCE-CHECKLIST,
  CI.md, TELEGRAM-ADMIN.md и этом файле. `node scripts/sync-legal.mjs
  --check` — без изменений (эта стадия не трогает юридические тексты).

**Внеплановый фикс (после этапа 78) — два пред-существующих
проваленных теста, найденных при верификации этапа 78, оказались
багами самих тестов, а не продукта.** По просьбе владельца продукта
разобраны отдельно от этапа: код обоих файлов не менялся, исправлены
только тесты.

`project.service.spec.ts` — тест `allows the 20th item and rejects the
21st in a LINE project (default limit)` проверял лимит 20 (`/at most 20
items/`), хотя дефолт `PROJECT_LINE_ITEM_LIMIT` был сознательно поднят
с 20 до 500 продуктовым решением ещё на этапе импорта фида
(`doc/PRODUCT-PROJECT-SPEC.md` §47.6, `PROJECT_LINE_ITEM_LIMIT=500` в
`backend/.env.example`) — тест с тех пор проверял число, отставшее от
кода, и не ловился только потому, что до этапа 78 в этой песочнице не
было честного прогона `jest --json --outputFile`, только ручной
подсчёт прироста по новым `it(`. Правка: тест теперь строит проект из
499/500 строк и ждёт отказ с текстом `/at most 500 items/` — сама
`ProjectService.addItem()` не тронута, поведение всегда было верным.

`marketing-consent.service.spec.ts` — тест `активная подписка → ставит
revokedAt` тоже проверял правильный код неправильным моком:
хелпер `build()` заводил `prisma.user.update` как
`jest.fn().mockResolvedValue(row)` — возвращал исходную строку КАК
БЫЛА, а не то, что реальный `prisma.user.update()` вернул бы ПОСЛЕ
записи. `MarketingConsentService.revoke()` строит ответ из возврата
`update()`, так что мок с непроставленным `marketingConsentRevokedAt`
заставлял `toStatus()` считать подписку всё ещё активной сразу после
её же отзыва. Правка: мок теперь `jest.fn().mockImplementation(({data})
=> Promise.resolve({...row, ...data}))` — сливает `data` из вызова
поверх строки, как это делает настоящий Prisma; `accept()`-тест той же
проблемы не поймал раньше только потому, что не проверял
`result.consented`, только аргументы вызова `update`.

Проверка: `npx jest --config jest.config.sandbox.json` на обоих файлах
— зелено (40/40 тестов, оба сьюта). Полный прогон `backend/` с
`--json --outputFile` — впервые за всю историю проекта в этой
песочнице выполнен ДО КОНЦА без единого провалившегося теста среди
всех сьютов, которые вообще способны загрузиться (**1161 из 1161**;
оставшиеся 46 сьютов не загружаются вовсе из-за той же цепочки
`Cannot find module '.prisma/client/default'`, что и всегда). Итоговая
честная база документов пересчитана: **2044/144**, долг сузился до
**15 падающих тестов / 3 сьютов** (`plan.controller.spec.ts`,
`billing.service.spec.ts`, `analysis.service.spec.ts` — не тронуты,
вне объёма этого фикса). `npx tsc --noEmit`/`eslint --max-warnings 0`
— чисто по обоим изменённым файлам (тот же класс несгенерированного
`@prisma/client`, без новых классов ошибок — одна временная TS2345 от
слишком узкого типа параметра `build()`, сразу расширена до `| null`
по факту вызова с `build(null)` в соседнем тесте). `node
scripts/check-docs.mjs`/`node scripts/sync-legal.mjs --check` — без
расхождений после этой правки не тронуты (правка не меняет ни одно из
проверяемых чисел, кроме уже учтённого в «Итоговая сверка» выше).

**Сделано (этап 79 — визуальная «обучалка»: блок-схема пайплайна на
лендинге, `doc/LANDING-HOW-IT-WORKS-VISUAL-SPEC.md`).** Реализация
готового ТЗ (документ-предложение, код не был начат до этой стадии) —
маркетинговая иллюстрация пайплайна для ЛЮБОГО посетителя лендинга (не
путать с админской воронкой `doc/WORKFLOW-FUNNEL-SPEC.md`, этап 78 —
разные аудитории, разные данные, общая только идея «блок-схема из
flex/CSS»). Гибридное размещение, как решил владелец продукта: короткий
тизер в существующей секции `#how` на главной + новая выделенная
страница `/[locale]/how-it-works` уровня `/blog`.

- **Словарь — единственное место, где контент придуман заново.** Все
  пять `landing/src/dictionaries/{ru,uk,en,de,es}.json` — `steps.items[]`
  получили `icon` (глиф, тот же приём, что `.feature-icon`, переиспользован
  один-в-один глиф у шагов 3/4/5/6, где смысл совпадает с уже
  нарисованной иконкой фичи), `badge` (`'standard'|'premium'`, только
  у шагов 2/4/5/7/9 — у 1/3/6/8 бейджа нет вообще, это тоже честная
  информация), `highlight` (одна строка-пример для тизера, есть у 8 из
  9 — у шага 1 нет намеренно, экран создания товара вне мастера
  генерации, см. §7 ТЗ) и `details[]` (1-4 пункта «что вы увидите на
  этом шаге» для полной страницы). Плюс новые ключи верхнего уровня
  `steps.badges` (подписи бейджей, чтобы не повторять фразу текстом в
  каждом пункте), `steps.moreLink` (текст CTA-кнопки) и `steps.page`
  (`metaTitle`/`metaDescription` новой страницы). `title`/`text` всех
  девяти существующих шагов не тронуты ни в одной локали — состав и
  порядок шагов не меняются (перепроверено построчным сопоставлением с
  реальными экранами мастера в самом ТЗ, §4). Все пять файлов
  проверены на структурную симметрию (ровно 9 элементов, один и тот же
  набор ключей) — Python-скриптом на этапе написания, не вручную.
  Бейдж «Standard+» на шаге 7 (качество рендера) поставлен НЕСМОТРЯ на
  то, что сам мастер генерации пока не показывает такой же замок в UI
  (находка ТЗ §2.4) — лендинг обязан быть как минимум не менее честным,
  чем реальные тарифные ограничения; расхождение в продукте
  зафиксировано отдельно, `doc/TODO.md` §I-Ж (новый пункт Ж-1, вне
  объёма этого этапа — другой модуль продукта, не лендинг).
- **`HowItWorks.tsx` — один серверный компонент на оба места.**
  Принимает `steps`, `variant: 'teaser'|'full'`, `hrefBase`. Всегда
  рендерит Слой 1 — блок-схему `<nav class="how-diagram">` из девяти
  ссылок `{hrefBase}#step-N` со стрелками между ними (тот же визуальный
  приём, что уже принят для админской воронки, перенесённый на тёмную
  палитру лендинга) — и Слой 2 — `<ol class="steps-grid">` карточек с
  `id="step-N"`. `variant="full"` рендерит полный `<ul class="step-details">`
  (для шага 9 — обёрнутый в нативный `<details>`, единственная
  карточка со сворачиваемым списком: семь опциональных панелей
  результата не поместились бы без сворачивания, §3.3 ТЗ), `variant="teaser"`
  — один `<p class="step-highlight">` и, после списка карточек,
  кнопку-CTA на `hrefBase`. Никакого `'use client'` и React-состояния —
  вся интерактивность (переход к карточке, раскрытие шага 9) — якорные
  ссылки и нативный `<details>` (§3.2, §7 ТЗ), SSR/SEO обеих страниц не
  страдает. **Одно осознанное отклонение от буквального текста ТЗ**:
  §5.3 приводит пример короткой подписи блок-схемы («Товар» вместо
  полного заголовка «Заведите товар»), но схема словаря в §5.1 не
  заводит отдельного поля под такую подпись — добавлять новый
  словарный ключ (и, значит, новый перевод на четыре языка) ради
  экономии 1-2 слов показалось несоразмерным. Решение: подпись в
  блок-схеме — тот же `title`, что уже короткий (2-3 слова у восьми
  шагов из девяти), контейнер `.how-diagram-box` расширен до 104px и
  допускает перенос на две строки для единственного длинного заголовка
  (шаг 7, шесть слов) — не архитектурное решение, при появлении
  отдельного поля меняется одной строкой в компоненте.
- **Новый маршрут** `landing/src/app/[locale]/how-it-works/page.tsx`,
  по образцу `blog/page.tsx`: `generateStaticParams` по пяти локалям,
  `generateMetadata` из `dict.steps.page`, явный `<Header/>` (макет его
  не рендерит — перепроверено чтением `[locale]/layout.tsx`), тело —
  `<HowItWorks variant="full" hrefBase="" />`. В отличие от блога —
  без похода в API и без `revalidate`, весь контент уже в словаре.
  Пункт в шапке НЕ заводится (§3.4, §7 ТЗ) — единственная точка входа
  на страницу — кнопка-CTA внутри тизера, второй пункт меню рядом с
  уже существующим «Как это работает» (`#how`) только запутал бы.
- **`sitemap.ts`** — по одной новой записи `/${locale}/how-it-works` на
  каждую из пяти локалей, тем же циклом, что уже добавляет `/blog`.
- **CSS** (`globals.css`) — новые классы `.how-diagram`/
  `.how-diagram-box`/`.how-diagram-arrow`/`.badge-plan` (Слой 1) и
  `.step-card`/`.step-card-head`/`.step-details`/`.step-highlight`
  (Слой 2, `.step-card` заменяет прежний безымянный `.steps-grid li`),
  плюс `.how-it-works-page`/`.how-it-works-lead` для оболочки новой
  страницы (по образцу `.blog-page`/`.blog-lead`). `.how-diagram` —
  `overflow-x: auto` на любой ширине вместо переноса строк (тот же
  приём, что уже принят в проекте для «ряда блоков шире экрана» —
  табличный скролл в админке, воронка в `doc/WORKFLOW-FUNNEL-SPEC.md`
  §6.3) — никакой отдельной мобильной медиа-правки не понадобилось,
  ТЗ прямо просит одинаковое поведение на всех ширинах (§5.3). CTA-кнопка
  тизера переиспользует существующие `.cta`/`.cta-ghost`/`.cta-small` —
  нового класса под кнопку не заводилось.
- **`doc/LANDING-ILLUSTRATIONS-BRIEF.md`** — новый §3 «Иконки
  блок-схемы «Как это работает»» с девятью описаниями (пять из них —
  прямое переиспользование уже описанных иконок фич, с явной пометкой
  «можно положить тот же файл под двумя именами»), плюс попутное
  исправление двух устаревших мест: ссылка на давно переехавший
  `app/page.tsx` → `app/[locale]/page.tsx`, и источник правды по
  контенту фич — `lib/content.ts` (давно не содержит `FEATURES`) →
  `dictionaries/ru.json`. Это дизайнерская правка документа (описания
  для иллюстратора), а не код — но входит в объём этого этапа по §6 ТЗ.
- **`doc/TODO.md`** — новый пункт **Ж-1** (§I-Ж) фиксирует находку ТЗ
  §2.4 (переключатель качества рендера в мастере не показывает замок
  тарифа в UI, хотя гейт реально работает на бэкенде) — сама починка
  вне объёма этого этапа (другой модуль, не лендинг), только фиксация,
  чтобы не потерялась.
- **Не сделано в этом этапе.** Line-art SVG-иконки (фаза 2, §5.2 ТЗ) —
  сознательно: глифы не блокируют код, замена — правка одного поля на
  иконку, не архитектурное решение; экран создания товара (шаг 1) не
  получил `highlight`/`details` — вне мастера генерации, за пределами
  объёма исследования ТЗ (§7); реальные скриншоты интерфейса и
  React-степпер с состоянием — намеренно отвергнутые альтернативы
  (§3.2 ТЗ), не пропуск.
- **Проверка.** `npx tsc --noEmit -p tsconfig.json` — чисто в `landing/`
  (единственная находка по пути — JSON-модули типизируют строковые
  значения как `string`, не литералами, из-за чего `steps.items[]`
  выводится TS как объединение разнородных по набору полей объектов;
  `badge`/`highlight` читаются через `'key' in step` — тот же приём
  defensive-доступа, что уже применяет `page.tsx` для
  `plans.items[].highlight`). `npx next lint --max-warnings 0` — без
  предупреждений. `npx next build` — все 25 маршрутов собираются
  (было 20 до этапа), включая новый `/[locale]/how-it-works` на всех
  пяти локалях; проверено чтением собранного HTML напрямую: `<title>`
  и мета-описание отличаются по локали (сверено на всех пяти), `<Header/>`
  рендерится на новой странице ровно один раз, блок-схема и карточки
  шагов присутствуют, бейджи «Premium»/«Standard+» стоят ровно на
  ожидаемых пяти шагах (2, 4, 5, 7, 9), `<details><summary>` — только у
  шага 9 и только в `variant="full"` (на тизере — 0 вхождений
  `step-details`, 8 вхождений `step-highlight`, ровно по числу шагов с
  `highlight`). `sitemap.xml` содержит по одной записи
  `/${locale}/how-it-works` на каждую локаль (проверено `grep` по
  собранному `sitemap.xml.body`, 5 вхождений). `node
  scripts/check-docs.mjs`/`node scripts/sync-legal.mjs --check` — без
  расхождений (эта стадия не меняет ни одно из проверяемых чисел —
  бэкенд не тронут вовсе). Ручная визуальная проверка на 360px и
  живого клика по блок-схеме — не выполнена (в песочнице нет браузера
  с рендерингом CSS для скролла/наведения) — статически подтверждено
  только то, что `overflow-x: auto` и верная разметка присутствуют в
  собранном CSS/HTML; отмечено как открытый пункт для владельца
  продукта при приёмке на стенде (см. §8 ТЗ, тот же класс ручной
  проверки, что и у прошлых чисто фронтенд-этапов).

**Внеплановый фикс (после этапа 79) — фаза 2 «обучалки»: сами line-art
SVG-иконки блок-схемы вместо однобуквенных глифов
(`doc/LANDING-ILLUSTRATIONS-BRIEF.md` §3).** Этап 79 сдал фазу 1 (код,
глифы `.feature-icon` на чистом CSS) и явно отложил фазу 2 (рисунки) —
владелец продукта попросил доделать её тем же ходом.

Сделано: девять SVG-иконок `landing/public/illustrations/how-step-1.svg` …
`how-step-9.svg` (новая папка `public/` в `landing/` — до этого её не
было вовсе), тонкая линия (`stroke-width: 1.6`), акцент `#6c8cff`,
композиции ровно по списку §3 ТЗ (карточка товара; play на кадре;
лупа+скан-линия; два пересекающихся круга; два силуэта, один в
пунктирной рамке выделения; документ с карандашом; уголки видоискателя
+ стопка миниатюр; кадр с тремя точками «идёт процесс»; лупа с
восклицательным знаком + стрелка загрузки). Для пяти шагов, где §3
явно требует переиспользовать уже описанный рисунок иконки фичи (§2:
шаги 3→иконка 1, 4→2, 5→5, 6→6, 9→8) — тот же файл физически положен
и под именем `feature-N.svg` (`feature-1.svg`, `feature-2.svg`,
`feature-5.svg`, `feature-6.svg`, `feature-8.svg`), впрок для секции
`#features` — саму секцию `#features` не трогали, это вне объёма
правки, там глифы остались как есть.

`HowItWorks.tsx`: новый локальный компонент `StepIcon` — `next/image` с
проп `unoptimized` (Next.js image-оптимизатор по умолчанию отказывает
в оптимизации SVG без `dangerouslyAllowSVG` в `next.config.js`; заводить
это ради девяти маленьких иконок — лишний конфиг ради одной строки,
`unoptimized` на самой картинке — рекомендованный точечный обход для
именно локальных статических SVG). Обе точки рендера (блок-схема,
20×20, и заголовок карточки шага, 16×16 — под фактический размер
контейнера `.feature-icon`, 36px и 28px) заменены с `{step.icon}` на
`<StepIcon n={n} size={...} />`. Поле `steps.items[].icon` (глиф) в
словарях не удалялось — просто больше нигде не читается.

Проверка: `npx tsc --noEmit`, `npx next lint --max-warnings 0` — оба
чисто. `npx next build` — все те же 25 маршрутов собираются; прямым
`grep` по собранному `ru.html` и `ru/how-it-works.html` подтверждено,
что все девять `illustrations/how-step-N.svg` присутствуют в разметке
обеих страниц (тизер и полная версия) — иконки реально дошли до
собранного HTML, а не только до исходников компонента. `check-docs.mjs`/
`sync-legal.mjs --check` — без расхождений (бэкенд не тронут).

**Внеплановый фикс №2 (после этапа 79) — распространение того же
line-art-стиля на весь `landing/` и на визуальный язык `frontend/`
(TMA), по просьбе владельца продукта.** Исследовал оба приложения
целиком (не только `#how`): в `landing/` единственным ещё не
переведённым потребителем `.feature-icon` оказалась секция
`#features` (`page.tsx`, `dict.features.items[].icon` — те же 9
однобуквенных глифов, что были у шагов до этапа 79); в `frontend/`
(TMA) готового места для нового стиля не нашлось — там уже несколько
стадий как принята и широко используется собственная система иконок
`lucide-react` (46 из ~102 исходных файлов), и «распространить стиль»
там означает не заводить второй, конкурирующий язык иконок, а
довести того немногого, что из неё выбивалось, до того же
единообразия — три места на голых глифах/эмодзи вместо lucide.

Сделано:

- `landing/public/illustrations/feature-3.svg`, `feature-4.svg`,
  `feature-7.svg`, `feature-9.svg` — четыре недостающие иконки фич (стопка
  карточек «Библиотека разборов»; сетка 2×2 «Проекты, товары, бренд»;
  переключатель на два положения «Google Veo 3.1, два качества»; окно
  браузера + пузырь чата «Браузер и Telegram — один продукт», без
  логотипа Telegram) — тот же стиль, что у `how-step-*.svg` (тонкая
  линия 1.6px, акцент `#6c8cff`). Оставшиеся пять (`feature-1/2/5/6/8`)
  уже существовали физически с этапа 79 (переиспользованы из
  `how-step-3/4/5/6/9`), просто не были подключены нигде в разметке.
- Новый общий компонент `landing/src/components/IllustrationIcon.tsx` —
  вынес туда `next/image` + `unoptimized`-обёртку из `HowItWorks.tsx`
  (`StepIcon` теперь просто зовёт `IllustrationIcon` по имени файла),
  чтобы `#features` не заводил свою копию того же кода.
- `page.tsx` (`#features`): `{feature.icon}` → `<IllustrationIcon
  name={`feature-${index+1}`} size={20} />` — та же по позиции файловая
  раскладка, что у блок-схемы, без сопоставления по значению глифа
  (глиф `features.items[].icon` в словарях так и остаётся неиспользуемым
  мёртвым полем, как и `steps.items[].icon` после этапа 79 — трогать
  не стал, тот же прецедент).
- **Сознательно НЕ тронуто в `landing/`**: чек-марки плашки тарифов
  (`.plan-yes::before`/`.plan-no::before`, CSS `content: '✓'/'×'`) и
  переключатель FAQ (`+`/`−` в `Faq.tsx`) — это типографские значки того
  же рода, что общепринято остаются текстом даже на сайтах с богатой
  иконографикой (не «иконки фич», а пунктуационные маркеры состояния);
  переводить их в SVG добавило бы сложность без визуального выигрыша.
  Роадмап-маркер (`.roadmap-mark`, кружок с номером шага) — тот же
  акцентный чип, что у `.feature-icon`, но по смыслу номер, а не
  иконка — не трогал по той же причине.
- `frontend/src/features/credits/CreditsScreen.tsx` — убрал висящий
  эмодзи «⭐» после суммы Stars: у кнопки уже есть `icon={<Sparkles/>}`
  в начале, вторая, текстовая иконка была лишней (подпись `«Stars ·
  {N}»` самодостаточна и без эмодзи).
- `frontend/src/features/generation/AspectRatioPicker.tsx` — заменил
  символ `★` перед подписью выбранного по умолчанию (от референса)
  формата на `<Star size={9}/>` из `lucide-react`, тем же паттерном,
  что уже используют соседние `<Lock/>`/`<Scan/>` в этом же компоненте
  (`sub` у `Pills` и так принимает `ReactNode`, не только строку).
- **Сознательно НЕ тронуто в `frontend/`**: маркеры `•` перед пунктами
  списков в `RelevancePanel.tsx` (дважды, строки ~247 и ~297) —
  цветные типографские буллеты, тот же класс решения, что чек-марки в
  `landing/` выше: это обычный список, не декоративная иконка, замена
  на `lucide`-точку ничего не улучшает.
- Мимоходом (не по этой находке, эта же полная проверка `eslint .`
  вскрыла): два «мёртвых» `// eslint-disable-next-line
  react-hooks/exhaustive-deps` в `frontend/src/App.tsx` (эффект
  редиректа после оплаты) и
  `frontend/src/features/brand/VoicePicker.tsx` (поллинг статуса
  голоса) — оба комментария подавляли предупреждение, которого правило
  больше не выдаёт при нынешних массивах зависимостей (флаг
  `--report-unused-disable-directives` в `npm run lint` их и поймал);
  убраны, поведение не менялось.

Проверка: `landing/` — `npx tsc --noEmit`, `npx next lint
--max-warnings 0`, `npx next build` (снова 25 маршрутов), прямым
`grep` по собранному `ru.html` подтверждено, что все девять
`illustrations/feature-N.svg` присутствуют в разметке `#features`.
`frontend/` — `npx tsc --noEmit`, `npx eslint . --ext ts,tsx
--report-unused-disable-directives --max-warnings 0`, `npm test` (все
скриптовые наборы, включая router/session-step/use-async/video-polling/
voiceover/youtube-search — без изменений в числе тестов, правки не
добавляли новых кейсов), `npx vite build` — все четыре команды чисты
(варнинг Vite про размер общего чанка — не новый, не по этой правке).
`check-docs.mjs`/`sync-legal.mjs --check` — без расхождений (backend не
тронут, числа тестов/файлов не менялись).

**Аудит кода трёх последних ТЗ (по просьбе владельца продукта, «одним
проходом»).** Три последних реализованных ТЗ — `doc/WORKFLOW-FUNNEL-SPEC.md`
+ `doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md` (этап 78), `doc/LANDING-
HOW-IT-WORKS-VISUAL-SPEC.md` (этап 79) и `doc/LANDING-ILLUSTRATIONS-BRIEF.md`
§2/§3 (иконки, два внеплановых фикса выше) — проверены тремя независимыми
параллельными разборами (каждый читал соответствующий ТЗ целиком и сверял
с кодом построчно), затем все подтверждённые находки исправлены одним
проходом.

*Воронка/когорты (этап 78) — исправлено:*

- `admin/src/app/funnel/page.tsx` — кнопка «Повторить» была мёртвой:
  `reload()` делал `setWindow((w) => w)` — React пропускает ререндер при
  `Object.is`-равном состоянии, эффект с зависимостями `[window_, mode]`
  не перезапускался, ошибка висела на экране до смены периода/режима
  вручную. Исправлено отдельным счётчиком `refreshKey` в зависимостях
  эффекта (тот же результат, что вынесение `load()` наружу, как в
  `cron/page.tsx`, но без риска разъехаться с `react-hooks/exhaustive-deps`
  на реактивных `window_`/`mode`).
- `backend/src/modules/admin-panel/admin-panel.controller.spec.ts` — новый
  файл, явно требовавшийся тест-планом обоих ТЗ (§9 в каждом): 7 тестов,
  подтверждающих, что оба новых маршрута (`/admin/workflow-funnel`,
  `/admin/workflow-funnel/cohort-conversion`) реально зовут
  `assertOperator` ДО обращения к данным сервиса, что отказ
  `assertOperator` останавливает запрос (сервис данных не вызывается), и
  что `window` парсится с дефолтом `day` на пустое/мусорное значение.
  Остальной контроллер (17 других маршрутов) — та же предсуществующая
  дыра в стратегии тестирования проекта (ни один маршрут
  `AdminPanelController` не имел контроллерного теста, только сервисы
  тестируются в изоляции), не входит в объём этого аудита сама по себе.
- Схема, индексы, миграция, все 9 точек вызова `logWorkflowStage()` (5 у
  партий, 4 у A/B), их `fromStage`, математика воронки/когорты (окна,
  дедуп, деление на ноль, немонотонность), гейт `assertOperator` на самих
  роутах, DTO/параметры — сверены построчно с обоими ТЗ, расхождений не
  найдено.

*Обучалка (этап 79) — исправлено:*

- Блок-схема показывала ПОЛНЫЙ заголовок шага (`step.title`) вместо
  короткой подписи 2-4 слова, которую явно требует §3.1 ТЗ («короткая
  подпись (2-4 слова, не полный заголовок шага)») и собственный пример
  разметки того же ТЗ (§5.3: `<span>Товар</span>`, не «Заведите товар»).
  Заметнее всего — на шаге 7 (самый длинный заголовок из девяти), чей
  блок визуально раздувался сильнее восьми соседей. Добавлено новое поле
  `steps.items[].shortLabel` во все 5 словарей (по одному короткому
  (1-3 слова) переводу на каждый из 9 шагов на каждую локаль — ru/uk/en/de/es),
  `HowItWorks.tsx` теперь берёт подпись оттуда.
- Блок-схема вообще не показывала бейдж плана, хотя §3.1 ТЗ прямо требует
  «иконка + короткая подпись + бейдж плана, если шаг что-то ограничивает»
  — бейдж был только в карточке ниже. Добавлен в `.how-diagram-box`,
  новый CSS-модификатор `.how-diagram-badge` (уменьшенный шрифт/паддинг
  под 104px-колонку, `.badge` в исходном размере туда не помещался).
  Подтверждено сборкой: ровно 5 бейджей на странице (шаги 2/4/5/7/9, как
  и в карточках).
- `scripts/check-docs.mjs` — новая проверка симметрии `steps.items` по
  всем 5 локалям (ровно 9 элементов, одинаковый набор полей на каждой
  позиции, каждое `badge`-значение входит в `steps.badges`) — сам ТЗ
  (§8) явно предлагал такую проверку как дешёвую страховку от того, что
  ни `tsc --noEmit`, ни `next build` НЕ ловят перекос набора
  необязательных полей между локалями (JSON-модули типизируют строковые
  значения как `string`, не литералы — проверено эмпирически: собранный
  тестовый пример с намеренно «уехавшим» `badge` проходит `tsc` без
  единой ошибки). Проверка добавлена и подтверждена на реальном
  расхождении (временно испорченный `uk.json` — проверка нашла точную
  строку, затем словарь возвращён на место).
- `doc/LANDING-HOW-IT-WORKS-VISUAL-SPEC.md` — задокументированы задним
  числом оба новых поля (`shortLabel`, `detailsToggle` — второе уже было
  реализовано на этапе 79, но не занесено в схему §5.1) и явно
  зафиксировано, какие 5 из 9 пар символов «фича/шаг» — настоящее
  осознанное переиспользование одного рисунка (◐/◎/☺/✎/⌕ — смыслы
  реально совпадают), а какие 3 — случайное совпадение символа при
  независимом выборе глифа (▶/⧉/▣ — смыслы РАЗНЫЕ, разный SVG
  нарисован намеренно). Один из параллельных разборов принял эти три
  совпадения за пропущенные пары переиспользования — уточнение в самом
  ТЗ закрывает эту путаницу на будущее.
- **Не исправлялось (осознанно)**: `aria-label` навигации блок-схемы
  дублирует видимый `<h2>` дословно (спец приводит другой пример,
  «Шаги пайплайна») — низкая значимость (один `<nav>` на странице,
  не ошибка, а небольшая избыточность для читалок с экрана), не стали
  заводить ради этого новое словарное поле на 5 локалей.

*Иконки (§2/§3 брифа) — аудит без находок*: все 18 SVG корректны (валидный
XML, нужный `viewBox`/`stroke-width`), все 5 обязательных пар
«физически один файл» подтверждены побайтовым `diff`, размеры (`size`
пропс у каждого вызова `IllustrationIcon`) соответствуют реальным CSS-
контейнерам, `unoptimized`/`alt=""` — везде последовательно, поле
`icon` в словарях — подтверждённо мёртвое (ни одного потребителя).
Правки во `frontend/` (замена эмодзи/глифов на `lucide-react`, уборка
двух мёртвых `eslint-disable`) — тоже без находок: оба `useEffect`,
которых коснулась уборка, реально не нуждаются в подавлении (проверено
живым прогоном eslint после уборки, не только рассуждением); отдельный
`eslint-disable` в `VoicePicker.tsx:93` (эффект начальной загрузки
каталога голосов) — по-прежнему нужен (пустая зависимость там
намеренная, эмпирически подтверждено обратным экспериментом), не
трогали. Найденная попутно (не по объёму этого аудита) особенность —
редкий гоночный случай устаревшей локали в тексте ошибки того же
эффекта — задокументирована как отдельная находка в `doc/TODO.md`
(§I-З), не исправлялась.

Проверка: backend — `npx tsc --noEmit` (430 ошибок, все — известный
класс несгенерированного Prisma-клиента, ни одна не в новом файле или
изменённых строках), `npx eslint .` (0 ошибок, 8 предупреждений
`no-explicit-any` — только в новом спек-файле, разрешено конфигом для
`*.spec.ts`), точечный `jest` по `admin-panel`/`catalog-batch`/
`ab-test`/`session.service`/`workflow-funnel-cohort` — новый
`admin-panel.controller.spec.ts` зелёный (7/7), остальные загружаемые
наборы без регрессий (55 тестов прошло, ноль провалов среди
загружаемых), обычная для песочницы группа `Cannot find module
'.prisma/client/default'` — не новая. `admin/` — `npx tsc --noEmit`,
`npx next lint --max-warnings 0`, `npx next build` (все 22 маршрута).
`landing/` — `npx tsc --noEmit`, `npx next lint --max-warnings 0`,
`npx next build` (все 25 маршрутов), прямым `grep` по собранному
`ru.html`/`en.html` подтверждены короткие подписи на всех 9 блоках и
ровно 5 бейджей. `node scripts/check-docs.mjs` — включая новую проверку
симметрии локалей — 0 расхождений (тесты пересчитаны на 2051/145 —
+7/+1 от нового `admin-panel.controller.spec.ts`, разнесено по
README.md/doc/CI.md/doc/ACCEPTANCE-CHECKLIST.md). `node
scripts/sync-legal.mjs --check` — без изменений.

**Сделано (этап 80 — лента, лайки и репосты, TODO §III.9,
doc/SOCIAL-FEED-SPEC.md).** Владелец продукта выбрал пункт №9 из
ранжированного списка `doc/TODO.md` §III («Лента, лайки и репосты:
постят только платные») — мини-социальная лента опубликованных
роликов внутри TMA, лайки привязаны к Telegram-идентичности (анти-
накрутка), право публиковать в ленту — только у платных и
неблокированных подписчиков (переиспользует уже существующую очередь
модерации `SharedVideoPage`, этап 60). Перед реализацией написан
полный ТЗ — `doc/SOCIAL-FEED-SPEC.md` (§0 обоснование ранга; §1 разбор
уже существующей инфраструктуры — модерация есть, платный гейт
частичный, проверка блокировки отсутствовала; §2 решение держать ленту
только в TMA, не на лендинге — Telegram `initData` доступен только
внутри настоящего Mini App; §3 модель данных; §4 API; §5 явные решения
по каждому пункту «что решить» из самого TODO; §6 план экрана; §7
админка; §8 порядок реализации).

- Схема: `SharedVideoPage` получила `likeCount`/`shareCount` (best-
  effort счётчики, без `$transaction` — тот же риск-профиль, что у уже
  существующих `viewCount`/`firstGenerationCount`). Новая модель
  `SharedVideoLike` (`userId`+`sharedVideoPageId`, `@@unique` — один
  лайк на пользователя на страницу, идемпотентность через перехват
  Prisma-ошибки `P2002`, а не предварительное чтение) с `@@index` на
  `sharedVideoPageId` и каскадным удалением при удалении пользователя/
  страницы. Одна новая миграция, `20261021090000_shared_video_likes`
  (ALTER TABLE + CREATE TABLE + два индекса + два FK), применена и
  подтверждена на локальном Postgres 16 вместе со всеми прежними 42.
- Бэкенд (`shared-video.service.ts`/`.controller.ts`/`.module.ts`):
  `create()` теперь дополнительно проверяет `assertUserNotBlocked()`
  (раньше только `assertUser(...,'publication')` — блокированный
  платный подписчик мог опубликовать страницу, хотя не должен был мочь
  постить в ленту); новые `listFeed()` (курсорная пагинация,
  `likedByViewer` вычисляется опционально — маршрут публичный, гвард
  identity не требует, но `TelegramIdentityMiddleware` подставляет
  `telegramUserId`, если он есть, что и использовано для этого поля без
  требования логина для простого просмотра ленты), `like()`/`unlike()`
  (идемпотентны), `recordShare()` (best-effort бамп `shareCount`, без
  проверки владения — публичная страница уже публична). Новые маршруты:
  `GET /shared-video/feed` (объявлен ДО `GET /shared-video/:id` — иначе
  Nest сопоставил бы `feed` как `:id`), `POST /shared-video/:id/share`
  (`204`), новый `SharedVideoLikeController`
  (`POST`/`DELETE /shared-video/:id/like`, под `TelegramIdentityGuard`
  — лайк требует настоящей Telegram-идентичности, в отличие от простого
  просмотра ленты).
- Тесты: `shared-video.service.spec.ts` — по пути также исправлена
  давняя, ранее не замеченная поломка загрузки самого файла в
  песочнице (`Cannot find module '.prisma/client/default'` через
  `PlanService`→`common/session.service.ts`); добавлены
  `jest.mock(...)` по прецеденту `admin-panel.controller.spec.ts` —
  файл теперь реально грузится и гоняется в песочнице, а не тихо
  пропускался. 11 новых тестов в 4 новых `describe`-блоках (29 тестов
  в файле всего). Новый `shared-video.controller.spec.ts` (тем же
  приёмом моков) — 5 тестов на оба новых публичных маршрута и новый
  контроллер лайков.
- TMA-фронтенд: новый экран `FeedScreen.tsx` (карточки видео с
  лайком/репостом/счётчиком просмотров, подгрузка «Показать ещё», алерт
  про необходимость войти при 401 на лайк), новый `feed-api.ts`, новый
  роут `feed` в `router.ts`. Точка входа — по прецеденту `App.tsx`
  (явный комментарий в коде: на ширине 390px помещается только 3
  вкладки навигации, четвёртая фича не получает свою вкладку) — не
  новая вкладка, а footer-ссылка на `ProjectsListScreen` рядом с уже
  существующей ссылкой «Быстрая генерация». `ShareVideoPanel.tsx`
  дополнен вызовом `recordSharedVideoShare()` из обеих веток копирования
  ссылки (нативный `navigator.share` и запасной clipboard-путь). Все 5
  словарей дополнены `feedScreen`-блоком и `projectsListScreen.feedLink`.
- Админка: очередь модерации `shared-videos/page.tsx` — только
  добавлены счётчики «лайков»/«репостов» рядом с уже существующими
  просмотрами/конверсией у `PUBLISHED`-строк, без нового экрана
  (переиспользование существующей вкладки, как и было решено в §7 ТЗ).
- Лендинг: `PublicSharedVideoPage` в `shared-video-api.ts` получил
  зеркальные поля `likeCount`/`shareCount` для полноты типа — сама
  лента и лайки сознательно НЕ показываются на публичной странице
  ролика (см. §2 ТЗ), UI-кода не добавлено.

Проверка: backend — `npx tsc --noEmit` (тот же известный класс ошибок
несгенерированного Prisma-клиента, ноль новых сверх него), `npx eslint .`
(0 ошибок), `npx jest --config jest.config.sandbox.json` по обоим
изменённым/новым спек-файлам — 29/29 и 5/5 зелёных (итог по всей
песочнице обновлён в `jest-results.json`: 2067/146, 2052 прошло, 15
провалов/3 набора — тот же долг, что после этапа 77, этим этапом не
тронут). Применена и подтверждена новая миграция на локальном
Postgres 16 вместе со всеми 43 подряд. `frontend/` — `npx tsc --noEmit`,
eslint, все 15 `scripts/*.test.ts`, `npx vite build` — все зелёные.
`admin/` — `npx tsc --noEmit`, `next lint --max-warnings 0`,
`next build` (22 маршрута). `landing/` — `npx tsc --noEmit`,
`next lint --max-warnings 0`, `next build` (25 маршрутов).

**Сделано (этап 81 — тёмная тема в тонах Telegram + переключатель тем,
frontend/).** Прямой запрос владельца продукта: «нужна ещё тёмная тема
в тонах телеграм и переключатель тем как в solar shop». До этого этапа
тёмная тема была автоматической (следует `tg.colorScheme` внутри
Telegram, системной настройке вне его — `applyTheme()` в
`lib/telegram.ts`, без изменений) и визуально была просто чёрным
вариантом той же серой палитры SilverFinance (акцент sky-300 #7dd3fc,
фон #11141a) — ничего от Telegram в ней не было. Через `AskUserQuestion`
уточнено, каким способом делать «тона Telegram»: статичная палитра
классической тёмной темы Telegram Desktop (рекомендованный вариант) —
не живые `tg.themeParams` (риск непредсказуемого контраста на
нестандартных скинах конкретного пользователя, тот же класс багов,
что уже чинили аудиты Б-4.6/Б-4.7/В-5.9 этой самой тёмной темы).

- **Палитра.** `tailwind.config.js`: `silver.600`–`950` были константами
  (#5a6479/#474f60/#2f3543/#1c2029/#11141a, общими для обеих тем) —
  теперь тоже переменные (`rgb(var(--silver-NNN) / <alpha-value>)`), по
  образцу уже существующих `silver-400`/`silver-500`/`accent` (этап 29).
  `src/index.css`: в `:root` (светлая тема) — те же самые значения,
  переехавшие в переменные БИТ-В-БИТ, ничего не изменилось; в `.dark` —
  новая палитра классической тёмной темы Telegram Desktop (тёмно-синяя,
  не серая: фон #0e1621 → #17212b → #243342 → #3b4c60 → #4f6178, акцент
  — фирменный синий Telegram #2AABEE вместо sky-300). Светлота каждого
  нового тона подобрана вплотную к светлоте заменяемого (пересчитано по
  формуле относительной яркости WCAG, разница в третьем знаке) — ни один
  из уже проверенных на прошлых этапах контрастов текста не просел:
  текст на фоне — было 16,2:1, стало 18,2:1; хинт/silver-400/500 — было
  7,36:1, стало 6,79:1; акцент — было 11,06:1, стало 7,06:1 (на
  `silver-950`) — везде запас поверх нормы 4,5:1. `lib/telegram.ts`:
  цвета системной шапки/фона Telegram (`setBackgroundColor`/
  `setHeaderColor`) — были захардкожены на `#11141a`, теперь `#0e1621`;
  по пути найдено и исправлено попутно — эти цвета читали
  `webApp.colorScheme` НАПРЯМУЮ, что после этого же этапа стало враньём
  при явном выборе темы человеком (см. ниже) — источник истины теперь
  один, класс `dark` на `<html>`, уже выставленный `applyTheme()`.
- **Переключатель.** Явный выбор темы теперь приоритетнее автоматики —
  ровно как явный выбор языка приоритетнее `initData` Telegram
  (`initialLocale()`). Новый `lib/theme.ts` (чистые функции,
  `localStorage`, по образцу `lib/i18n.ts`: `readStoredThemePreference`/
  `storeThemePreference`, ключ `v4c_theme`) и `lib/theme-context.ts`
  (React-контекст по образцу `lib/i18n-context.ts` — намеренно `.ts` без
  JSX, провайдер в `AppRoot.tsx` рядом с `I18nContext`). `applyTheme()`
  в `lib/telegram.ts` теперь сначала проверяет явный выбор и, если он
  есть, автоматику полностью игнорирует (включая живые события
  `themeChanged`/`matchMedia` — обратного пути к «авто» переключатель не
  даёt, тот же интерфейс, что и в исходном запросе). Новый
  `components/ThemeToggle.tsx` — по образцу
  `apps/admin/src/components/ThemeToggle.tsx` проекта Solar Shop: круглая
  иконка без подписи, показывает ТЕКУЩЕЕ состояние (не то, во что
  переключит), клик — на противоположное; иконки — `lucide-react`
  (Sun/Moon), а не эмодзи оригинала (весь остальной `nav` в этом
  приложении уже на `lucide-react`, эмодзи было бы единственным
  исключением). Кнопка — в шапке рядом с `LanguageSwitcher`, компактная
  (44×44), а не `<select>` — на 390px рядом с языком места на ещё один
  текстовый контрол уже нет (тот же компромисс, что и у самого
  `LanguageSwitcher`). Пять словарей (`ru/uk/en/de/es.json`) дополнены
  блоком `themeToggle` (`switchToDark`/`switchToLight`, для
  `aria-label`/`title` кнопки).
- **Проверено визуально.** Локальный `vite`-сервер + Playwright
  (headless Chromium) — скриншот исходного состояния (светлая тема по
  умолчанию системной настройки headless-браузера) подтвердил кнопку с
  иконкой солнца рядом с языком; клик по кнопке — второй скриншот
  подтвердил переключение на тёмную тему, реальный тёмно-синий фон
  Telegram (не серый) и смену иконки на луну.

Проверка: `npx tsc --noEmit` — 0 ошибок; `npx eslint . --max-warnings 0` —
0 ошибок (две мелкие правки формата исправлены `--fix`); все 15
`scripts/*.test.ts` — зелёные (правки этого этапа не тронули покрытые
ими модули, но общий прогон подтверждён); `npx vite build` — успешно,
собранный CSS напрямую сверен `grep`: правило `.dark{...}` содержит
именно новые значения переменных. Backend/admin/landing этот этап не
трогает вовсе — `git diff --stat` ограничен `frontend/`.

**Сделано (этап 82 — ИИ-консультант (обучающий) на лендинге, backend +
landing + admin).** Прямой запрос владельца продукта: «реализовать тз ИИ
советника за один проход» — весь `doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md`
(детализированный и дополненный проактивным режимом на предыдущем
проходе) целиком за один присест, без паузы на подтверждение между
частями, вопреки обычному порядку работы этой песочницы «этап за этапом
с проверкой между ними» — явное решение владельца продукта для этого
конкретного прохода, не новый постоянный режим работы.

- **Backend — новый модуль `modules/assistant/`.** `AssistantService.streamChat()`
  — единый асинхронный генератор событий (`token`/`actions`/`done`/`error`),
  общий для SSE-маршрута и JSON-запасного варианта (§4.3 ТЗ), с двумя
  таймаутами на один `AbortController` (30с до первого токена, 90с всего)
  и буферизацией разделителя `<<<actions>>>` через границы чанков
  (`ACTIONS_DELIMITER_MAX_PREFIX - 1` символов в хвосте, проверено тестом
  на посимвольном стриминге). Учёт бюджета — `AiUsageService.spentTodayForOperation('assistant')`
  против дневного лимита в `PlatformSetting` (`AssistantSettingsService`,
  сумма редактируется в админке без деплоя); при исчерпании —
  `TelegramNotifyService.alert()` (10-минутная дедупликация, существующий
  приём) и запись в новую модель `AssistantEvent` (см. ниже). Пост-фильтр
  (`post-filter.ts`, §5.5) — маскирует похожее на email/телефон/токен в
  эхе пользовательского ввода и помечает `flagged`, если ответ обещает то,
  чего продукт не делает; разбор `actions` (`actions.ts`, §5.4) —
  строгая валидация каждого элемента (`stepId` 1-9, `planId` из
  `PLAN_IDS`, `faqIndex` в диапазоне базы знаний, `legal.slug` из
  двух документов), невалидный JSON или элемент — молча без кнопок, а
  не ошибка ответа. Новая модель Prisma `AssistantEvent`
  (`assistant_events`, миграция `20261027090100_assistant_event`,
  написана вручную — см. «Известное ограничение песочницы» ниже) —
  добавлена сверх дословного текста ТЗ: §10 требует долю
  `proactive_shown → proactive_engaged` по каждому триггеру и счётчик
  «бюджет исчерпан», а без отдельной событийной таблицы им неоткуда было
  бы взяться (тот же приём, что `WorkflowStageEvent`/`CronRunLog`).
  Публичный `AssistantController` (`GET /assistant/config`,
  `POST /assistant/chat` — единственный маршрут во всём бэкенде, что сам
  пишет в `@Res()` без `passthrough` и для SSE, и для JSON-запасного
  варианта, в обход `ResponseInterceptor`; `POST /assistant/event` —
  батч клиентской телеметрии) под `PublicOriginGuard` + `RateLimitGuard`
  — сам `RateLimitGuard`/`@RateLimit()` расширен принимать МАССИВ правил
  (10/мин и 60/час на чат одновременно, первое нарушение отвечает 429),
  с сохранением обратной совместимости для всех остальных маршрутов,
  где правило одно. `AssistantAdminController`/`AssistantAdminService`
  (`GET/PATCH /admin/settings/assistant`, `GET /admin/assistant` — лента
  с фильтрами + агрегаты 7/30 дней) — отдельный контроллер внутри
  `AssistantModule`, тот же приём, что `AdminGenerationRetryController`/
  `AdminCronController` (фиче-модуль сам импортирует `AdminPanelModule`,
  направление зависимостей однонаправленное); `PATCH`, не `PUT` — при
  подготовке эндпоинта сперва написан как `PUT`, исправлено на `PATCH`
  до сдачи, чтобы совпасть с методом, которым в проекте уже сохраняются
  все остальные редактируемые настройки admin/settings (voiceover-
  provider, grok-transport). Скрипт базы знаний
  (`scripts/build-assistant-knowledge.ts`) расширен: читает `steps.items[]`
  из словарей лендинга и кладёт их в `ASSISTANT_STEPS` сгенерированного
  модуля (контекст текущего шага в системный промпт); заодно найдена и
  закрыта находка самого генератора — `JSON.stringify` пишет двойные
  кавычки, а `.prettierrc` проекта требует одинарные, из-за чего
  `generated.ts` до этой правки падал на еslint сотнями ошибок
  форматирования — теперь вывод прогоняется через `prettier.format()`
  тем же конфигом перед записью на диск. Крон очистки (`cron-jobs.service.ts`)
  расширен двумя новыми джобами прунинга (`assistant-prune.ts`,
  30 дней хранения) — `AssistantExchange`/`AssistantEvent` не растут
  бесконечно, тот же приём, что уже есть для остальных логов.
- **Landing.** `AssistantWidget.tsx` — единственный клиентский компонент
  на два места (`variant="floating"` — плавающая кнопка + выезжающая
  панель на главной, появляется после того, как `#how` попал в кадр;
  `variant="embedded"` — постоянно открытая панель на `/how-it-works`,
  сетка `1fr 360px` рядом с блок-схемой на ≥1100px, под ней — на узких
  экранах). Стрим читается `fetch` + `ReadableStream` (не `EventSource`
  — маршрут принимает POST, §4.3 ТЗ прямо оговаривает это ограничение),
  история — до 10 сообщений в `sessionStorage`. Пять проактивных
  триггеров (§6.6.1) через `IntersectionObserver`/таймеры/`mouseleave`
  с анти-спамом (`sessionStorage`, максимум один показ на триггер за
  сессию) — с двумя упрощениями против буквы ТЗ, зафиксированными явно
  в коде: «возврат к шагу» считает возвратом сам факт повторного
  попадания карточки в кадр (без накопительного счётчика времени по
  визитам), а у пятого триггера («открыл панель и 15с молчит») в
  `ProactiveTips` от бэкенда нет отдельного текста — переиспользован
  текст подсказки про тарифы. `HowItWorks.tsx` — добавлена кнопка
  «Спросить об этом шаге» в каждую карточку (оба варианта, teaser и
  full) с `data-assistant-ask-step`/`data-assistant-step-title` —
  серверный компонент остаётся без своего состояния (как и был, §3.2
  исходного ТЗ), виджет слушает клики делегированием на `document`.
  Действия из ответа модели (§5.4): `open-app` открывает TMA,
  `step`/`plan`/`legal` ведут на нужный якорь/страницу (новый
  `data-plan-id` на карточках тарифов), `faq` — упрощение: прокрутка к
  `#faq` без автораскрытия конкретного пункта (аккордеон `Faq.tsx`
  локальный, без внешнего управления состоянием — заводить его ради
  этого не стали). Пять словарей (`ru/uk/en/de/es.json`) дополнены
  ключом `steps.askAbout` и блоком `assistant` (22 строки — заголовки,
  плейсхолдеры ошибок, подписи кнопок действий, `{{title}}`/`{{n}}`
  интерполяция). Новая переменная `NEXT_PUBLIC_API_BASE_URL` в
  `.env.example` — первый случай, когда браузер лендинга ходит в backend
  напрямую (не через SSR, как блог), поэтому `CORS_ORIGIN` бэкенда
  должен включать происхождение лендинга (см. `doc/DEPLOYMENT.md`).
- **Admin.** `AssistantSettingsCard` на `/settings` (рубильник
  `enabled`/`proactiveEnabled`, дневной бюджет в $, модель — свободным
  текстом, невалидную бэкенд отклонит `IsIn`: отдельный эндпоинт под
  список допустимых Gemini-моделей не заводили ради одного поля) и
  новая вкладка `/assistant` (лента обменов с разворачиваемой строкой
  полного текста вопроса/ответа, фильтры по флагу/локали/поиску,
  агрегаты 7/30 дней, топ вопросов) — та же связка, что уже даёт
  «Модерация публикаций» vs «Телеметрия»: действие отдельно от
  наблюдения. Пункт «ИИ-консультант» добавлен в группу «Система»
  навигации.
- **Известное ограничение песочницы (не новое, см. `doc/CI.md`,
  подтверждено повторно этим этапом).** `prisma generate` по-прежнему
  заблокирован (403 от `binaries.prisma.sh`, включая
  `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` — блокировка на уровне
  самого бинарника, не только чексуммы), поэтому миграция
  `assistant_event` написана вручную (тот же приём, что и все
  предыдущие) — но, в отличие от `prisma generate`, локальный Postgres
  16 в этой песочнице есть (`pg_lsclusters` находит кластер, просто
  выключен по умолчанию — `sudo pg_ctlcluster 16 main start`): все **49**
  миграций подряд накатаны `psql -f` на чистую базу, обе новые таблицы
  (`assistant_events`, `assistant_exchanges` — вторая заведена
  раньше в этом же проходе) сверены со `schema.prisma` через `\d`
  колонка-в-колонку и пройдены функциональной вставкой/чтением строки
  в каждую. Отдельно, новым в этом
  этапе наблюдением: `npx jest` не может ИСПОЛНИТЬ ни один спек-файл,
  чей модуль-подопытный обращается к реальным Prisma-аксессорам
  (`this.prisma.assistantExchange` и т.п.) — ts-jest типизирует сам
  проверяемый файл по не сгенерированному `@prisma/client`, даже когда спек
  мокает `PrismaService` через `jest.mock`. Проверено, что это не
  регрессия этого этапа: та же ошибка воспроизводится на уже
  существующих `rate-limit.spec.ts`/`relevance.service.spec.ts`/
  `ai-usage.service.spec.ts`. Из шести новых/изменённых спек-файлов
  этапа четыре не касаются Prisma и зелёные в этой песочнице (`actions.spec.ts`,
  `post-filter.spec.ts`, `assistant-chat-request.dto.spec.ts`,
  `assistant-knowledge.spec.ts` — 56/56 тестов); `assistant.service.spec.ts`,
  `assistant.controller.spec.ts` и добавленный в `rate-limit.spec.ts`
  блок на массив правил написаны по тем же образцам мокирования, что и
  остальной проект, но не исполнены здесь — предназначены для реального
  CI, где `prisma generate` проходит.

Проверка: backend — `npx tsc --noEmit` (диф с базовым списком до этапа:
0 новых ошибок сверх известного класса несгенерированного Prisma-клиента),
`npx eslint` по всем изменённым файлам — 0 ошибок; `npx jest` — 56/56 в
четырёх спек-файлах, не касающихся Prisma (см. ограничение песочницы
выше), остальные спек-файлы этапа написаны, но не исполнены здесь; все
49 миграций подряд применены и сверены на локальном Postgres 16 (см.
выше).
`landing/` — `npx tsc --noEmit`, `next lint --max-warnings 0`, `next build`
— все зелёные, сборка отчиталась `Generating static pages (25/25)`
(включая новый встроенный виджет на `/how-it-works` на всех пяти
локалях). `admin/` — `npx tsc --noEmit`, `next lint --max-warnings 0`,
`next build` — все зелёные, `Generating static pages (23/23)`
(включая новую `/assistant`).

**Сделано (этап 83 — восьмой сквозной аудит: лендинг + ИИ-консультант,
все высокие устранены).** Прямой запрос владельца продукта: «проведи
полный аудит лендинга включая советника и исправь высокие в одном
проходе» — см. `doc/AUDIT-2026-09-15-round8.md`. Три высокие находки,
все три — прямое следствие того, что этап 82 (запись выше) первым
довёл до продакшена страницу, зависящую от рантайм-конфига с бэкенда, и
при этом `assistant.enabled` по умолчанию выключен на проде (§13 ТЗ).

- **Н8-1.** `sendMessage` в `AssistantWidget.tsx` убирал временный
  пустой пузырь ответа ассистента только на одном из трёх путей ошибки
  (`!res.ok`) — SSE-событие `error` и сетевой `catch` оставляли его в
  транскрипте (и в `sessionStorage`) навсегда. Кнопка «Повторить»
  безусловно дописывала вопрос новым сообщением — задваивала его и в
  UI, и в том, что уходит на бэкенд. Исправлено: все три пути
  одинаково убирают пустой плейсхолдер; `sendMessage` получил
  `opts?: { retry?: boolean }` — retry переотправляет существующую
  историю без повторного добавления вопроса.
- **Н8-2.** Гейт рендера виджета — `if (config !== null && config.enabled === false) return null` —
  прятал виджет только при явном `enabled === false`; пока конфиг ещё
  грузится или запрос `/assistant/config` не прошёл вовсе (например,
  из-за не заданного в проде `NEXT_PUBLIC_API_BASE_URL`, введённого
  тем же этапом 82), виджет рендерил нерабочую кнопку/панель — fail-open
  вместо принятого в проекте fail-closed (та же логика, что у
  `CORS_ORIGIN`/CSRF). Исправлено на `if (!config?.enabled) return null`.
- **Н8-3.** После фикса Н8-2 виджет при выключенном советнике честно
  возвращает `null` — и безусловно зарезервированная в CSS колонка
  `1fr 360px` на `/how-it-works` превратилась бы в гарантированно
  пустой блок у каждого посетителя при запуске. Исправлено CSS-парой
  `.how-it-works-assistant:empty { display:none; }` +
  `.how-it-works-layout:has(.how-it-works-assistant:empty){ grid-template-columns:1fr; }`.

Одна средняя находка (М8-1 — кнопка «Спросить об этом шаге» в
`HowItWorks.tsx` рендерится безусловно и остаётся видимой, но
неотзывчивой, когда советник выключен) сознательно отложена первым
заходом — вне рамок инструкции «исправить высокие»; закрыта вторым
заходом тем же днём, по прямому запросу владельца продукта.

- **М8-1 (второй заход).** Тот же приём, что у Н8-3: `AssistantWidget`
  при выключенном советнике не рендерит ни `.assistant-widget-floating`,
  ни `.assistant-widget-embedded`, так что правило
  `body:not(:has(.assistant-widget)) .step-ask-btn { display:none; }`
  (`globals.css`) прячет кнопку на уровне страницы по отсутствию узла —
  вместо видимой, но нерабочей кнопки, на обеих страницах (`#how` на
  главной, `/how-it-works`) сразу.

Файлы: `landing/src/components/AssistantWidget.tsx`,
`landing/src/app/globals.css`.

Проверка (оба захода): `npx tsc --noEmit` — чисто; `next lint` — без
предупреждений; `next build` — чисто, все 25 маршрутов собраны. В
`landing/` нет юнит-тестов (нет `test`-скрипта) — все четыре фикса
точечные (условие рендера в одну строку, три CSS-правила), проверены
логическим разбором вместо рантайм-скриншота (честная оговорка, см.
аудит).

**Сделано (этап 84 — постобработка ролика больше не зависает в
«обрабатывается» навсегда).** Живой репорт владельца продукта со
скриншотом Mini App: карточка «Сгенерированная реклама» уже показывает
«Скачать», формат и «голос записан, накладываем на ролик — ссылка
обновится сама», а «Проверить на артефакты» отвечает «Ролик ещё
обрабатывается — дождитесь готовой версии» (`VideoAuditService.run`,
`video-audit.service.ts:165-168`, тот же гейт у `runSoundCheck`).
Формулировка «аудит неправильно считывает статус» подтвердилась
частично: гейт по `generatedVideo.postStatus === 'pending'` сам по
себе верный (см. этап 39, А-2.9 — аудит обязан смотреть готовый файл, а
не исходник Veo), но поле, которое он проверяет, оказалось способно
залипнуть в `'pending'` навсегда.

- **Причина — рецидив класса Е-2.3/М-1.2-5.2 (шестой и седьмой
  аудиты): «платная внешняя работа, которую никто не досматривает без
  открытой вкладки».** `postStatus` двигает ровно один путь —
  `PostProductionService.poll()`, вызываемый ТОЛЬКО изнутри
  `GET /sessions/:id/video-status` (`GenerationService.getVideoStatus`,
  строка 1209), то есть только клиентским поллингом
  (`useWorkflow.ts:startVideoPolling`). У постобработки (crop/озвучка
  через ffmpeg, `postprod.service.ts`) есть собственный 15-минутный
  дедлайн (`POSTPROD_DEADLINE_MS`, `postProductionExpired`) — но он
  тоже проверяется только ВНУТРИ `poll()`. Закрыл вкладку/свернул
  Telegram Mini App между «Veo закончил» и «ffmpeg-задача готова» — и
  `postStatus` остаётся `'pending'` бессрочно: не завершается успехом,
  не проваливается по дедлайну, просто висит. В отличие от яруса B
  автоэкспорта и Grok-пачек, у постобработки крон-досмотра не было
  вовсе — единственный из трёх подобных механизмов без него.
- **Исправление — тот же приём, что у Grok-пачек (М-1.2/М-2.3/М-5.2):**
  новая `SessionService.findSessionsWithPendingPostProduction()`
  (`generationStatus = 'complete'` AND `postStatus = 'pending'`,
  сортировка по `lastActivityAt`, лимит) и
  `GenerationService.runPostProductionSyncTick()` — находит такие
  сессии, продлевает им TTL (`touchSessions`) и досматривает каждую
  через уже существующий `getVideoStatus()` (тот сам вызывает
  `postprod.poll()` для `status === 'complete'` — отдельный вызов
  `poll()` не нужен). Встроено в уже существующий крон `export-sync-run`
  (`ExportService.runSyncTick`, каждые 2 мин, `backend/vercel.json`) —
  тем же способом, каким туда же встроили Grok-досмотр: один
  крон-маршрут на все «внешние асинхронные операции без открытой
  вкладки», а не отдельная запись в `vercel.json`/admin-cron на каждую.
  Результат: сессия, застрявшая без открытой вкладки, теперь либо
  получает готовый файл (следующий тик), либо честно проваливается по
  15-минутному дедлайну с «ролик доступен без неё» — в обоих случаях
  `postStatus` больше не `'pending'`, и аудит/проверка голоса
  разблокируются сами, без действий пользователя.

Файлы: `backend/src/common/session.service.ts`,
`backend/src/modules/generation/generation.service.ts`,
`backend/src/modules/export/export.service.ts` — плюс тесты
`session.service.spec.ts`, `generation.service.spec.ts`,
`export.service.spec.ts`.

Проверка: `npx tsc --noEmit` — 0 новых ошибок сверх известного класса
несгенерированного Prisma-клиента (ограничение песочницы, см. этап 82);
`npx eslint` по всем изменённым файлам, включая три спека, — 0 ошибок.
Новые тесты написаны (три `describe`-блока — по одному на
`findSessionsWithPendingPostProduction`, `runPostProductionSyncTick` и
на слияние счётчиков в `ExportService.runSyncTick`), но не исполнены в
этой песочнице: все три спек-файла транзитивно типизируются по
`SessionService`/`GenerationService`, которые обращаются к
несгенерированному `@prisma/client` — тот же класс ограничения, что и
`session.service.spec.ts` до этой правки (сам SQL проверяется на живом
Postgres в CI).

**Сделано (этап 85 — «Продолжить» со шага промпта после возврата по
степперу).** Живой репорт владельца продукта со скриншотом Mini App:
вернулись через кликабельный номер шага на уже утверждённый (без правок)
промпт — единственная кнопка карточки («Утвердить промпт») в этом
состоянии становилась `disabled` с той же надписью, что и бейдж
«Утверждён», и продолжить со шага было решительно нечем.

- **Причина.** `PromptEditor.tsx`: кнопка гасилась условием
  `isApproved && !dirty` — рассчитанным на то, что повторно нажимать
  «Утвердить» незачем, раз уже утверждено. Но дальше по мастеру
  (`GenerationWizard.tsx`) именно это утверждение — единственный путь,
  который переводит `currentStep` на шаг генерации ролика
  (`useWorkflow.ts:handleApprovePrompt`, `currentStep:
  'video-generation'`). Формальный, но не единственный путь вперёд
  всё-таки был: степпер (`Stepper.tsx`) уже кликабелен для следующего
  шага, если он в принципе достижим (`selectableSteps`, этап 52,
  В-1.5) — независимо от того, «пройден» ли он (`done = i < current`).
  Но красился кружок степпера ровно так же, как обычный недостижимый
  будущий шаг (`bg-silver-200/60`, тот же серый) — рабочая, но
  визуально неотличимая от заблокированной кнопка. Сверка с соседними
  шагами мастера показала: только здесь так — `ProductInput.tsx`,
  например, держит свою кнопку «Продолжить» рабочей всегда (гейт —
  только пустые поля, не «раз уже отправляли — нечего повторять»).
- **Исправление, двумя частями.**
  1. `PromptEditor.tsx` — кнопка больше не гасится условием `isApproved
     && !dirty`; в этом состоянии она остаётся рабочей и показывает
     «Продолжить» (новый ключ `promptEditor.continueApproved`, все 5
     словарей) вместо неактивной надписи «Утверждён». Клик по ней
     по-прежнему уходит в `PromptService.approvePrompt` — тот
     бесплатный и идемпотентный (только пишет новый `approvedAt`, без
     платного вызова и без сайд-эффектов — проверено по коду) — и
     штатно переводит на шаг генерации ролика тем же путём, что и
     первое утверждение.
  2. `Stepper.tsx` — кружок шага, который уже кликабелен
     (`selectable[i]`), но ещё не «пройден» (`!done`), получил
     отдельную окраску (тонкая рамка акцентным цветом) вместо той же
     серой заливки, что у недостижимых шагов — чтобы сама возможность
     продолжить со степпера была заметна, а не только рабочей. Второй,
     более общий путь к той же цели — на случай, если пользователь
     вернётся на шаг, для которого специальной кнопки-обхода вроде
     первой правки ещё нет.

Файлы: `frontend/src/components/PromptEditor.tsx`,
`frontend/src/components/ui/Stepper.tsx`,
`frontend/src/dictionaries/{ru,uk,en,de,es}.json`.

Проверка: `npm install` (node_modules отсутствовал в этой песочнице —
поставлен впервые в рамках этой правки), `npx tsc --noEmit` — чисто (в
т.ч. подтверждает паритет новых ключей по всем пяти словарям — тип
словаря строится по `ru.json`, расхождение было бы ошибкой типов);
`npm run lint` — чисто по обоим изменённым файлам (в остальных файлах
проекта нашлись дочиненные до этой правки `prettier`-расхождения — не
трогались, вне рамок находки); `npm run build` (`tsc && vite build`) —
чисто; `npm test` (`scripts/*.test.ts`, включая `session-step.test.ts`
и `video-polling.test.ts`) — все проверки пройдены. Компонентных тестов
на кнопку не добавлено: во фронтенде нет инфраструктуры рендер-тестов
React-компонентов (`scripts/*.test.ts` — только тесты на чистую логику
через `tsx`), заводить её ради одной кнопки — вне рамок находки;
поведение прослежено по коду (условие `disabled`, цепочка
`onApprove → handleApprovePrompt → currentStep`).

**Сделано (этап 86 — колонка «Качество» в админке всегда прочерк).**
Живой репорт владельца продукта со скриншотами списка `/sessions`:
колонка «Качество» пустая у всех строк подряд, независимо от статуса
(`video_complete` в том числе) и режима озвучки.

- **Причина.** Колонка в SQL-сводке (`common/session-summary.ts`,
  `SELECT_FROM`) читает ровно один JSON-путь:
  `data.generatedVideo.quality`. Это поле пишет ТОЛЬКО ветка Veo
  (`startVeoGeneration`, свойство `quality` пишется как сокращённая
  запись `quality,` без двоеточия — и это ровно то место, где
  первоначальная гипотеза «поле не пишется вовсе» не подтвердилась:
  `grep` по буквальному `"quality:"` с двоеточием эту запись не ловит).
  У Grok-ветки (`startGrokGeneration`) `quality` не пишется никогда и
  осознанно — своя ось качества, `resolution` (`'480p' | '720p' |
  '1080p'`, ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §11.2: «У Grok нет
  понятия `quality` — там своя ось, разрешение»), это уже задокументи-
  ровано в типе `GeneratedVideo` и учтено в других местах кода (тот же
  файл `admin/src/app/sessions/page.tsx`, разворачиваемая панель
  «Версии», строка 621: `v.provider === 'grok' ? \`Grok · ${v.resolution
  ?? '—'}\` : \`Veo · ${v.quality ?? '—'}\``). Но сама Grok-ветка — не
  редкий случай: `GenerationWizard.tsx` держит `useState('grok')` как
  фолбэк-дефолт провайдера ДО ответа админской настройки
  `getDefaultVideoProvider()`, и по прямому наблюдению у владельца
  продукта Grok — фактический провайдер почти всех роликов на этом
  стенде. Колонка в главном списке читала только `quality` и потому у
  подавляющего большинства строк честно показывала «нет значения» —
  только это выглядело как «данных нет вообще», хотя данные были,
  просто по другому полю (`resolution`), которое строка сводки не
  выбирала совсем.
- **Исправление.** Сводка сессии (используется и списком, и одиночной
  деталью — `toSummary` в `admin-panel.service.ts` делегирует в тот же
  `summaryFromSlim`) расширена двумя полями, тем же путём, что и
  `quality`:
  1. `common/session-summary.ts` — `SessionSummaryRow` и `SELECT_FROM`
     получили `data.generatedVideo.provider` и
     `data.generatedVideo.resolution`.
  2. `admin-panel.service.ts` — `SessionSummary` (публичный тип ответа)
     и обе точки построения (`summaryFromSlim` для списка,
     `toSummary`/`getSession` для детали одной сессии) прокидывают оба
     новых поля.
  3. `admin/src/lib/types.ts` — тот же `provider`/`resolution` добавлены
     в `SessionSummary` на фронте админки.
  4. `admin/src/app/sessions/page.tsx` — рендер колонки «Качество»
     переведён на ту же провайдеро-зависимую формулу, что уже была в
     панели «Версии» той же страницы (строка 621): `Grok · <resolution
     ?? '—'>` для `provider === 'grok'`, `Veo · <quality ?? '—'>`
     иначе, и обычный прочерк только когда нет вообще ни `quality`, ни
     `resolution` (рендера не было). Фильтр по качеству в шапке списка
     (`quality`, только Veo-значения) не трогался — отдельная функция,
     расширение фильтра под обе оси не входило в рамки этого репорта.

Файлы: `backend/src/common/session-summary.ts`,
`backend/src/common/session-summary.spec.ts`,
`backend/src/modules/admin-panel/admin-panel.service.ts`,
`admin/src/lib/types.ts`, `admin/src/app/sessions/page.tsx`.

Проверка: `npx tsc --noEmit` в `backend/` и в `admin/` — 0 новых ошибок
(в `backend/` те же типовые ошибки непосгенерированного Prisma-клиента,
что и на предыдущих этапах этой песочницы, ни одна не касается новых
полей `provider`/`resolution`); `npx eslint` на всех изменённых файлах
— чисто (в `admin-panel.service.ts` дальше по файлу нашлись дочиненные
до этой правки `prettier`-расхождения в соседнем блоке
`errorCode`/`errorMessage`/`errorRetryable` — не трогались, вне рамок
находки); `npx jest session-summary.spec.ts` — новая проверка (сводка
теперь выбирает оба JSON-пути) написана в том же файле и по тому же
шаблону, что и остальные проверки этого набора, но не выполнена в
песочнице: тот же файл `session-summary.ts` уже падает на типах
непосгенерированного `PrismaService` (`$queryRawUnsafe` не существует
на типе) при попытке импорта через `ts-jest` — известное ограничение
песочницы (`prisma generate` блокируется 403 от binaries.prisma.sh),
задокументированное на предыдущих этапах; проверена в CI/на реальном
Postgres. `node scripts/check-docs.mjs` — одно расхождение
(«переменные окружения») пред-существующее и не связано с этой правкой
(про `GEMINI_IMAGE_MODEL`/`GROK_VIDEO_MODEL`/`OPENAI_FAST_MODEL`/
`VITE_CLAUDE_REFERRAL_URL`), не трогалось.

## Проверка на каждом этапе (сквозное)

- `npx tsc --noEmit` в `backend/`, `frontend/` — без новых ошибок.
- Ручной прогон соответствующего куска сценария через
  `docker compose -f docker-compose.dev.yml up` — каждый этап
  демонстрируется независимо, без ожидания следующих.
- Начиная с Этапа 4 — реальные вызовы платных API (SerpApi, YouTube
  Data API, Veo, Gemini) требуют настоящих ключей в `.env`/`.env.docker`
  и включают реальные расходы — тестировать осмысленно (не в цикле),
  учитывая дневные лимиты, заведённые на Этапе 1.

## Порядок реализации (сводно)

1 (секреты) → 2 (Prisma) → 3 (Project/ProductItem CRUD) → 4 (аналоги +
категория) → 5 (голос) → 6 (страны/валюты) → 7 (Brand Manifest CRUD) →
8 (фронт экраны 1–5) → 9 (фронт Brand Manifest) → 10 (Project → Session
+ снимок манифеста) → 11 (YouTube API) → 12 (фронт YouTube) → 13
(Gemini персонажи) → 14 (фронт персонажи + манифест) → 15 (Veo
referenceImages) → 16 (аудит backend) → 17 (фронт аудит/публикация) →
18a (очередь модерации; 18b — отдельное ТЗ) → 19 (озвучка минимум) →
20 (формат кадра) → 21 (своя сцена + слоты) → 22 (сцены бренда) →
23 (превью, аудитория, релевантность) → 24 (сцены/массовка, оферта,
библиотека, переименование) → 25 (приватность и модерация библиотеки) →
26 (жизненный цикл файлов) → 27 (каскады + подметатель сирот) →
28 (сброс при смене референса + сквозная сверка) → 29 (режимы сервиса,
диагностика базы, метла в кроне, аудит тем, аудит лендинга) →
30 (пользователи и режимы в админке) → 31 (блокировка и учёт расходов
на ИИ) → 32 (суточные потолки расхода, кеш токенов, уведомления в TMA) →
33 (CI и сверка документов с кодом) → 34 (обрезка кадра
через хостед-ffmpeg) → 35 (настоящая озвучка: свой голос, текст реплик
отдельной сущностью, один проход ffmpeg на обрезку и звук) →
36 (проба голоса, сдвиг речи по таймкоду, переключатель версий ролика) →
37 (долг I.1 аудита: постобработка доходит до пользователя и
оплачивается один раз) → 38 (долг I.2: закрытые двери) → 39 (долг I.3: дефекты
пользовательских сценариев) → 40 (остаток аудита: база, тесты, документы,
вёрстка) → 41 (высокие находки второго аудита) → 42 (чужая сессия как
ключ, индексы под внешние ключи, повторная генерация, тупики мастера) →
43 (тесты на непокрытые ветки и документы, которые врали) →
44 (то, что дорожает со временем: кеш отчёта, лишние индексы, гонки
квот, касания) → 45 (два служебных канала Telegram) → 46 (движение
камеры) → 47 (serverless-класс третьего аудита) → 48 (сценарий целиком: проект →
генерация, тупики мастера, сообщения сервера) → 49 (защиты без тестов,
двери на входе) → 50 (вёрстка, проверяемая замером) → 51 (данные, которые растут) → 52 (дедлайны ожидания, дорога назад в мастере) →
53 (документы, которые не врут; CI, который проверяет) →
54 (хвост аудитов: крон, фильтр, частота, потолок, триграммы) →
55 (мультиязычность: инфраструктура + лендинг на пяти языках) →
56 (мультиязычность: полный перевод экранов TMA) →
57 (блог/новости: модели, источник контента, перевод ИИ-конвейером) →
58 (блог/новости: публичные страницы, админ-модерация, sitemap-news) →
59 (локализация ИИ-вывода продукта под язык пользователя) →
60 (публичная страница ролика и петля шеринга) →
61 (выгрузка одобренных роликов в YouTube и TikTok) →
62 (оплата: подписки Standard/Premium и пакеты кредитов через Telegram
Stars и WayForPay) →
63 (рекламный канал: согласие на рассылку и подборка удачных роликов
через Telegram-бота) → 64 (исправление высоких находок аудита
2026-09-08: деньги, безопасность, база, продукт/UX, мультиязычность,
документы и юридические тексты) → 65 (пакетная генерация по каталогу:
один одобренный ролик переносится на остальные товары линейки одним
заходом, кроном) → 66 (A/B-варианты одного ролика: 3 дубля с разным
хуком и CTA к одной раскадровке, один синхронный вызов GPT-5 при
создании запуска, старт рендеров кроном) → 67 (жёстко вшитые субтитры с
брендовым стилем и автотаймингом: третья необязательная операция того
же прохода ffmpeg, что кроп и голос — реальный тайминг из
`/with-timestamps` ElevenLabs для voiceover/dub, best-effort эвристика
по длительности ролика для veo) → 68 (товарный фид: импорт каталога по
ссылке на YML/CSV-фид, разовый снимок, два тика одного крона —
скачивание+разбор, затем заведение позиций через уже существующий
`ProjectService.addItem()`, новая SSRF-защита для чужого URL, дефолт
лимита позиций проекта поднят с 20 до 500) → 69 (админка: вкладка
«Кроны» — реестр десяти крон-задач, ручной запуск с флагом debug,
история прогонов в новой таблице `CronRunLog`; бизнес-логика кронов
извлечена в `CronJobsService` — единственный источник истины на два
вызывающих, настоящий крон Vercel и ручной admin-запуск; вкладка
env-переменных из того же запроса оказалась уже реализована на этапе
40, новой работы не потребовала) → 70 (Resemble AI как второй
провайдер синтеза речи: переключаемый DI-токен `TTS_PROVIDER`,
`ResembleService` рядом с `ElevenLabsService`, пометка провайдера на
голосе бренда — и в самом манифесте, и в снимке сессии, — guard от
рассинхрона перед платным вызовом синтеза, ставка `resemble-tts` в
`ai-pricing.ts`, предупреждение в интерфейсе манифеста) → 71
(исправление семи высоких находок пятого аудита: воркеры партии/A-B
сами досматривают статус рендера у Veo вместо пассивного ожидания
открытого экрана; подтверждение для необратимой «метлы» на вкладке
«Кроны»; редирект-safe SSRF-guard для импорта фида; индекс `createdAt`
на трёх историях админки; настоящий Vercel Cron тоже пишет
`CronRunLog`; кнопка «Повторить» на вкладке «Кроны»; чеклист приёмки
покрыл этапы 64–70; число миграций в `TELEGRAM-ADMIN.md` больше не
привязано к номеру этапа) → 72 (пилот говорящего AI-аватара: Hedra
Character-3 + Resemble, `doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md` — новый
модуль `modules/actors/`, персонаж референсится индексом в снимке
манифеста бренда, порядок трат «сперва озвучка, только потом Hedra» с
тем же принципом «деньги потрачены в момент старта», admin-only
контроллер в обход `PlanService`, десятый `PlanFeature` `avatarLipsync`
выключен на всех тарифах, страница `/actors` в админке) → 72а (тем же
проходом, по правке владельца продукта: субтитры пилота аватара явным
чекбоксом, выключены по умолчанию, второй отдельный проход ffmpeg после
Hedra со своим дедлайном; при верификации найдена и закрыта гонка
двойной отправки платной задачи ffmpeg — новый вид работы
`'avatar-subtitle-burn'` в `WORK_KINDS`, тот же приём, что у
`claimPostProduction`/`'avatar-generate'`) → 72б (детальный аудит
пилота аватара по прямому запросу владельца продукта — 6 находок, 2
высокие: остаточная гонка второго рода в отправке прожига субтитров
несмотря на замок Д-1 (закрыта свежим чтением сессии из БД под замком
непосредственно перед платным вызовом), устаревший снимок дедлайна
рендера мог необратимо затереть уже готовый и оплаченный ролик Д-2
(закрыта новым `writeIfStillCurrent` — перечитывает и сверяет состояние
перед каждой финализирующей записью); плюс дубль в локальном учёте
расходов закрыт как следствие Д-1, недоказанная гарантия дедупликации
ffmpeg-api и мёртвый `try/catch` — низкие, исправлены) → 73 (три независимых приоритета из
одного `AskUserQuestion`: саундчек Gemini «звучит ли голос как живой
человек», отдельный от аудита артефактов, реализован симметрично для
Veo (`VideoAuditService.runSoundCheck`) и Hedra-аватара
(`ActorsService.runSoundCheck`) через общую чистую логику
`common/sound-check.ts`; «товар в кадре» у аватара — регламентная мера,
не код: обязательный чекбокс-подтверждение оператора на `/actors`,
Hedra не даёт API-параметра для композитинга товара, генерация
изображения персонажа с товаром явно отклонена владельцем продукта;
самообслуживаемое клонирование голоса через Resemble AI — новый модуль
`modules/user-voices/`, presigned-Blob поток, асинхронное обучение с
готовностью по вебхуку или poll-фоллбеком, новый `PlanFeature`
`voiceCloning` (Standard и выше), лимит 3 голоса на пользователя,
явное согласие на каждый клон; попутно найдена и закрыта
межпользовательская утечка каталога голосов — общий `RESEMBLE_API_KEY`
отдавал бы клоны одного пользователя в каталог всех остальных без
фильтра в `TtsController.voices()`) → 74 (исправление 16 средних и 5
низких находок пятого аудита, оставшихся после этапа 71: партии
каталога/A-B — busy-check исключает `DONE` при перезапуске, Serializable-
транзакция против межпартийной гонки, точечный повтор одной строки,
резюме ретрая по фактическому состоянию сессии вместо слепого повтора
шагов; новый джоб-уровневый TTL-замок `CronJobLock` на все три воркера;
импорт фида — идемпотентная запись `productItemId` до финальной строки
статуса, видимая ошибка вместо молчаливого `.catch`; потоковый лимит
размера тела ответа `readBodyWithLimit`; частичные счётчики в ошибке
упавшей «метлы»; два новых индекса (`CronRunLog.startedAt`,
`CatalogBatchItem.productItemId`); переставляемый таймер поллинга и в
`.catch()`, не только в `.then()`; семь переменных окружения добавлены
в «Настройки»; N+1 в двух списках админки пересмотрен и оставлен
осознанно; семь документных находок — числа маршрутов/миграций/тестов,
пропущенные файлы и пункт роадмапа приведены в порядок) → 75 (автоэкспорт
одной генерации под несколько площадок сразу, TODO §III п.35, закрывает
«Горизонт 2» — оба яруса сразу, решение владельца продукта из четырёх
`AskUserQuestion` этой стадии: ярус A — дешёвая пакетная обрезка уже
готового файла хостед-ffmpeg в форматы того же семейства кадра, один
batched-вызов `FfmpegApiService.submit()`, одна запись расходов на весь
батч; ярус B — второй платный рендер Veo тем же одобренным промптом
для формата из другого семейства, новая дочерняя сессия тем же приёмом,
что у `CatalogBatchWorkerService`/`AbTestWorkerService`; денормализованное
поле `GeneratedVideo.exportVariants`, без новой таблицы/миграции; новый
модуль `modules/export` (три маршрута); попутно исправлен пробел заявки
на публикацию — YouTube/TikTok от одной сессии теперь получают файл
нужного семейства, если готовый экспорт-вариант есть; попутно закрыт
смежный пробел в `common/blob-paths.ts` — файлы яруса A не входили в
список путей, удаляемых вместе с сессией; фронтенд — `ExportPanel.tsx`
на экране готового ролика, свой опрос статуса, без второго канала в
`useWorkflow`).

Зависимости для параллельной работы:
- Этапы 4–7 взаимно независимы друг от друга — 4–6 зависят от этапа 3
  (работают через `ProductItem`), этап 7 зависит только от этапа 2
  (своя таблица, своя CRUD, можно делать сразу после миграции, не
  дожидаясь Project/ProductItem).
- Этап 9 (фронт манифеста) зависит от этапа 7, не от этапа 8 — можно
  делать в любом порядке относительно фронта экранов 1–5.
- Этапы 11–12 (YouTube) зависят от этапа 3 и этапа 10, но не от 4–7,
  9 — можно вести параллельно с той веткой.
- Этап 14 (фронт персонажей) полноценно готов, только когда сделаны
  9 (список персонажей бренда), 10 (снимок манифеста в Session) и 13
  (Gemini различает персонажей) — самый «сходящийся» этап плана.
