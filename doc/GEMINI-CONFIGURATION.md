# Gemini: production-конфигурация и проверка

Дата проверки: 2026-10-14. Этот файл описывает реальные настройки и ограничения, а не обещает отсутствие ошибок провайдера.

## Ключ и billing

Платный проект Google AI Studio: Default Gemini Project, `gen-lang-client-0095329325`, project number `55978970218`, аккаунт billing `019E30-A67CD7-9F268D`. При проверке: Tier 1, положительный Prepay balance $9.84, Auto-reload Off, существующий billing account tier cap $250. Покупки, автопополнение и лимиты Google не изменялись.

Отдельный Gemini Onlyfance (`gen-lang-client-0641694175`) — Free tier. Его наличие не подтверждает оплату ключей других проектов.

Существующий ключ платного проекта «Gemini local test» проверен через официальный API и установлен как Secret `GEMINI_API_KEY` в Production `assist-api` и `viral-backend`. Значение ключа не хранится в репозитории. До обновления секреты Vercel нельзя было выгрузить: принадлежность предыдущих значений не подтверждена. Обновление ключа не создаёт новых прав в Google и не меняет модели. Изменение env требует новой готовой выкладки; само успешное сохранение env не подтверждает применение в работающей функции.

## Модели и реальные проверки

У assist-api текущая явно заданная модель — `gemini-3.1-flash-lite` (подтверждена production-журналами). Общий default кода и генератора — `gemini-3.6-flash`; модель изображений и эмбеддинги настраиваются отдельно. Голос Nova `a9fc5a41` не относится к Gemini и не менялся.

Прямой запрос платным ключом: models.list HTTP 200, Flash-Lite generateContent HTTP 200 за 1269 мс, украинский короткий ответ, ненулевые токены. Проверочный запрос использовал thinkingLevel LOW; это не означает, что все production-вызовы уже имеют LOW. Flash 3.6 в отдельном коротком запросе не ответил в пределах 25 секунд. Этот результат не доказывает постоянную недоступность модели и не является причиной менять качество всех генераторов без отдельной приёмки.

Ставка Flash-Lite Standard сверена с Google: $0.25/1M text/image/video input, $0.50 audio input, $0.025 cached text input, $1.50 output включая размышления. Расчёт находится в backend/src/common/ai-pricing.ts и синхронизированной копии sites-backend.

## Таймауты, повторы и расходы

GeminiText повторяет только явный HTTP 503: максимум два повтора с паузами 1/2 секунды в исходном таймауте. Empty/truncated после ответа не повторяются: расход сохраняется. SiteChatModel аналогично ограничивает повторы до первого отданного chunk; ответ после начала стрима не переигрывается. Короткая явная minute quota RetryInfo может повторяться; billing/auth/daily quota не повторяются.

Planner теперь вычисляет стоимость по фактически полученным токенам до записи usage ledger: сбой записи не превращает платный ответ в нулевой расход при settlement. Для successful и empty ответов добавлены регрессии отказа ledger.

В live-voice QA транспортные исключения очищаются от исходного Call log, visitor headers/cookies. Трассы отключены, артефакты содержат только агрегаты и безопасные коды. Временные локальные файлы с ключами удаляются после проверки.

## Приёмка

Готовность означает одновременно: новая production-выкладка с обновлённым env Ready; свежий настоящий ответ через widget API; RU/UK TTS→STT→voiceTicket→chat с WER ≤20%; отдельное живое исполнение многошагового мемо с подтверждениями и доказанным конечным статусом. Прямая проверка Google, зелёный CI, сухой прогон или ручная отправка формы не заменяют эти результаты.

## Источники

- [Gemini troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting): различение отказов и ограниченные повторы.
- [Billing](https://ai.google.dev/gemini-api/docs/billing): Prepay, платные проекты и ограничения.
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing): Standard ставки, включая thinking tokens.
- [Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite): поддерживаемые возможности.

Дополнительная прямая проверка тем же ключом: gemini-embedding-001 HTTP 200, 768 измерений, 2519 мс; Flash-Lite structured JSON HTTP 200, JSON ok=true, STOP, 1081 мс (без thinking override). Ключи обоих имён нормализуются trim; пустое/пробельное основное значение допускает существующий альтернативный ключ. 3 теста каждого сервера прошли.


## Результат production-проверки

b162848 развёрнут: assist-api Ready dpl_8EheQ9LNGEdCw64G5f4JrhrEgXZg с production alias; viral-backend Ready dpl_GVGKnnhMh9w8jgQzwz5dRcweyNzp. Свежий widget chat вернул HTTP 200. UK provider roundtrip полностью прошёл (1 passed, 2.9m, WER ≤20%). Шестишаговое М-1 реально исполнено в отдельной sandbox staging-сессии: после «Да» получены итог страницы и «Готово» виджета. После проверки off сохранён. Эти результаты не объявляют стабильность Flash 3.6, все видео-конвейеры или физические устройства прошедшими приёмку.

Финальный функциональный [CI #38612946838](https://github.com/tarasenkoandriii/viral4creators/actions/runs/38612946838) на b162848 — success: backend, sites-backend, widget, оба TMA и обязательные проверки. Неприменимые jobs skipped не считаются пройденными.
