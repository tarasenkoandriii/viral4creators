# Реализация: Google Ads для блиц-лотов аукциона (§22)

**Дата:** 2026-09-21
**Область:** `backend/src/modules/auction/google-ads.service.ts` (новый), `auction.service.ts`, `auction.module.ts`, `backend/.env.example`, `marketplace/.../auctions/feed/google-ads.xml/route.ts` (комментарий)

## Контекст

Предыдущий аудит §22 нашёл единственный содержательный пробел: товарный фид (`/auctions/feed/google-ads.xml`) готов, но реального вызова Google Ads API, который создавал/приостанавливал бы кампании, не было. По ответам на уточняющие вопросы: реализуем **Performance Max**, без уже настроенного аккаунта/developer token — значит по требованию **fail-safe**: без credentials код не делает ни одного сетевого вызова, а не падает и не блокирует аукцион.

## Что сделано

Новый `GoogleAdsService` — тонкий REST-клиент (`googleads.googleapis.com/v18`, прямой `fetch`, без тяжёлой gRPC-библиотеки `google-ads-api`, которую всё равно нельзя ни установить, ни протестировать в этой песочнице):

- `isConfigured()` — проверяет 5 обязательных переменных окружения.
- `createBlitzCampaign()` — полная цепочка мутаций: `campaignBudgets` → `campaigns` (Performance Max, `PAUSED`, brand guidelines выключены) → `assetGroups` → текстовые ассеты (заголовки/описания из названия лота) → `assetGroupAssets` (линковка) → изображение превью (скачивается и кодируется в base64, т.к. Google принимает только байты, не ссылку) → попытка включить кампанию (`ENABLED`) последним шагом.
- `pauseCampaign()` — ставит кампанию на паузу.
- Без credentials — сразу `null`/no-op с debug-логом, без единого HTTP-запроса.

`AuctionService` вызывает это **best-effort** (не блокирует и не откатывает основной цикл при сбое):
- `promoteNextQueued()` → `activateGoogleAdsCampaignIfBlitz()` — только для BLITZ, при переходе QUEUED→ACTIVE.
- `withdraw()`, `closeExpiredListings()` (ветка EXPIRED), `closeListing()` (ветка WON) → `pauseGoogleAdsCampaignIfAny()` — при любом уходе из ACTIVE.

Изменений в схеме не потребовалось — `AuctionListing.googleAdsCampaignId` (`TEXT`, без ограничения длины) уже существовал.

## Честные ограничения — прочитать перед реальным включением

Это не «интеграция, которая просто работает после того как вставите ключи». Даже с настоящими credentials:

1. **Conversion goals.** Performance Max требует хотя бы одну настроенную conversion action на уровне аккаунта — это отдельная ручная настройка в самом кабинете Google Ads, вне того, что может сделать этот код. Без неё создание кампании, скорее всего, завершится ошибкой Google — она перехватывается и логируется, лот всё равно остаётся ACTIVE и продаётся без рекламы.
2. **Минимум креативов.** Google требует **минимум 4 разных** горизонтальных marketing image и **4 разных** square marketing image на asset group ([support.google.com/google-ads/answer/17091269](https://support.google.com/google-ads/answer/17091269)). У нас есть только один `thumbnailUrl` на лот — он прикладывается в оба слота, но это заведомо меньше минимума. Видео-ассеты не прикладываются вовсе: Google принимает только видео, уже загруженное на YouTube, а ролики лежат в Vercel Blob — отдельная интеграция (YouTube Data API), не в этом проходе.
3. Из-за (1)–(2) кампания создаётся `PAUSED` и включается отдельным вызовом только после сборки asset group; если Google откажет на этом шаге, кампания остаётся `PAUSED` (деньги не тратятся на заведомо неполную настройку), но `googleAdsCampaignId` всё равно сохраняется — оператор увидит кампанию в кабинете Google Ads и сможет донастроить вручную (добавить креативы, снять с паузы).
4. **Бюджет** — `GOOGLE_ADS_BLITZ_DAILY_BUDGET_MICROS` в валюте самого рекламного аккаунта, не `payoutCurrency` лота (это разные вещи). Дефолт (5 000 000 микро = 5 условных единиц/день) — заведомо условный плейсхолдер, пересмотреть перед включением.
5. **Не проверено живым вызовом.** В этой песочнице нет сети до `googleads.googleapis.com` и нет тестовых credentials. Структура запросов собрана по официальной документации Google Ads API (create-campaign, assets/overview, support-статья 17091269) на момент написания — версия API (`v18`) и точные поля стоит сверить с актуальной документацией перед реальным включением.

## Что нужно от вас, чтобы это заработало

Все переменные — в `backend/.env.example` (новый блок «Google Ads для блиц-лотов»): `GOOGLE_ADS_DEVELOPER_TOKEN` (выдаётся Google по заявке, обычно дни), `GOOGLE_ADS_CLIENT_ID`/`_CLIENT_SECRET`/`_REFRESH_TOKEN` (OAuth2 приложение + разовый consent-флоу), `GOOGLE_ADS_CUSTOMER_ID`, опционально `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC) и `GOOGLE_ADS_BLITZ_DAILY_BUDGET_MICROS`. До этого — код просто ничего не делает, безопасно.

## Проверено вручную (компилятор недоступен)

`npm install` в этой песочнице по-прежнему не проходит (`prisma not found`) — TypeScript-компиляцию и `prisma validate` прогнать не удалось. Проверено вручную: баланс скобок во всех трёх изменённых/созданных файлах, отсутствие изменений схемы (поле уже было), согласованность сигнатуры `closeListing()` в обоих местах вызова. Рекомендуется прогнать `tsc --noEmit` перед деплоем.
