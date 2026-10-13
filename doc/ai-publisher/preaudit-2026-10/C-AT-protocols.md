# C1. Протоколы приёмочных сценариев AT (44 P0)

> Внутренний предаудит. Не является независимым внешним аудитом по плану v1.1 §1; не заменяет внешнее заключение. Цель — подготовить пакет передачи (Приложение B) и снять очевидные дефекты до внешнего прохода.

> **В репозиторий входят только markdown/csv.** Пути вида `logs/…`, `ev/…`, `evidence/…`, `e2e2/…`, `c3/…`, `probe/…` указывают на сырые доказательства в рабочем каталоге предаудита (scratchpad) — они хранятся отдельно и передаются внешнему исполнителю по запросу с ограниченным доступом (план §18); md5 приведены в тексте.

> **Обновление после раунда исправлений Z-2c (13.10.2026).** Статусы карточек не изменились (42 passed, 2 blocked). Финальное дерево перепроверено: jest Publisher 107 наборов / 858 тестов passed (`sb-pub7.json` md5 `734731ad6cc622b641500f854b8427aa`), E2E `--site` 51/51 passed (`pube2e7/e2e.json` md5 `34f1aae3f007c15d1059f886d822d713`). AT-CORE-09 остаётся blocked: заглушку уведомления утвердить больше нельзя (Р-PUB-Z2-26, DEF-C-04), а настоящий текст и `consent_map` не утверждены. Доказательство AT для гейтов D0/закупки теперь — сохранённый прогон qa-catalog (Р-PUB-Z2-27); на стенде он засеян сидом, живого прохождения 44 AT в qa-catalog нет.

Шаблон — «Карточка теста» плана v1.1 §16. Общие поля для всех карточек:

- **Версия:** текущее дерево `/home/claude/v5` (не git); манифест sha256 проверенных файлов — `manifest.sha256` (1 696 файлов, sha256 манифеста `6374e3d020aba44a07e36f088027af8cce57462cf4c34a00fc6d12100f9395c2`); commit будет назначен после доставки.
- **Среда:** песочница Linux, 2 vCPU, 8 ГБ; PostgreSQL 16.13 (:55432, база `sites_pac`, пересоздаётся из всех миграций); Node 24.21.0; jest 29.7 (`-i`, `CI=true` — без базы набор падает, а не пропускается); sites-backend собран из текущего `src` в `c/dist` (`tsc -p tsconfig.build.json`, общий `sites-backend/dist` устарел и не использовался); publisher-site — копия в `c/w/publisher-site`, Next 15.5.27; Chromium 141 (playwright-core 1.56); AI — fake-провайдер, внешней сети нет.
- **Исполнитель:** Claude-агент предаудита C (та же команда, что писала код — не независимо). **Дата:** 13.10.2026 (UTC).
- **Сброс:** jest — каждый файл сам сеет свои кабинеты/продукты (`kind=test`) в общей базе; база пересоздавалась перед прогоном. E2E — свежая база из миграций + `seed.cjs`.
- **Сквозной стенд:** `c/publisher-e2e.pac.sh --site` (копия `scripts/publisher-e2e.sh` с портами 4241/3220, базой `sites_pac`, своим dist и копией сайта; оригинал не правился) → `e2e2/e2e.json` md5 `41a76b23a4772befee500ba41d7e5947`, `e2e2/site.json` md5 `5f19aa705354210bf6500d7572987f55`; итог 49/49 passed. C3 — `c3/c3.json` md5 `f05b9d8efcc2e6f43a16607d97368854`.
- **Шлюзы:** D0 — список 21, Z — список 30 закупки, 42 — дополнительно к D42 (план §13).

Статус «passed» ставится только когда каждый элемент критерия `pilot-acceptance-v2.md` имеет исполненное и воспроизводимое доказательство; иначе — blocked (нет условия) / failed (дефект).

## AT-CORE-01 Доступность материала

- **Run ID:** PA-C-AT-CORE-01-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-01» (план v1.1, Приложение A)
- **Статус:** **blocked**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-public-read.spec.ts` — 3/3 passed, exit 0, 7 с; лог `logs/jest/content-public-read.spec.log` md5 `1bf5e05a0d2482453de59ab1422b9409`, JSON md5 `2d2a779d23bec87b596bff552a6d967d`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 12 E2E-01 [passed] режим live (владелец), материал запланирован и опубликован на сайте
  - шаг 13 E2E-01 [passed] публичный текст = согласованная версия (API сайта)
  - шаг 20 E2E-02 [passed] сайт (Chromium, https-домен продукта): метка → материал → CTA → форма → успех с номером
- **Дополнительно:**
  - CI publisher-site: check:built --expect-noindex / --expect-indexable / HTTP (logs/ci-ps/06,07,09)
  - e2e.mjs (мок-стенд): без JS, 410/404 (logs/ci-ps/11-e2e.log)
  - z-e2e-site (настоящий backend): 200, h1 = согласованной версии, текст в HTML без JS, неизвестный материал 404 (e2e2/site.json)
  - C3 matrix: desktop/mobile-эмуляция/320 — 200, h1, без горизонтальной прокрутки (c3/c3.json)
- **Ожидаемо → фактически / доказательность:** Автоматизированная часть доказывает: 200, основной текст в первом HTML, title/description/canonical, sitemap, noindex тестовой и index сборки с двумя ключами, CTA. Не исполнено: «на телефоне» (есть только эмуляция мобильного вьюпорта Chromium), HTTPS с настоящим сертификатом тестового домена, «после выпуска повторить проверку публичного URL» (нет развёртывания).
- **Дефект/примечание:** Причина blocked: нет реального телефона, нет тестового домена/развёртывания Vercel. Владелец: команда (стенд), внешний QA.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-02 Клавиатура и ошибки формы

- **Run ID:** PA-C-AT-CORE-02-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/public-rate-limit.spec.ts` — 9/9 passed, exit 0, 5 с; лог `logs/jest/public-rate-limit.spec.log` md5 `3d1fd1f8a7b99e11d72bd53923c73313`, JSON md5 `2319dd62e27c79e513a7a02be3abce9c`
  - `src/acceptance/publisher/public-limits.http.spec.ts` — 14/14 passed, exit 0, 6 с; лог `logs/jest/public-limits.http.spec.log` md5 `cae20a86c07d22054b5dc0aca0a57011`, JSON md5 `17bab7e491fe8fa9180f829201fac14a`
- **Дополнительно:**
  - axe-check.mjs и e2e.mjs на мок-стенде (logs/ci-ps/10,11)
  - C3 keyboard (настоящий API): порядок фокуса, пустая форма → текст ошибки и фокус, данные не исчезают, отправка клавиатурой
  - C3 axe 4.13 WCAG 2.x A/AA (вкл. color-contrast) на настоящем сайте: 0 нарушений, desktop и 320
  - C3 matrix w320: без горизонтальной прокрутки, поля в пределах ширины
  - C3 burst6: 6-я с одного адреса → 429, текст «не відправлено», альтернативный контакт
- **Ожидаемо → фактически / доказательность:** Каждый элемент критерия имеет исполненную проверку: клавиатура, ошибка текстом, сохранение данных, 320 px, контраст ≥ 4,5:1 (правило axe color-contrast), консоль 0, лимит и альтернативный контакт, сброс тестового счётчика (public-rate-limit.spec «сброс тестового счётчика»). «Понятность» подписей оценена только автоматически (axe label) — субъективная оценка относится к C2.
- **Дефект/примечание:** Ручной остаток каталога «телефон» в критерий AT-CORE-02 не входит; см. C3 (матрица устройств blocked).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-03 Неудачная отправка

- **Run ID:** PA-C-AT-CORE-03-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-03» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/public-lead-intake.spec.ts` — 12/12 passed, exit 0, 4 с; лог `logs/jest/public-lead-intake.spec.log` md5 `f5b1176ce2466a22fcc70471d5ebb037`, JSON md5 `92548c79be648ddf491fa2642d6bcc70`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 23 E2E-02 [passed] повтор отправки тем же submissionKey — тот же номер, одна заявка
- **Дополнительно:**
  - e2e.mjs (мок): 500/503/обрыв, повтор (logs/ci-ps/11)
  - C3 offline, lostResponse, serverReject на настоящем стенде
- **Ожидаемо → фактически / доказательность:** Доказано на настоящем backend: сбой до COMMIT → нет заявки и события успеха (jest); офлайн → статус network, нет строки, кнопка повтора и альтернативный контакт (C3); ответ потерян после записи → нет ложного успеха, повтор тем же ключом → тот же номер, одна строка (C3).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-04 Однократное сохранение

- **Run ID:** PA-C-AT-CORE-04-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-04» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/public-lead-idempotency.spec.ts` — 5/5 passed, exit 0, 4 с; лог `logs/jest/public-lead-idempotency.spec.log` md5 `00b3be5f8bc54f096464d06d1a60ac6d`, JSON md5 `5ce068d623e51eddb50926c7fce89290`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 21 E2E-02 [passed] заявка с сайта в кабинете: одна на операцию (двойной клик), атрибуция метка → материал → закупка
  - шаг 23 E2E-02 [passed] повтор отправки тем же submissionKey — тот же номер, одна заявка
  - шаг 26 E2E-02 [passed] вторая задача того же клиента — тот же prospect_id (уникальные не растут)
- **Дополнительно:**
  - e2e.mjs (мок): двойной клик, 5 параллельных
  - z-e2e-site: двойной клик → одна заявка
  - C3 parallel5: 5 посетителей одновременно → 5 успехов, 5 строк, 5 событий, без дублей
  - C3 burst6 и load-2rps/10rps (420 заявок, 0 дублей)
- **Ожидаемо → фактически / доказательность:** Повтор того же submissionKey → одна запись и тот же leadRef (jest ×10 параллельно; E2E шаг 23: 201 → 200). Другая задача того же человека → новая заявка (jest; E2E шаг 26). Пять разных параллельно — все сохранены по одному (jest и настоящий стенд C3). Лимит сброшен/обойдён разными адресами — проверка сохранения не подменена лимитом.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-05 Уведомление менеджеру недоступно

- **Run ID:** PA-C-AT-CORE-05-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-05» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/leads-notifications.spec.ts` — 6/6 passed, exit 0, 5 с; лог `logs/jest/leads-notifications.spec.log` md5 `687a227f3ec90689ae4cf440755cc819`, JSON md5 `5522f838e06a19d3279f19fbbf546557`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 22 E2E-02 [passed] сбой уведомления (бот недоступен на стенде) не теряет заявку; статус виден
  - шаг 37 E2E-04 [passed] сбой уведомления: повтор — честный статус, заявка цела
- **Дополнительно:**
  - E2E: бот недоступен на стенде — уведомления failed, заявка цела; повтор — честный статус
- **Ожидаемо → фактически / доказательность:** Сбой бота → заявка, событие и outbox сохранены, уведомление failed, повтор не плодит заявку, очередь видна, отметка «очередь проверена сегодня» не зависит от уведомлений (jest). Исполнение регламента оператором (ежедневная проверка) — эксплуатационный факт пилота, проверяется на D42 по журналу pub_queue_checks.
- **Дефект/примечание:** Примечание: регламент ежедневной проверки исполняется людьми после D0; здесь доказана поддержка системой.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-06 Тесты исключены из спроса

- **Run ID:** PA-C-AT-CORE-06-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-06» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/leads-test-flag.spec.ts` — 7/7 passed, exit 0, 5 с; лог `logs/jest/leads-test-flag.spec.log` md5 `adb6e2c1dca160565e98c875c40123e3`, JSON md5 `b50db60ca37e102a8d6250402c636a30`
  - `src/acceptance/publisher/reports-exclusion.spec.ts` — 1/1 passed, exit 0, 5 с; лог `logs/jest/reports-exclusion.spec.log` md5 `d4fd108d66863e231681cfa626d1fd60`, JSON md5 `699ad8a775218a83922458857a7f1ac7`
  - `src/acceptance/publisher/reports-cohorts.spec.ts` — 14/14 passed, exit 0, 3 с; лог `logs/jest/reports-cohorts.spec.log` md5 `e8adf67fe44c29be1f9ce08203e08051`, JSON md5 `5c02c497fdf0541c00bb40d8955898f9`
- **Ожидаемо → фактически / доказательность:** Тестовые переход/событие/заявка/квалификация видны в диагностике и отсутствуют в деловых суммах (db + unit); смена testFlag — с причиной и историей. «Публичный кейс» (F15) не реализован; проверено отсутствие в публичном контенте.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-07 Квалификация и причины

- **Run ID:** PA-C-AT-CORE-07-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-07» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/leads-qualification.spec.ts` — 9/9 passed, exit 0, 5 с; лог `logs/jest/leads-qualification.spec.log` md5 `260880f63c20b76afedae074fc6073c1`, JSON md5 `4715cf0af2f3607daab374195541602b`
  - `src/acceptance/publisher/reports-cohorts.spec.ts` — 14/14 passed, exit 0, 3 с; лог `logs/jest/reports-cohorts.spec.log` md5 `e8adf67fe44c29be1f9ce08203e08051`, JSON md5 `5c02c497fdf0541c00bb40d8955898f9`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 25 E2E-02 [passed] менеджер: раскрытие контакта, контакт, квалификация, предложение, тестовая оплата
  - шаг 26 E2E-02 [passed] вторая задача того же клиента — тот же prospect_id (уникальные не растут)
- **Дополнительно:**
  - E2E: квалификация менеджером, вторая задача — тот же prospect_id
- **Ожидаемо → фактически / доказательность:** Квалификация с датой подтверждения, отказ поставщику с кодом причины, бюджет unknown не отказ, AI-маршрута изменения статуса нет (статическая проверка импорта), две задачи одного проспекта — один в сигнале.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-08 Второй продукт и чужие данные

- **Run ID:** PA-C-AT-CORE-08-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-08» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/z-isolation.spec.ts` — 5/5 passed, exit 0, 28 с; лог `logs/jest/z-isolation.spec.log` md5 `e01a53ffafc7dde6aee5be54ccc5b012`, JSON md5 `a86096c1bea5ea7d0fa1df713b067b28`
- **Ожидаемо → фактически / доказательность:** Реестр контрактов ≡ роутер; чужой продукт/сайт/объект → 404 как несуществующий; отозванные роли/наблюдатель → 403; без побочных эффектов. Система мультипродуктная — проверена программная изоляция, а не «отсутствие второго контура».
- **Дефект/примечание:** Отметка «второй продукт не подключён» (ручной остаток каталога) для мультипродуктного кода неприменима; изоляция доказана программно.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-09 Контакты не попали в аналитику

- **Run ID:** PA-C-AT-CORE-09-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-09» (план v1.1, Приложение A)
- **Статус:** **blocked**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/z-pii-scan.spec.ts` — 1/1 passed, exit 0, 7 с; лог `logs/jest/z-pii-scan.spec.log` md5 `15e51203ccdc32f74ad0becd641c0647`, JSON md5 `2ce5d495dde044c70dad546ddb37e1f9`
  - `src/acceptance/publisher/leads-pii-scan.spec.ts` — 1/1 passed, exit 0, 5 с; лог `logs/jest/leads-pii-scan.spec.log` md5 `a136dd62aefff3ad8ea97694cbb589db`, JSON md5 `afaba6f0b1af8e6609c748148182fb83`
  - `src/acceptance/publisher/ai-context.spec.ts` — 12/12 passed, exit 0, 7 с; лог `logs/jest/ai-context.spec.log` md5 `32b48dde40167c5f59e92aad583b7371`, JSON md5 `428cb04ecac0573a8e0175074098c169`
  - `src/acceptance/publisher/leads-retention.spec.ts` — 8/8 passed, exit 0, 5 с; лог `logs/jest/leads-retention.spec.log` md5 `05299ee63d7b468762ec73b6faf5c6c4`, JSON md5 `b4b2df3c13c499bc45a67a5febda6f43`
  - `src/acceptance/publisher/restore-export.spec.ts` — 1/1 passed, exit 0, 4 с; лог `logs/jest/restore-export.spec.log` md5 `2dd8becf65171bc451e698eb8fa1c28e`, JSON md5 `8f65a06012716ac1e4b0cc1728fd4940`
  - `src/acceptance/publisher/leads-contact-reveal.http.spec.ts` — 6/6 passed, exit 0, 5 с; лог `logs/jest/leads-contact-reveal.http.spec.log` md5 `9cca6653f6e0da07dd3056c08a026f74`, JSON md5 `31b4944a2a78e2ca489a3955f8040055`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 33 E2E-05 [passed] недельный снимок: pending ≠ qualified, уникальные проспекты, unknown отдельно, деньги раздельно, без контактов
  - шаг 40 E2E-04 [passed] удаление тестового контакта: раскрытие → 404, обезличенная запись; отзыв источника — задачи проверки
- **Дополнительно:**
  - E2E: недельный снимок без контактов; удаление контакта → раскрытие 404, обезличенная запись
- **Ожидаемо → фактически / доказательность:** Технические элементы доказаны: сырой поиск по всем pub_*, журналам, промпту, ответам и уведомлениям; UTM с контактом → [redacted]; раскрытие только SA/PO; closed_at + 90, удаление и обезличенная запись. Не исполнено: «проверить уведомление о данных и настройки consent_state до публичного сбора» — текст уведомления и consent_map не утверждены владельцем/специалистом рынка; на стенде утверждена заглушка «Чернетка… потребує затвердження» (DEF-C-04).
- **Дефект/примечание:** Причина blocked: нет утверждённого текста уведомления и карты согласий; см. DEF-C-04 (S2).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-10 Версия и согласование

- **Run ID:** PA-C-AT-CORE-10-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-10» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-approval-hash.spec.ts` — 3/3 passed, exit 0, 6 с; лог `logs/jest/content-approval-hash.spec.log` md5 `79779107330617c216d3978c88792802`, JSON md5 `888367849ea72d589d5d43391d375517`
  - `src/acceptance/publisher/core-revision.spec.ts` — 2/2 passed, exit 0, 4 с; лог `logs/jest/core-revision.spec.log` md5 `ff602d54c6c3f892d52df6d134bd158f`, JSON md5 `4bfb1d3c4df44161f037bbea386ab8bc`
  - `src/acceptance/publisher/content-after-approval.spec.ts` — 11/11 passed, exit 0, 11 с; лог `logs/jest/content-after-approval.spec.log` md5 `1b50a8320cca2783e808f174433011f7`, JSON md5 `d5dc4c6eb281791ff90f512fff35860a`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 8 E2E-01 [passed] неподтверждённый критический факт блокирует согласование
  - шаг 9 E2E-01 [passed] claim подтверждён источником → согласование hash версии
  - шаг 42 E2E-01 [passed] изменение цены (новый оффер) → новая версия требует решения
  - шаг 43 E2E-01 [passed] изменение ключевого claim → повторная проверка материала и адаптаций
- **Дополнительно:**
  - assist publisher-view.test (UI 409 → перезагрузка) — logs/ci-assist/05-unit.log
- **Ожидаемо → фактически / доказательность:** Новый факт → новая версия требует решения, прежний hash не проходит (PUB_APPROVAL_STALE в E2E шаг 9), параллельная правка → 409, параллельные approve → одно активное согласование.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-11 Доступы и отзыв роли

- **Run ID:** PA-C-AT-CORE-11-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-11» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/core-role-revoke.spec.ts` — 2/2 passed, exit 0, 4 с; лог `logs/jest/core-role-revoke.spec.log` md5 `2fd0ac7d350ac052007e165d4f86e368`, JSON md5 `ad6ab0788679c4225056e8f816a25158`
  - `src/acceptance/publisher/ai-role-command.spec.ts` — 4/4 passed, exit 0, 4 с; лог `logs/jest/ai-role-command.spec.log` md5 `30674bfa162935ee81e02f0b6e9447d2`, JSON md5 `4d5ee388d72bbc79a72e669ffec55d7c`
- **Ожидаемо → фактически / доказательность:** После отзыва operator — 403 на следующем запросе; удалённый участник — гранты отозваны заданием. AI: у генераторов нет инструментов, роль меняет только система (статически + на fake-модели). Поведение реальной модели на AI-28 — этап D (набор AI).
- **Дефект/примечание:** Реальная модель не вызывалась (нет ключа) — относится к этапу D, не к критерию доступа.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-12 Неполная аналитика

- **Run ID:** PA-C-AT-CORE-12-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-12» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/reports-integrations.spec.ts` — 8/8 passed, exit 0, 4 с; лог `logs/jest/reports-integrations.spec.log` md5 `fa4cb28dd772e858a8c4241835c2db83`, JSON md5 `8183ea819d0968bf2acc2d7426a2d008`
  - `src/acceptance/publisher/budget-purchase-gate.spec.ts` — 8/8 passed, exit 0, 6 с; лог `logs/jest/budget-purchase-gate.spec.log` md5 `e135660ab833e2f328ecd569f42cd32a`, JSON md5 `bab37e418d9ba14eb77d5f26ab33bbc5`
  - `src/acceptance/publisher/reports-signal.spec.ts` — 5/5 passed, exit 0, 2 с; лог `logs/jest/reports-signal.spec.log` md5 `932a34d1985cf73998b9d8feedb04945`, JSON md5 `27c61d68b06f1420d09fb6e2bb67d3c1`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 38 E2E-04 [passed] аналитика отключена — новые закупки стоят (гейт purchases), после восстановления — открыто
- **Дополнительно:**
  - E2E: аналитика отключена → гейт purchases закрыт, восстановление открывает
- **Ожидаемо → фактически / доказательность:** degraded/disconnected/устаревшая интеграция → PUB_GATE_CLOSED на резерв и согласование; отчёт показывает lastSyncedAt и неполный период, пропуски — «неизвестно», не 0.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-13 Валюта и полная цена

- **Run ID:** PA-C-AT-CORE-13-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-13» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/budget-price-fx.spec.ts` — 3/3 passed, exit 0, 4 с; лог `logs/jest/budget-price-fx.spec.log` md5 `a1d0a60007c59a85283db8eb2805930a`, JSON md5 `dfd0064f816e2bd395a0c9b523bcdd77`
- **Ожидаемо → фактически / доказательность:** Цена без комиссий → PUB_PRICE_INCOMPLETE; USD без курса/источника/времени → PUB_FX_REQUIRED; с ними — итог в UAH с округлением вверх.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-14 Два претендента на остаток бюджета

- **Run ID:** PA-C-AT-CORE-14-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-14» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/budget-reserve-concurrency.spec.ts` — 3/3 passed, exit 0, 5 с; лог `logs/jest/budget-reserve-concurrency.spec.log` md5 `7efab7e0692cf56c896accc6921f1c8c`, JSON md5 `886ef8198d1f9f91648dc402367b6fd2`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 30 E2E-03 [passed] два претендента на один остаток: параллельный резерв одной закупки — одно обязательство
- **Дополнительно:**
  - E2E шаг 30 проверяет лишь двойной резерв ОДНОЙ закупки (DEF-C-02)
- **Ожидаемо → фактически / доказательность:** Доказано jest на настоящей базе и HTTP: две транзакции на один остаток → одна успешна; два параллельных HTTP-резерва 3 000 на остаток 5 000 → 200 и 409 PUB_BUDGET_INSUFFICIENT; 20 претендентов → ровно один успех, счётчики = записи. Сквозной протокол E2E-03 этот элемент не исполняет (название шага вводит в заблуждение).
- **Дефект/примечание:** DEF-C-02 (S3).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-15 Неизвестная оплата

- **Run ID:** PA-C-AT-CORE-15-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-15» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/budget-payment-unknown.spec.ts` — 3/3 passed, exit 0, 5 с; лог `logs/jest/budget-payment-unknown.spec.log` md5 `6cf79c7de1da2ccf78d615ee2a4b411a`, JSON md5 `c1acb119423a145351031f1205fed008`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 31 E2E-03 [passed] оплата со статусом unknown — новые закупки стоят до сверки; сверка снимает блок
- **Дополнительно:**
  - E2E: unknown → гейт закрыт, заказ PUB_RECONCILE_REQUIRED, сверка снимает блок
- **Ожидаемо → фактически / доказательность:** unknown удерживает обязательство; повтор оплаты/заказа → PUB_RECONCILE_REQUIRED; сверка ответственным с документом.
- **Дефект/примечание:** DEF-C-03 (S3): в E2E шаге 31 отказ заказа записан в доказательство, но не утверждается проверкой.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-16 Оплачено, но не опубликовано

- **Run ID:** PA-C-AT-CORE-16-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-16» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/dist-paid-unpublished.spec.ts` — 1/1 passed, exit 0, 4 с; лог `logs/jest/dist-paid-unpublished.spec.log` md5 `919cfd6b4e49e50fd275c12b9ebe6c63`, JSON md5 `a0bf21f184c0c126fa2015e4f003f113`
- **Ожидаемо → фактически / доказательность:** paid + publication_pending → disputed с владельцем и nextActionAt; оплата не меняется; трафик не создаётся.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-17 Отмена и возврат

- **Run ID:** PA-C-AT-CORE-17-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-17» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/budget-cancel-refund.spec.ts` — 5/5 passed, exit 0, 6 с; лог `logs/jest/budget-cancel-refund.spec.log` md5 `0e3fa0890c49dd154a3c07d77e2a2822`, JSON md5 `f65600072fa285f7cb945c0233f4e8f9`
  - `src/acceptance/publisher/budget-math.spec.ts` — 12/12 passed, exit 0, 1 с; лог `logs/jest/budget-math.spec.log` md5 `9314bd56e43a1e4862b59311e8931c3c`, JSON md5 `d38f68e90920113af6a7bf5d3d26e4af`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 32 E2E-03 [passed] отмена закупки и возврат оплаты: обязательство снято, возврат ≤ оплаты
- **Дополнительно:**
  - E2E: отмена и возврат, возврат ≤ оплаты
- **Ожидаемо → фактически / доказательность:** Отмена освобождает только подтверждённую часть; обещанный возврат не меняет net_paid, подтверждённый — меняет (E2E: netPaid 3 000 → 2 800).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-18 Нулевой знаменатель

- **Run ID:** PA-C-AT-CORE-18-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-18» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/reports-economics.spec.ts` — 13/13 passed, exit 0, 2 с; лог `logs/jest/reports-economics.spec.log` md5 `94e2f0bd9ad226f70218af85b9487b7f`, JSON md5 `3f00c25b28e23a6a64a2a84f07b6eaf9`
  - `src/acceptance/publisher/reports-at-report.spec.ts` — 1/1 passed, exit 0, 2 с; лог `logs/jest/reports-at-report.spec.log` md5 `c36863de0865846f5301d4318c8e37a7`, JSON md5 `1f179953db1e03af955ccb04117396bc`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 46 E2E-05 [passed] D42 (задание после t42): когорта [t0,t42) — сессия ровно в t42 вне неё; независимый пересчёт сессий; нулевые знаменатели — «не рассчитывается»
- **Дополнительно:**
  - assist publisher-ops-view.test: «не розраховується» (UI)
  - E2E D42: zeroDenominators
- **Ожидаемо → фактически / доказательность:** 0 заявок/оплат → not_computable(zero_denominator) с числителем; экран показывает «не рассчитывается», не 0.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-19 Предварительные окна

- **Run ID:** PA-C-AT-CORE-19-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-19» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/core-kyiv-time.spec.ts` — 3/3 passed, exit 0, 2 с; лог `logs/jest/core-kyiv-time.spec.log` md5 `a1610cc757bb2c332882c991fe18fbda`, JSON md5 `c9a860fe48c2e35ba4a5a9bbc75173dc`
  - `src/acceptance/publisher/reports-cohorts.spec.ts` — 14/14 passed, exit 0, 3 с; лог `logs/jest/reports-cohorts.spec.log` md5 `e8adf67fe44c29be1f9ce08203e08051`, JSON md5 `5c02c497fdf0541c00bb40d8955898f9`
  - `src/acceptance/publisher/reports-snapshots.spec.ts` — 6/6 passed, exit 0, 5 с; лог `logs/jest/reports-snapshots.spec.log` md5 `ba66056ec37b991227dee4fd48ce2e5a`, JSON md5 `094641d8cc886e86fb6db16bec20e985`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 45 E2E-05 [passed] синтетический календарь: часы стенда → t42 − 1 мс и ровно t42; время сессий и заявок ставит сервер БД стенда
  - шаг 46 E2E-05 [passed] D42 (задание после t42): когорта [t0,t42) — сессия ровно в t42 вне неё; независимый пересчёт сессий; нулевые знаменатели — «не рассчитывается»
  - шаг 47 E2E-05 [passed] D72 (после t72): окно обращений закрыто, pending отдельно от qualified
  - шаг 48 E2E-05 [passed] поздняя квалификация после D72 → наследник late_decision, исходный D72 неизменен
  - шаг 49 E2E-05 [passed] D90 (после t90): период [t0,t90), поисковый сигнал отдельно; история снимков
- **Дополнительно:**
  - E2E-05 на часах стенда: t42 − 1 мс / ровно t42, D42/D72/D90, late_decision
- **Ожидаемо → фактически / доказательность:** Синтетически доказаны все элементы: [t0,t42) без сессии ровно в t42 (SQL и независимый пересчёт 2 vs 3), окно 30 дней включительно, pending отдельно, позднее решение → наследник, поздняя публикация → отдельная когорта. По плану §13 закрытие окон живой когорты на D72 этим не подтверждается.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-20 Восстановление экспорта

- **Run ID:** PA-C-AT-CORE-20-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-20» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/restore-apply.spec.ts` — 16/16 passed, exit 0, 9 с; лог `logs/jest/restore-apply.spec.log` md5 `b8990d9f632fe8c0af073f82c9f5dc47`, JSON md5 `5243c99a1d181dc7ce0c94e8f75e2906`
  - `src/acceptance/publisher/restore-export.spec.ts` — 1/1 passed, exit 0, 4 с; лог `logs/jest/restore-export.spec.log` md5 `2dd8becf65171bc451e698eb8fa1c28e`, JSON md5 `8f65a06012716ac1e4b0cc1728fd4940`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 39 E2E-04 [passed] резервная копия до удаления и отзыва (ручная, хранилище стенда): sha256, счётчики таблиц
  - шаг 41 E2E-04 [passed] восстановление копии в новый продукт kind=restored: удалённый контакт и отозванный источник не возвращаются, внешние действия не повторяются
- **Дополнительно:**
  - modules: report-jobs.db.spec (ротация rotationUntil), secrets-rotation.db.spec — logs/ci-sb/07
  - E2E-04: копия sha256, восстановление в restored, applied erasures 1 / revocations 1 / claimsNeedsReview 1, уведомлений 0
- **Ожидаемо → фактически / доказательность:** Связи, версии и расходы сохранены; внешние действия не повторены (outbox/уведомления 0); удалённый контакт и отозванный источник не вернулись; rotationUntil записывается из retention_policy.backupRotationDays и исполняется заданием ротации.
- **Дефект/примечание:** Значение срока ротации утверждает владелец (параметр).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-21 Удаление разрешённого ранее источника

- **Run ID:** PA-C-AT-CORE-21-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-21» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-source-revoke.spec.ts` — 2/2 passed, exit 0, 6 с; лог `logs/jest/content-source-revoke.spec.log` md5 `9bed887768e491d2b029ac84fe8055a2`, JSON md5 `bbda91f5efb04f6b29e5409c21c425da`
  - `src/acceptance/publisher/ai-context.spec.ts` — 12/12 passed, exit 0, 7 с; лог `logs/jest/ai-context.spec.log` md5 `32b48dde40167c5f59e92aad583b7371`, JSON md5 `428cb04ecac0573a8e0175074098c169`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 40 E2E-04 [passed] удаление тестового контакта: раскрытие → 404, обезличенная запись; отзыв источника — задачи проверки
- **Дополнительно:**
  - E2E: отзыв источника → задачи проверки (9)
- **Ожидаемо → фактически / доказательность:** Отозванный источник не попадает в context-preview и CSV; claims/версии/адаптации/публикации получают задачи; кэша контекста нет.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-22 Внешний URL с недопустимой целью

- **Run ID:** PA-C-AT-CORE-22-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-22» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-import-ssrf.spec.ts` — 17/17 passed, exit 0, 4 с; лог `logs/jest/content-import-ssrf.spec.log` md5 `54f27d2288544cb993a71d8af5168a02`, JSON md5 `da0f7c58400ed74f9f4b8f9f48ed1d28`
- **Ожидаемо → фактически / доказательность:** Внутренние/локальные адреса, смешанный DNS, rebinding, редирект на внутренний и чужой origin → отказ без подключения (подменённый резолвер и счётчик подключений).
- **Дефект/примечание:** Проверка — с подменой DNS в процессе; сетевой пробы против реальной внутренней сети стенда не было (этап D).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-23 Порог не переписан задним числом

- **Run ID:** PA-C-AT-CORE-23-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-23» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/reports-experiment-immutable.spec.ts` — 4/4 passed, exit 0, 4 с; лог `logs/jest/reports-experiment-immutable.spec.log` md5 `db412c3f36834fec81e0b8f4ecf73e62`, JSON md5 `0c507801057924435b50b8f0e90e2249`
  - `src/acceptance/publisher/reports-signal.spec.ts` — 5/5 passed, exit 0, 2 с; лог `logs/jest/reports-signal.spec.log` md5 `932a34d1985cf73998b9d8feedb04945`, JSON md5 `27c61d68b06f1420d09fb6e2bb67d3c1`
  - `src/acceptance/publisher/reports-experiment-conclusion.spec.ts` — 11/11 passed, exit 0, 4 с; лог `logs/jest/reports-experiment-conclusion.spec.log` md5 `00a67663e69cfce1d49fae56a87b7bf1`, JSON md5 `3ed86c179562435df26af0f843613324`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 46 E2E-05 [passed] D42 (задание после t42): когорта [t0,t42) — сессия ровно в t42 вне неё; независимый пересчёт сессий; нулевые знаменатели — «не рассчитывается»
- **Дополнительно:**
  - E2E D42: verdict not_met при порогах 100/5/2
- **Ожидаемо → фактически / доказательность:** Пороги заморожены триггером (23514 на правку); ниже порога → not_met; новая гипотеза — новая версия; t0 ставится один раз.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-CORE-24 Оплата и внутренний клиент

- **Run ID:** PA-C-AT-CORE-24-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-CORE-24» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/leads-payments-kinds.spec.ts` — 8/8 passed, exit 0, 5 с; лог `logs/jest/leads-payments-kinds.spec.log` md5 `9fe35488590c903e262efb861172a110`, JSON md5 `f54ce701ce447059b133833faec20627`
  - `src/acceptance/publisher/reports-revenue.spec.ts` — 6/6 passed, exit 0, 4 с; лог `logs/jest/reports-revenue.spec.log` md5 `5ab097a7bdbdbf0012d16c6088fc3a1a`, JSON md5 `e90aa4119f360092b682cc7c434fc1d6`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 25 E2E-02 [passed] менеджер: раскрытие контакта, контакт, квалификация, предложение, тестовая оплата
- **Дополнительно:**
  - E2E: тестовая оплата payerKind=test
- **Ожидаемо → фактически / доказательность:** Внутренняя/тестовая оплата не выручка и не CAC; без подтверждённой внешней — «коммерческая валидация не подтверждена».
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F01-01 Карта вопросов: 10 вопросов → группы → 6 тем

- **Run ID:** PA-C-AT-F01-01-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-F01-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-questions.spec.ts` — 1/1 passed, exit 0, 4 с; лог `logs/jest/content-questions.spec.log` md5 `9b0ecf00710b766c78021dbc0e86c0c1`, JSON md5 `9f72cce7e8ded6b2883103003048c5f5`
- **Ожидаемо → фактически / доказательность:** 10 вопросов с источниками → 2 группы (человек) → 6 тем с фрагментами и пояснением всех четырёх оценок. AI-кластеризация в P0 выключена (ДТ-2) — группы создаёт человек; критерий AT этого не запрещает, но каталог функций P0 F01 называет «AI-кластеризацию одного набора».
- **Дефект/примечание:** Наблюдение для этапа B: расхождение каталога F01 (AI-кластеризация) и реализации (ручная группировка, ДТ-2).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F01-02 Частотность неизвестна, намерения не склеены

- **Run ID:** PA-C-AT-F01-02-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-F01-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-questions-merge.spec.ts` — 3/3 passed, exit 0, 3 с; лог `logs/jest/content-questions-merge.spec.log` md5 `bbd16dca75d00f7653e2560c4709994a`, JSON md5 `2b87ec95529775ee60c060259ff6ab60`
- **Ожидаемо → фактически / доказательность:** Без частотности — NULL и «невідомо»; общие слова — подсказка, склейка только решением человека.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F02-01 Контекст из утверждённого профиля

- **Run ID:** PA-C-AT-F02-01-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F02-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-brand-context.spec.ts` — 1/1 passed, exit 0, 4 с; лог `logs/jest/content-brand-context.spec.log` md5 `302f1cafea7cea39d44f58f6b8370d4d`, JSON md5 `2d7252dbaff376833f555c980a200db4`
- **Ожидаемо → фактически / доказательность:** context-preview: активные цена v2, условие и оффер v2; черновой кейс, конфликт и v1 — вне.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F02-02 Конфликт цены, неутверждённый кейс, каскад оффера

- **Run ID:** PA-C-AT-F02-02-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F02-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-brand-conflict.spec.ts` — 1/1 passed, exit 0, 4 с; лог `logs/jest/content-brand-conflict.spec.log` md5 `129754e70debd8c13081510b826eddbc`, JSON md5 `16c4cdc025ba5c9acc2863c5527db7a4`
  - `src/acceptance/publisher/content-offer-cascade.spec.ts` — 2/2 passed, exit 0, 6 с; лог `logs/jest/content-offer-cascade.spec.log` md5 `1b6a3a95349a48472e1a852c49d93da2`, JSON md5 `6107189bd8e2725c75c5baf5eb90310b`
  - `src/acceptance/publisher/content-after-approval.spec.ts` — 11/11 passed, exit 0, 11 с; лог `logs/jest/content-after-approval.spec.log` md5 `1b50a8320cca2783e808f174433011f7`, JSON md5 `d5dc4c6eb281791ff90f512fff35860a`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 42 E2E-01 [passed] изменение цены (новый оффер) → новая версия требует решения
- **Дополнительно:**
  - E2E: новый оффер → материал correction_required, 7 задач
- **Ожидаемо → фактически / доказательность:** Конфликт → needs_resolution + задача; кейс вне контекста; новый оффер/изменённый факт → опубликованные материалы и адаптации на проверку при неизменном hash.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F03-01 Бриф: вклад, источник, CTA

- **Run ID:** PA-C-AT-F03-01-r1 · **шлюзы:** D0 · **требование:** pilot-acceptance-v2.md, раздел «AT-F03-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-brief.spec.ts` — 3/3 passed, exit 0, 4 с; лог `logs/jest/content-brief.spec.log` md5 `5aa8e14c3d029bc6187f65deaa165fd2`, JSON md5 `f89374897c2778bcaff8da4f5115d75b`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 6 E2E-01 [passed] бриф создан и готов (оффер, CTA, источник)
- **Дополнительно:**
  - E2E: бриф ready
- **Ожидаемо → фактически / доказательность:** Готовый бриф со связями question_id, offer_version, source_ids и CTA с пояснением уместности; вариант через fake-генератор принимает человек.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F03-02 Бриф не готов без вклада/с подменённым оффером

- **Run ID:** PA-C-AT-F03-02-r1 · **шлюзы:** D0 · **требование:** pilot-acceptance-v2.md, раздел «AT-F03-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-brief-not-ready.spec.ts` — 2/2 passed, exit 0, 4 с; лог `logs/jest/content-brief-not-ready.spec.log` md5 `b8a5c9f44a1d9189df1d72810d2f3286`, JSON md5 `149d838a965ac35074cd30b4f0335d11`
- **Ожидаемо → фактически / доказательность:** Без вклада или с неактивным оффером → PUB_BRIEF_NOT_READY; версию по устаревшему брифу не собрать.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F04-01 Claims связаны с источниками и ручным подтверждением

- **Run ID:** PA-C-AT-F04-01-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F04-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-claims.spec.ts` — 2/2 passed, exit 0, 4 с; лог `logs/jest/content-claims.spec.log` md5 `5d086772718b0866461b26056cd4d140`, JSON md5 `a6858207f9124e3fbbfe4c3c22153014`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 7 E2E-01 [passed] черновик статьи с критическим claim
  - шаг 9 E2E-01 [passed] claim подтверждён источником → согласование hash версии
- **Дополнительно:**
  - E2E: критический claim, подтверждение источником
- **Ожидаемо → фактически / доказательность:** Критический claim без связи не supported; связь yes с разрешённым источником + человек → supported; изменение источника → снова проверка. Извлечение AI выключено (ДТ-2), claims вводит редактор.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F04-02 Источник не подтверждает цифру — QA блокирует

- **Run ID:** PA-C-AT-F04-02-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F04-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-claims-unsupported.spec.ts` — 1/1 passed, exit 0, 5 с; лог `logs/jest/content-claims-unsupported.spec.log` md5 `0a653ebafd2cb4266bb5e27b98c81c6a`, JSON md5 `13d79f51eada39b71fa2d957ac7b4f17`
  - `src/acceptance/publisher/content-after-approval.spec.ts` — 11/11 passed, exit 0, 11 с; лог `logs/jest/content-after-approval.spec.log` md5 `1b50a8320cca2783e808f174433011f7`, JSON md5 `d5dc4c6eb281791ff90f512fff35860a`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 8 E2E-01 [passed] неподтверждённый критический факт блокирует согласование
- **Дополнительно:**
  - E2E: PUB_BLOCKERS_OPEN claim_not_supported
- **Ожидаемо → фактически / доказательность:** supports=no → claim не supported, согласование → PUB_BLOCKERS_OPEN; то же после публикации — correction_required.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F06-01 Пост, карточки и сценарий с parent_version

- **Run ID:** PA-C-AT-F06-01-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-F06-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-adaptations.spec.ts` — 1/1 passed, exit 0, 4 с; лог `logs/jest/content-adaptations.spec.log` md5 `5aa7cb9cbd056ba0596f2e4fc354ba8b`, JSON md5 `ec0b48e88e89c35519043c4271e81d30`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 14 E2E-01 [passed] три адаптации: смысловая проверка обязательна, затем согласование
- **Дополнительно:**
  - E2E: три адаптации (post/cards/checklist), до смысловой проверки — PUB_BLOCKERS_OPEN
- **Ожидаемо → фактически / доказательность:** Три адаптации одной версии с parentVersionId, своим заголовком и CTA, сценарий isScript; без смысловой QA согласования нет. «Самостоятельная польза» обеспечена обязательной человеческой смысловой проверкой, не автоматической оценкой.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F06-02 Изменение ключевого claim → адаптации на проверку

- **Run ID:** PA-C-AT-F06-02-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-F06-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/content-adaptation-cascade.spec.ts` — 1/1 passed, exit 0, 6 с; лог `logs/jest/content-adaptation-cascade.spec.log` md5 `5d003fc246d1b558161621b39f3495a3`, JSON md5 `2072755e13c6c49b8d3db9b79f5de6f6`
  - `src/acceptance/publisher/content-after-approval.spec.ts` — 11/11 passed, exit 0, 11 с; лог `logs/jest/content-after-approval.spec.log` md5 `1b50a8320cca2783e808f174433011f7`, JSON md5 `d5dc4c6eb281791ff90f512fff35860a`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 43 E2E-01 [passed] изменение ключевого claim → повторная проверка материала и адаптаций
- **Дополнительно:**
  - E2E: claim_changed по версиям, контенту и публикациям
- **Ожидаемо → фактически / доказательность:** Новая строка claim → correction_required + criticalStale у статьи и адаптаций; распространение с criticalStale отвергнуто.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F09-01 Календарь по адаптациям

- **Run ID:** PA-C-AT-F09-01-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-F09-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/dist-calendar.spec.ts` — 2/2 passed, exit 0, 4 с; лог `logs/jest/dist-calendar.spec.log` md5 `5d600c7d168d4bba19133e0f4db593f0`, JSON md5 `9ce92d6ae47f96a7ffda04775f2ca750`
- **Ожидаемо → фактически / доказательность:** Действия по адаптации и статье: формат, владелец, версия, измеряемая ссылка (UTM у Telegram); done только с публикацией. AI-план выключен (ДТ-2).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F09-02 Канал запрещает рекламу/недоступен

- **Run ID:** PA-C-AT-F09-02-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-F09-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/dist-blocked.spec.ts` — 2/2 passed, exit 0, 5 с; лог `logs/jest/dist-blocked.spec.log` md5 `1651890ab400ac44a536f4d822356bfc`, JSON md5 `13bad679e02ec6a354f467098f4ee8d2`
- **Ожидаемо → фактически / доказательность:** adsAllowed=false → blocked/ads_not_allowed; channel_unavailable; done без публикации невозможен.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F10-01 Пять проверенных площадок с условиями и источником

- **Run ID:** PA-C-AT-F10-01-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F10-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/dist-venues.spec.ts` — 1/1 passed, exit 0, 5 с; лог `logs/jest/dist-venues.spec.log` md5 `83a5c815eeb0d0fca77c2787170c9e49`, JSON md5 `fd0c480af24fada21d0cf148fae520f2`
  - `src/acceptance/publisher/dist-placement-verify.spec.ts` — 1/1 passed, exit 0, 5 с; лог `logs/jest/dist-placement-verify.spec.log` md5 `61b2238f7fcc649447860006cc092244`, JSON md5 `c377dbe6f9da2de5f541ae7a2d7b243c`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 16 E2E-03 [passed] площадка: пять проверок, маркировка, доказательство → verified
- **Дополнительно:**
  - assist publisher-ops-view.test (балл ≠ полнота)
  - E2E: verified только после пяти проверок, маркировки и доказательства
- **Ожидаемо → фактически / доказательность:** Одинаковые критерии 0–2, пять verified с условиями и доказательствами pub_venue_evidence, полнота отдельно от балла.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F10-02 Посещаемость без соответствия аудитории

- **Run ID:** PA-C-AT-F10-02-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F10-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/dist-venues-traffic.spec.ts` — 3/3 passed, exit 0, 3 с; лог `logs/jest/dist-venues-traffic.spec.log` md5 `dfd98d7cd524be10e5d5c110edc7ebe3`, JSON md5 `ba888924c0ccdaeff26f47c0805aaecb`
- **Ожидаемо → фактически / доказательность:** Поля прогноза нет (unknown_field); 10/10 без соответствия аудитории → не verified.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F11-01 Тестовый путь по метке → форма → CRM/отчёт

- **Run ID:** PA-C-AT-F11-01-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F11-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/leads-traffic-passport.spec.ts` — 5/5 passed, exit 0, 5 с; лог `logs/jest/leads-traffic-passport.spec.log` md5 `40636da0e731ecf5f8bb600146f1e24a`, JSON md5 `49765a401cedee7cbe40f9b83bed67a1`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 20 E2E-02 [passed] сайт (Chromium, https-домен продукта): метка → материал → CTA → форма → успех с номером
  - шаг 21 E2E-02 [passed] заявка с сайта в кабинете: одна на операцию (двойной клик), атрибуция метка → материал → закупка
- **Дополнительно:**
  - e2e.mjs (мок): sessionRef, text/plain, метки
  - z-e2e-site + E2E шаг 21 (настоящий backend): заявка с сайта связана с материалом, размещением и кампанией, coverage linked
  - modules: leads-public-api.spec (карта событий = content_view, cta_click, lead_submit_success по ТЗ)
- **Ожидаемо → фактически / доказательность:** Метка → материал → внутренний переход → CTA → форма → заявка; атрибуция first/last, sessionRef, consentState записан, дедупликация eventId; события ≡ ТЗ §11. «CRM» — защищённый реестр заявок Publisher (внешняя CRM вне объёма, IMPLEMENTATION-DESIGN §1).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F11-02 Без UTM и истории — unknown, без удвоения

- **Run ID:** PA-C-AT-F11-02-r1 · **шлюзы:** D0, Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F11-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/leads-attribution-unknown.spec.ts` — 3/3 passed, exit 0, 5 с; лог `logs/jest/leads-attribution-unknown.spec.log` md5 `cc12b4eaff7b11411662ffb35101a873`, JSON md5 `155fd230a814782a16eabb508cf6c339`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 24 E2E-02 [passed] без метки и без сессии (запрет хранения) — атрибуция unknown, не догадка
- **Дополнительно:**
  - e2e.mjs (мок): без хранения
  - E2E: coverage unknown, sessionRef null
- **Ожидаемо → фактически / доказательность:** Без UTM и хранения → coverage unknown без догадки; первая/последняя модели не удваивают заявку.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F12-01 Согласование → резерв → оплата; вектор §17

- **Run ID:** PA-C-AT-F12-01-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F12-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/budget-flow.spec.ts` — 2/2 passed, exit 0, 5 с; лог `logs/jest/budget-flow.spec.log` md5 `837a5313b067b58a6d39e8f0f7bc40b3`, JSON md5 `18f1a5c439d82d246300d6183ceb84a1`
  - `src/acceptance/publisher/budget-math.spec.ts` — 12/12 passed, exit 0, 1 с; лог `logs/jest/budget-math.spec.log` md5 `9314bd56e43a1e4862b59311e8931c3c`, JSON md5 `d38f68e90920113af6a7bf5d3d26e4af`
  - `src/acceptance/publisher/budget-counters.spec.ts` — 2/2 passed, exit 0, 6 с; лог `logs/jest/budget-counters.spec.log` md5 `50084cbab64b0a8b17c0c35477744520`, JSON md5 `9fb333a3f4a57c43af66cf052985e46e`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 15 E2E-03 [passed] параметры бюджета (10 000 / 6 000 / 2 000 / 2 000) и закупок утверждены
  - шаг 19 E2E-03 [passed] согласование → резерв → заказ → оплата → публикация → проверка; вектор 10 000 − 2 000 − 1 000 − 2 000 = 5 000
- **Дополнительно:**
  - E2E шаг 19 на стенде: available 5 000 до и после оплаты 1 000, open 1 000, delivered_unpaid 400
- **Ожидаемо → фактически / доказательность:** Контрольная арифметика 10 000 − 2 000 − 1 000 − 2 000 = 5 000 подтверждена по HTTP на настоящей базе (budget-flow: total/netPaid/openCommitment/deliveredUnpaid/protectedReserve/available) и на стенде E2E; delivered_unpaid 400 не вычитается (5 000, не 4 600); оплата 1 000 сохраняет 5 000; перевод резерва — только PO, лимит 10 000 не растёт; счётчики = эталон записей.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F12-02 Рост цены / повтор неизвестной / истёкшее согласование

- **Run ID:** PA-C-AT-F12-02-r1 · **шлюзы:** Z · **требование:** pilot-acceptance-v2.md, раздел «AT-F12-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/budget-approval-stale.spec.ts` — 5/5 passed, exit 0, 5 с; лог `logs/jest/budget-approval-stale.spec.log` md5 `e3f691e5460974eb265f126ddbbbc605`, JSON md5 `545242413117d187f7746f85b31938e6`
  - `src/acceptance/publisher/budget-price-change.spec.ts` — 5/5 passed, exit 0, 5 с; лог `logs/jest/budget-price-change.spec.log` md5 `975dcdf99d2b39704ec78225e3a05c45`, JSON md5 `fcdce712782ec4b1ecfcb0b244bf54a8`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 28 E2E-03 [passed] рост цены после согласования — резерв отказан (согласование устарело)
  - шаг 29 E2E-03 [passed] истёкшее согласование (синтетическое время) — заказ не выполняется
- **Дополнительно:**
  - E2E: PUB_APPROVAL_STALE {price_changed}, PUB_APPROVAL_EXPIRED
- **Ожидаемо → фактически / доказательность:** Рост цены → новое согласование; повтор unknown → сверка, второй расход не создан; истёкшее согласование не действует при прежней цене.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F17-01 Регистрация изменения до запуска, решение с лимитом

- **Run ID:** PA-C-AT-F17-01-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-F17-01» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/reports-experiments.spec.ts` — 4/4 passed, exit 0, 4 с; лог `logs/jest/reports-experiments.spec.log` md5 `74f0c53cf2be6f3e664960d7e5c95e63`, JSON md5 `d5b9393cf967267bf25081176f2bed91`
- **Сквозной стенд (E2E, `e2e2/e2e.json`):**
  - шаг 10 E2E-01 [passed] материал включён в эксперимент pilot (до t0)
- **Дополнительно:**
  - E2E: эксперимент pilot зарегистрирован до t0
- **Ожидаемо → фактически / доказательность:** Задним числом не регистрируется; регистрация → применение → снимок → решение с лимитом; без лимита — 400.
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

## AT-F17-02 Нет «значимого победителя» при малой выборке

- **Run ID:** PA-C-AT-F17-02-r1 · **шлюзы:** D42 · **требование:** pilot-acceptance-v2.md, раздел «AT-F17-02» (план v1.1, Приложение A)
- **Статус:** **passed**
- **Исполнено (jest, по файлу, перепрогон 13.10.2026):**
  - `src/acceptance/publisher/reports-experiment-conclusion.spec.ts` — 11/11 passed, exit 0, 4 с; лог `logs/jest/reports-experiment-conclusion.spec.log` md5 `00a67663e69cfce1d49fae56a87b7bf1`, JSON md5 `3ed86c179562435df26af0f843613324`
- **Ожидаемо → фактически / доказательность:** Открытое окно / выборка < порога → только «невизначено» (409 PUB_WINDOW_OPEN на иные заключения).
- **Повторная проверка:** не требуется до исправлений (внешний retest — этап E).

