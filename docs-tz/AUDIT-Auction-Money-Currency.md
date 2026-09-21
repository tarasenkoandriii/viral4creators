# Аудит и исправления: денежные поля аукциона (Float → Int, минорные единицы) + конвертация валют

**Дата:** 2026-09-21
**Область:** `backend/prisma/schema.prisma`, новая миграция
`20261202090000_auction_money_minor_units`,
`backend/src/modules/auction/{auction.service.ts, auction-payment.service.ts}`,
новый `backend/src/common/money.ts`, `backend/src/common/types/marketplace.types.ts`,
`admin/src/lib/types.ts`, `admin/src/app/auctions/page.tsx`,
`backend/src/modules/cron/cron.controller.ts` (побочная находка, см. ниже).

Продолжение `AUDIT-Auction-Full-Pipeline.md` — там пункт 6 («Float,
накопление ошибки округления») был сужен только для расчёта комиссии и
сознательно оставлен открытым вопросом целиком для схемы. По запросу —
закрыть его полностью, с учётом конвертации валют.

## Решение и почему

Два реальных варианта обсуждались: `Decimal(12,2)` (уже используется в
этой схеме, но только для полей бюджета проекта, не для денег) и `Int` в
минорных единицах (копейки/центы) — конвенция, которую уже реально
использует `Payment.amount` в `BillingService`/WayForPay для настоящих
платежей. Выбран **Int в минорных единицах** — совпадение с уже
работающим денежным контуром важнее, чем совпадение с полем бюджета,
которое деньгами не является.

**API-контракт НЕ меняется** — DTO (`CreateAuctionListingDto`,
`PlaceBidDto`) и все *View-типы (`AuctionListingView`,
`PublicAuctionListingView`, `MyBidView`, `BidView`, `AdminAuctionListingView`)
остаются в МАЖОРНЫХ единицах, как и раньше. Конвертация — только на
границах: мажорные → минорные при записи в Prisma, минорные → мажорные
при чтении для View/уведомлений/вызова `BillingService.startAuctionCheckout`
(который сам ожидает мажорные и сам переводит их в минорные для
`Payment.amount` по своей уже существующей конвенции). Новый
`common/money.ts` — `toMinorUnits`/`toMajorUnits`, чтобы не разбрасывать
`Math.round(x * 100)` по коду.

### Мигрированные поля

`AuctionListing.startingPrice/reservePrice/buyNowPrice`, `Bid.amount`,
`AuctionPayment.amount/commission` — все `Float`/`Float?` → `Int`/`Int?`.
Миграция — `ALTER COLUMN ... TYPE INTEGER USING ROUND(x * 100)::INTEGER`,
конвертирует уже накопленные значения без потери данных.

**`PortfolioItem.soldPrice` НЕ мигрирован** — сознательно. Это
read-only витринное поле карточки «Продано» на `/my-portfolio`, уже
отдаётся наружу в публичном API как есть (мажорные единицы), и его
собственное «денежное» назначение — чисто отображение, не участвует ни
в одном сравнении/расчёте. Миграция его типа добавила бы риск (ещё одна
колонка с уже накопленными значениями) без выигрыша в точности —
сравнений с ним нигде нет. Точка записи (`AuctionPaymentService.applySuccess`)
теперь явно конвертирует `AuctionPayment.amount` (минорные) обратно в
мажорные (`toMajorUnits`) перед записью в это поле.

### Все затронутые точки конвертации

- `AuctionService.create()` — `dto.startingPrice/reservePrice/buyNowPrice` (мажорные, с клиента) → `toMinorUnits` при записи.
- `AuctionService.placeBid()` — `dto.amount` (мажорные) → `toMinorUnits` в `amountMinor`; вся арифметика внутри транзакции (сравнение с `floor`, запись `Bid.amount`) — в минорных; `BidView`, возвращаемый наружу, — обратно в мажорных (`toMajorUnits`).
- `AuctionService.notifyWinner()` — текст уведомления форматирует `bid.amount` (минорные, из БД) через `toMajorUnits`.
- `AuctionService.listMyBids()` — `myHighestBid` (минорные, из БД) → `toMajorUnits` в `MyBidView.myBidAmount`.
- `AuctionService.startCheckout()` — `listing.payment.amount` (минорные, из БД) → `toMajorUnits` перед вызовом `BillingService.startAuctionCheckout` (её контракт — мажорные, не тронут).
- `AuctionService.toOwnView/toPublicView/toAdminView` — все денежные поля (`startingPrice/reservePrice/buyNowPrice/highestBidAmount`) конвертируются `toMajorUnits` на выходе.
- `AuctionPaymentService.applySuccess()` — `commission = Math.round(payment.amount * commissionRate)` теперь целочисленно (оба операнда уже целые минорные единицы — упрощение по сравнению с прошлым проходом, где `payment.amount` было Float в мажорных и требовало отдельного округления `*100/100`); `soldPrice: toMajorUnits(payment.amount)` при записи в `PortfolioItem`; `sendSoldNotification` получает уже мажорную сумму для текста уведомления.
- `closeListing()`/`closeExpiredListings()` — амаунты берутся напрямую из `Bid`/`AuctionListing` (уже минорные из БД) и пишутся в `AuctionPayment.amount` без конвертации — весь путь внутри одной единицы измерения, конвертация не нужна.

**Не тронуто намеренно:** `dto/auction.dto.ts` — `@Max(PAYMENT_PROCESSING_MAX)`
и другие валидаторы остаются в мажорных единицах, как и раньше — они
проверяют то, что пришло с клиента, до какой-либо конвертации.

## Конвертация валют — по запросу, привязана к этой же задаче

`backend/src/common/fx-rates.ts` уже существовал (статичная таблица
курсов к UAH, `convertForDisplay()`) но не имел ни одного вызова во всём
проекте — был написан заранее именно для этого случая («зритель из
другой страны видит информационную оценку в своей валюте»), но
неиспользуемая функция — фактически мёртвый код.

**Подключено:** `AuctionService.toAdminView()` теперь вычисляет
`currentPriceUahEquivalent` — UAH-эквивалент текущей цены лота
(`highestBidAmount` либо `startingPrice`, если ставок ещё нет) через
`convertForDisplay()`, `null` при `payoutCurrency === 'UAH'` (конвертация
в саму себя не несёт информации). Причина именно в админке, не на
публичной витрине: оператор модерирует общую очередь из UAH/USD/EUR-лотов
одновременно (`adminList`, сортировка по `auctionType`/`createdAt`, без
группировки по валюте) и раньше не мог на глаз сравнить «что дороже» без
ручного пересчёта — тот самый сценарий, под который и был изначально
написан `convertForDisplay()`.

Прокинуто в типы (`AdminAuctionListingView` в
`backend/src/common/types/marketplace.types.ts`, `AdminAuctionListing` в
`admin/src/lib/types.ts`) и в отображение (`admin/src/app/auctions/page.tsx`
— строка `≈ N UAH` под ценой, с `title`-подсказкой, что это не сумма
сделки).

**Публичная витрина/чек-аут не тронуты** — там платёж всегда идёт в
`payoutCurrency` лота, конвертация там намеренно не нужна (и, согласно
доккомментарию самого `fx-rates.ts`, статичный курс и не должен быть
авторитетным источником для реальной суммы).

## Побочная находка: реальная синтаксическая ошибка в существующем коде

При проверке синтаксиса `tsc` (см. «Проверено» ниже) обнаружено, что 4
JSDoc-комментария (добавленные в предыдущих проходах этой же сессии, до
текущей задачи) содержат буквальную подстроку `*/2` (сокращение от
cron-расписания «раз в 2 минуты», например «тот же тик, что у остальных
`*/2 мин`») — эта подстрока **преждевременно закрывает** сам блочный
комментарий `/** ... */`, оставляя следующий текст комментария как код.
Реальная синтаксическая ошибка, не вопрос стиля — `tsc --noEmit` на
затронутых файлах падал с `TS1005`/`TS1128` и похожими.

Затронуто: `backend/src/modules/auction/auction.service.ts` (комментарий
у `GOOGLE_ADS_PAUSE_ALERT_AFTER_MS`) и `backend/src/modules/cron/cron.controller.ts`
(4 доккомментария у cron-эндпоинтов: `auction-close`, `auction-assess`,
`auction-google-ads-sync`, `portfolio-watermark`).

**Исправлено** — переформулировано без буквального `*/N` внутри
блочных комментариев («тот же тик раз в 2 минуты», вместо cron-нотации).
Два похожих упоминания в `portfolio.service.ts` и
`cron-jobs.service.spec.ts` НЕ трогались — там та же подстрока стоит
внутри построчных `//`-комментариев, где она безопасна (построчный
комментарий не имеет закрывающей последовательности).

Эта находка — прямое следствие уже задокументированного во всех
предыдущих аудитах ограничения песочницы: `npm install` здесь не
проходит, поэтому ни один прошлый проход в этой сессии не мог
фактически прогнать `tsc` на изменённых файлах и полагался только на
ручной подсчёт баланса скобок — который не ловит такие ошибки внутри
самих комментариев. В этом проходе `tsc` (глобально установленный,
версия 6.0.3) удалось запустить точечно на отдельных файлах вне
контекста всего проекта (без резолва импортов) — этого хватило, чтобы
поймать данный класс ошибок.

## Проверено вручную

`npm install` в `backend/` по-прежнему не проходит (`prisma generate` в
`postinstall`) — полноценная компиляция всего проекта, `prisma
migrate`/`prisma validate` и реальный прогон миграции на БД
недоступны. Что удалось сделать в этом проходе, в отличие от предыдущих:

- Точечный `tsc --noEmit` (глобальный `tsc` 6.0.3, без резолва
  импортов проекта — `--moduleResolution node`, отфильтрованы
  ошибки резолва модулей/типов `TS2307/TS2688/TS2792`) на каждом
  изменённом файле по отдельности: `auction.service.ts`,
  `auction-payment.service.ts`, `common/money.ts`, `common/fx-rates.ts`,
  `dto/auction.dto.ts`, `common/types/marketplace.types.ts`,
  `cron.controller.ts` — все чисто, реальных синтаксических ошибок
  не осталось (нашёл и исправил 5 существовавших, см. раздел выше).
- `admin/src/app/auctions/page.tsx` и `admin/src/lib/types.ts` —
  тот же точечный `tsc` с `--jsx react-jsx`: оставшиеся ошибки — все
  `TS7026`/`TS7006`/`TS2591` (нет `@types/react`/`@types/node` в этой
  песочнице), ни одной синтаксической.
- Валидность миграции: `ROUND(x * 100)::INTEGER` — тот же паттерн,
  что уже применяется в `BillingService` (`Math.round(amountMajor *
  100)`), просто на стороне SQL для существующих данных.

**Не удалось и остаётся рекомендацией перед деплоем:** прогнать
`prisma migrate deploy` на копии реальной БД и сверить контрольные суммы
(`SUM(startingPrice)` до/после в мажорном эквиваленте) — раунд-трип
Float → Int может теоретически разойтись на значениях, уже содержащих
артефакты двоичной плавающей точки (именно то, что эта миграция и
устраняет на будущее, но накопленные старые записи стоит сверить перед
переключением). Также рекомендуется полный `tsc --noEmit` на всём
проекте (а не точечно по файлам, как здесь) сразу после того, как
`npm install` станет возможен в целевом окружении.
