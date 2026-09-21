# Аудит: админские эндпоинты аукциона отдавали не тот вид карточки

**Дата:** 2026-09-21
**Область:** `backend/src/modules/auction/{auction.service.ts, auction.controller.ts}`
**Повод:** проверка нового `POST /admin/auctions/:id/studio` при добавлении
UI назначения студии (`admin/src/app/auctions/page.tsx`) — сверка ответа
эндпоинта с тем, что реально ожидает фронтенд, вскрыла тот же дефект в
трёх СУЩЕСТВУЮЩИХ соседних эндпоинтах, появившихся ещё на Этапе 2, до
всей работы над живым аукционом.

## Найдено и исправлено

### HIGH — `adminApprove`/`adminReject`/`adminConfirmPayment`/`assignVirtualStudio` возвращали `AuctionListingView`, а не `AdminAuctionListingView`

Админ-фронтенд (`admin/src/lib/endpoints.ts`) всегда ожидал от всех
четырёх admin-эндпоинтов полный `AdminAuctionListing` — тип с
`portfolioItemTitle`/`portfolioItemVideoUrl`/`creatorDisplayName`/
`currentPriceUahEquivalent` (`apiPost<AdminAuctionListing>(...)` для всех
четырёх функций-клиентов). Но на бэкенде `AuctionService.adminApprove()`,
`adminReject()`, `adminConfirmPayment()` (все — Этап 2, задолго до
живого аукциона) и мой собственный новый `assignVirtualStudio()` (Этап
5/§7.8) строили ответ через `toOwnView()` — обычный `AuctionListingView`,
БЕЗ этих четырёх полей.

Реальный эффект на экране: `admin/src/app/auctions/page.tsx`'s
`replace(updated)` подставляет ответ эндпоинта прямо в строку таблицы —
после клика «Одобрить»/«Отклонить»/«Подтвердить оплату вручную» превью-
видео, заголовок лота и ссылка на исполнителя в этой строке пропадали
(становились `undefined`) до следующего полного `load()`. У трёх старых
эндпоинтов это маскировалось тем, что `load()` вызывается сразу следом
(`replace(updated); load();`) — видимый эффект был лишь секундной
вспышкой неполной строки на медленном соединении, а не постоянной
поломкой, поэтому не был замечен раньше. У новой кнопки «Назначить
студию» я `load()` после `replace()` не вызывал вовсе (в этом не было
технической необходимости — статус лота не меняется) — без общего
`toAdminView()` эта строка осталась бы сломанной ПОСТОЯННО, не на
секунду, что и обнаружило проблему при проверке.

**Фикс:** во всех четырёх методах re-fetch/update теперь берёт
`include: { portfolioItem: true, creatorProfile: { include: { user: true } }, bids: true }`
— тот же include, что уже использует `adminList()` — и отдаёт результат
через `toAdminView()`, а не `toOwnView()`. Возвращаемый тип методов
сервиса и соответствующих методов `AdminAuctionController`
(`approve`/`reject`/`confirmPayment`/`assignStudio`) изменён с
`Promise<AuctionListingView>` на `Promise<AdminAuctionListingView>`.
`adminReject()` — единственный без отдельного re-fetch (ставок у только
что отклонённой заявки быть не может по построению) — `bids: []`
подставляется в объект перед `toAdminView()`, отдельный запрос не нужен.

## Проверено вручную

Баланс скобок в обоих изменённых файлах сошёлся. Проверено, что
`AuctionListingView`/`AdminAuctionListingView` оба остаются
использованными (не осиротевший импорт) в `auction.controller.ts` —
первый всё ещё нужен `AuctionController`'s `create`/`mine`/`withdraw`
(владельческие маршруты, которым полный admin-вид не нужен и не должен
быть виден). `npm install`/`tsc --noEmit` в этой песочнице по-прежнему не
проходят — рекомендуется прогнать после мержа, отдельно проверив вручную
`admin/src/app/auctions/page.tsx` после клика «Одобрить»/«Отклонить»/
«Подтвердить оплату»/«Назначить студию» — строка не должна терять
превью/заголовок/ссылку на исполнителя ни на миг.
