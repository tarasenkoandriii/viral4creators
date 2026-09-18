# ТЗ: ИИ-скетч вместо изображения (персонажи, товары, сцены)

Статус: **v3 — фазы −1, 1 и бо́льшая часть 2 реализованы в коде** · 17.09.2026
Владелец продукта: Андрій Тарасенко
Связанные документы: `PRODUCT-PROJECT-SPEC.md` (§10.2, §12, §17, §26, §41), `AI-ACTORS-NO-REFERENCE-SPEC.md`, `AVATAR-LIPSYNC-PIPELINE-SPEC.md`, `doc/legal/offer.md`, `doc/legal/terms-of-use.md`
Журнал изменений v1 → v2 — §15. Все исправления уже внесены в текст разделов; каждое такое место помечено номером находки _(аудит А-N)_.

---

## 0. Коротко

К любому изображению, которое пользователь загрузил или которое система подтянула сама (персонаж, сцена, товар), добавляется отдельная кнопка **«ИИ-скетч»**. Она генерирует стилизованную (нефотореалистичную) версию изображения, показывает превью рядом с оригиналом и по подтверждению пользователя **подменяет оригинал во всех дальнейших вызовах**: референсы и первый кадр Veo/Grok, аватар Hedra, публичные страницы шеринга, снимки бренда и товара в сессиях.

Зачем:
1. **Юридически** — снизить риски от чужих изображений: внешность реальных людей (персональные данные и право на изображение), чужие фотографии (авторское право), логотипы и упаковка (товарные знаки), третьи лица в кадре.
2. **Коммерчески** — функция доступна на всех тарифах, но с разными квотами. Пакетный режим и политика «только скетчи» — повод перейти на старший тариф (§8).

> ⚠️ ТЗ описывает техническую и продуктовую сторону. Достаточность решений §13 (п. 1–2) и тексты §11 до релиза проверяет юрист. Решения §13 устроены так, что изменение позиции юриста меняет только настройки, а не код (колонка «Как откатить»).

> 🚨 **Срочно, вне этой фичи (аудит А-1).** По сторонним сводкам модель по умолчанию `gemini-2.5-flash-image` (`common/gemini-image-model.ts`) отключается **2 октября 2026**; рекомендуемая замена — GA `gemini-3.1-flash-image`. На этой модели уже работает превью персонажа. Фаза −1 (§14) — перевести его на новую модель до 02.10.2026, независимо от сроков скетча.

---

## 1. Термины

| Термин | Значение |
|---|---|
| **Слот изображения** | Место, где хранится изображение, способное уйти во внешнюю генерацию или на публичную страницу (§2). |
| **Оригинал** | Изображение, которое пользователь загрузил или система импортировала. |
| **ИИ-скетч** | Изображение, которое модель сгенерировала по оригиналу или по описанию, в одном из нефотореалистичных стилей (§5.3). |
| **Кандидат** | Сгенерированный, но ещё не применённый скетч (превью). |
| **Активный вариант** | То, что реально уходит дальше: `original` или `sketch`. |
| **Резолвер** | Функции, которые возвращают активное изображение слота (§6.3). Все потребители обязаны ходить только через них. |
| **Разделяемый оригинал** | Blob, на который ссылаются несколько записей. Фото товара проекта — сессии, созданные из товара. Фото бренда — снимки бренда в сессиях. Важно при удалении оригинала (§4, п. 10). |

---

## 2. Слоты и потребители

### 2.1 Слоты в объёме работ _(аудит А-9)_

По результатам инвентаризации кода (17.09.2026):

| # | Слот | UI | Хранение | Куда уходит дальше | Доступ к слоту | Фаза |
|---|---|---|---|---|---|---|
| S1 | Персонаж сессии (замена), `kind` = `photo` / `brand` / `text` | `features/generation/CharacterCasting.tsx` | `Session.characterCasting.casts[].replacement` (JSON), Blob `sessions/{sid}/characters/{cid}/photo.*` | `buildReferencePlan` → Veo/Grok (`kind:'character'`) | `characterReplacement` (Standard+) | 1 |
| S2 | Фото товара сессии | `components/ImageUpload.tsx` (мастер) | `Session.productInformation.productImagePathname/…MimeType/…Url`. Blob `sessions/{sid}/product-image.*` **или разделяемый** `projects/{pid}/items/{iid}/photo.*`, если сессия создана из товара | **первый кадр** (`legacyFirstFrame`) или `kind:'product'` → Veo/Grok; `catalog-batch-worker` | все тарифы, включая Lite | 1 |
| S3 | Сцена сессии | `features/generation/ReferenceSlotsPanel.tsx` | `Session.scenes[]`, Blob `sessions/{sid}/scenes/{id}/photo.*` | Veo/Grok (`kind:'scene'`) | `referenceAssets` (Standard+) | 1 |
| S4 | Персонаж бренда | `features/brand/ManifestScreen.tsx` (`AssetsBlock`) | `BrandCharacter.photoUrl`, Blob `brand-manifests/{mid}/characters/{id}/photo.*` (разделяемый со снимками) | снимок сессии → Veo/Grok; Hedra `start_image` (только операторский маршрут) | `brandManifest` (Standard+) | 2 |
| S5 | Сцена бренда | там же | `BrandScene.photoUrl`, Blob `brand-manifests/{mid}/scenes/{id}/photo.*` (разделяемый) | снимок сессии (только URL) → Veo/Grok | `brandManifest` | 2 |
| S6 | Фото товара в проекте | `features/projects/ItemScreen.tsx` | `ProductItem.photoUrl`/`photoHash`, Blob `projects/{pid}/items/{iid}/photo.*` (разделяемый с S2) | `productInformationFromItem` → S2; `catalog-batch` | проекты | 2 |
| S7 | Фото из импорта фида | нет (крон) | как S6 | как S6 | `library` (Premium — тот же гейт, что у импорта фида) | 2 |

Кнопка «ИИ-скетч» доступна, если у пользователя есть доступ к слоту **и** осталась квота скетчей по тарифу (§8). На Lite слоты S1 и S3–S5 закрыты своими признаками тарифа, поэтому там скетч доступен только для S2 и S6.

### 2.2 Не входят

Только отображаются и во внешнюю генерацию не уходят:
- кадры-превью разбора (`videoAnalysis.*.previewUrl`);
- библиотека разборов;
- аналоги SerpApi (`ProductAnalog.thumbnailUrl`);
- аватары каналов;
- обложки блога.

Текстовые карточки (`text-card`) генерируем мы сами, скетч им не нужен.

### 2.3 Внутренний анализ оригинала (не меняется) _(аудит А-12)_

Фото товара проекта (S6/S7) при загрузке уходит в два внешних сервиса анализа — ещё до того, как можно сделать скетч:
- `ProductRecognitionService` → Gemini: категория и название (операция `product-photo`);
- `SerpApiLensService.visualMatches` → Google Lens: аналоги и цена.

Это не генерация и не публикация; передача покрыта офертой §5.1. Скетч на это **не влияет**, и это прямо сказано в юридических текстах (§11). При политике «только скетчи» анализ не отключается: без него пропадут категория и рыночная цена.

### 2.4 Потребители, которые переводятся на резолвер _(аудит А-2, А-16, А-18)_

| Файл | Функция / место | Что читает сейчас |
|---|---|---|
| `common/reference-plan.ts` | `buildReferencePlan`, кандидаты персонажей, сцен, товара | `replacement.photoUrl/photoPathname`, `scenes[].photo*`, `brandManifestSnapshot.characters[]/scenes[].photoUrl`, `productInformation.productImage*` |
| `modules/generation/generation.service.ts` | `startVeoGeneration`: проверка наличия фото и **ветка `legacyFirstFrame`** (`downloadBuffer(productImagePathname)`); `startGrokGeneration`: **`legacyFirstFrame`** (`productImageUrl`); `continueVeoChain`, `fetchReference`, `resolveReferenceUrl` | `productInformation.productImagePathname/Url` напрямую |
| `modules/prompt/prompt.service.ts` | признак `references` в брифе (`!legacyFirstFrame`) | через план |
| `modules/project-session/snapshot.ts` | `characterSnapshot`, `sceneSnapshot`, `productInformationFromItem` | `photoUrl` бренда и товара |
| `modules/shared-video/shared-video.service.ts` | `keepOwnCopy` — копия фото товара на публичную страницу | `productImagePathname` |
| `modules/catalog-batch/catalog-batch-worker.service.ts` | `imageUrl` | `productImageUrl` |
| `modules/actors/actors.service.ts` | `generateAvatarVideo` (Hedra `start_image`) | `brandManifestSnapshot.characters[].photoUrl` |
| `modules/brand-manifest/brand-manifest.service.ts` | `addCharacterFromSessionCast` | `replacement.photoPathname` |
| `modules/project/project.service.ts` | выдача товаров проекта (UI) | `ProductItem.photoUrl` |
| `modules/generation/admin-generation-retry.controller.ts`, `modules/export/export.service.ts` | повтор рендера; перерендер в другой формат | через `generateVideo` → план |

---

## 3. Пользовательский сценарий

### 3.1 Точка входа

На карточке каждого доступного слота (§2.1), у которого есть оригинал или описание, появляется вторичная кнопка **«ИИ-скетч»** (иконка `PenTool`).
- **Квота исчерпана** (на сегодня или на месяц): кнопка остаётся видимой. Нажатие открывает окно с сообщением о лимите и CTA «Больше скетчей на Standard/Premium» (§8.4).
- **Гость** (без Telegram-идентичности): кнопка показывает «Войдите через Telegram, чтобы создавать скетчи». Квоты и журнал требуют пользователя.

### 3.2 Окно генерации (bottom sheet на мобильном, модалка на десктопе)

1. **Источник** (радио):
   - «По фото» (image-to-image): оригинал передаётся модели скетча один раз на генерацию. Выбран **по умолчанию**, если фото есть: качество заметно выше, а значит, скетч чаще применяют.
   - «По описанию» (text-to-image): передаётся только текст. Для персонажей подсказка: «Максимальная защита: фото человека никуда не передаётся». Описание предзаполняется:
     - для персонажа — из `replacement.description` / `BrandCharacter.description`;
     - для товара — из `productName` + `productDescription`;
     - для сцены — из `label` / `description` сцены.
   - Для S1 с `kind:'text'` доступен только режим «По описанию» _(аудит А-10)_.
2. **Стиль** (пилюли, §5.3): «Карандаш» (по умолчанию), «Линия», «Плоская иллюстрация», «Акварель».
3. **Опции**:
   - «Лицо неузнаваемо» — показывается только для персонажей в режиме «По фото». Всегда включено, переключатель заблокирован, подсказка «Обязательно для фото людей» (§4, п. 3). В режиме «По описанию» опция не нужна: лицо и так вымышленное.
   - «Убрать логотипы и надписи» — для товаров и сцен. По умолчанию **выкл** для S2/S6 и **вкл** для S7 и S3/S5.
   - «Сохранить цвета» — по умолчанию вкл.
   - «Как использовать в видео» (§5.5): «Реалистично» (по умолчанию) или «В стиле скетча».
4. Кнопка **«Сгенерировать превью»** → индикатор `Busy` (5–20 с) → превью.
5. **Превью**: оригинал и скетч рядом; на мобильном — переключатель «Оригинал / Скетч».
   - Счётчик «Скетчей: осталось N сегодня · M в этом месяце».
   - **«Ещё вариант»** — новая генерация с теми же параметрами. Все кандидаты остаются лентой миниатюр, между ними можно переключаться.
   - **«Применить вместо оригинала»** — основное действие.
   - **«Отмена»** — кандидаты остаются до истечения TTL (§6.7).
   - Если выбрано «Реалистично» и слот уходит в Veo/Grok, мелким текстом: «В ролике объект будет выглядеть реалистично, скетч задаёт только форму и позу».
6. **Ошибки**:
   - **отказ модели по безопасности (422)** → «Модель отказалась обработать это изображение. Попробуйте режим „По описанию“ или другое фото». Попытка засчитывается: вызов оплачен;
   - **сбой сети или провайдера (502)** → «Не удалось сгенерировать, попробуйте ещё раз». Попытка **не** засчитывается;
   - **лимит (429)** _(аудит А-5)_ → «Лимит скетчей исчерпан. Дневной обновится в 03:00 по Киеву» (сутки считаются от 00:00 UTC, как в `startOfDayUtc`). Для месячного лимита — «Месячный лимит исчерпан» и CTA тарифа;
   - **оригинал сменился (409)** → «Фото изменилось — сгенерируйте скетч заново».

### 3.3 После применения

- На карточке слота показан скетч с бейджем **«ИИ-скетч»**.
- Меню карточки:
  - **«Вернуть оригинал»** — активным снова становится `original`; скетч остаётся в истории, к нему можно вернуться из ленты;
  - **«Показать оригинал»** — только просмотр;
  - **«Удалить оригинал»** — необратимо, с подтверждением; правила для разделяемых оригиналов — §4, п. 10. После удаления пункт «Вернуть оригинал» недоступен, а генерация «По фото» строится от текущего скетча.
- Если оригинал заменили новой загрузкой, скетч отвязывается (`activeVariant = original`), а старый скетч уходит в историю со статусом `superseded`.

### 3.4 Сводка перед оплатой

На шаге генерации в сводке референсов (`slotsView`) у каждого слота стоит пометка «оригинал» или «ИИ-скетч». У товара дополнительно указано, как он пойдёт: «первый кадр» или «референс» (§5.6). Это последний экран, где пользователь видит, что именно уйдёт в Veo/Grok.

Здесь же для Standard+ выводится подсказка «N изображений людей без скетча» и кнопка «Сделать скетчи» — массовое действие по слотам сессии в рамках обычной квоты.

### 3.5 Политика «Только ИИ-скетчи» (Premium, фаза 3)

В бренд-манифесте появляется переключатель «Использовать только ИИ-скетчи» с двумя галочками: «люди» (по умолчанию вкл) и «товары и сцены» (по умолчанию выкл). Когда политика включена:
- генерация видео в сессиях этого бренда блокируется (400 с понятным текстом), пока у охваченных слотов нет применённого скетча;
- на шаге генерации выводится список таких слотов и кнопка «Сделать скетчи для всех» — пакетно (§4.6), в режиме «По фото», стилем бренда по умолчанию;
- на Standard переключатель виден под замком Premium — это повод перейти на старший тариф.

---

## 4. Бизнес-правила

1. **Главный инвариант.** Скетч заменяет оригинал, а не дополняет его. При активном скетче оригинал:
   - не уходит в Veo, Grok или Hedra — ни как референс, ни как **первый кадр**;
   - не копируется на публичные страницы.

   Для этого есть отдельный тест (§12.2).
2. **Передача модели скетча.** В режиме «По фото» оригинал уходит в Gemini ровно один раз на генерацию. Каждая передача записывается в журнал (§6.6).
3. **Обезличивание.** Персонажи (S1, S4) в режиме «По фото» всегда генерируются с изменёнными чертами лица. Сохраняются поза, одежда, телосложение, возрастная группа и силуэт причёски. Для этих слотов сервер игнорирует `anonymizeFace=false`.
4. **Товары.** Форма, цвет, пропорции и компоновка упаковки сохраняются; логотипы и надписи — по опции. Если опция выключена, модель просят сохранить надписи читаемыми, но гарантии нет (§10).
5. **Сцены.** Композиция и планировка сохраняются. Людей в кадре модель убирает всегда; вывески — по опции.
6. **Ограничения контента.** На скетч распространяются запреты оферты и правил: несовершеннолетние, откровенный контент, имитация публичных людей. Промпты запрещают это явно (§5.2). Отказ модели показывается пользователю как отказ.
7. **Владелец и перенос.** Скетч принадлежит владельцу слота. `from-session-cast` переносит в бренд оригинал, скетч и активный вариант — копированием Blob.
8. **Синхронизация перед первым рендером** _(аудит А-15)_. Снимки бренда и товара в сессии фиксируют активный вариант на момент создания сессии. Если скетч применили в бренде или товаре позже, он подтягивается в сессию перед первым рендером.
   - Механизм — `SnapshotVoiceSyncService`, обобщённый до `SnapshotSyncService` (§6.5).
   - Условия те же, что у голоса: у сессии ещё нет `generatedVideo`, и слот в сессии не меняли вручную (отметка `assetsEditedAt[слот]`, по образцу `voiceEditedAt`).
   - Для товара ручной правкой считается новая загрузка фото в самой сессии.
9. **Одобрение промпта — НЕ сбрасывается** _(правка по аудиту реализации A-7)_. Первая редакция требовала сбрасывать `generationPrompt.approvedAt` при применении и откате скетча. В коде это оказалось вредно: кнопки скетча стоят на шаге `video-generation`, то есть ПОСЛЕ одобрения, и сброс превращал «Сгенерировать» в вечный 400 «Prompt must be approved», а вернуться и одобрить заново экран не предлагал. По существу сбрасывать нечего: `referenceMappingText` в одобряемый текст не входит — он дописывается к запросу Veo/Grok во время рендера из свежего плана, а пользователь одобряет сценарий, а не список картинок. Ровно так же ведёт себя выбор слотов (`ReferenceSlotsPanel`) — он на том же шаге и одобрение никогда не снимал.
10. **Удаление оригинала** _(аудит А-3)_.
    - **Несессионный слот (S4–S6) с разделяемым Blob.** До удаления сервер:
      1. находит все записи, которые ссылаются на этот pathname или URL: сессии из товара (`productInformation.productImagePathname`), снимки бренда (`brandManifestSnapshot.characters[]/scenes[].photoUrl`), публичные страницы (`SharedVideoPage.productImagePathname`, если это не собственная копия страницы);
      2. прописывает в каждую скетч: сессиям — поля `sketch` и `originalDeleted`, публичным страницам — копию скетча в `shared-videos/{id}/photo.*`;
      3. только после этого удаляет Blob.

      Без этого удаление сломало бы повтор рендера, экспорт яруса B и опрос уже созданных сессий.
    - **Сессионный слот (S1–S3)** удаляет только собственный Blob сессии. Если S2 ссылается на Blob товара, удаляется только ссылка: у товара свой оригинал и своё решение.
      В коде это признак слота `ownsOriginalFile` (путь под `sessions/{id}/` — свой, `projects/…` — общий; brand-замена персонажа — всегда чужой файл). Ответ маршрута несёт `fileDeleted: boolean` — «файл удалён» против «снята только ссылка» _(аудит реализации A-4)_.
    - **Готовые ролики и их история** (`videoHistory`) не меняются: оригинал уже «запечён» в видео. В подтверждении удаления это сказано прямо: «Уже созданные ролики не изменятся».
11. **Публичные страницы** _(аудит А-11)_. Когда к товару применяют скетч (S2 или S6 через сессии), все опубликованные страницы шеринга этой сессии (`SharedVideoPage.sessionId`) автоматически получают копию скетча вместо фото товара. Видео на странице не меняется (п. 10).
12. **Только для вошедших** _(аудит А-13)_. Скетч, квоты и журнал требуют `userId`. Гость получает 401 с текстом из §3.1.

### 4.6 Пакетный режим (Premium) _(аудит А-19, А-21)_

Пакетно запускаются:
- «Сделать скетчи для всех товаров проекта» (S6);
- «Сделать скетчи для всех» из политики бренда (§3.5);
- автоматический скетч при импорте фида (S7) — настройка импорта «Сразу делать ИИ-скетч», для Premium по умолчанию **вкл**.

Как это работает:
- Выполняется кроном очереди по образцу `catalog-batch-run`: таблица `ImageSketchBatch` со статусом и счётчиками, лимит на тик и общий бюджет.
- Генерация идёт **через Gemini Batch API**: это примерно −50% к интерактивной цене (§8.3). Результат приходит асинхронно — до 24 ч, обычно быстрее; для пакета это нормально.
- Пакетные скетчи применяются автоматически, без превью, с пометкой «применено автоматически». Любой можно откатить в карточке слота.
- Пакеты тратят отдельную месячную квоту (§8.2). Если её не хватает, пакет обрабатывает сколько может, остаток переносит на следующий месяц и предлагает пакет «Скетч+» (§8.4).

---

## 5. Генерация

### 5.1 Модель _(аудит А-1)_

- **Выбор модели.** Новая константа `GEMINI_SKETCH_MODEL` в `common/gemini-image-model.ts`; по умолчанию равна `GEMINI_IMAGE_MODEL`, который в фазе −1 переводится на **`gemini-3.1-flash-image`** (GA). Точный ID и прайс перед релизом сверяются на официальной странице Google. Модель меняется через env или админку, без изменения кода.
- **Клиент** — существующий `createGeminiClient()`.
- **Формат запроса:**
  - image-to-image: `contents = [{ inlineData: { mimeType, data } }, { text: prompt }]`;
  - text-to-image: `contents = [{ text: prompt }]`.
- **`responseModalities` и разбор ответа** — по итогам фазы 0. В `CharacterPreviewService` это помечено «не проверено вживую» (`['Image']` против `['IMAGE']`). Итог фиксируется в `gemini-image-model.ts` и в §16.
- **Разрешение выхода — 1K**: этого хватает для референса Veo/Grok. Превью в UI показывает тот же файл. 2K и выше не используются.
- **Соотношение сторон** — как у оригинала (ближайшее поддерживаемое). Без оригинала:
  - товар — 1:1;
  - персонаж — 3:4;
  - сцена — по формату ролика сессии (16:9 или 9:16), вне сессии — 16:9.

### 5.2 Промпты _(аудит А-7)_

Файл `backend/src/common/sketch-prompts.ts`, чистая функция `buildSketchPrompt({ slotKind, mode, style, options, description })`. Промпты на английском.

Обязательные части **для всех стилей скетча** (`SketchStyle`):
- `"Non-photorealistic {styleFragment}. It must clearly look like a drawing, not a photograph."`
- `"No captions, watermarks or signatures."`; для товара без `removeLogos` к этому добавляется `"Keep existing product lettering legible."`
- `"Do not depict minors. No nudity or sexual content. Do not depict any real, identifiable or famous person."`

По виду слота и режиму:

| Вид | Режим | Шаблон |
|---|---|---|
| character | from-image | `Redraw the person from the reference image. Keep pose, clothing, body type, approximate age group and hairstyle silhouette. Change facial features so the person is NOT recognisable as the individual in the photo. Plain light background.` |
| character | from-text | `Draw a fictional adult person: {description}. Waist-up, facing camera, plain light background.` |
| product | from-image | `Redraw this product. Keep exact shape, proportions, colours and packaging layout. {removeLogos ? 'Replace all logos, brand names and text with blank shapes.' : ''} Plain background.` |
| product | from-text | `Draw a product: {name}. {description}. No brand names or logos. Plain background.` |
| scene | from-image | `Redraw this location. Keep layout, perspective and key objects. Remove all people. {removeLogos ? 'Remove signage and logos.' : ''}` |
| scene | from-text | `Draw a location: {description}. No people. {removeLogos ? 'No signage or logos.' : ''}` |

Опция `keepColors` добавляет `"Keep the original colour palette."`.

Описание пользователя подставляется как данные, а не как инструкция: обрезается до 2000 символов, очищается от управляющих символов и берётся в кавычки.

### 5.3 Стили

| Ключ | ru | Фрагмент |
|---|---|---|
| `pencil` | Карандаш | `graphite pencil sketch with light shading` (с `keepColors` — `coloured pencil sketch`) |
| `lineart` | Линия | `clean ink line art, no shading` (с `keepColors` — `coloured line art`) |
| `flat` | Плоская иллюстрация | `flat vector illustration with solid colours` |
| `watercolor` | Акварель | `loose watercolor illustration` |

### 5.4 Существующее фотореалистичное превью персонажа _(аудит А-8)_

Превью по двойному клику на описании в `CharacterCasting.tsx` (`CharacterPreviewService`) остаётся, но переводится на общий `SketchGeneratorService` с **внутренним** режимом `photo`. Этот режим:
- не входит в `SketchStyle` и не показывается в окне скетча;
- не содержит обязательной части «Non-photorealistic», но сохраняет запреты на несовершеннолетних, откровенный контент и реальных людей;
- расходует ту же квоту, что и скетч: операция `ai-sketch`, в журнале — `mode='photo-preview'`.

### 5.5 Скетч в видео: `sketchRendering`

Получив скетч как референс, Veo/Grok могут перенести рисованную стилистику в ролик. Это регулирует параметр слота `sketchRendering`:
- **`realistic`** (по умолчанию) — в текст сопоставления референсов (`referenceMappingText` для Veo, `grokReferencePromptText` для Grok) добавляется: `"Reference #{n} is a stylized drawing used only as a guide for shape, pose and layout. Render it photorealistically in the video's style; do not copy the drawing style."`;
- **`stylized`** — строка не добавляется, и ролик может унаследовать стиль скетча.

Для людей режим `realistic` даёт реалистичного, но вымышленного человека: черты лица изменены ещё при генерации скетча (§4, п. 3).

### 5.6 Скетч товара и первый кадр _(аудит А-2)_

Сейчас, если других референсов нет, фото товара идёт **первым кадром**: `legacyFirstFrame`, у Veo — `image`, у Grok — `imageUrl`. Скетч в роли первого кадра означает ролик, который начинается с рисунка. Правило:
- если у товара активен скетч, `buildReferencePlan` **всегда** кладёт товар в `images` (`kind:'product'`), и `legacyFirstFrame = false`;
- промпт (`PromptService`) получает `references: true` из того же плана, так что бриф остаётся согласованным;
- если провайдер или модель не принимает референсы в этом режиме (проверяется в фазе 0, особенно Veo 3.1 Lite и Grok), это фиксируется в §16. Тогда генерация с таким товаром возвращает понятную ошибку «Для скетча товара нужен режим с референсами — выберите другое качество/провайдера», а не молча откатывается к первому кадру.

---

## 6. Бэкенд

### 6.1 Модель данных (Prisma) _(аудит А-13, А-14, А-23)_

```prisma
model ImageSketch {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// 'session-character' | 'session-product' | 'session-scene'
  /// | 'brand-character' | 'brand-scene' | 'project-item'
  targetType      String
  /// sessionId | manifestId | itemId — строка без FK (владелец мог быть
  /// удалён, журнал остаётся — §6.6)
  targetId        String
  /// characterId | sceneId; пусто для товара
  targetSubId     String?
  /// 'from-image' | 'from-text' | 'photo-preview'
  mode            String
  /// SketchStyle; для photo-preview — 'photo'
  style           String
  /// { anonymizeFace, removeLogos, keepColors, sketchRendering }
  options         Json
  /// sha256 оригинала (from-image) — «от какого файла» и защита от
  /// применения к сменившемуся фото (409)
  sourceHash      String?
  sourcePathname  String?
  description     String?
  model           String
  promptHash      String
  /// sketches/{userId}/{id}.png; null после удаления файла (§6.7)
  pathname        String?
  url             String?
  mimeType        String?
  /// 'pending' (пакет) | 'candidate' | 'applied' | 'superseded'
  /// | 'expired' | 'refused' | 'failed'
  status          String
  batchId         String?
  auto            Boolean   @default(false)
  createdAt       DateTime  @default(now())
  appliedAt       DateTime?
  expiresAt       DateTime?

  @@index([targetType, targetId, targetSubId])
  @@index([userId, createdAt])
  @@index([status, expiresAt])
  @@index([batchId])
  @@map("image_sketches")
}

model ImageSketchBatch {
  id            String    @id @default(cuid())
  userId        String
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// 'project-items' | 'feed-import' | 'brand-policy'
  scope         String
  scopeId       String
  style         String
  options       Json
  /// имя задачи Gemini Batch API
  providerJob   String?
  /// 'queued' | 'submitted' | 'done' | 'failed' | 'deferred'
  status        String
  total         Int
  done          Int       @default(0)
  failed        Int       @default(0)
  createdAt     DateTime  @default(now())
  finishedAt    DateTime?

  @@index([status, createdAt])
  @@map("image_sketch_batches")
}
```

**Связи и новые поля:**
- `User` получает обратные связи `imageSketches ImageSketch[]` и `imageSketchBatches ImageSketchBatch[]`.
- `BrandCharacter`, `BrandScene`, `ProductItem`: `activeSketchId String?`, `sketchRendering String?`, `originalDeletedAt DateTime?`.
- `BrandManifest`: `sketchPolicy Json?` — `{ people: boolean, objects: boolean, style }`.
- `ProductFeedImportRun`: `autoSketch Boolean @default(true)` — настройка задаётся при запуске импорта и хранится на прогоне.

**JSON-слоты сессии.** Слоты `casts[].replacement`, `productInformation`, `scenes[]`, `brandManifestSnapshot.characters[]/scenes[]` получают:
- поле `sketch?: { sketchId, url, pathname, mimeType, style, sketchRendering }`;
- флаг `originalDeleted?: boolean`.

Это денормализация: резолверу не нужно ходить в БД за каждым референсом. `brandManifestSnapshot` дополнительно получает `assetsEditedAt?: Record<string, string>` (§4, п. 8).

**Ограничения:**
- Ни один новый ключ не входит в `LIVE_KEYS` (`common/session.service.ts`): это холодные данные, их пишут редко.
- Миграция `20261121090000_image_sketches` — только добавление, без переноса данных, по правилам `doc/PRISMA-SUPABASE.md`.

### 6.2 API

**Доступ.**
- Все маршруты закрыты `TelegramIdentityGuard`.
- Владение проверяется по `targetType` так же, как в существующих контроллерах слотов:
  - сессии — `SessionOwnerGuard`, в сервисе — сверка `session.userId`;
  - проекты и товары — `ProjectService.findOwnProject/findOwnItem`;
  - манифесты — владелец манифеста.
- Чужой или несуществующий ресурс → 404 (не 403), как в соседних модулях.

| Метод и путь | Тело → ответ | Назначение |
|---|---|---|
| `POST /sketches` | `{ target: {type, id, subId?}, mode, style, options, description? }` → `{ sketch: SketchView, quota: QuotaView }` | Сгенерировать кандидата |
| `GET /sketches?type=&id=&subId=` | → `{ items: SketchView[], active: SketchView \| null, quota }` | История и кандидаты слота |
| `GET /sketches/quota` | → `QuotaView` `{ dayUsed, dayLimit, monthUsed, monthLimit, batchMonthUsed, batchMonthLimit, resetsAtUtc }` | Счётчики для UI |
| `POST /sketches/:id/apply` | `{ sketchRendering? }` → `{ slot }` | Применить |
| `POST /sketches/revert` | `{ target }` → `{ slot }` | Вернуть оригинал |
| `POST /sketches/delete-original` | `{ target }` → `{ slot, updatedRefs: number, fileDeleted: boolean }` | Удалить оригинал (§4, п. 10). POST, а не DELETE с телом _(аудит А-17)_: не все прокси пропускают тело у DELETE |
| `POST /projects/:pid/sketch-batch` | `{ style, options, itemIds? }` → `{ batchId, accepted, deferred }` | Пакет по товарам (Premium) |
| `POST /brand-manifests/:mid/sketch-batch` | `{}` → `{ batchId, … }` | Пакет по политике бренда (Premium) |
| `GET /sketch-batches/:id` | → статус | Прогресс пакета |
| `PATCH /brand-manifests/:mid` | `+ sketchPolicy` | Политика §3.5 (существующий маршрут, новое поле DTO) |

`SketchView = { id, status, mode, style, options, url, createdAt, appliedAt, auto }`. Путей Blob в ответах нет.

**Валидация:**
- путь к источнику берётся только на сервере, из слота; клиент путей не присылает;
- `description` — 3–2000 символов, обязателен для `from-text`;
- `style`, `mode`, `options.*` проверяются `class-validator` (`IsIn`, `IsBoolean`); `mode='photo-preview'` через этот маршрут не принимается;
- `apply` принимает только кандидата того же владельца со `status='candidate'`, у которого `sourceHash` совпадает с хешем текущего оригинала (или `mode='from-text'`). Иначе 409.

**Коды ответов:**
- 401 — гость;
- 403 — нет доступа к слоту (текст `featureDeniedMessage(<признак слота>)`) или к пакету (`featureDeniedMessage('aiSketchBatch')`);
- 404 — чужой или несуществующий слот;
- 409 — оригинал сменился;
- 422 — отказ модели;
- 429 — квота исчерпана; `quota` и `upgrade: PlanId | null` приходят в `error.details` конверта — фильтр исключений пробрасывает их по белому списку _(аудит реализации A-2)_;
- 409 при `apply` — в `error.details.reason` машиночитаемая причина: `source-changed` (фото слота сменилось, нужен новый скетч), `already-applied`, `sketch-gone` _(аудит реализации A-13)_;
- 502 — сбой провайдера.

### 6.3 Резолвер

`backend/src/common/active-image.ts`:

```ts
export interface ActiveImage {
  url: string;
  pathname: string | null; // у снимка бренда pathname нет — только URL
  mimeType: string;
  variant: 'original' | 'sketch';
  sketchRendering: 'realistic' | 'stylized' | null;
}
// kind photo | brand | text (text — только скетч, без оригинала)
export function activeCastImage(r: CastReplacement, snap?: BrandManifestSnapshot): ActiveImage | null;
export function activeProductImage(p: ProductInformation): ActiveImage | null;
export function activeSessionSceneImage(s: SceneAsset): ActiveImage | null;
export function activeSnapshotCharacterImage(c: BrandCharacterSnapshot): ActiveImage | null;
export function activeSnapshotSceneImage(s: BrandSceneSnapshot): ActiveImage | null;
export function activeBrandCharacterImage(c: BrandCharacterWithSketch): ActiveImage | null;
export function activeBrandSceneImage(s: BrandSceneWithSketch): ActiveImage | null;
export function activeItemImage(i: ProductItemWithSketch): ActiveImage | null;
```

**Персонаж `kind:'text'`** _(аудит А-10)_. При применении скетча замена переходит в `kind:'photo'`: у неё есть скетч, но нет оригинала. Персонаж начинает занимать один из трёх слотов референсов; действует гейт `characterReplacement`.

**Перевод потребителей:**
- Все потребители из §2.4 переводятся на резолвер.
- Правило ESLint `no-restricted-properties` запрещает прямое чтение полей оригинала (`photoUrl`, `photoPathname`, `productImagePathname`, `productImageUrl`) в `modules/generation`, `modules/prompt`, `modules/actors`, `modules/shared-video`, `modules/catalog-batch` и `common/reference-plan.ts`. Исключения — сам резолвер и адаптеры §6.4.
- `ReferenceImageSource` и `ReferenceCandidateView` получают поле `variant`, чтобы сводку §3.4 и админку можно было построить без дополнительных запросов.

### 6.4 Модуль

`backend/src/modules/image-sketch/`:
- `image-sketch.module.ts`, `image-sketch.controller.ts`;
- `image-sketch.service.ts` — `generate`, `apply`, `revert`, `deleteOriginal`, `list`, `quota`;
- `sketch-generator.service.ts` — вызов Gemini (интерактивно и через Batch API), разбор ответа, ресайз входа, загрузка в Blob; его же использует `CharacterPreviewService`;
- `sketch-quota.service.ts` — квоты §8.2;
- `sketch-targets.ts` — адаптеры по `targetType`: `loadSlot`, `assertOwner`, `readSource`, `writeActive`, `clearActive`, `findSharedRefs`, `propagateSketch`, `deleteOriginalBlob`;
- `image-sketch-batch.worker.ts` — обработка пакетов. Это шаг внутри существующего крона `catalog-batch-run`, новая запись в `vercel.json` не нужна.

**Генерация (интерактивная):**
1. Проверить идентичность → иначе 401.
2. Проверить доступ к слоту по его признаку тарифа (§2.1).
3. `plans.assertCanSpendUser(userId)` — общий суточный бюджет.
4. `sketchQuota.assertAvailable(userId, 'interactive')` → иначе 429.
5. Взять замок:
   - сессионные слоты — `sessions.claimWork(sessionId, 'sketch', 90_000)`; новый вид `'sketch'` добавляется в `WORK_KINDS` (`common/session.service.ts`);
   - остальные — `@RateLimit({ name: 'ai-sketch', limit: 10, windowSec: 60 })` и `pg_advisory_xact_lock(hashtext('sketch:' + targetType + targetId + subId))`.
6. _(аудит А-20)_ Прочитать слот и оригинал (`blob.downloadBuffer`), посчитать `sourceHash`, уменьшить до 1536 px по длинной стороне. Для ресайза в зависимости бэкенда добавляется `sharp` (сейчас есть только `pngjs`, он не умеет JPEG и ресайз). Работу `sharp` на Vercel проверить в фазе 0.
7. Вызвать Gemini с таймаутом 60 с _(аудит А-6)_.
   - Исключение или сетевой сбой (ответа нет) → расход не пишется, квота не тратится; в журнал пишется `ImageSketch(status='failed')`; ответ 502.
   - Ответ получен → `aiUsage.recordGemini(response, { operation: 'ai-sketch', model, sessionId?, userId })`. `userId` обязателен.
8. Если в ответе нет `inlineData` (или `finishReason` ∈ {`SAFETY`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`}) → `ImageSketch(status='refused')`, ответ 422.
9. Иначе `blob.uploadBuffer('sketches/{userId}/{id}.png')` → `ImageSketch(status='candidate', expiresAt=now+24h)`.

**Применение** _(аудит А-4)_. Сессионные слоты пишутся сырым `updateSession`, поэтому общей транзакции Prisma с ними нет. Порядок действий и откат:
1. `updateMany({ where: { id, status: 'candidate', userId }, data: { status: 'applied', appliedAt } })`. Если затронуто 0 строк → 409. Это и есть атомарный захват.
2. Сверить `sourceHash` с текущим оригиналом. Не совпало → вернуть кандидату статус `candidate`, ответ 409.
3. `writeActive` в слот. Для сессии сброс одобрения (§4, п. 9) делается тем же вызовом `updateSession`.
4. `updateMany` прежних `applied` того же слота → `superseded`.
5. Для S2 — обновить публичные страницы сессии (§4, п. 11).
6. Если шаг 3 упал — вернуть кандидату статус `candidate` и пробросить ошибку.

Для Prisma-слотов (S4–S6) шаги 1, 3 и 4 выполняются в одной `prisma.$transaction`.

**Удаление оригинала** идёт в порядке §4, п. 10: `findSharedRefs` → `propagateSketch` (по одной записи, идемпотентно) → `deleteOriginalBlob` → проставить `originalDeletedAt` / `originalDeleted`. Если процесс упал посередине, повторный вызов доводит операцию до конца: Blob удаляется только после того, как все ссылки успешно обновлены.

### 6.5 Синхронизация снимков _(аудит А-15)_

`SnapshotVoiceSyncService` (`modules/generation/snapshot-voice-sync.service.ts`) переименовывается в `SnapshotSyncService` и обобщается. Перед первым рендером (`POST /sessions/:id/generate`) он подтягивает:
- голос (как сейчас);
- активные варианты персонажей и сцен бренда, если `assetsEditedAt[ключ]` пуст;
- активный вариант товара из `ProductItem` (`session.productItemId`), если фото товара в сессии вручную не перезагружали.

Режим озвучки по-прежнему не трогается.

### 6.6 Журнал для юридических целей

`ImageSketch` — одновременно и журнал. В нём видно, кто и когда сделал скетч, от какого файла (`sourceHash`), какой моделью и каким промптом (`promptHash`), когда его применили, а также отказы и сбои.
- Записи **не удаляются** при удалении слота, сессии или бренда: `targetId` — строка без FK.
- При удалении пользователя записи удаляются каскадом (`onDelete: Cascade`), как и остальные его данные.
- Записи хранятся **3 года** с `createdAt` — это общий срок исковой давности в Украине. Удаляет их шаг крона `cleanup-sessions`. Файлы удаляются по правилам §6.7.
- Gemini встраивает в результат невидимую маркировку SynthID; это отражено в §11.

### 6.7 Уборка (шаг крона `sweep-orphans`)

- `candidate` с `expiresAt < now` → статус `expired`, Blob удаляется, `pathname`/`url` обнуляются.
- `superseded` старше 30 дней → Blob удаляется, `pathname`/`url` обнуляются, запись остаётся.
- `applied` не удаляются, пока существует слот. Когда сессию мягко удаляют (этап 89) или удаляют бренд или товар, Blob скетча удаляется вместе с сущностью (префикс `sketches/`, по списку `ImageSketch` с этим `targetId`). Запись остаётся по правилам §6.6.
- Бюджет времени шага — по образцу `SWEEP_TIME_BUDGET_MS`.

### 6.8 Закрытие найденных дыр в соседнем коде — _сделано 17.09.2026_

| Место | Проблема | Исправление |
|---|---|---|
| `POST sessions/:sid/characters/:cid/preview` | нет тарифного гейта и лимита; `userId` не передаётся в `recordGemini` | гейт `characterReplacement`, квота §8.2, передавать `userId` |
| `POST …/preview/use-as-photo` | нет гейта `characterReplacement`; `previewPathname` от клиента не сверяется с `sessions/{sid}/character-preview-` | добавить гейт и проверку префикса |
| `POST brand-manifests/…/characters/from-session-cast` | `photoPathname` от клиента без проверки префикса; PNG сохраняется как `image/jpeg` | брать путь из слота сессии на сервере; MIME — из `head()` |
| `common/gemini-image-model.ts`, `common/ai-pricing.ts` | модель по умолчанию отключается 02.10.2026 | фаза −1 |

---

## 7. Фронтенд

### 7.1 Компоненты

- `frontend/src/features/sketch/SketchButton.tsx` — кнопка; учитывает доступ к слоту, гостя и квоту.
- `frontend/src/features/sketch/SketchSheet.tsx` — окно из §3.2.
- `frontend/src/features/sketch/SketchBadge.tsx` — бейдж и меню из §3.3.
- `frontend/src/features/sketch/SketchQuota.tsx` — счётчик и CTA тарифа (§8.4).
- `frontend/src/features/sketch/SketchPolicyCard.tsx` — политика бренда (§3.5).
- `frontend/src/services/sketch-api.ts` — `generateSketch`, `listSketches`, `getSketchQuota`, `applySketch`, `revertSketch`, `deleteOriginal`, `startProjectSketchBatch`, `startBrandSketchBatch`, `getSketchBatch`.
- Тип `SketchTarget` повторяет серверный `targetType`. Новые признаки тарифа добавляются в `PlanFeature` фронтенда (`frontend/src/types/index.ts`).

### 7.2 Встраивание

| Слот | Файл | Место |
|---|---|---|
| S1 | `CharacterCasting.tsx` | вкладки «Фото», «Бренд», «Описание» |
| S2 | `components/ImageUpload.tsx` | под превью фото товара |
| S3 | `ReferenceSlotsPanel.tsx` | карточка сцены; пометка варианта у слотов |
| S4, S5 | `features/brand/ManifestScreen.tsx` (`AssetsBlock`) | карточка ассета; `SketchPolicyCard` |
| S6 | `features/projects/ItemScreen.tsx` | блок фото; пакетная кнопка — на экране проекта |
| S7 | экран импорта фида | переключатель `autoSketch` |
| сводка | `GenerationWizard.tsx` | пометки из §3.4, кнопка «Сделать скетчи», блокировка по политике |

После `apply`, `revert` и `delete-original` родительский компонент обновляет слот из ответа. У сессионных слотов мастер дополнительно перечитывает промпт: одобрение могло сброситься (§4, п. 9). Превью и миниатюры помечаются `data-qa-mask`, чтобы их не учитывал крон UI-снимков.

### 7.3 Тексты

Секция `sketch` в `frontend/src/dictionaries/{ru,uk,en,de,es}.json`:
- `button`, `title`, `guestOnly`;
- `sourceImage`, `sourceText`, `sourceTextHintPeople`;
- `styleLabel`, `styles.{pencil,lineart,flat,watercolor}`;
- `optAnonymize`, `optAnonymizeLocked`, `optRemoveLogos`, `optKeepColors`;
- `renderingLabel`, `rendering.{realistic,stylized}`, `renderingRealisticNote`;
- `generate`, `busy`, `busyHint`, `another`, `apply`, `cancel`;
- `quotaLine` («Скетчей: осталось {{day}} сегодня · {{month}} в этом месяце»), `quotaDayOver`, `quotaMonthOver`, `upgradeCta`;
- `errSafety`, `errFailed`, `errStale`;
- `badge`, `revert`, `showOriginal`;
- `deleteOriginal`, `deleteOriginalConfirm` (с фразой «Уже созданные ролики не изменятся»), `originalDeleted`;
- `autoApplied`;
- `summaryOriginal`, `summarySketch`, `summaryFirstFrame`, `summaryReference`, `summaryPeopleWithoutSketch`, `sketchAll`;
- `policyTitle`, `policyPeople`, `policyObjects`, `policyBlocked`, `policyLocked`;
- `batchStart`, `batchProgress`, `batchDeferred`, `feedAutoSketch`.

После правки словарей нужно пересобрать `backend/src/modules/assistant/knowledge/generated.ts` (`npm run prebuild` в backend), иначе падает проверка совпадения.

В словари лендинга (`landing/src/dictionaries`), в раздел ассистента, добавляется короткий абзац о функции. Отдельный визуальный блок на лендинге — вне этого ТЗ.

---

## 8. Тарифы, квоты, экономика

### 8.1 Признаки тарифа

| Признак | Lite | Standard | Premium |
|---|---|---|---|
| `aiSketch` (интерактивные скетчи) | ✅ | ✅ | ✅ |
| `aiSketchBatch` (пакеты, автоскетч фида, политика бренда) | — | — | ✅ |

Оба признака добавляются в `backend/src/common/plans.ts` (`PlanFeature`, таблицы `ALL` / `PLANS`, русские подписи) и в `frontend/src/types/index.ts`.

**Почему скетч есть на всех тарифах:**
- юридическая защита нужна прежде всего массовому бесплатному пользователю;
- это дешёвый «крючок»: на Lite доступны только S2 и S6;
- квоты — естественная точка апсейла.

### 8.2 Квоты _(аудит А-6, А-19)_

**Что считается.** Квоты считаются по **оплаченным вызовам** — строкам `ai_usage` с `operation='ai-sketch'`:
- сбои, после которых ответа нет, не засчитываются;
- отказы модели по безопасности засчитываются;
- пакеты считаются по строкам `ImageSketch` с `auto=true` за месяц.

**Как считается.** Новый метод `AiUsageService.countSince(userId, operation, since)`. `countToday` остаётся обёрткой над ним. Месячная граница — уже существующий в сервисе `monthStart()` (UTC).

| Квота | Lite | Standard | Premium | env |
|---|---|---|---|---|
| Интерактивных в сутки | 3 | 15 | 50 | `AI_SKETCH_DAY_LITE/STANDARD/PREMIUM` |
| Интерактивных в месяц | 20 | 150 | 600 | `AI_SKETCH_MONTH_LITE/STANDARD/PREMIUM` |
| Пакетных в месяц | — | — | 1000 | `AI_SKETCH_BATCH_MONTH_PREMIUM` |

- Все значения дублируются в админке (`env-settings.ts`) и меняются без редеплоя.
- Превью персонажа (§5.4) расходует ту же интерактивную квоту — буквально ту же: операции `ai-sketch` и `character-preview` считаются ОДНИМ счётчиком (`IMAGE_OPERATIONS`), иначе фактический потолок вдвое выше объявленного _(аудит реализации A-10)_.
- Параллельные запросы не пробивают лимит: перед платным вызовом создаётся бронь (`ImageSketch(status='pending')`), и квота считается как расход плюс чужие живые брони, созданные раньше. Протухшие брони уборка переводит в `failed`.
- Поверх квот продолжает действовать общий суточный бюджет тарифа (`DAILY_SPEND_LIMIT_USD_*`, `assertCanSpendUser`).

### 8.3 Себестоимость _(аудит А-1, А-19)_

Ориентиры по сторонним сводкам (март 2026, для preview-версии `gemini-3.1-flash-image`):
- интерактивно, 1K — ≈ **$0.067** за изображение;
- через Batch API, 1K — ≈ **$0.034**.

**Перед релизом сверить цены на официальной странице Google** и записать фактические ставки в `ai-pricing.ts` (`MODEL_RATES`).

Худший случай — все квоты выбраны полностью, за месяц:

| Тариф | Цена (по умолчанию, `billing-pricing.ts`) | Интерактив | Пакеты | Итого максимум |
|---|---|---|---|---|
| Lite | 0 | 20 × $0.067 ≈ $1.3 | — | ≈ $1.3 |
| Standard | 799 ₴ (≈ $19) | 150 × $0.067 ≈ $10 | — | ≈ $10 |
| Premium | 1999 ₴ (≈ $48) | 600 × $0.067 ≈ $40 | 1000 × $0.034 ≈ $34 | ≈ $74 |

На практике используется малая доля квоты: скетч делают один раз на персонажа или товар и дальше переиспользуют.

У Premium худший случай выше цены тарифа — это осознанный риск. Его ограничивают суточный бюджет Premium ($100 в сутки) и месячная квота пакетов. Если за первый месяц полностью выберут квоту больше 5% пользователей, квоты пересматриваются через env, без релиза.

В `ai-pricing.ts` добавляются:
- операция `'ai-sketch'` в `AiOperation` и `AI_OPERATION_LABEL` («ИИ-скетч»);
- ставки новой модели;
- для пакетных вызовов — модель `…-batch` со ставкой со скидкой, чтобы отчёт расходов был точным.

### 8.4 Монетизация _(аудит А-19)_

1. **Апсейл по квоте.** Ответ 429 содержит `upgrade: 'STANDARD' | 'PREMIUM' | null`. По нему `SketchQuota` показывает CTA «Больше скетчей на Standard» или «Пакеты и автоскетч на Premium»; кнопка ведёт на существующий экран тарифов.
2. **Замок Premium на политике и пакетах** (§3.5, §4.6) виден пользователям Standard.
3. **Пакет «Скетч+»** (фаза 3) — докупка +500 пакетных скетчей сверх квоты Premium.
   - Оплата через Stars/WayForPay, тем же механизмом, что пакеты роликов: `CREDIT_PACK` → новое назначение `SKETCH_PACK`.
   - Кредиты роликов на скетчи **не тратятся**: кредит в проекте — это оплаченный ролик (`CreditLedgerService`), смешивать единицы нельзя.
   - Пока пакета нет, CTA ведёт в поддержку.
4. **Метрики.** События воронки в `logWorkflowStage` не нужны. В админке (§9) показываются:
   - скетчей в день;
   - доля применённых;
   - доля выбора «Реалистично»;
   - отказы модели;
   - срабатывания 429 по тарифам;
   - клики на CTA тарифа — событие `upgrade_cta_clicked` в существующей аналитике экрана тарифов, если она есть; иначе счётчик в `PlatformSetting`.

---

## 9. Админка

- **«Сессии» и карточка сессии:** пометка «ИИ-скетч» у слотов, ссылки на оригинал и скетч, `sourceHash`, модель, дата применения.
- **«Генерация → ИИ-скетчи»:** список `ImageSketch` с фильтрами (пользователь, тип слота, статус, `auto`, отказы), быстрый просмотр, агрегаты из §8.4.
- **«Генерация → Пакеты скетчей»:** список `ImageSketchBatch`.
- **Отчёт расходов:** операция «ИИ-скетч» появляется сама через `AI_OPERATION_LABEL`.
- **Настройки:** квоты из §8.2, `GEMINI_SKETCH_MODEL`, стиль по умолчанию, флаги отката из §13.

---

## 10. Нефункциональные требования и риски

| Тема | Требование / риск | Мера |
|---|---|---|
| Время ответа | Генерация 5–20 с; потолок функции Vercel — 300 с | таймаут вызова 60 с, `maxDuration` маршрута 90 с |
| Размер входа | Оригиналы до 10 МБ | ресайз до 1536 px через `sharp` (§6.4) |
| Надписи товара | Модель искажает текст | опция «Убрать логотипы»; подпись в UI «надписи могут отличаться» |
| Узнаваемость лица | Обезличивание не гарантировано | обязательно для людей (§4, п. 3); ручная проверка в превью; оговорка в §11 |
| Стиль в видео | Veo/Grok копируют рисовку | `sketchRendering` (§5.5); проверка в фазе 0 |
| Первый кадр | Ролик начинается со скетча | принудительный режим референсов (§5.6) |
| Разделяемые оригиналы | Удаление ломает сессии и страницы | обновление ссылок до удаления (§4, п. 10) |
| Hedra | Липсинк со скетч-лицом может работать хуже | `realistic` для аватара; проверка в фазе 3; если не работает — понятный отказ аватару со скетчем |
| Гонки | Двойное нажатие, два таба | `claimWork('sketch')` / advisory lock; атомарный `apply` (§6.4) |
| Безопасность | Клиент подменяет пути | пути только с сервера (§6.2); `isOwnBlobUrl` в генерации сохраняется |
| Приватность | Скетч — производная от фото человека | считается «Материалами Пользователя»; удаляется вместе со слотом (§6.7) |
| Отключение модели | `gemini-2.5-flash-image` — 02.10.2026 | фаза −1; модель задаётся через env/админку |
| Граница суток | Считается по UTC, не по Киеву | тексты UI (§3.2) |

---

## 11. Юридические тексты (черновик для юриста)

**`doc/legal/terms-of-use.md`**
- §3.4 — дополнить: «Для изображения можно создать ИИ-скетч — стилизованную версию, созданную нейросетью. Если скетч применён, в генерацию видео и на публичные страницы передаётся скетч, а не исходное изображение. Исходное изображение можно удалить, оставив только скетч; уже созданные ролики при этом не меняются».
- §5.3 — дополнить: «ИИ-скетч людей по фото создаётся с изменением черт лица, но не гарантирует, что человека не узнают. Для максимальной защиты создавайте скетч по описанию. Ответственность за права и согласия на исходное изображение остаётся за Пользователем».
- Новый пункт: «Изображения, созданные ИИ, могут содержать невидимую маркировку их происхождения».
- Новый пункт в §3: «Фото товара при загрузке анализируется, чтобы определить категорию и найти аналоги; создание скетча на этот анализ не влияет».

**`doc/legal/offer.md`**
- §2 — добавить в «Материалы Пользователя» производные изображения (ИИ-скетчи).
- §5.1 — упомянуть, что в режиме «По фото» исходное изображение передаётся модели скетча.
- Новый раздел о товарных знаках (сейчас в оферте его нет): пользователь гарантирует права на логотипы в своих материалах; опция удаления логотипов в скетче вспомогательная и прав не создаёт.

После согласования поднять `LEGAL_VERSION`, чтобы `TermsGate` запросил повторное согласие.

---

## 12. Критерии приёмки и тесты

### 12.1 Приёмка (ручная)

1. Кнопка «ИИ-скетч» есть на S2/S6 в Lite и на S1–S6 в Standard/Premium. Гость видит просьбу войти.
2. «По фото» и «По описанию» дают превью не дольше 20 с; счётчики «сегодня» и «в месяце» уменьшаются.
3. «Ещё вариант» даёт нового кандидата; между кандидатами можно переключаться.
4. «Применить» → на карточке бейдж, в сводке «ИИ-скетч», ролик сгенерирован, в админке у референса `variant=sketch`.
5. Сессия с одним товаром (без персонажей) и скетчем товара → в запросе к Veo/Grok нет первого кадра, товар идёт референсом, ролик не начинается с рисунка.
6. «Вернуть оригинал» → в сводке «оригинал», следующий ролик с оригиналом; одобрение промпта остаётся в силе (§4, п. 9).
7. «Удалить оригинал» у товара проекта, из которого созданы 2 сессии и опубликована 1 страница → обе сессии и страница показывают скетч, Blob оригинала удалён, повтор рендера в админке работает.
8. Фото заменили после применения → слот вернулся к оригиналу; `apply` старого кандидата → 409.
9. Скетч персонажа бренда, применённый после создания сессии, попадает в эту сессию перед первым рендером, если слот в сессии не меняли; если меняли — не попадает.
10. Квоты: 4-й скетч за сутки на Lite → 429 с CTA Standard. Сбой провайдера квоту не уменьшает, отказ модели — уменьшает.
11. На Premium политика бренда блокирует генерацию, пока не применены скетчи; «Сделать скетчи для всех» доводит пакет до конца. На Standard переключатель под замком.
12. Автоскетч фида на Premium: импортированные товары получают скетч с пометкой «применено автоматически».
13. Все тексты есть на 5 языках; `generated.ts` пересобран.

### 12.2 Автотесты (бэкенд, jest)

- **`sketch-prompts.spec.ts`:**
  - для каждой комбинации вида слота, режима и стиля в промпте есть обязательные запреты;
  - у `character + from-image` фраза об изменении черт лица есть всегда, даже при `anonymizeFace=false`;
  - у `photo-preview` нет «Non-photorealistic», но запреты есть;
  - описание экранировано.
- **`active-image.spec.ts`** — для каждого резолвера: оригинал без скетча, скетч при активном варианте, скетч при `originalDeleted`, `null` без изображения.
- **Главный инвариант** (`reference-plan.spec.ts`, `generation.service.spec.ts`, `actors.service.spec.ts`, `shared-video.service.spec.ts`, `catalog-batch-worker.service.spec.ts`): при активном скетче ни `downloadBuffer`, ни `fetchReference`, ни `resolveReferenceUrl`, ни Hedra `submit`, ни `copyBlob` не получают путь или URL оригинала (шпионы на `BlobService` и клиентах). Ветка `legacyFirstFrame` у Veo и Grok проверяется отдельно.
- **`reference-plan.spec.ts`** — скетч товара → `legacyFirstFrame=false`, товар в `images`.
- **`image-sketch.service.spec.ts`:**
  - доступ: 401 для гостя, 403 без доступа к слоту, 404 для чужого;
  - квоты: сутки, месяц, пакеты;
  - расход: `userId` в `recordGemini`; 502 — без записи расхода; 422 — с записью;
  - `apply`: второй параллельный захват → 409; несовпадение `sourceHash` → 409; при сбое записи статус возвращается; прежний скетч становится `superseded`; одобрение промпта сбрасывается;
  - `deleteOriginal`: сначала обновляются все найденные ссылки, потом удаляется Blob; повтор после сбоя посередине доводит операцию до конца.
- **`sketch-targets.spec.ts`** — для каждого `targetType` путь к источнику берётся с сервера, клиентский путь игнорируется.
- **`snapshot-sync.service.spec.ts`** — голос, персонажи, сцены, товар; соблюдаются `voiceEditedAt` / `assetsEditedAt`; если ролик уже есть, синхронизации нет.
- **Уборка** — TTL кандидатов, `superseded` через 30 дней, журнал старше 3 лет.
- **Регресс** на дыры из §6.8.
- **`session.service.spec.ts`** — `'sketch'` есть в `WORK_KINDS`; новых ключей нет в `LIVE_KEYS`.

### 12.3 Фронтенд

- `frontend/scripts/*.test.ts` для чистых функций: состояние окна, выбор кандидата, подписи в сводке, выбор CTA по ответу 429.
- `tsc`, `eslint` (по изменённым файлам) и `vite build` проходят без ошибок.

---

## 13. Решения по открытым вопросам _(аудит А-22)_

Критерий — максимальная коммерческая отдача при сохранении юридической защиты. Каждое решение можно откатить настройкой, без релиза.

| # | Вопрос | Решение | Почему | Как откатить |
|---|---|---|---|---|
| 1 | Режим «По фото» для людей (оригинал уходит в Gemini) | **Разрешён и выбран по умолчанию.** Обезличивание обязательно; «По описанию» рекомендуется подсказкой | качество выше → скетч чаще применяют и доводят до готового ролика; передача ИИ-системе уже покрыта офертой §5.1 | флаг `AI_SKETCH_PEOPLE_FROM_IMAGE=false` → для S1/S4 остаётся только «По описанию» |
| 2 | `sketchRendering=realistic` для людей | **Разрешён, по умолчанию** | реалистичный ролик — основная ценность продукта; лицо вымышленное | флаг `AI_SKETCH_PEOPLE_REALISTIC=false` → для людей принудительно `stylized` |
| 3 | Тарифы | **Всем** (`aiSketch`) с квотами по тарифу; пакеты, автоскетч и политика — **Premium** (`aiSketchBatch`) | массовая защита, «крючок» на Lite, апсейл | таблица признаков и env квот |
| 4 | Кредиты | **Не списываются**; квоты по тарифу плюс пакет «Скетч+» (фаза 3) | кредит — это ролик, смешивать единицы нельзя; отдельный пакет даёт дополнительную выручку | — |
| 5 | Срок хранения журнала | **3 года**; файлы — по §6.7 | срок исковой давности; записи дешёвые | env `AI_SKETCH_JOURNAL_DAYS` |
| 6 | Автоскетч фида | **Включён по умолчанию на Premium**, через Batch API | у фото из фида самый высокий риск чужих прав; Batch API даёт скидку 50% | настройка импорта `autoSketch` |
| 7 | Политика «Только скетчи» | **Фаза 3, Premium** | ценна для агентств; MVP не задерживает | — |
| 8 | Логотипы у собственного товара | **По умолчанию не удалять** (удалять — для фида и сцен) | логотип своего товара обычно принадлежит продавцу; удаление портит рекламу | опция в окне |

---

## 14. План работ

**Фаза −1 — срочно, до 02.10.2026 (0,5 дня)** — _код сделан 17.09.2026 (модель по умолчанию, ставка, квоты превью); остался ручной вызов с боевым ключом, см. §16_
- Сверить на официальной странице Google ID и цену GA-модели изображений.
- Переключить `GEMINI_IMAGE_MODEL` по умолчанию на `gemini-3.1-flash-image`, обновить ставку в `ai-pricing.ts`.
- Проверить `CharacterPreviewService` реальным вызовом.

**Фаза 0 — spike (1–2 дня)** — _не пройдена: нужен боевой ключ, см. §16_
- Реальные вызовы image-to-image и text-to-image: `responseModalities`, отказы, время ответа, соотношения сторон.
- Batch API: создание задачи, опрос, формат результата.
- Работа `sharp` на Vercel.
- Veo 3.1 (Lite и Standard) и Grok со скетч-референсом: режимы `realistic` и `stylized`, скетч товара без персонажей (§5.6).
- Итоги записать в §16.

**Фаза 1 — ядро и сессия (5–7 дней)** — _сделано 17.09.2026_
- Миграция, модуль, резолвер и lint-правило, промпты, квоты, признак `aiSketch`, учёт расходов.
- Слоты S1–S3; правило первого кадра; `SnapshotSyncService` (голос + товар из проекта).
- UI: `SketchButton`, `SketchSheet`, `SketchBadge`, `SketchQuota`; сводка из §3.4.
- Дыры из §6.8; автотесты §12.2 для S1–S3.

**Фаза 2 — бренд, проекты, пакеты (5–6 дней)** — _слоты и пропагация сделаны; пакетный режим и Batch API — нет_
- Слоты S4–S7, обновление ссылок при удалении оригинала, публичные страницы.
- Синхронизация персонажей и сцен бренда; `from-session-cast`.
- `aiSketchBatch`, `ImageSketchBatch`, Batch API, автоскетч фида.

**Фаза 3 — политика и монетизация (3–4 дня)**
- Политика «Только скетчи», Hedra, админка (§9), пакет «Скетч+».
- Юридические тексты и `LEGAL_VERSION` — после согласования с юристом.
- Обновить `doc/API.md`, `doc/ACCEPTANCE-CHECKLIST.md`, `PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`, `doc/TODO.md`.

---

## 15. Журнал изменений v1 → v2 (аудит 17.09.2026)

Аудит сверил ТЗ v1 с кодом репозитория и с актуальными данными о моделях.

| # | Находка в v1 | Серьёзность | Исправление в v2 |
|---|---|---|---|
| А-1 | Модель по умолчанию `gemini-2.5-flash-image` отключается 02.10.2026; цена $0.039 устарела | Критично | Фаза −1; модель `gemini-3.1-flash-image`, константа `GEMINI_SKETCH_MODEL`; новые ставки (§5.1, §8.3) |
| А-2 | Не учтён путь «фото товара — первый кадр» (`legacyFirstFrame`): Veo/Grok читают `productImagePathname/Url` напрямую, минуя `plan.images`. Скетч ушёл бы первым кадром, а оригинал — в обход резолвера | Критично | §5.6; первый кадр добавлен в §2.4 и в тесты инварианта |
| А-3 | «Удалить оригинал» не учитывал разделяемые Blob: сессии из товара ссылаются на фото товара, снимки бренда — на фото бренда. Удаление сломало бы повтор рендера, экспорт и опрос | Критично | §4, п. 10 — обновление ссылок до удаления; порядок и идемпотентность (§6.4); приёмка, п. 7 |
| А-4 | «Применение в одной транзакции» невыполнимо для JSON-слотов сессии: они пишутся сырым `updateSession` вне транзакции Prisma | Высокая | атомарный захват через `updateMany` и откат статуса (§6.4) |
| А-5 | Граница суток указана как 00:00 по Киеву, а в коде `startOfDayUtc` (00:00 UTC = 03:00 по Киеву) | Средняя | тексты §3.2, риск в §10 |
| А-6 | «Сбой не засчитывается, если нет токенов» противоречило подсчёту квоты по строкам `ai_usage` | Средняя | правило «нет ответа — нет записи; отказ — есть запись» (§6.4, §8.2) |
| А-7 | Не было промпта для сцены «По описанию» | Средняя | §5.2 |
| А-8 | Внутренний стиль `photo` противоречил обязательному «Non-photorealistic» | Средняя | §5.4 — отдельный режим с частичным набором требований |
| А-9 | Не учтено, что на Lite нет `characterReplacement`, `referenceAssets`, `brandManifest` | Средняя | колонка «Доступ к слоту» в §2.1; `aiSketch` на всех тарифах |
| А-10 | Не описано, что происходит при применении скетча к персонажу `kind:'text'` (без фото) | Средняя | только «По описанию» (§3.2); переход в `kind:'photo'` со скетчем без оригинала (§6.3) |
| А-11 | Не учтены уже опубликованные страницы шеринга: `keepOwnCopy` копирует фото товара один раз при публикации | Средняя | §4, п. 11 — автоматическая замена копии |
| А-12 | Не упомянут анализ фото товара при загрузке (Gemini `product-photo`, SerpApi Lens), из-за чего создавалось неверное ожидание «оригинал никуда не уходит» | Средняя | §2.3, §11 |
| А-13 | Не описан гость (сессия без `userId`), хотя журналу нужен `userId` | Средняя | §4, п. 12; `userId` обязателен в `ImageSketch` |
| А-14 | Не указаны обратные связи `User` для новой модели; не было таблицы пакетов | Низкая | §6.1 |
| А-15 | Синхронизация перед рендером была описана только для бренда: не учтены сессии из товара проекта и признак ручной правки ассетов | Средняя | §4, п. 8; §6.5; `assetsEditedAt` |
| А-16 | Повтор рендера в админке и экспорт яруса B не были указаны как потребители | Низкая | §2.4 |
| А-17 | `DELETE` с телом | Низкая | `POST /sketches/delete-original` |
| А-18 | Неполный список потребителей: не было `project.service.ts` (выдача товаров) и `prompt.service.ts` | Низкая | §2.4 |
| А-19 | Пакеты по интерактивной цене; не было месячных квот и апсейла | Коммерческая | Batch API (−50%), месячные квоты, CTA, пакет «Скетч+» (§4.6, §8) |
| А-20 | Предполагалось, что `sharp` уже в зависимостях, но его нет (есть только `pngjs`) | Низкая | явное добавление и проверка на Vercel (§6.4, фаза 0) |
| А-21 | Отдельный крон для пакетов раздул бы `vercel.json` | Низкая | шаг внутри `catalog-batch-run` (§6.4) |
| А-22 | Открытые вопросы оставались без решений | — | §13 с флагами отката |
| А-23 | Неверные имена в коде: `ProductFeedImport` (в схеме — `ProductFeedImportRun`/`ProductFeedImportItem`), `SessionScene` (в типах — `SceneAsset`) | Низкая | §6.1, §6.3 |

---

## 16. Итоги spike

**17.09.2026 — фазы 1–2 в коде (что уже работает):**
- Модель данных: таблица `image_sketches` + `activeSketchId`/`originalDeletedAt` у персонажа бренда, сцены бренда и товара проекта; миграция `20261121090000_image_sketches` проверена на локальном PostgreSQL 16.
- Резолвер `common/active-image.ts` и правило ESLint не нужны: прямых чтений `photoUrl`/`productImagePathname` в генерации не осталось — план референсов, оба пути первого кадра (Veo и Grok), снимок бренда и товара, публичные страницы, партии по каталогу и Hedra ходят через резолвер.
- Промпты `common/sketch-prompts.ts`: обязательные «это рисунок» и запреты, обезличивание лица у фото людей, описание как данные.
- Модуль `modules/image-sketch`: `POST /sketches`, `GET /sketches`, `GET /sketches/quota`, `POST /sketches/:id/apply`, `POST /sketches/revert`, `POST /sketches/delete-original`; квоты по тарифу, три исхода вызова модели (ok/refused/failed), атомарное применение с откатом, пропагация скетча по ссылкам перед удалением оригинала, сброс одобрения промпта.
- Признак тарифа `aiSketch` (все тарифы), операция расхода `ai-sketch`, вид работы `sketch` в `WORK_KINDS`, уборка кандидатов и вытесненных файлов шагом крона `cleanup-sessions`.
- Синхронизация перед первым рендером: голос (как раньше) плюс скетчи бренда и товара проекта.
- Фронтенд: `SketchButton`, `SketchSheet`, `SketchBadge`, `SketchSlotActions`, `sketch-api.ts` и встраивание во все шесть слотов; тексты на 5 языках.
- Тесты: промпты, резолвер, план референсов со скетчем, сервис скетча (квоты, 429/422/502, apply/revert/delete), синхронизация снимка.

**Чего ещё нет (осознанно):** пакетный режим и Gemini Batch API (§4.6), автоскетч фида, политика «только скетчи» (§3.5), раздел админки (§9), пакет «Скетч+» (§8.4), правки юридических текстов (§11).

**17.09.2026 — фаза −1 и §6.8 в коде:**
- `GEMINI_IMAGE_MODEL` по умолчанию — `gemini-3.1-flash-image` (`DEFAULT_GEMINI_IMAGE_MODEL`); ставка $60/1M выходных токенов в `ai-pricing.ts` — из вторичных источников, **сверить** на официальной странице до 02.10.2026.
- Превью персонажа: гейт `characterReplacement` и бюджет до вызова модели (`CastingService.assertPreviewAllowed`), квоты по тарифу (`common/image-generation-quota.ts`, env `AI_SKETCH_DAY_*`/`AI_SKETCH_MONTH_*`), `userId` в учёте расхода, `AiUsageService.countSince`; сбой без ответа модели квоту не тратит; описание подставляется как данные, в промпт добавлены запреты §5.4.
- `use-as-photo`: копируется только `sessions/{sid}/character-preview-{cid}.(png|jpg)`; `confirmPhoto` проверяет `characterReplacement`.
- `from-session-cast`: путь сверяется с сессией владельца и её кастингом до создания персонажа; тип файла — по расширению (PNG больше не сохраняется как JPEG).
- Фронтенд: двойной клик на младшем режиме запрос не шлёт; под превью — «осталось N из M».
- **Не проверено вживую** (нет ключа в этой среде): ID модели, формат ответа (`responseModalities: ['Image']`), фактический расход токенов на картинку.

_Заполняется по итогам фаз −1 и 0: ID и цена модели, формат `responseModalities`, отказы, время ответа, Batch API, `sharp` на Vercel, поведение Veo 3.1 Lite/Standard и Grok со скетч-референсом (оба режима `sketchRendering`, товар без персонажей)._
