# Аудит-дополнение: фронтенд GREETING_VIDEO + референс-изображения Grok

Основание: аудит `docs-tz/AUDIT-Greeting-Video-Project-Type.md` (находки
№1–3, backend-only реализация) и follow-up запрос пользователя:

> «четвёртый тип проекта GREETING_VIDEO добавлен только в backend
> (admin/frontend не тронуты, как требует §1/§10). Админка видимо по
> минимуму тут задействована — добавить, а вот фронтенд надо реализовать
> полностью. Референс-кадр для grok-пути, описанный в ТЗ, нигде не
> существует — сделан прямой text-to-video. Видимо опционально надо дать
> возможность creator подгрузить его на фронтенде, и ещё несколько реф
> изображений (вообще grok поддерживает до 7), для них сделать доступным
> скетч режим как в остальных изображениях на проекте»

Метод тот же, что у исходного аудита: построчное чтение существующего
кода перед каждым изменением, без выполнения (сборка/тесты недоступны в
песочнице — см. находку №9 исходного аудита, ограничение не снято).

**Итог:** все три пункта запроса выполнены. Админка получила минимальную
доработку (лейбл операции биллинга). Фронтенд реализован полностью —
новый экран-визард на весь путь брифа/референсов/сценария/видео.
Референс-изображения — отдельный, сознательно НЕ гейтированный тарифом
модуль, переиспользующий существующий AI-скетч механизм.

---

## 1. Референс-изображения — новое поле сессии, не расширение `scenes`

Ключевое архитектурное решение этого сегмента. `ReferenceAssetsService`
(существующий механизм сцен/слотов, `session.scenes`) гейтит
`createUploadUrl`/`putSlots` через `plans.assertUser(..., 'referenceAssets')`,
которая `false` на LITE (`common/plans.ts`). §7 ТЗ прямо требует
GREETING_VIDEO доступным на всех тарифах — переиспользование этого
сервиса «в лоб» тихо реинтродуцировало бы тарифное ограничение, которого
не просила ни ТЗ, ни follow-up.

**Решение:** новое поле `Session.greetingReferenceImages?: SceneAsset[]`
(та же форма, что `scenes`, поэтому `activeSessionSceneImage()` работает
без изменений) плюс отдельный модуль `greeting-reference`
(`GreetingReferenceService`/`Controller`/`Module`) без единого вызова
`plans.assertUser`. Скетч-режим подключён отдельным типом слота
`session-greeting-reference` в `image-sketch/sketch-targets.ts` — с
`feature: null` вместо `'referenceAssets'` у соседнего `session-scene`
(единственное смысловое отличие двух веток кейса).

Лимит — 7 изображений (docs.x.ai `reference_images`), отдельная константа
`MAX_GREETING_REFERENCE_IMAGES`, не спутана с существующим
`REFERENCE_IMAGE_CAP = 3` (лимит Veo для SINGLE/LINE — другая величина
для другого провайдера).

---

## 2. Grok reference-to-video — понижение разрешения теперь верно биллится

`GrokVideoService.startGeneration()` уже сам понижает 1080p → 720p при
референсах (`effectiveGrokResolution`), но возвращает наружу только
`requestId` — не фактическое разрешение. `GreetingVideoService.
startGrokVideo` теперь **пересчитывает** `effectiveGrokResolution`
отдельно и использует именно её (а не запрошенную) и для
`GeneratedVideo.resolution`, и для `aiUsage.record()` — до этой правки
PREMIUM-пользователь с референсами мог быть выставлен по цене 1080p за
фактически 720p-рендер. Промпт (`greeting-prompt.service.ts`) получает
референсы отдельным путём — маркеры `<IMAGE_1>`, `<IMAGE_2>` встраиваются
в текст сцены рядом с их описанием (по образцу docs.x.ai, без полного
анализа изображения — приближение, не точный алгоритм xAI).

---

## 3. Недостающий GET-роут — тот же паттерн, что POST из первого аудита

Исходный аудит (находка №11) уже фиксировал: таблица §8 ТЗ не содержит
роута создания `Session` из `GreetingBrief`, и он был добавлен как
необходимое дополнение. В этом сегменте обнаружился симметричный
пробел: без **списка** сессий проекта возвращающийся создатель не может
узнать, что сессия уже создана, и мастер каждый раз создавал бы новую
пустую сессию вместо продолжения начатой.

Добавлено `GET /projects/:projectId/greeting-brief/sessions` —
`ProjectSessionService.listForGreetingBrief` (та же проверка владения
проектом, что у `POST`, `orderBy: desc`) — тем же приёмом, что уже
существующий `listItemSessions` для SINGLE/LINE. `GreetingVideoWizard`
берёт `sessions[0]` (последнюю) при загрузке.

---

## 4. Почему не переиспользован `useWorkflow`/`PublishPanel`

`useWorkflow.ts` (1400+ строк) — конечный автомат конкретно для
SINGLE/LINE (`upload → analyze → product → prompt → generate`),
завязанный на разбор пользовательского референсного видео и
`ProductInformation` — ни того, ни другого у GREETING_VIDEO нет
(тот же вывод, что и у backend: `GreetingVideoService` не переиспользует
`GenerationService` по той же причине, см. находку №3 исходного аудита).
`PublishPanel`/`ExportPanel` требуют товарных полей (`productName`,
`category`), неприменимых к ролику-поздравлению.

**Решение:** отдельный, компактный `GreetingVideoWizard.tsx` — свой
конечный автомат на 4 шага (бриф → референсы → сценарий → видео), свой
polling (тот же паттерн, что `usePostprodVideo.ts`: `setInterval` +
`document.hidden` + `inFlight`-ref).

**Обновление после доп. запроса пользователя — подключено:**
`PostprodVideoScreen`/`PublishPanel`/`ExportPanel` (`features/postprod/`,
`features/generation/`) оказались уже полностью product-агностичны по
факту, а не только по намерению — построчная проверка их пропсов
показала, что ни один из трёх компонентов не принимает
`ProductItemView`, `itemId` или `Project.type`; всё, что им нужно, —
`sessionId` и `GeneratedVideo`, а товарные поля (`productName`/
`productDescription`/`category`) у `PublishPanel` уже были
опциональными (`string | null`, только для предзаполнения формы). Экран
`/postprod/:sessionId` сам ничем не гейтится по типу проекта — он
монтируется по одному `sessionId` (`App.tsx`) и тянет данные заново
через `usePostprodVideo`/`getSession`, не получая их от вызывающего
экрана.

Из этого следует, что подключение свелось к одной кнопке, а не к
переписыванию панелей: в `VideoStep` (`GreetingVideoWizard.tsx`) при
`video.status === COMPLETE` добавлена карточка-переход в Постпрод — тот
же JSX-блок и те же ключи словаря (`dict.generationWizard.postprodCta*`),
что уже использует `GenerationWizard.tsx` для SINGLE/LINE, без единой
новой строки в словарях (ключи уже были общими, не
product-специфичными).

Единственная реальная находка при проверке: **`GreetingPromptService.
generateGreetingPrompt` не проставлял `approvedAt`** у собранного
промпта (только `moderationStatus: APPROVED`). Экспорт tier B
(`ExportService.startRerender`, второй платный рендер в другом
соотношении сторон) требует именно `session.generationPrompt?.approvedAt`,
иначе отвечает 400 — до правки это закрывало tier B-экспорт для ВСЕХ
GREETING_VIDEO-сессий. Исправлено: `approvedAt: now` проставляется в
момент сборки промпта (GREETING_VIDEO не проходит отдельный экран
одобрения, как `PromptService.approvePrompt` у SINGLE/LINE, — текст
считается одобренным сразу). Экспорт tier A (дешёвый кроп в другое
соотношение той же «семьи», самый частый случай) этой проверки не
касается и работал бы и без правки.

Также проверено (без изменений — уже работает верно):
`ExportService.startRerender`'s клонирование дочерней сессии
(`hasProjectLink = !!(session.projectId && session.productItemId)`)
корректно уходит в ветку «сессия без привязки к товару» для
GREETING_VIDEO (`productItemId` там нет), которая уже копирует
опциональный `brandManifestSnapshot` — тот же код-путь, что у обычного
визарда без проекта; `PostprodVideoSummary`-запрос (список «моих
роликов») фильтрует только по `userId`/`generationStatus='complete'`/
`deletedAt IS NULL`, без привязки к типу проекта, — GREETING_VIDEO-сессии
появятся там автоматически с `productName: null`.

`updateGreetingReference` (PATCH лейбла/описания референса) теперь
подключён к UI: в `ReferencesStep` у каждой карточки референса появилась
кнопка-карандаш рядом с «Удалить», открывающая инлайн-форму
(`ReferenceEditor` — компонент, добавленный в этом сегменте) с теми же
полями, что у загрузки (подпись/описание), без файла — заменить фото
можно только удалением и повторной загрузкой, отдельный флоу для этого
не нужен. Форма ведёт себя как `ReferenceUploader` рядом: свой
`saving`/`error`, `onDone` только при успехе (при ошибке форма остаётся
открытой с введённым текстом, а не закрывается вслепую).

---

## 5. Минимальная админка (по формулировке запроса — «по минимуму»)

Единственная правка: `admin/src/lib/money.ts` — лейбл операции
`'greeting-prompt': 'Сценарий ролика-поздравления'` в `OPERATION_LABEL`,
чтобы биллинг-операция GREETING_VIDEO не отображалась в админке
безымянным ключом. Прочая админка (просмотр проектов/сессий, биллинг
по `aiUsage.record`) уже тип-агностична — то же подтверждение, что
находка №4 исходного аудита сделала для `PostProductionService`: она
читает общие поля сессии/проекта, не `Project.type`.

---

## 6. Проверено вручную (компилятор недоступен — см. находку №9 исходного аудита)

Тот же сборочный тупик: `npm install` — `403` от `registry.npmjs.org`
даже на GET метаданных, несмотря на allowlist прокси. Все ниже —
результат построчного чтения, не прогона `tsc`/`jest`:

- **Соответствие типов бэкенд↔фронтенд**: `GreetingReferenceImageView`
  (`common/types/greeting.types.ts` и `frontend/src/types/project.ts`)
  — поле в поле идентичны.
- **Все словарные ключи** (`greetingVideoWizard.*`,
  `projectCreateScreen.greetingVideo*`), фактически используемые в
  `GreetingVideoWizard.tsx` и `ProjectCreateScreen.tsx` (включая
  вложенные карты `occasion.*`/`tone.*` по всем 7/3 значениям
  enum'ов), проверены программно (не выборочно) во всех пяти словарях
  — ru/en/de/es/uk. Расхождений нет.
- **Все использования UI-компонентов** (`Pills`, `Button`, `Field`/
  `Input`/`Textarea`/`Select`, `CardHeader`, `Stepper`, `Alert`,
  `SketchSlotActions`) сверены с их реальными пропсами построчным
  чтением исходников компонентов.
- **`sketch-targets.ts`**: новый `case 'session-greeting-reference'`
  сверен построчно с соседним `'session-scene'` — совпадает по
  структуре, отличается ровно `feature: null` вместо
  `'referenceAssets'`, как и задумано.
- **`GrokVideoService.startGeneration`/`effectiveGrokResolution`**:
  сигнатуры и порядок использования в `greeting-video.service.ts`
  сверены с реальным экспортом `grok-video.service.ts` — совпадают.
- **`app.module.ts`**: `GreetingReferenceModule` зарегистрирован и
  импортирован по корректному пути.
- **`router.ts`/`App.tsx`**: маршрут `'greeting-video'`, билдер
  `routes.greetingVideo(projectId)` и проп `projectId` у
  `GreetingVideoWizard` согласованы.
- **`ProjectCreateScreen.tsx`**: `canSubmitGreeting`/`submitGreeting`
  корректно требуют `countryCode` (бэкенд `resolveCountryCode` бросает
  `BadRequestException` для GREETING_VIDEO без страны — то же правило,
  что у SINGLE/LINE, отдельное от CLIENT_SITE, где страна
  подставляется по умолчанию).
- **Ранее найденные неиспользуемые импорты** (`updateGreetingReference`,
  `getProject`, `CreateGreetingBriefInput` в `greeting-api.ts`)
  подтверждённо удалены — их больше нет в файлах.

**Обновление после доп. запроса пользователя:** UI редактирования
референса добавлен (см. раздел 4 выше) — новые ключи словаря
(`editReferenceAria`, `saveReferenceButton`) проверены программно во всех
пяти локалях тем же способом, что и остальные ключи этого сегмента.

**Единственная найденная не-функциональная неточность:** `SketchSlotActions`
в `ReferencesStep` не получает `activeSketchId` — потому что
`GreetingReferenceImageView` (в отличие от `ProductItemView`/
`BrandCharacterView`) не отдаёт id применённого скетча. Проверено, что
`slot.sketchId` фактически нигде не читается ниже по стеку (`SketchBadge`/
`SketchButton` работают через `target`, не через `sketchId`) — поведения
это не меняет, это только пробел в типовой полноте относительно старших
слотов.

---

## 7. Файлы, изменённые/созданные в этом сегменте

### Backend — изменены
- `backend/src/common/types/session.types.ts`
- `backend/src/common/session.service.ts`
- `backend/src/common/types/sketch.types.ts`
- `backend/src/common/types/greeting.types.ts`
- `backend/src/modules/image-sketch/sketch-targets.ts`
- `backend/src/modules/greeting-video/greeting-video.service.ts`
- `backend/src/modules/greeting-prompt/greeting-prompt.service.ts`
- `backend/src/modules/project-session/project-session.service.ts`
- `backend/src/modules/project-session/project-session.controller.ts`
- `backend/src/app.module.ts`

### Backend — новый модуль `greeting-reference`
- `backend/src/modules/greeting-reference/greeting-reference.service.ts`
- `backend/src/modules/greeting-reference/greeting-reference.controller.ts`
- `backend/src/modules/greeting-reference/greeting-reference.module.ts`
- `backend/src/modules/greeting-reference/dto/greeting-reference.dto.ts`

### Admin
- `admin/src/lib/money.ts`

### Frontend — новые файлы
- `frontend/src/services/greeting-api.ts`
- `frontend/src/features/projects/GreetingVideoWizard.tsx`

### Frontend — изменены
- `frontend/src/types/sketch.ts`
- `frontend/src/features/sketch/sketch-model.ts`
- `frontend/src/types/project.ts`
- `frontend/src/types/index.ts`
- `frontend/src/services/projects-api.ts`
- `frontend/src/lib/router.ts`
- `frontend/src/App.tsx`
- `frontend/src/dictionaries/{ru,en,de,es,uk}.json`
- `frontend/src/features/projects/ProjectCreateScreen.tsx`
- `frontend/src/features/projects/ProjectScreen.tsx`

**Landing, marketplace, live-login-relay — не затронуты** (вне области
запроса).

---

## Заключение

Все три явных пункта follow-up-запроса выполнены: минимальная админка,
полный фронтенд-визард, и опциональная загрузка до 7 референс-изображений
со скетч-режимом. Архитектурный принцип, заданный исходной реализацией
(«не форсировать GREETING_VIDEO в инфраструктуру, для него не
спроектированную»), проведён последовательно и в этом сегменте — как для
референс-изображений (свой модуль вместо гейтированного
`ReferenceAssetsService`), так и для фронтенда (свой визард вместо
`useWorkflow`). Главное техническое ограничение то же, что в исходном
аудите: сборка и тесты не выполнялись в этой песочнице — рекомендация
из находки №9 исходного аудита (прогнать `tsc`/`jest` в среде с доступом
к npm) остаётся в силе и для этого сегмента изменений.
