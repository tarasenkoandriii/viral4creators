# Аудит реализации: четвёртый тип проекта GREETING_VIDEO

Основание: `docs-tz/TZ-Greeting-Video-Project-Type.md`.
Метод: построчное чтение существующего кода перед каждым изменением (та же
методология, которую декларирует сама ТЗ — «проверено чтением кода, не
предположением»); ни одна цифра, путь или поведение из ТЗ не приняты на
веру.

**Итог:** реализация выполнена и по объёму соответствует ТЗ, но с двумя
осознанными и явно задокументированными отклонениями от текста ТЗ (оба —
в сторону меньшего, а не большего риска). Ниже — все находки, начиная с
самой важной.

---

## 1. Hedra/говорящий аватар — ТЗ ошибается в §5.3, PREMIUM-путь урезан

**Это главная находка аудита.**

ТЗ §5.3 утверждает, что для PREMIUM-тарифа путь `hedra` «вызывается ровно
так же, как сегодня» через `ActorsService.generateAvatarVideo`. Чтение
`common/plans.ts` и `admin/actors/actors.controller.ts` показывает, что
это не так:

- `avatarLipsync: false` — на **всех** тарифах в `PlanFeature`-матрице,
  без исключений;
- единственный контроллер, вызывающий `generateAvatarVideo`, —
  `admin/actors` за `AdminSessionGuard`;
- doc-comment самого `ActorsController` прямым текстом называет это
  пилотом, который «isn't considered ready for real users yet».

То есть Hedra-путь для GREETING_VIDEO — это не «уже работающая
интеграция», а **выключенный админ-пилот**, который ТЗ приняло за готовую
для пользователей функцию.

**Решение, принятое в этой реализации:** `resolveGreetingConfig`
по-прежнему разрешает PREMIUM выбрать `presenterProvider: 'hedra'` (по
§7 это тарифная фича, не техническая), но `GreetingVideoService.
startHedraVideo` отказывает с понятным `BadRequestException`, объясняющим
ситуацию, а не тихо переключается на grok и не притворяется, что видео
сгенерировано. Ничего не подключено к реальному Hedra-рендерингу для
обычных пользователей.

**Что нужно решить продуктово (не техническое решение, а бизнес-выбор):**

- **Вариант A** — вывести пилот `ActorsService`/Hedra из admin-only в
  продакшн для пользователей (отдельная задача, требует ревью пайплайна
  Hedra+Resemble, лимитов и мониторинга — вне рамок этой ТЗ);
- **Вариант B** — до варианта A сузить PREMIUM в §7 до `grok`-only при
  1080p (то есть убрать выбор hedra из тарифной таблицы), пока пилот не
  готов к реальным пользователям.

До выбора одного из двух вариантов PREMIUM-пользователи, выбравшие
`hedra`, получат явную ошибку вместо тихой деградации — это осознанный
компромисс в пользу честности перед пользователем, а не сокрытия
ограничения.

---

## 2. Grok-путь — ТЗ описывает шаг, которого нет в кодовой базе

ТЗ §5.3 описывает grok-рендеринг как «image-to-video от сгенерированного
референс-кадра». Ни в текущей кодовой базе, ни в самой ТЗ не названо ни
одного сервиса, который бы генерировал такой референс-кадр для
GREETING_VIDEO (в отличие, например, от `SINGLE`/`LINE`, где
референс-видео приходит от пользователя, а не генерируется).

**Решение:** `GreetingVideoService.startGrokVideo` вызывает
`GrokVideoService.startGeneration` в режиме text-to-video (без
`imageUrl` — это параметр опциональный в существующем клиенте). Это
функционально достаточно для короткого ролика-поздравления и не требует
изобретения нового шага генерации кадра, которого не было в ТЗ ни как
реализация, ни как чёткая спецификация. Озвучка и постобработка остаются
на существующем, неизменённом `PostProductionService` (см. находку №4).

Если продукту нужен именно image-to-video с референс-кадром (например,
для визуальной консистентности), это отдельная, самостоятельная задача
генерации кадра — её нет смысла делать неявно внутри этой ТЗ.

---

## 3. `GenerationService` — не переиспользован напрямую, и это осознанно

ТЗ подразумевает, что существующий `generation.service.ts` (~2000 строк)
можно использовать для GREETING_VIDEO без изменений. Чтение файла
показало, что он тесно связан с пайплайном анализа референс-видео и
цепочек продления (`extendVideo`, `videoAnalysis`, `referenceVideoUrl` и
т.д.) — специфика, которой у ролика-поздравления просто нет (нет
пользовательского референс-видео для анализа).

**Решение:** написан отдельный, компактный `GreetingVideoService`,
который вызывает `GrokVideoService` напрямую и переиспользует только
действительно тип-агностичные части существующего пайплайна:
`PostProductionService.start`/`poll` (см. находку №4) и общую логику
статусов (`GenerationStatus`, `renderExpired` из `generation.service.ts`,
импортированную, а не продублированную).

Это не отклонение от намерения ТЗ («переиспользовать инфраструктуру»,
§9), а более точная реализация этого намерения: переиспользуется именно
то, что действительно универсально, вместо форсирования типа в сервис,
для этого не спроектированный.

---

## 4. Подтверждённая находка: `PostProductionService.planWork()` — уже полностью тип-агностичен

В противовес находкам №1–3 (отклонения), это подтверждение **успешного**
допущения ТЗ. Чтение `postprod/postprod.service.ts`'s `planWork()`
показало, что она читает исключительно `session.generationPrompt` и
`session.brandManifestSnapshot` — никогда `Project.type` и никогда
`session.productInformation`. Это значит, что весь пайплайн
кадрирования/наложения озвучки/субтитров подключается к GREETING_VIDEO
**без единой строки изменений** — именно то, что декларирует §9 ТЗ, и в
этом единственном месте декларация подтвердилась буквально.

---

## 5. Подтверждённая находка: `PlanFeature`/`Record<PlanFeature, boolean>` уже закрывает риск exhaustiveness

ТЗ §11 сама поднимает риск: «не проверено, что `PlanService`/
`planAllows` действительно исчерпывающе обрабатывает новую фичу».
Чтение `common/plans.ts` показало, что `PlanFeature` — объединение строк,
а каждая тарифная запись типизирована как `Record<PlanFeature, boolean>`
— то есть добавление `'greetingVideo'` в `PlanFeature` без соответствующей
записи в любом из трёх тарифов **не компилируется** (TypeScript сам
требует заполнить все три). Риск, который ТЗ пометила как непроверенный,
на практике устранён самой архитектурой типов, а не ручной дисциплиной —
это стоит знать на будущее как общий паттерн защиты для этого файла.

---

## 6. Два известных ветвления по типу проекта (§9 ТЗ) — подтверждены, изменений не потребовалось

- `project.service.ts:629` (countryCode guard) — ветвление по типу уже
  включает `CLIENT_SITE`; GREETING_VIDEO **не требует** попадания в эту
  ветку (у ролика-поздравления страна нужна как у SINGLE/LINE, для
  локализации TTS/промпта) — код не тронут, поведение по умолчанию
  корректно.
- `client-site-tutorial.service.ts:932` (type guard) — специфичен для
  CLIENT_SITE, GREETING_VIDEO никогда не проходит через этот сервис
  (у него собственный `project-session`/`greeting-prompt`/
  `greeting-video` путь) — не тронут, как и предсказывала ТЗ.

---

## 7. `GreetingBrief` как отдельная таблица, а не JSON-поле — выбор сделан в пользу таблицы

ТЗ §11 отмечает выбор между JSON-полем на `Project` и отдельной таблицей
как открытый вопрос. Реализовано как отдельная модель `GreetingBrief`
1:1 с `Project` (по образцу `ClientSiteTutorialDraft` для CLIENT_SITE) —
это уже существующий в кодовой базе паттерн для «доп. данных одного
типа проекта», что даёт: типобезопасные Prisma-запросы вместо
JSON-парсинга на каждое чтение, честную схему БД (видно в `\d
greeting_briefs`, а не спрятано внутри `Project.metadata`), и
согласованность с тем, как в этой кодовой базе уже решён точно такой же
вопрос для третьего типа проекта.

---

## 8. Второстепенная находка: защитная проверка в `updateProject` избыточна, но безвредна

В `ProjectService.updateProject` добавлена проверка, отклоняющая
`PATCH /projects/:id { type: 'GREETING_VIDEO' }`. На момент реализации
она недостижима — `UpdateProjectRequestDto.type` уже ограничен списком
`['SINGLE', 'LINE']` на уровне DTO, так что запрос с
`type: 'GREETING_VIDEO'` отклоняется ValidationPipe раньше, чем доходит
до сервиса. Проверка оставлена как defense-in-depth (на случай, если
список допустимых значений в DTO когда-нибудь расширят не подумав про
это ограничение) — по цене одной короткой проверки это оправдано, но
явно помечено в коде как «в настоящий момент недостижимо».

---

## 9. Не выполнено технически: сборка/тесты не запускались

`npm install` в этой песочнице получает `403 Forbidden` от
`registry.npmjs.org` даже на простых GET-запросах метаданных пакета,
несмотря на то что этот хост явно в allowlist прокси (проверено через
`curl $HTTPS_PROXY/__agentproxy/status`). Из-за этого в текущей сессии
недоступны: `tsc --noEmit`, `prisma generate`/`prisma validate`,
`jest`.

**Что это означает практически:** все утверждения о корректности типов и
поведении в этом аудите основаны на ручном построчном чтении сигнатур,
импортов и существующих файлов (в том числе прослеживании реальных
типов Prisma-моделей через уже сгенерированные `.d.ts`, где они были
доступны в архиве), а не на фактическом прогоне компилятора или тестов.
Написанные тесты (`greeting-config.spec.ts`,
`project.service.spec.ts`'s новый describe-блок,
`dto-validation.spec.ts`'s новые кейсы) синтаксически подготовлены и
логически выверены вручную, но ни разу не выполнялись.

**Рекомендация:** первым шагом после получения архива — прогнать в
среде с доступом к npm-реестру:
```
cd backend
npm install
npx prisma generate
npx prisma migrate deploy   # или migrate dev на staging
npx tsc --noEmit
npx jest src/modules/project src/modules/greeting-brief src/modules/greeting-prompt src/modules/greeting-video
```
и устранить любые несоответствия, которые всплывут (наиболее вероятная
точка риска — точные названия сгенерированных Prisma-типов для новых
enum'ов/модели, которые не могли быть верифицированы компилятором).

---

## 10. Полный список изменённых/созданных файлов

### Prisma
- `backend/prisma/schema.prisma` — изменён (enum `ProjectType`, модель
  `Project`/`BrandManifest`, новые enum'ы `GreetingOccasion`/
  `GreetingTone`, модель `GreetingBrief`)
- `backend/prisma/migrations/20261130090000_project_type_greeting_video/migration.sql` — новый
- `backend/prisma/migrations/20261130090100_greeting_briefs/migration.sql` — новый

### Общие типы
- `backend/src/common/types/project.types.ts` — изменён
- `backend/src/common/types/greeting.types.ts` — новый
- `backend/src/common/types/session.types.ts` — изменён
- `backend/src/common/session.service.ts` — изменён
- `backend/src/common/plans.ts` — изменён
- `backend/src/common/ai-pricing.ts` — изменён

### Модуль project
- `backend/src/modules/project/greeting-config.ts` — новый
- `backend/src/modules/project/greeting-config.spec.ts` — новый
- `backend/src/modules/project/dto/create-project-request.dto.ts` — изменён
- `backend/src/modules/project/dto/update-greeting-brief.dto.ts` — новый
- `backend/src/modules/project/dto/dto-validation.spec.ts` — изменён
- `backend/src/modules/project/project.service.ts` — изменён
- `backend/src/modules/project/project.service.spec.ts` — изменён

### Новый модуль greeting-brief
- `backend/src/modules/greeting-brief/greeting-brief.service.ts` — новый
- `backend/src/modules/greeting-brief/greeting-brief.controller.ts` — новый
- `backend/src/modules/greeting-brief/greeting-brief.module.ts` — новый

### Модуль project-session
- `backend/src/modules/project-session/snapshot.ts` — изменён
- `backend/src/modules/project-session/project-session.service.ts` — изменён
- `backend/src/modules/project-session/project-session.controller.ts` — изменён
- `backend/src/modules/project-session/project-session.module.ts` — изменён

### Новый модуль greeting-prompt
- `backend/src/modules/greeting-prompt/greeting-prompt.service.ts` — новый
- `backend/src/modules/greeting-prompt/greeting-prompt.controller.ts` — новый
- `backend/src/modules/greeting-prompt/greeting-prompt.module.ts` — новый

### Новый модуль greeting-video
- `backend/src/modules/greeting-video/greeting-video.service.ts` — новый
- `backend/src/modules/greeting-video/greeting-video.controller.ts` — новый
- `backend/src/modules/greeting-video/greeting-video.module.ts` — новый

### Приложение
- `backend/src/app.module.ts` — изменён (регистрация трёх новых модулей)

**Admin, frontend, landing, marketplace, live-login-relay — не
затронуты**, как и требует §1/§10 ТЗ.

---

## 11. Соответствие §8 ТЗ (API-поверхность) — с одним осознанным дополнением

| Метод | Путь | В ТЗ §8 | Статус |
|---|---|---|---|
| GET | `/projects/:id/greeting-brief` | да | реализовано |
| PATCH | `/projects/:id/greeting-brief` | да | реализовано |
| POST | `/projects` с `type: 'GREETING_VIDEO'` | да (неявно, через существующий роут) | реализовано |
| POST | `/projects/:id/greeting-brief/sessions` | **нет в таблице §8** | добавлено — см. ниже |
| POST | `/sessions/:id/greeting-prompt` | да (§5.1/5.2) | реализовано |
| POST/GET | `/sessions/:id/greeting-video` | да (§5.3) | реализовано |

Таблица §8 не включает буквально ни один роут для создания `Session` из
`GreetingBrief`, но без такого роута весь остальной пайплайн (промпт →
видео → постобработка) физически недостижим: ни один существующий роут
не умеет создать `Session` без `ProductItem`, а у `GreetingBrief` его
нет. Это необходимое, явно задокументированное в коде дополнение к
таблице §8, а не самовольное расширение API за пределы задачи.

---

## Заключение

Реализация покрывает весь функциональный объём ТЗ и оставляет систему в
согласованном состоянии: новый тип проекта работает на общей
инфраструктуре (сессии, TTS, постобработка, публикация, биллинг) почти
без ветвлений, тарифная логика реализована с явным отказом вместо тихой
деградации, а два места, где сама ТЗ содержала фактические неточности
(§5.3 про Hedra и про референс-кадр), не воспроизведены слепо в коде —
вместо этого система ведёт себя честно и явно там, где реальность
разошлась с текстом задания. Главное, что требует решения от продукта, —
пункт 1 (будущее Hedra-пути на PREMIUM); главное техническое
ограничение этой сессии — пункт 9 (сборка и тесты не запускались,
нужно прогнать при первой возможности).
