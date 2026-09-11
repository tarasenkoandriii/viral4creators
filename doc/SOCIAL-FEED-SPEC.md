# Лента, лайки и репосты — ТЗ (этап 80, TODO §III п.9)

## 0. Что это и почему сейчас

`doc/TODO.md`, раздел III («Крупные направления, по убыванию отдачи»),
пункт 9: «Мини-соцсеть внутри продукта: лента опубликованных роликов,
лайки, репосты, право публикации — у платного и незаблокированного
подписчика». Пункты 1–8 того же списка уже сделаны (этапы 52–68); это —
следующий по рангу, выбран владельцем продукта явно (см. историю сессии).

Документ-ТЗ пишется перед кодом (как и у обучалки/воронки/A-B) — сама
задача больше, чем один экран, и несколько «что решить» пунктов TODO
нужно зафиксировать письменно, а не решать по ходу правки кода.

## 1. Что уже есть и на чём это строится

Item 1 того же списка («Публичная страница ролика и петля шеринга», этап
60) уже дал ровно ту инфраструктуру, которая нужна «ленте» — это НЕ новая
подсистема, а надстройка над `SharedVideoPage`:

- **Модерация уже есть.** `SharedVideoService.approve/reject`,
  вкладка `admin/src/app/shared-videos/page.tsx` — то же
  `PENDING → PUBLISHED/REJECTED`, что и у публикации на YouTube/TikTok.
  Лента показывает только уже одобренные (`status = PUBLISHED`) страницы —
  отдельной модерации для самой ленты заводить не нужно.
- **«Право публикации только у платных» уже частично есть.**
  `SharedVideoService.create()` вызывает
  `this.plans.assertUser(userId, 'publication')` — тот же `PlanFeature`,
  что и у выгрузки на YouTube/TikTok, доступен от Standard и выше
  (`common/plans.ts`). Отдельного `PlanFeature` под ленту заводить не
  нужно — «выпустить ролик наружу» уже одно понятие для всех похожих
  функций (комментарий в коде это явно фиксирует).
- **Чего не хватает — блокировки.** `create()` сегодня НЕ проверяет
  `User.isBlocked` — заблокированный пользователь технически может
  поставить ролик на модерацию (то, что модерация его потом отклонит,
  не оправдание — проверка должна быть на входе, не только через
  оператора). `PlanService.assertUserNotBlocked(userId)` уже существует
  (используется в других местах платных вызовов) — это ровно один вызов,
  без новой логики.

## 2. Кто размещается на «внутри продукта», а не на лендинге

TODO явно говорит «мини-соцсеть **внутри продукта**» — это TMA
(`frontend/`), не публичный лендинг. Причина техническая, не только
формулировка: лайк привязан к Telegram-идентичности
(`TelegramIdentityGuard`/`req.telegramUserId`), а она доступна только
внутри TMA (initData Telegram Web App передаётся лишь настоящим Mini
App, не произвольной странице лендинга, открытой в браузере Telegram) —
у лендинга такой идентичности нет и быть не может без переноса всего
логина. Публичная страница `landing/video/:id` (item 1) продолжает быть
самостоятельной точкой входа для НЕ вошедших (её трогать не нужно) —
лента её не заменяет, а добавляет внутрипродуктовый способ смотреть
чужие ролики подряд и взаимодействовать с ними, не выходя из TMA.

Решение (осознанное сужение объёма): в этой стадии лента и лайки — ТОЛЬКО
в TMA. Публичная витрина-галерея на лендинге (аналог блога/RSS, item
II.3/II.4) сюда НЕ входит — это отдельная возможная надстройка над тем же
публичным `GET /shared-video/feed`, но не требуется ни ТЗ, ни этим
пунктом; если понадобится — заводится отдельным ТЗ.

## 3. Данные

### 3.1. `SharedVideoPage` — два новых счётчика

```prisma
likeCount  Int @default(0)
shareCount Int @default(0)
```

Денормализованные счётчики (тот же приём, что `viewCount`/
`firstGenerationCount`) — сортировка и отображение в ленте не должны
каждый раз считать `COUNT(*)` по лайкам.

### 3.2. Новая модель `SharedVideoLike`

```prisma
model SharedVideoLike {
  id     String @id @default(cuid())
  userId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  sharedVideoPageId String
  sharedVideoPage   SharedVideoPage @relation(fields: [sharedVideoPageId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())

  // Один лайк на пользователя на страницу — и защита от накрутки (TODO
  // §III.9: "лайк привязан к Telegram-пользователю, иначе накрутка ничего
  // не стоит"), и естественная идемпотентность повторного POST.
  @@unique([userId, sharedVideoPageId])
  @@index([sharedVideoPageId])
  @@map("shared_video_likes")
}
```

`onDelete: Cascade` на обеих связях — лайк не переживает ни удаление
пользователя (везде в схеме так), ни `withdraw()` страницы (у страницы и
так `onDelete: Cascade` не было нужно раньше, потому что `withdraw()` —
явный `delete`, а не FK-каскад с другой стороны; здесь каскад нужен,
чтобы `withdraw()` не падал на висящих лайках).

### 3.3. Миграция

Новый файл `backend/prisma/migrations/20261021090000_shared_video_likes/migration.sql`
(таймстамп больше последней существующей, `20261020090000`):

```sql
-- Этап 80 (doc/SOCIAL-FEED-SPEC.md, TODO §III.9): лента опубликованных
-- роликов внутри TMA — надстройка над уже существующей SharedVideoPage
-- (этап 60). Лайк привязан к Telegram-пользователю (защита от накрутки),
-- один лайк на пару (userId, sharedVideoPageId).
ALTER TABLE "shared_video_pages" ADD COLUMN "likeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shared_video_pages" ADD COLUMN "shareCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "shared_video_likes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sharedVideoPageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_video_likes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shared_video_likes_userId_sharedVideoPageId_key" ON "shared_video_likes"("userId", "sharedVideoPageId");
CREATE INDEX "shared_video_likes_sharedVideoPageId_idx" ON "shared_video_likes"("sharedVideoPageId");

ALTER TABLE "shared_video_likes" ADD CONSTRAINT "shared_video_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_video_likes" ADD CONSTRAINT "shared_video_likes_sharedVideoPageId_fkey" FOREIGN KEY ("sharedVideoPageId") REFERENCES "shared_video_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

## 4. Бэкенд API

Всё в существующем модуле `shared-video` — новых модулей не требуется.

```
GET    /shared-video/feed?cursor=&pageSize=      публичный, лента (PUBLISHED, новые сверху)
POST   /shared-video/:id/share                   публичный, best-effort +1 к shareCount
POST   /shared-video/:id/like                    TelegramIdentityGuard, идемпотентно
DELETE /shared-video/:id/like                     TelegramIdentityGuard, идемпотентно
```

- **`GET /shared-video/feed`** — без гварда (лента технически читаема и
  анонимно, как и одиночная страница), но middleware
  (`TelegramIdentityMiddleware`) всё равно пытается заполнить
  `req.telegramUserId`, когда может (initData/dev-bypass) — используем
  ЭТО опционально, чтобы посчитать `likedByViewer` для уже вошедшего
  пользователя, не требуя его для самого просмотра ленты. Курсорная
  пагинация по `id` (сортировка `createdAt desc, id desc`, `take:
  pageSize + 1` — есть ли следующая страница).
- **`POST /shared-video/:id/share`** — тот же паттерн, что
  `bumpViewCount`: не проверяет статус страницы жёстко (страница уже
  показана клиенту, если он досюда дошёл), сбой — просто `warn`, не
  роняет ответ.
- **`POST/DELETE /shared-video/:id/like`** — требуют identity (реальный
  лайк без личности не имеет смысла), НЕ проверяют `isBlocked` и тариф:
  лайк — бесплатное действие без трат на внешние API, ограничение
  «только платные» в TODO относится к ПУБЛИКАЦИИ, не к лайку («сверх уже
  имеющегося входа регистрации не требуется» — про сам вход, не про
  тариф). Идемпотентны: повторный `POST` на уже лайкнутое — no-op,
  `DELETE` на не лайкнутое — no-op (оба возвращают актуальный
  `likeCount`/`likedByViewer`, а не ошибку).

`SharedVideoService.create()` — единственное изменение в уже
существующем методе: `await this.plans.assertUserNotBlocked(userId);`
сразу после текущей проверки тарифа (см. §1).

## 5. Что решить из текста TODO — принятые решения

- **«Блокировка не стирает опубликованное задним числом»** — уже так по
  устройству: `isBlocked` влияет только на `create()` (заявку на НОВУЮ
  страницу), уже `PUBLISHED` страницы никак не проверяют `isBlocked`
  автора при чтении/показе в ленте. Ничего дополнительно писать не
  нужно — это следствие того, что лента фильтрует только по
  `status = PUBLISHED`, не по состоянию автора.
- **«Лента без наполнения мертва»** — техническое решение (эндпоинт,
  экран) от организационного (когда именно показывать вход в ленту всем
  пользователям) не зависит: эта стадия строит функцию полностью
  рабочей; входная точка на экране «Проекты» — обычная кнопка, не
  требует отдельного фичефлага. Решение о том, когда убрать/акцентировать
  эту кнопку по мере роста числа страниц — остаётся владельцу продукта,
  вне объёма кода.
- **Категории/фильтры ленты** — TODO не требует их для этого пункта
  (это часть §II.4 — RSS по категориям, уже сделано на этапе 58 отдельно
  от этой ленты). Первая версия — одна лента, новые сверху, без фильтра;
  оставлено на будущее расширение, если понадобится.
- **«Репост»** — не заводит отдельной сущности: это счётчик действия
  «поделиться» (`shareCount`), best-effort, по образцу `viewCount`.
  Механика самого шеринга переиспользует уже принятый в проекте паттерн
  `navigator.share` → иначе `navigator.clipboard` (тот же код, что
  `ShareVideoPanel.copyLink` и лендинговый `ShareButtons`), целевая
  ссылка — уже существующая публичная страница `landing/video/:id`
  (ничего нового шарить не нужно, страница item 1 уже играет эту роль).
  Кнопка «Поделиться» внутри `ShareVideoPanel` (владелец делится своим же
  роликом) тоже начинает бампать `shareCount` — тот же счётчик, то же
  действие, просто другая точка входа. Клиентские кнопки шеринга на
  ЛЕНДИНГЕ (`ShareButtons`) сознательно НЕ трогаются в этой стадии —
  лендинг сегодня не делает ни одного клиентского вызова к API (только
  серверные fetch на этапе рендера), и заводить туда новый
  cross-origin-запрос ради одного счётчика — по объёму отдельная, не
  обязательная сейчас правка.

## 6. TMA — экран «Лента»

- Новый роут `{ name: 'feed' }` (`frontend/src/lib/router.ts`).
- `frontend/src/features/feed/FeedScreen.tsx`: список карточек
  (видео `<video controls>`, обложка — `productImageUrl`, заголовок,
  товар/цена если есть), кнопка лайка (сердце, залито — если
  `likedByViewer`, счётчик рядом) и кнопка «Поделиться» (см. §5).
  Пагинация — кнопка «Показать ещё» (курсор из ответа), без
  бесконечного скролла (тот же уровень простоты, что у списков в
  админке).
- Лайк без входа: `POST /like` вернёт 401 — обрабатывается как и другие
  401 в TMA (`isUnauthorized`, см. `ShareVideoPanel`) — кнопка лайка
  показывает мягкую подсказку «войдите через Telegram», не падает
  ошибкой на весь экран.
- Точка входа — кнопка на `ProjectsListScreen` (не четвёртая вкладка
  верхней навигации: в `App.tsx` уже зафиксировано решение не добавлять
  туда четвёртый пункт при 390px, см. комментарий у `AccountNotice`/
  режима — то же ограничение действует и здесь).
- Словари — все 5 локалей (`ru/uk/en/de/es`), как у остального TMA.

## 7. Админка

`admin/src/app/shared-videos/page.tsx` уже показывает `viewCount`/
`firstGenerationCount` в списке — `likeCount`/`shareCount` добавляются
туда же, тем же способом. Новой вкладки/логики не требуется.

## 8. Порядок реализации и проверка

1. `schema.prisma` + миграция (§3), накатать на локальный Postgres 16.
2. Бэкенд: типы → сервис (`listFeed`/`like`/`unlike`/`recordShare` +
   `assertUserNotBlocked` в `create()`) → контроллер → тесты.
3. Фронтенд (TMA): типы → api-функции → `FeedScreen` → роут → точка
   входа → словари.
4. Админка: два новых столбца/полей в уже существующей вкладке.
5. Документы: `doc/TODO.md` (закрыть п.9; отдельно — исправить
   стухшие ✅ у §II.3/§II.4, см. `doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`
   заметку при закрытии), новая запись «Сделано (этап 80…)», числа
   тестов/наборов.
6. `tsc`/`eslint`/`jest` (backend), `tsc`/`eslint`/`vite build`
   (frontend, 15 unit-скриптов), `tsc`/`next lint`/`next build` (admin,
   landing — типы `SharedVideoPageView` расширились, landing собирает
   те же типы через `shared-video-api.ts`), `check-docs.mjs`,
   `sync-legal --check`.
