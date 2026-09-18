# API — все маршруты бэкенда

Полный список того, что реально отдаёт `backend/` (глобальный префикс
`/api`, ответы завёрнуты `ResponseInterceptor` в
`{ success, data, meta }`). Появился на этапе 28 после сквозной сверки:
часть маршрутов не была описана нигде, а один — `GET /api/health` — был
описан в четырёх документах, но не существовал.

**Правило:** новый контроллер → строка в этой таблице. Здесь только
маршруты; смысл и решения — в `doc/PRODUCT-PROJECT-SPEC.md`, рецепты
локальных прогонов — в `doc/LOCAL-DEVELOPMENT.md`.

## Кто может звать

| Доступ | Что означает |
| --- | --- |
| **открыто** | без заголовков; предъявителем выступает UUID сессии (§7.8). С этапа 42 поверх стоит глобальный `SessionOwnerGuard`: если у сессии есть владелец, запрос обязан прийти от него — иначе 403 «Эта сессия принадлежит другому аккаунту». С этапа 49 первый опознанный запрос к ничьей сессии привязывает её к вошедшему (В-3.4) |
| **идентичность** | `TelegramIdentityGuard`: initData из Telegram, cookie обычного логина или `X-Dev-User-Id` при `ALLOW_DEV_AUTH`. Для cookie любой не-GET запрос дополнительно проверяется по `Origin` против `CORS_ORIGIN` (этап 41, `common/csrf.ts`) — 403 «Cross-origin request rejected» |
| **оператор** | `AdminSessionGuard` (cookie админки) + флаг `isOperator` (`assertOperator` первой строкой каждого обработчика) |
| **вход/выход** | маршруты `telegram-login/*` и `admin/auth/*` под `OriginGuard` (этап 49): форма с чужого сайта не может ни посадить посетителя в чужую сессию, ни выкинуть оператора. С этапа 54 входы (`callback`, `dev-login`) и `POST /api/sessions` ещё и под `RateLimitGuard` — 10 (входы) / 30 (сессии) запросов в минуту с одного адреса, счётчик в базе (`rate_limits`); сверх — 429 с `Retry-After` |
| **секрет крона** | заголовок `Authorization: Bearer $CRON_SECRET`, сравнение constant-time. Переменная не задана — 503 на всех десяти маршрутах (этап 54, Б-3.3); открыты без секрета они только на dev-стенде (`ALLOW_DEV_AUTH=true` вне production) |

## Служебные

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `GET /api/health` | открыто | жив ли сервис и видит ли он базу (`status`, `database`, `uptimeSeconds`) |
| `GET /api/reference/countries` | открыто | справочник стран → валюта/язык для формы проекта |

## Сессия и генерация (§1–§5, §15)

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `POST /api/sessions` | открыто | создать сессию (под идентичностью привяжется к пользователю) |
| `GET /api/sessions/:id` | открыто | всё состояние сессии |
| `DELETE /api/sessions/:id` | открыто | удалить свой готовый ролик из «Постпрода» (этап 88.2); с этапа 89 — софт-delete: ставит `deletedAt` (`SessionService.softDeleteSession`, общий метод с `DELETE /api/admin/sessions/:id` ниже — «тот же механизм»), физическая уборка строки и файлов в Blob — фоновым кроном спустя грейс-период (24 ч); 404, если сессии уже нет (в т.ч. уже мягко удалённой) |
| `POST /api/sessions/:id/video/upload-url` | открыто | presigned PUT для файла-референса |
| `POST /api/sessions/:id/video/youtube` | открыто | зарегистрировать ссылку как референс |
| `POST /api/sessions/:id/video/library` | открыто | взять готовый разбор из библиотеки (§21) |
| `POST /api/sessions/:id/analysis` | открыто | запустить разбор (или взять из кеша библиотеки); 409, если разбор уже идёт (замок, ТЗ §30.3) |
| `GET /api/sessions/:id/analysis` | открыто | результат разбора |
| `PATCH /api/sessions/:id/analysis` | открыто | правки текста разбора |
| `POST /api/sessions/:id/analysis/previews/upload-url` | открыто | presigned PUT для кадров-превью (§18.1) |
| `POST /api/sessions/:id/analysis/previews/confirm` | открыто | подтвердить кадры → `previewUrl` в разборе |
| `GET/PUT /api/sessions/:id/analysis/selection` | открыто | снятые сцены и массовка (§19) |
| `GET/PUT /api/sessions/:id/characters` | открыто | кастинг персонажей (§10) |
| `POST /api/sessions/:id/characters/:cid/photo/upload-url` | открыто | фото-замена персонажа |
| `POST /api/sessions/:id/characters/:cid/photo/confirm` | открыто | подтвердить фото-замену |
| `GET /api/sessions/:id/scenes` | открыто | свои сцены сессии (§17) |
| `POST /api/sessions/:id/scenes/upload-url` | открыто | presigned PUT для сцены (минтит `sceneId`) |
| `POST /api/sessions/:id/scenes/confirm` | открыто | подтвердить сцену |
| `PATCH /api/sessions/:id/scenes/:sceneId` | открыто | название/описание сцены |
| `DELETE /api/sessions/:id/scenes/:sceneId` | открыто | удалить сцену (и её файл) |
| `GET/PUT/DELETE /api/sessions/:id/references` | открыто | три слота `referenceImages`; `DELETE` — вернуть авто-правило |
| `GET/POST/PATCH /api/sessions/:id/relevance` | открыто | отчёт о релевантности референса товару (§18.3) |
| `POST /api/sessions/:id/product` | открыто | данные товара для этой сессии |
| `POST /api/sessions/:id/product/image/upload-url` | открыто | presigned PUT для фото товара в сессии; путь в сессию тут НЕ пишется (В-1.8, этап 123 — выдать ссылку и загрузить файл разные события) |
| `POST /api/sessions/:id/product/image/confirm` | открыто | подтвердить загрузку фото: проверяет, что файл реально лежит по этому пути, сверяет путь с префиксом сессии (целиком, а не «начинается с» — иначе `..` уводит в чужую сессию) и только после этого записывает путь и тип в сессию (В-1.8, этап 123) |
| `PATCH /api/sessions/:id/brand-manifest` | открыто | правки копии манифеста для этого ролика (§12) |
| `POST /api/sessions/:id/prompt` | открыто | собрать промпт (GPT-5); 409, если сборка уже идёт (замок, ТЗ §30.3) |
| `PATCH /api/sessions/:id/prompt` | открыто | правки промпта; необязательное поле `voiceoverScript` — текст озвучки (§15.2), не передан — прежний текст сохраняется |
| `POST /api/sessions/:id/prompt/approve` | открыто | утвердить промпт |
| `POST /api/sessions/:id/generate` | открыто | генерация ролика (Veo); повтор при записанном идущем рендере возвращает его же, параллельный запуск в окне старта — 409 (замок, ТЗ §30.3); `quality: 'standard'` — только с признаком пакета `fullQualityVideo` (403 у Lite) |
| `GET /api/sessions/:id/generate` | открыто | статус генерации; здесь же опрашивается обрезка кадра (§16.1) |
| `POST /api/sessions/:id/export` | открыто | этап 75: автоэкспорт под площадки, ярус A — пакетная дешёвая обрезка готового файла под несколько форматов ТОГО ЖЕ семейства кадра, один платёж на весь батч (`doc/MULTI-FORMAT-EXPORT-SPEC.md`) |
| `POST /api/sessions/:id/export/rerender` | открыто | ярус B: второй платный рендер Veo тем же одобренным промптом для формата ИЗ ДРУГОГО семейства кадра — новая дочерняя сессия |
| `GET /api/sessions/:id/export/status` | открыто | статус автоэкспорта, оба яруса |
| `POST /api/sessions/:id/postprod/revoice` | открыто | этап 87: переозвучить уже готовый ролик БЕЗ повторного рендера Veo/Grok — новая дорожка (и субтитры под неё) поверх исходного, ещё не обработанного файла; необязательное `voiceoverScript` — новый текст реплик, голос меняют отдельно через `PATCH .../brand-manifest` |
| `GET /api/postprod/videos` | идентичность | этап 88 (вкладка «Постпрод» в TMA): список ВСЕХ готовых роликов текущего пользователя (`page`/`pageSize`, ответ `{items,total,page,pageSize}`); каждая строка помечена `canRevoice` — доступна ли переозвучка (голос не `'veo'`) — сам список не фильтруется по ней, экспорт/публикация/шаринг применимы к любому готовому ролику |
| `GET/POST /api/sessions/:id/audit` | открыто | аудит готового ролика на артефакты (§11) |
| `POST /api/sessions/:id/audit/apply` | открыто | положить предложенный промпт в черновик |
| `GET/POST /api/sessions/:id/sound-check` | открыто | этап 73: звучит ли озвучка Veo-ролика как живой человек, а не TTS — отдельно от аудита артефактов |
| `GET/POST /api/sessions/:id/publications` | идентичность | заявки на публикацию (§8) |
| `DELETE /api/sessions/:id/publications/:requestId` | идентичность | отозвать заявку |
| `GET/POST /api/sessions/:id/shared-video` | идентичность | публичная страница ролика (§40): список заявок / создать |
| `DELETE /api/sessions/:id/shared-video/:pageId` | идентичность | отозвать — в ЛЮБОМ статусе (не только «на модерации»), с удалением своей копии видео и фото |

## Проекты, товары, бренд (§6–§7, §12, §17.1)

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `POST/GET /api/projects` | идентичность | создать проект / список |
| `GET/PATCH/DELETE /api/projects/:id` | идентичность | проект; `DELETE` — софт-delete (этап 89): ставит `deletedAt`, физическая уборка строки/фото товаров/файлов — фоновым кроном спустя грейс-период (24 ч), не синхронно в запросе |
| `GET /api/projects/:id/delete-preview` | идентичность | «умный» алерт удаления (этап 89): точные счётчики того, что каскадом уйдёт из БД вместе с проектом — `{items, catalogBatchRuns, abTestRuns, feedImportRuns}`, до самого `DELETE` |
| `POST /api/projects/:id/items` | идентичность | добавить товар |
| `PATCH/DELETE /api/projects/:id/items/:itemId` | идентичность | товар: поля, аудитория (§18.2); `DELETE` — софт-delete (этап 89, тот же приём, что у проекта) |
| `GET /api/projects/:id/items/:itemId/delete-preview` | идентичность | то же самое (см. выше), только для одного товара — `{analogs, catalogBatchItems}` |
| `POST /api/projects/:id/items/:itemId/photo/upload-url` | идентичность | presigned PUT для фото товара |
| `POST /api/projects/:id/items/:itemId/photo/process` | идентичность | распознать категорию/аудиторию + аналоги (SerpApi) |
| `POST /api/projects/:id/items/:itemId/voice/upload-url` | идентичность | presigned PUT для голосового описания |
| `POST /api/projects/:id/items/:itemId/voice/transcribe` | идентичность | расшифровка (Gemini), файл удаляется сразу |
| `POST/GET /api/projects/:id/items/:itemId/sessions` | идентичность | создать сессию из товара (снимок) / её прогоны |
| `POST/GET /api/brand-manifests` | идентичность | манифест бренда: создать / список |
| `GET/PATCH/DELETE /api/brand-manifests/:id` | идентичность | манифест (удаление уносит фото персонажей и сцен) |
| `POST /api/brand-manifests/:id/characters` | идентичность | персонаж бренда |
| `PATCH/DELETE /api/brand-manifests/:id/characters/:cid` | идентичность | правка / удаление персонажа |
| `POST /api/brand-manifests/:id/characters/:cid/photo/upload-url` | идентичность | presigned PUT фото персонажа |
| `POST /api/brand-manifests/:id/characters/:cid/photo/confirm` | идентичность | подтвердить фото персонажа |
| `POST /api/brand-manifests/:id/scenes` | идентичность | постоянная сцена бренда (§17.1) |
| `PATCH/DELETE /api/brand-manifests/:id/scenes/:sid` | идентичность | правка / удаление сцены |
| `POST /api/brand-manifests/:id/scenes/:sid/photo/upload-url` | идентичность | presigned PUT фото сцены |
| `POST /api/brand-manifests/:id/scenes/:sid/photo/confirm` | идентичность | подтвердить фото сцены |
| `GET /api/youtube-search?q=&regionCode=&language=` | идентичность | поиск референса на YouTube (суточный лимит) |
| `POST /api/projects/:id/catalog-batch` | идентичность | пакетная генерация по каталогу (§44, этап 65): перенести уже одобренный разбор+промпт исходной сессии на остальные товары линейки; только Premium (`PlanFeature 'library'`); тело `{ sourceSessionId, productItemIds }`, ответ `{ batchId, itemCount, skipped }` — товары, уже занятые другой активной партией, пропускаются, а не дублируются |
| `GET /api/projects/:id/catalog-batch/:batchId` | идентичность | статус партии: сводка `{pending, generating, done, failed}` + по каждому товару живое состояние его сессии (без записи обратно в `CatalogBatchItem` — рендер отслеживается штатно) |
| `POST /api/projects/:id/ab-test` | идентичность | A/B-варианты одного ролика (§45, этап 66): из уже одобренного ролика исходной сессии собрать 3 дубля с разным хуком и CTA; только Premium (`PlanFeature 'library'`); тело `{ sourceSessionId }`, один синхронный вызов GPT-5 на весь запуск, ответ `{ runId, variantCount }` — `variantCount` может быть меньше 3, если модель вернула не все варианты |
| `GET /api/projects/:id/ab-test/:runId` | идентичность | статус запуска A/B-вариантов: сводка `{pending, generating, done, failed}` + по каждому варианту `hookLabel`/`ctaLabel` и живое состояние его сессии (тот же приём, что у статуса партии — без записи обратно в `AbTestVariant`, рендер отслеживается штатно) |
| `POST /api/projects/:id/feed-imports` | идентичность | товарный фид — импорт каталога по ссылке (§47, этап 68): разовый снимок YML- или CSV-фида; только Premium (`PlanFeature 'library'`), только для LINE-проекта; тело `{ sourceUrl }` — проверяется SSRF-guard'ом ДО создания запуска; ответ `{ runId }` |
| `GET /api/projects/:id/feed-imports` | идентичность | список запусков импорта фида этого проекта — сводки `{status, totalRows, importedCount, skippedCount, failedCount}` без строк |
| `GET /api/projects/:id/feed-imports/:runId` | идентичность | статус одного запуска: та же сводка + все строки фида (`rowIndex`, `title`, `status`, `reason`, `productItemId`) — счётчики читаются как есть из строки запуска, не пересчитываются на каждый опрос |
| `GET /api/projects/:id/site-tutorial` | идентичность | черновик обучалки по САЙТУ ЗАКАЗЧИКА (§5.2 doc/CLIENT-SITE-TUTORIAL-SPEC.md, этап 111) или `null`, если визард ещё не начинали; отдаёт `steps`, `stepsPerRound`, `roundScreenshots`, `status`, `version` и `hasCredentials` — САМИ куки и учётные данные наружу не отдаются никогда, только признак их наличия |
| `POST /api/projects/:id/site-tutorial/explore` | идентичность | первый раунд визарда: тело `{ url }`, адрес проверяется SSRF-guard'ом ДО запуска браузера; `origin` этого адреса фиксируется как доменный замок черновика навсегда (сменить сайт можно только удалив черновик); только Standard+ (`PlanFeature 'siteTutorial'`), только для проекта типа `CLIENT_SITE`; повторный вызов при уже существующем черновике — 409, а не перезапись |
| `POST /api/projects/:id/site-tutorial/step` | идентичность | очередной раунд: тело `{ expectedVersion, fills[], clickSelector? }` — до 20 полей (пустые значения не принимаются: в сценарии пустое значение означает «это было секретное поле») и не более одного клика, всё это ОДИН раунд и РОВНО один кадр предпросмотра (сколько шагов сценария он дописал, видно в `stepsPerRound`); `expectedVersion` — оптимистичная блокировка, и с этапа 117 она занимается ДО того, как браузер что-либо нажмёт: повтор запроса (оборвалась связь, клиент сдался по таймауту) получает 409 «шаг уже выполнялся», а не нажимает кнопку на сайте заказчика второй раз; дневной лимит раундов (`SITE_TUTORIAL_ROUNDS_PER_DAY`) занимается ДО браузера и возвращается, если раунд не состоялся |
| `POST /api/projects/:id/site-tutorial/login` | идентичность | раунд входа на сайт заказчика: тело `{ expectedVersion, submitSelector, fields[{selector, value, sensitive}] }`; значения полей с `sensitive:true` в `steps` НЕ попадают (там остаётся только селектор) — они шифруются `SITE_TUTORIAL_TOKEN_KEY` и лежат в `credentialsEnc` отдельно от сценария |
| `POST /api/projects/:id/site-tutorial/undo` | идентичность | отменить последний РАУНД (тело `{ expectedVersion }`), а не последний шаг: из хвоста `steps` уходит `stepsPerRound.at(-1)` элементов — раунд из трёх полей и кнопки снимается целиком. Оставшиеся шаги переигрываются в браузере С НУЛЯ, от первого `goto` (куки хранятся одним «последним слепком», вернуться на раунд назад нечем — §14 п.6), поэтому вызов тратит слот суточного лимита как обычный раунд; свежий кадр ЗАМЕЩАЕТ последний оставшийся. 409 на первом раунде и на черновике, где был живой вход — капчу переиграть нечем |
| `POST /api/projects/:id/site-tutorial/finish` | идентичность | завершить запись: тело `{ expectedVersion, title }`, кадры НЕ присылаются (сервер снял их сам на каждом раунде — §15 п.1). Заливает `roundScreenshots` в Blob под `tutorial-video-frames/{draftId}/{n}.jpg`, предварительно СТЕРЕВ этот префикс целиком (иначе повторный `/finish` короче прошлого оставил бы хвостовые файлы навсегда — §15 п.4), пишет `previewFrameCount` и замораживает черновик в `PENDING_REVIEW`. Сборку видео НЕ запускает — это делает одобрение оператора: залить готовые JPEG дёшево, собрать ролик через внешний ffmpeg-api дорого (§14 п.2) |
| `POST /api/projects/:id/site-tutorial/live-login/start` | идентичность | живой вход (§7.4 doc/CLIENT-SITE-TUTORIAL-SPEC.md, этап 114) — единственный способ пройти капчу, одноразовый код и вход через чужой SSO: их содержимое узнаётся только в моменте и требует живого человека. Поднимает сессию в отдельном сервисе `live-login-relay` и отдаёт `{ sessionId, streamToken, relayWsUrl, ticket }`; браузер пользователя соединяется с реле НАПРЯМУЮ по `relayWsUrl` — видеопоток через serverless-функцию не имеет смысла ни по архитектуре, ни по биллингу. Отдельный дневной лимит (`SITE_TUTORIAL_LIVE_SESSIONS_PER_DAY`), 503 при ненастроенном реле |
| `POST /api/sketches` · `GET /api/sketches` · `GET /api/sketches/quota` · `POST /api/sketches/:id/apply` · `POST /api/sketches/revert` · `POST /api/sketches/delete-original` | идентичность | ИИ-скетч вместо изображения (doc/AI-SKETCH-SPEC.md): стилизованная версия персонажа, товара или сцены, которая ПОДМЕНЯЕТ оригинал во всём, что уходит наружу — референсы и первый кадр Veo/Grok, аватар Hedra, публичные страницы. Путь к файлу берётся из самого слота, клиент его не присылает. Квоты по тарифу (`common/image-generation-quota.ts`, общие с превью персонажа): 429 с `quota` и `upgrade` в `error.details` конверта; 409 с `error.details.reason` (`source-changed` \| `already-applied` \| `sketch-gone`); отказ модели — 422; сбой провайдера — 502 и квота не тратится. `delete-original` отвечает `{slot, updatedRefs, fileDeleted}`: `fileDeleted: false` — файл был общим (фото товара проекта) и остался у владельца, снята только ссылка |
| `POST /api/projects/:id/site-tutorial/live-login/complete` | идентичность | тело `{ ticket, expectedVersion }` — ЗАШИФРОВАННАЯ квитанция со старта, а не `sessionId`: тот пришёл бы от клиента, и подставив чужой, сосед записал бы чужую живую сессию в свой черновик. Забирает у реле весь cookie jar (все домены, включая SSO-провайдера) и `finalUrl`, проверяет, что сессия закончилась на сайте заказчика (успешный ответ реле НЕ означает, что человек довёл вход до конца — куки снимаются и по таймауту), шифрует куки, дописывает МАРКЕРНЫЙ шаг `assertVisible` и `requiresLiveLoginReplay: true` — воспроизвести интерактивно пройденную капчу нельзя, и записывать «нажми сюда» было бы враньём. Тут же выполняет обычный раунд поверх добытой сессии и отвечает тем же `{ draft, exploration }`, что `/step` |
| `POST /api/projects/:id/site-tutorial/refresh` | идентичность | свежий снимок ТЕКУЩЕЙ страницы черновика, без записи чего-либо (этап 115): визард живёт кадром, а кадр приходит только ответом на раунд — после перезагрузки вкладки продолжить запись было бы нечем. Отдельный вызов, а не часть `GET`, потому что снять снимок значит поднять Chromium: чтение состояния осталось дешёвым, а снимок честно тратит слот суточного лимита. Ни шага, ни кадра, ни версии не пишет — иначе перезагрузка вкладки дописывала бы в сценарий пустые шаги |
| `POST /api/projects/:id/site-tutorial/resume` | идентичность | вернуть в работу черновик, отклонённый оператором (`REJECTED` → `DRAFTING`, причина отклонения очищается); любой другой статус — 409: редактировать можно только `DRAFTING`, иначе правки молча разошлись бы с тем, что видел оператор |
| `DELETE /api/projects/:id/site-tutorial` | идентичность | удалить черновик целиком, 204 — единственный способ сменить сайт или переиграть сценарий, в котором уже был живой вход |

Раунды визарда (`/explore`, `/step`, `/login`) отвечают
`{ draft, exploration }`, где `exploration` — §5.4: `currentUrl`,
`screenshotDataUrl` (`data:image/jpeg;base64,…`, не Blob-ссылка — §6.3),
`elements[]` и `looksLikeLogin`. У `<select>` в элементе приходят
`options[]` — `fill` сопоставляет строку со ЗНАЧЕНИЕМ опции, а не с
надписью, и без списка вариантов заполнить его было бы нечем. У каждого
элемента может стоять
`danger` — предупреждение стоп-листа §8.3 по видимому тексту кнопки
(«Оплатить», «Удалить»); оно приходит РАНЬШЕ, чем пользователь выберет
кнопку, поэтому «вы уверены?» успевает спроситься до того, как шаг
выполнится на настоящем сайте. Сервер при этом ничего не блокирует. Если
раунд нажал такую кнопку, тот же текст возвращается в
`exploration.dangerWarning` — для оператора при модерации. Отдельный
код ответа: **503**, если headless-браузер не поднялся (внешняя
инфраструктура, не ошибка запроса) — слот суточного лимита при этом
возвращается, раунд не засчитывается.

`GET /site-tutorial` дополнительно несёт `liveLoginAvailable: boolean` —
явный канал мягкой деградации (§15.8 контракта реле): фронтенд прячет
кнопку живого входа по этому признаку, а не догадывается по тексту
ошибки после нажатия.

## Библиотека разборов (§21)

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `GET /api/library/recommend?sessionId=&limit=` | открыто | рекомендации под товар сессии (публичные + свои приватные) |
| `GET /api/library/:entryId` | открыто | одна запись (только признаки, без самого разбора) |
| `GET /api/admin/library` | оператор | список с фильтрами `visibility`, `sourceType`, `q`, пагинацией |
| `GET /api/admin/library/:id` | оператор | запись целиком, включая разбор |
| `PATCH /api/admin/library/:id` | оператор | видимость (причина обязательна при скрытии) и категория |
| `DELETE /api/admin/library/:id` | оператор | удалить запись и её копии кадров |

## Публичная страница ролика (ТЗ §40, TODO §III.1, этап 60)

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `GET /api/shared-video/:id` | открыто | снимок страницы (только `PUBLISHED`) — читает `landing/src/app/video/[id]/page.tsx`; бампит `viewCount` |
| `POST /api/shared-video/:id/fork` | открыто, БЕЗ идентичности и без гейта тарифа | «Сделать такой же»: новая анонимная сессия; если у страницы есть привязка к записи библиотеки и она видна (§21) — разбор подставляется в новую сессию |

## Каналы выгрузки (ТЗ §14.2/14.4, этап 61)

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `POST /api/channels/oauth/:platform/start` | идентичность | обычный POST (не голая ссылка — identity едет заголовками, не cookie), возвращает `{ url }`, дальнейший редирект на площадку делает сам браузер |
| `GET /api/channels/oauth/:platform/callback?code=&state=` | открыто (дёргает сам Google/TikTok) | завершает OAuth, `userId` — из подписанного `state`; отдаёт HTML-страницу с редиректом обратно в TMA (`TMA_PUBLIC_URL`) |
| `GET /api/channels` | идентичность | подключённые каналы текущего пользователя |
| `DELETE /api/channels/:id` | идентичность, только свой канал | отключить (best-effort отзыв гранта у площадки) |

## Оплата: Telegram Stars и WayForPay (ТЗ §41, TODO §III.3, этап 62)

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `GET /api/billing/prices` | открыто | цены подписок и пакетов кредитов (XTR и минорные единицы WayForPay) — публичная, читается и анонимно |
| `POST /api/billing/checkout/subscription` | идентичность | `{ plan: 'STANDARD'\|'PREMIUM', method: 'STARS'\|'WAYFORPAY' }` → `{ starsInvoiceUrl }` либо `{ wayforpayFormUrl, wayforpayFields }` (подписанные поля POST-формы, не голая ссылка) |
| `POST /api/billing/checkout/credit-pack` | идентичность | `{ packId, method }` → та же форма ответа, что у подписки |
| `POST /api/billing/webhook/telegram` | открыто, секрет в заголовке `X-Telegram-Bot-Api-Secret-Token` (`TELEGRAM_WEBHOOK_SECRET`) | `pre_checkout_query`/`successful_payment` из тела Telegram Update; идемпотентность — `@@unique([method, providerRef])` на `Payment`, `providerRef = telegram_payment_charge_id` |
| `POST /api/billing/webhook/wayforpay` | открыто, подпись `merchantSignature` в теле | приём результата оплаты/регулярного платежа; обязан ответить строгой квитанцией `{orderReference, status:'accept', time, signature}` — иначе WayForPay повторяет доставку |

## Блог (ТЗ §36, TODO §II.3–II.4, этап 57)

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `GET /api/blog?locale=&category=&page=&pageSize=` | открыто | список опубликованных записей; без `locale` — оригинальный язык |
| `GET /api/blog/:slug?locale=` | открыто | одна запись; `isRequestedLocale: false`, если готового перевода на запрошенную локаль ещё нет (отдаётся оригинал, честно помеченный) |
| `GET /api/admin/blog?status=&category=&page=&pageSize=` | оператор | список с фильтрами, включая черновики |
| `GET /api/admin/blog/:id` | оператор | запись целиком + статус каждого перевода |
| `POST /api/admin/blog` | оператор | ручная запись (новости, кейсы, обновления продукта — тот же экран, TODO §II.3) |
| `PATCH /api/admin/blog/:id` | оператор | правка текста; сбрасывает READY/QUEUED-переводы на PENDING |
| `POST /api/admin/blog/:id/approve` | оператор | DRAFT → APPROVED |
| `POST /api/admin/blog/:id/reject` | оператор | → REJECTED; `{ reason }` обязателен |
| `POST /api/admin/blog/:id/publish` | оператор | APPROVED → PUBLISHED |
| `POST /api/admin/blog/:id/unpublish` | оператор | PUBLISHED → APPROVED, без отклонения |
| `DELETE /api/admin/blog/:id` | оператор | удалить запись |

## ИИ-консультант на лендинге (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md, этап 82)

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `GET /api/assistant/config` | открыто, кешируется (`Cache-Control: public, max-age=300`) | включён ли консультант, стартовые вопросы-подсказки, проактивные подсказки по локалям, версия базы знаний |
| `POST /api/assistant/chat` | открыто (`PublicOriginGuard` + `RateLimitGuard`, 10/мин и 60/час) | вопрос посетителя → потоковый ответ; SSE при `Accept: text/event-stream`, иначе JSON-запасной вариант `{text,actions,usage}` (§4.3) — единственный маршрут во всём бэкенде, что сам пишет `@Res()` в обход `ResponseInterceptor` |
| `POST /api/assistant/event` | открыто (`PublicOriginGuard` + `RateLimitGuard`, 30/мин) | батч клиентской телеметрии виджета (open/ask/action_click/close/proactive_*) — best-effort, ошибка записи не возвращается как ошибка ответа |

## Идентичность, оферта, админка

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `POST /api/telegram-login/callback` | открыто | вход через Telegram Login Widget (вне Telegram) |
| `POST /api/telegram-login/dev-login` | открыто (только `ALLOW_DEV_AUTH`) | локальный вход без Telegram |
| `POST /api/telegram-login/logout` | открыто | выйти |
| `GET /api/telegram-login/me` | открыто | `{ loggedIn }` — честно отвечает и без сессии |
| `GET /api/tts/voices?language=` | идентичность | каталог голосов синтеза (§15.3); `configured: false` + причина, если ключа нет — не ошибка; ответ содержит `provider` — активный провайдер (`elevenlabs`/`resemble`, doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.1), маршрут один и тот же для обоих |
| `POST /api/tts/preview` | идентичность | проба голоса (§15.5): фраза ≤ 300 символов → mp3 в `data:`-URL; 30 проб в сутки на пользователя, блокировка и бюджет проверяются раньше потолка |
| `POST /api/voices/upload-url` | идентичность | этап 73: presigned PUT для образца голоса для клонирования (`voiceCloning`, Standard и выше) |
| `POST /api/voices/clone` | идентичность | подтвердить загрузку → запустить обучение у Resemble AI; требует `consent: true`; лимит 3 голоса на пользователя (неудачные не считаются) |
| `GET /api/voices` | идентичность | список своих клонированных голосов со статусом (`training`/`ready`/`failed`); попутно подтягивает готовность у Resemble (poll-фоллбек, если вебхук не настроен) |
| `DELETE /api/voices/:id` | идентичность | удалить свой клон (запись, файл в Blob, голос на стороне Resemble) |
| `POST /api/voices/webhook/resemble?secret=` | секрет в query | вебхук готовности обучения от Resemble; секрет — query-параметр, не заголовок (формат вебхука Resemble фиксирован) |
| `GET /api/me/terms` | идентичность | принята ли текущая версия оферты (§20) |
| `POST /api/me/terms/accept` | идентичность | зафиксировать принятие |
| `GET /api/me/marketing-consent` | идентичность | статус согласия на рассылку подборки роликов (§42, этап 63) — `consented`/`consentedAt`/`revokedAt`, без версии документа |
| `POST /api/me/marketing-consent` | идентичность | подписаться (или переподписаться поверх уже отозванного согласия) |
| `POST /api/me/marketing-consent/revoke` | идентичность | отписаться в один клик |
| `GET /api/me/plan` | открыто | режим + матрица (§23), блокировка (§25.3), состояние суточного лимита (§26.4, без сумм), `subscription` (план/статус/`currentPeriodEnd`/`cancelAtPeriodEnd` или `null`) и `credits.balance` (§41, этап 62); без идентичности — честный `LITE` |
| `PATCH /api/me/plan` | идентичность | сменить режим: на `LITE` при включённой оплате — запрос отмены подписки (`cancelAtPeriodEnd: true`, доступ до конца периода); на `STANDARD`/`PREMIUM` при `PLANS_BILLING_ENABLED=true` — 403 с указанием на `POST /api/billing/checkout/subscription` (§41, этап 62); пока `PLANS_BILLING_ENABLED=false` — бесплатно, любой режим |
| `POST /api/admin/auth/telegram-callback` | открыто | вход оператора |
| `POST /api/admin/auth/dev-login` | открыто (только `ALLOW_DEV_AUTH`) | локальный вход оператора |
| `POST /api/admin/auth/logout` | открыто | выйти из админки |
| `GET /api/admin/auth/me` | сессия админки | кто вошёл |
| `GET /api/admin/sessions` | оператор | список сессий |
| `GET/DELETE /api/admin/sessions/:id` | оператор | сессия / удалить — с этапа 89 тот же софт-delete через `SessionService.softDeleteSession`, что у пользовательского `DELETE /api/sessions/:id` выше |
| `GET /api/admin/users?q=&plan=&operators=1&blocked=1&page=&pageSize=` | оператор | пользователи: режим, права, счётчики активности; сводка `byPlan` — по всей базе (§25) |
| `GET /api/admin/users/:id` | оператор | карточка пользователя + 10 последних сессий + баланс кредитов и подписка (§41, этап 62) |
| `PATCH /api/admin/users/:id` | оператор | режим, флаг оператора, блокировка (`isBlocked`, `blockedReason`); снять оператора или заблокировать САМОГО СЕБЯ нельзя (403) |
| `POST /api/admin/users/:id/cancel-subscription` | оператор | отменить подписку пользователя (`cancelAtPeriodEnd: true`, без возврата денег) — тот же эффект, что кнопка «Отменить подписку» в TMA (§41, этап 62) |
| `GET /api/admin/costs?top=` | оператор | расходы на ИИ (§26): итоги, разбивка по провайдерам/операциям/моделям, топ по тратам, действующий прайс |
| `GET /api/admin/telemetry` | оператор | агрегаты по сессиям |
| `GET /api/admin/settings` | оператор | проверка переменных окружения |
| `GET /api/admin/settings/assistant` | оператор | настройки ИИ-консультанта (включён/выключен, проактивный режим, дневной бюджет, модель) + счётчики за сегодня (§9/§10, этап 82) |
| `PATCH /api/admin/settings/assistant` | оператор | изменить настройки консультанта — все поля необязательны, частичное обновление (тот же метод, что у остальных редактируемых admin/settings) |
| `GET /api/admin/assistant?flagged=&locale=&stepId=&search=&page=&pageSize=&days=` | оператор | лента обменов вопрос/ответ с фильтрами + агрегаты за 7 и, опционально, 30 дней (§10, этап 82) |
| `GET /api/admin/tutorial-scenarios?subjectKey=&locale=&costly=&approved=&page=&pageSize=` | оператор | список сценариев для автозаписи обучающих видео, сгенерированных ИИ по крону (§4.10 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 94); read-only, вмешиваться нечем, кроме одобрения ниже |
| `PATCH /api/admin/tutorial-scenarios/:id/approve` | оператор | явное одобрение траты на costly-сценарий перед автоматическим исполнением (§4.11 того же ТЗ) — идемпотентно, `approved`/`approvedBy`/`approvedAt` ставятся только один раз; бесплатный сценарий (`costly: false`) отвечает 400, одобрение ему не требуется |
| `DELETE /api/admin/tutorial-scenarios/:id` | оператор | удаляет сгенерированный сценарий безвозвратно (этап 106) — генератор только добавляет строки (`create`, не `upsert`), а раннер берёт все подходящие по `createdAt asc` без пропуска уже провалившихся; без удаления сломанный сценарий (например, с несуществующим `route`) падал бы и слал алерт в Telegram на каждом прогоне крона бесконечно |
| `GET /api/admin/site-tutorial-drafts?status=&page=&pageSize=` | оператор | очередь модерации обучалок по САЙТУ ЗАКАЗЧИКА (§5.2/§8.3 doc/CLIENT-SITE-TUTORIAL-SPEC.md, этап 113) — вкладка «Обучалки по сайтам»; строки несут объём работы (`stepCount`, `roundCount`, `previewFrameCount`), но ни кук, ни кред, ни шагов целиком |
| `GET /api/admin/site-tutorial-drafts/:id` | оператор | карточка одной заявки: шаги целиком и прямые Blob-ссылки на кадры предпросмотра — та же серия, что видел пользователь. Без неё оператор одобрял бы вслепую, платя за сборку ради того, чтобы просто посмотреть; о кредах сообщается фактом (`hasCredentials`), не значением |
| `PATCH /api/admin/site-tutorial-drafts/:id/approve` | оператор | `PENDING_REVIEW` → `APPROVED`. ИМЕННО этот вызов, а не `/finish`, ставит ролик в сборку: заводит `TutorialVideoAsset` с мягкой ссылкой `clientSiteDraftId` (§6.2) и отправляет слайд-шоу тому же внешнему ffmpeg-api, что и штатную обучалку — из УЖЕ залитых кадров, не из нового обхода сайта (дешевле, детерминированнее: сайт мог измениться). Условный `updateMany` по статусу — два оператора не оплатят сборку дважды |
| `PATCH /api/admin/site-tutorial-drafts/:id/reject` | оператор | `{ reason }` → `REJECTED` + `rejectionReason`; пользователь видит причину и может либо удалить черновик, либо вернуть его в работу через `/resume`. Кадры не стираются — повторный `/finish` перезальёт префикс целиком |
| `GET /api/admin/tutorial-video-assets?subjectKey=&locale=&reviewed=&page=&pageSize=` | оператор | список собранных обучающих видео (§4.9 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 99) — вкладка «Видео-контент»; без `reviewed:true` видео физически недоступно консультанту на лендинге |
| `GET /api/admin/tutorial-video-assets/data-status` | оператор | агрегированная сводка (§4.9, этап 99): версия базы знаний ассистента, число шагов обучалки по локалям, матрица покрытия одобренными видео по `subjectKey`×локаль, последние прогоны генерации/исполнения сценариев — вкладка «Состояние данных» |
| `PATCH /api/admin/tutorial-video-assets/:id/review` | оператор | `{ reviewed: boolean }` — переключает публикационный флаг (§4.9, этап 99); в отличие от одобрения сценариев выше, обратимо в обе стороны; `reviewed:true` делает видео доступным посетителям лендинга немедленно (консультант резолвит `kind:"video"` только среди `reviewed:true`, см. `AssistantService.resolveVideoActions`) |
| `POST /api/admin/tutorial-video-assets/:id/publish` | оператор | `{ platform, channelId, privacy?, title?, description?, tags? }` — публикация одобренного (`reviewed:true`) видео в YouTube/TikTok (§4.7 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, Фаза 3, этап 101); заводит `PublicationRequest` сразу `APPROVED` (см. `PublicationService.publishTutorialVideo`) — тот же крон-воркер выгрузки, что и рекламные ролики; `channelId` обязателен и должен принадлежать вызвавшему оператору (у обучающего видео нет ни проекта, ни бренд-манифеста, откуда угадать канал по умолчанию); 409, если заявка на эту площадку от этого видео уже подана |
| `POST /api/admin/tutorial-runner/seed-fixture-user` | оператор | заводит/обновляет фикстурного пользователя (§3.3 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 97) — та же идемпотентная цепочка upsert'ов (пользователь → манифест бренда → персонаж → проект → товар → сессия с готовым роликом), что раньше требовала ручного CLI-запуска `scripts/seed-fixture-user.ts` с прод `DATABASE_URL` (этап 105); `telegramId` берётся из `FIXTURE_TELEGRAM_ID` окружения, не из тела запроса — 400, если переменная не задана |
| `GET /api/admin/workflow-funnel?window=hour\|day\|week\|month` | оператор | событийная воронка по трём воркфлоу (сессия/пакетная генерация/A-B-варианты, §3 doc/WORKFLOW-FUNNEL-SPEC.md, этап 78): сколько раз каждая стадия была ДОСТИГНУТА за окно — событийный счётчик, не когорта |
| `GET /api/admin/workflow-funnel/cohort-conversion?window=hour\|day\|week\|month` | оператор | когортная конверсия по тем же трём воркфлоу (doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md, этап 78): что случилось с сущностями, СТАРТОВАВШИМИ в окне, без ограничения по времени перехода; помечает незавершённые когорты (`matured: false`) |
| `GET /api/admin/publications?status=&page=&pageSize=` | оператор | очередь модерации публикаций (§8) |
| `GET /api/admin/publications/:id` | оператор | одна заявка целиком |
| `POST /api/admin/publications/:id/approve` | оператор | одобрить; `{ channelId?, privacy? }` — без `channelId` сервис сам находит канал (проект → бренд-манифест → единственный канал автора); крон-воркер выгружает автоматически (§14.5) |
| `POST /api/admin/publications/:id/reject` | оператор | отклонить; `{ reason }` обязателен и дословно уходит автору |
| `POST /api/admin/publications/:id/retry` | оператор | FAILED → APPROVED, сброс `attempts`/`nextAttemptAt`/`publishError`/`uploadJobId` (§14.5) |
| `GET /api/admin/shared-videos?status=&page=&pageSize=` | оператор | очередь модерации публичных страниц ролика (§40) |
| `GET /api/admin/shared-videos/:id` | оператор | одна заявка целиком |
| `POST /api/admin/shared-videos/:id/approve` | оператор | одобрить — страница сразу доступна на лендинге |
| `POST /api/admin/shared-videos/:id/reject` | оператор | отклонить; `{ reason }` обязателен; копия ролика НЕ удаляется — автор отзывает сам (`DELETE .../shared-video/:pageId`) |
| `GET /api/admin/payments?status=&method=&page=&pageSize=` | оператор | список платежей с фильтрами по статусу/методу (§41, этап 62) |
| `POST /api/admin/payments/:id/refund` | оператор | возврат: Stars — реальный вызов `refundStarPayment`; WayForPay — только пометка `REFUNDED` на своей стороне, реальный возврат делается вручную в личном кабинете WayForPay |
| `GET /api/admin/marketing/broadcasts?page=&pageSize=` | оператор | история выпусков рассылки (§42, этап 63): сводка доставки sent/failed/skipped/pending на каждый + текущее число активных подписчиков; read-only, отбор контента для выпуска автоматический |
| `GET /api/admin/catalog-batches?page=&pageSize=` | оператор | список партий пакетной генерации (§44, этап 65): проект, инициатор, сводка `{pending, generating, done, failed, total}` по товарам; read-only, вмешиваться нечем — партия либо идёт, либо завершилась |
| `GET /api/admin/ab-tests?page=&pageSize=` | оператор | список запусков A/B-вариантов (§45, этап 66): проект, инициатор, исходная сессия, сводка `{pending, generating, done, failed, total}` по вариантам; read-only, вмешиваться нечем — запуск либо идёт, либо завершился |
| `GET /api/admin/feed-imports?page=&pageSize=` | оператор | список запусков импорта товарного фида (§47, этап 68): проект, инициатор, ссылка на фид, статус, сводка `{totalRows, importedCount, skippedCount, failedCount}`; read-only, вмешиваться нечем — запуск либо идёт, либо завершился; в отличие от партий/A/B-запусков, сводка не пересчитывается `groupBy`, а читается готовой из строки запуска |
| `GET /api/admin/cron/registry` | оператор | реестр пятнадцати крон-задач: `jobKey` + описание (§69, этап 69; export-sync-run добавлен этапом 76, tutorial-scenario-generate — этапом 94, tutorial-scenario-run — этапом 96, ui-snapshot-run — этапом 100, ai-usage-rollup — этапом 118) |
| `GET /api/admin/cron/history?jobKey=` | оператор | история прогонов из `CronRunLog` — без `jobKey` последние по всем джобам вперемешку, с `jobKey` — история одного джоба (§69, этап 69) |
| `POST /api/admin/cron/:jobKey/run?debug=` | оператор | ручной запуск одного из пятнадцати кронов (та же бизнес-логика, что у настоящего крона Vercel, через общий `CronJobsService`); `debug` у двенадцати джобов раскрывает подробный `debugLog` результата, у `sweep-orphans` дополнительно означает `dryRun` (ничего не удаляет); ограничен `RateLimitGuard` (5 запросов/15с — кроны дёргают платные внешние API) (§69, этап 69) |

## Крон и обслуживание

| Метод и путь | Доступ | Назначение |
| --- | --- | --- |
| `GET /api/cron/cleanup-sessions` | секрет крона | удалить истёкшие сессии вместе с их файлами (ежедневно 03:00 UTC, `backend/vercel.json`) |
| `GET /api/cron/report` | секрет крона | суточный отчёт в служебный канал статистики (ежедневно 06:00 UTC, ТЗ §28); по понедельникам добавляет недельные числа. Ничего не удаляет; отвечает тем же текстом, что ушёл в канал, `sent` — по ответу Telegram, а не по постановке в очередь (этап 47) |
| `GET /api/cron/sweep-orphans?dryRun=1&limit=&minAgeHours=&cursor=` | секрет крона | подметатель осиротевших файлов (ежедневно 03:30 UTC, этап 29); с этапа 41 ходит по четырём префиксам — `sessions/`, `projects/`, `brand-manifests/`, `publications/` — и отдаёт разбивку `byScope`; с этапа 47 каждая область досматривается до конца курсора (потолки 40 страниц / 120 с), в ответе `complete` и `pages` по областям — без `complete: true` ноль сирот ничего не значит; `dryRun=1` — прогон без удаления (`doc/STORAGE-AUDIT.md`) |
| `GET /api/cron/blog` | секрет крона | генератор черновиков блога, затем очередь перевода xAI Grok Batch API, последовательно, одним маршрутом (ежедневно 04:00 UTC, этап 57, ТЗ §36) — без `BLOG_CATEGORIES`/`GROK_API_KEY` честно отвечает 200 и не делает ничего |
| `GET /api/cron/publish` | секрет крона | берёт до `PUBLISH_CRON_BATCH` заявок `APPROVED` с подключённым каналом, выгружает в YouTube/TikTok, бэкофф при ошибке (каждые 2 минуты, `backend/vercel.json`, требует план Vercel Pro — этап 61, ТЗ §14.5) |
| `GET /api/cron/billing-renew` | секрет крона | продление подписок: WayForPay — списание по `recTokenEnc`, бэкофф при отказе; Stars — сверка `currentPeriodEnd` без пришедшего вебхука продления → `PAST_DUE` → `CANCELED` + понижение до LITE (ежедневно 05:00 UTC, `backend/vercel.json`, Vercel Pro НЕ требуется — этап 62, ТЗ §41) |
| `GET /api/cron/marketing-broadcast` | секрет крона | сборка нового выпуска рассылки (не чаще раза в `MARKETING_BROADCAST_FREQUENCY_DAYS` дней) + доставка партии с бэкоффом, одним маршрутом; блокировка бота пользователем на попытке отправки снимает согласие автоматически (ежедневно 07:00 UTC, `backend/vercel.json`, Vercel Pro НЕ требуется — этап 63, ТЗ §42) |
| `GET /api/cron/catalog-batch-run` | секрет крона | пакетная генерация по каталогу (§44, этап 65): до `CATALOG_BATCH_CRON_BATCH` строк за тик, claim-цикл по образцу `/cron/publish` — на каждый товар создать сессию из снимка, перенести разбор, собрать и одобрить промпт, запустить рендер, одним заходом без остановки на подтверждение; бэкофф `2^attempts` минут при временной ошибке, план понижен/заблокирован — сразу терминальный `FAILED` (каждые 2 минуты, `backend/vercel.json`, та же частота и потому тот же уже действующий план Vercel Pro, что у `/cron/publish` — этап 65, ТЗ §44) |
| `GET /api/cron/ab-test-run` | секрет крона | A/B-варианты одного ролика (§45, этап 66): до `AB_TEST_CRON_BATCH` строк за тик, claim-цикл по образцу `/cron/catalog-batch-run` — но БЕЗ вызова GPT-5 (текст всех вариантов уже готов, собран одним вызовом при создании запуска): на каждый вариант создать сессию из снимка, перенести разбор, посеять уже готовый текст (`seedPrompt`, не `generatePrompt`), одобрить, запустить рендер; тот же бэкофф/`FAILED`-приём, что у `/cron/catalog-batch-run` (каждые 2 минуты, `backend/vercel.json`, тот же уже действующий план Vercel Pro) |
| `GET /api/cron/feed-import-run` | секрет крона | товарный фид (§47, этап 68): два тика подряд одного вызова — фаза 1 (до `PRODUCT_FEED_IMPORT_CRON_BATCH` запусков) скачивает и разбирает YML/CSV-фид, заводит строки; фаза 2 (тот же лимит строк) валидирует и заводит позиции через `ProjectService.addItem`, дописывает категорию/фото напрямую в БД; SSRF-guard проверяется повторно перед скачиванием; сетевой сбой — бэкофф `2^attempts` минут, SSRF-отказ/пустой фид/превышение размера — терминальный `FAILED` сразу (каждые 2 минуты, `backend/vercel.json`, тот же уже действующий план Vercel Pro) |
| `GET /api/cron/export-sync-run` | секрет крона | крон-аналог `advanceGenerating()` для автоэкспорта яруса B (Е-2.3 шестого аудита, этап 76): досматривает статус дочерних рендеров независимо от того, открыт ли у пользователя экран прогресса — без него закрытие приложения до конца рендера рисковало потерей уже оплаченного файла по TTL сессии (каждые 1-2 минуты, `backend/vercel.json`) |
| `GET /api/cron/tutorial-scenario-generate` | секрет крона | генерация сценариев для будущей автозаписи обучающих видео (§4.10 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 94): по одному вызову Gemini на каждый из 10 шагов обучалки (только локаль `ru` в этой итерации), разбор ответа в фиксированный словарь примитивов (НЕ исполняемый код), прикидка стоимости через `estimateCost()` для сценариев с `triggerPaidOperation` (§4.11 того же ТЗ); best-effort по каждому шагу отдельно — упавший/невалидный ответ на одном шаге не роняет остальные (ежедневно 08:00 UTC, `backend/vercel.json`); исполнение сгенерированных сценариев (§5 того же ТЗ) реализовано этапом 96 — см. следующую строку |
| `GET /api/cron/tutorial-scenario-run` | секрет крона | исполнение уже сгенерированных (и, если платных, одобренных) сценариев (§5 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 97): headless-браузер (`common/headless-chromium.ts`, puppeteer-core) проигрывает шаги против фикстурного пользователя (§3.3 ТЗ, служебный вход `X-Fixture-Token` — `common/fixture-token.ts`), пишет `TutorialScenario.lastRunAt/lastRunStatus/lastRunError`; регрессионный прогон, БЕЗ видео/скриншотов (сознательно отложено — см. «Сделано (этап 97)» в doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md) и БЕЗ реального платного вызова (`triggerPaidOperation` — no-op маркер и на исполнении); без настроенной фикстуры не падает, пропускает прогон с логом (ежедневно 09:00 UTC, `backend/vercel.json`, свой джоб-лок отдельно от `tutorial-scenario-generate`) |
| `GET /api/cron/ui-snapshot-run` | секрет крона | крон-обход интерфейса TMA (§3 doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, «Фаза 1», этап 100): тот же headless-браузер и фикстурный вход, что у `tutorial-scenario-run`, обходит 5 MVP-маршрутов (`ru`/`light`), снимает скриншот, маскирует `[data-qa-mask]`-элементы, считает перцептивный dHash и сравнивает с предыдущим снимком той же комбинации маршрут×локаль×тема; при расхождении — тревога через `TelegramNotifyService`; сбой одного маршрута пишет `UiSnapshot.error` и не прерывает обход остальных; без настроенной фикстуры не падает, пропускает прогон с логом (раз в две минуты, `backend/vercel.json`, свой джоб-лок отдельно от tutorial-scenario-*) |
| `GET /api/cron/ai-usage-rollup` | секрет крона | свёртка журнала расходов (§I-Б.5 `doc/TODO.md`, этап 118): завершившиеся месяцы старше 90 дней схлопываются в `ai_usage_monthly` по ключу пользователь×анонимность×провайдер×операция×модель×`unpriced`, и только после этого сырые строки того месяца удаляются — одной транзакцией, поэтому обрыв оставляет месяц либо целиком свёрнутым, либо целиком сырым; за прогон не больше трёх месяцев (первый запуск на накопленном журнале иначе не уложился бы в тик функции); отчёты «за всё время» с этого этапа читают оба источника и складывают их. Без этой задачи `ai_usage` растёт примерно на 4 ГБ в год и не чистится ничем (еженедельно, понедельник 04:00 UTC, `backend/vercel.json`, свой джоб-лок) |

Если `CRON_SECRET` не задан, все тринадцать маршрутов отвечают 503 (этап 54,
Б-3.3) — до этого они были открыты, и одна забытая переменная делала
метлу публичной. Исключение — dev-стенд: `ALLOW_DEV_AUTH=true` при
`NODE_ENV !== production` открывает крон для `curl`, как и dev-вход
(`doc/DEPLOYMENT.md`, `doc/TELEGRAM-ADMIN.md`).

Ошибки любого маршрута приходят в одном формате: `{ success: false,
error: { code, message }, meta: { requestId, timestamp, path } }`. Текст
`message` написан для пользователя только у ошибок, которые сервер бросил
сам (4xx, 409, 429); всё непредвиденное — одинаковая фраза и `requestId`,
по которому запись ищется в логе (этап 54, Б-3.6).
