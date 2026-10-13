# C1. Протоколы сквозных маршрутов E2E-01…05

> Внутренний предаудит. Не является независимым внешним аудитом по плану v1.1 §1; не заменяет внешнее заключение. Цель — подготовить пакет передачи (Приложение B) и снять очевидные дефекты до внешнего прохода.

> **В репозиторий входят только markdown/csv.** Пути вида `logs/…`, `ev/…`, `evidence/…`, `e2e2/…`, `c3/…`, `probe/…` указывают на сырые доказательства в рабочем каталоге предаудита (scratchpad) — они хранятся отдельно и передаются внешнему исполнителю по запросу с ограниченным доступом (план §18); md5 приведены в тексте.

## Общие условия прогона

| Поле | Значение |
|---|---|
| Run ID | PA-C-E2E-r2 (основной); PA-C-E2E-r1 — первый запуск, упал на дефекте стенда DEF-C-01 |
| Версия | текущее дерево `/home/claude/v5`, манифест `manifest.sha256` (sha256 `6374e3d0…95c2`); стенд — `manifest-stand.sha256` |
| Сборка backend | `c/dist` — `tsc -p tsconfig.build.json` из текущего `src` 13.10.2026 (общий `sites-backend/dist` от 08:11 старше `src`, не использовался) |
| Сайт | копия `c/w/publisher-site` (без правок кода), `next build` / `next start -p 3220`, https-прокси :443 на `pubsite.test` |
| База | `sites_pac` — пересоздаётся скриптом из всех миграций + `stand-db-clock.sql` + `seed.cjs` |
| Скрипт | `c/publisher-e2e.pac.sh --site` — копия `scripts/publisher-e2e.sh`: `DB=sites_pac`, `PORT=4241`, `SITE_PORT=3220`, свой `DIST`, `SITE_DIR`; оригинал не правился (diff в разделе «Стенд» ниже) |
| Окружение процесса | `NODE_ENV=development`, fake-AI (`PUBLISHER_AI_ALLOW_UNEVALUATED=true`), часы и хранилище копий стенда (Р-PUB-Z2-21/22), `TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128`; бот Telegram недоступен (нет сети) |
| Время | старт 2026-10-13T10:43:08Z, конец 10:44:02Z |
| Итог | **49 шагов: 49 passed, 0 failed, 0 blocked**; сайт 7/7 |
| Доказательства | `e2e2/e2e.json` md5 `41a76b23a4772befee500ba41d7e5947`; `e2e2/site.json` md5 `5f19aa705354210bf6500d7572987f55`; `e2e2/run.log` md5 `53ad45cc6a435094707d37ee8f86ce94`; `e2e2/server.log` md5 `a091a9ec2f21264516445825676e98d8`; полный перечень — `e2e2/md5.txt`, шаги с доказательствами — `e2e2/steps.txt` |

Первый запуск (`e2e1/`, run.log md5 `388bd79f251c77275cd5498784519841`): 48/49 — шаг «снятие материала → site-revalidate» упал `TypeError: fetch failed`: драйвер ходит на сайт по `PUB_E2E_SITE_PORT ?? 3020`, а `publisher-e2e.sh` не передаёт ему `SITE_PORT` (DEF-C-01). Повтор с `PUB_E2E_SITE_PORT=3220` — 49/49.

Контрольный продукт run r2: `productId cmv6jytke00008c7d4x1leqp6`, ключ `pp_xMSV…` (публичный), участники с ролями PO/editor/operator/analyst/sales/viewer (шаг 2).

---

## E2E-01 Подготовка и выпуск контента — **passed** (16 шагов, вкл. 2 хвостовых)

| Шаг | Что | Цепочка ID / факт |
|---|---|---|
| 3 | оффер | `offerId cmv6jytuk001i…` active |
| 4 | источники | `cmv6jytxn001n…`, `cmv6jytyn001p…` allowed |
| 5 | вопрос | `questionId cmv6jytzg001r…` selected |
| 6 | бриф | `briefId cmv6jyu1l001v…` ready |
| 7 | черновик с критическим claim | `contentId cmv6jyu3p00208…`, `versionId cmv6jyu69…`, `claimId cmv6jyu4g…`, hash `6ebc2a7c…` |
| 8 | неподтверждённый факт блокирует | 409 `PUB_BLOCKERS_OPEN` claim_not_supported |
| 9 | claim подтверждён → согласование | прежняя версия `PUB_APPROVAL_STALE`; новая `versionId cmv6jyug4002k…`, `approvalId cmv6jyulx002w…`, hash `f17a28e8…`, selfReview false |
| 10 | эксперимент pilot до t0 | `experimentId cmv6jyuo4002z…` v2 registered |
| 11 | гейт public_publish | параметры утверждены владельцем стенда (в т. ч. заглушка уведомления — DEF-C-04), гейт open |
| 12 | live, публикация | `publicationId cmv6jyvxf004v…` published, URL `https://pubsite.test/materials/<slug>` |
| 13 | публичный текст = согласованная версия | API сайта: versionHash = `f17a28e8…` |
| 14 | три адаптации | post/cards/checklist: до смысловой QA — `PUB_BLOCKERS_OPEN`, затем approvals `cmv6jyw6e…`, `cmv6jywdc…`, `cmv6jywkr…` |
| 42 | смена цены (новый оффер) | `cmv6jzrha00ah…`; статья `correction_required`; 7 задач |
| 43 | смена ключевого claim | новый `cmv6jzrkm00at…` заменяет `cmv6jyu4g…`; задачи claim_changed по версиям, контенту, публикациям |

Ожидание плана: «неподтверждённый факт блокируется; новая версия требует решения; адаптации получают повторную проверку; публичный текст соответствует разрешённой версии» — выполнено (8, 9, 13, 43). Снимки до/после — HTML страницы проверен драйвером сайта (`site.json`: h1 = согласованной версии, текст в HTML без JS). Связанные AT: F01*/F02/F03/F04/F06, CORE-10/21/22 — см. `C-AT-protocols.md`.

Замечание: в шаге 42 `cascade.correctionRequired=[]` при статусе статьи `correction_required` и прежнем активном согласовании — согласуется с правилом «страница с прежним hash остаётся до решения» (AT-F02-02), но в доказательство шага стоит добавить статусы адаптаций (сейчас видно только число задач).

## E2E-02 Обращение и продажа — **passed** (7 шагов + 7 проверок сайта)

| Шаг | Что | Цепочка ID / факт |
|---|---|---|
| сайт | Chromium, мобильный вьюпорт, `https://pubsite.test`, `utm_source=venue&utm_medium=paid&placement=<код>` → материал → внутренний переход → CTA → форма; двойной клик | 7/7; `leadRef L-L6DXYTYS3U`, `sessionRef HDzeN83D3CmolbGAq2iFIg`, ошибок консоли 0 |
| 21 | заявка в кабинете | `leadId pl_17084c90…`, contentId `cmv6jyu3p…`, placementId `cmv6jyxnl007j…`, campaignId `cmv6jytmh…`, attribution first/last = paid_placement, coverage `linked`; одна заявка на двойной клик |
| 22 | сбой уведомления | 2 уведомления `failed`, outbox `done`, заявка `new` цела |
| 23 | повтор того же submissionKey | `L-PYQYZD67GY`: 201 → 200, одна заявка |
| 24 | без метки и без хранения | `pl_a9ad0cef…`: coverage `unknown`, sessionRef null — догадки нет |
| 25 | менеджер: раскрытие, контакт, квалификация, предложение, тестовая оплата | prospect `pr_2aa0eab8…`, status `proposal_sent`, payment `cmv6jzplo008e…` payerKind `test`, pending |
| 26 | вторая задача того же клиента | `pl_ef904c7b…` → тот же `pr_2aa0eab8…`, проспектов 3 (не выросло на вторую задачу) |

Ожидание: «нет ложного успеха; одна заявка на одну операцию; unknown не восстанавливается догадкой; две задачи одного клиента не увеличивают число уникальных prospect_id» — выполнено. Отчёт без контактов — шаг 33 (E2E-05). Потеря UTM/запрет истории — шаг 24; сбой уведомления — 22; повтор — 23. Дополнительно на настоящем стенде в C3: офлайн, потерянный ответ, 500, 5 параллельных, недоступный приём событий — все без ложного успеха (`C3-nonfunctional.md`).

## E2E-03 Закупка и денежная сверка — **passed с замечаниями** (13 шагов)

| Шаг | Что | Цепочка ID / факт |
|---|---|---|
| 15 | параметры бюджета 10 000 / 6 000 / 2 000 / 2 000 | total 1 000 000 коп., protectedReserve 200 000, available 800 000 |
| 16 | площадка | `venueId cmv6jyxeh007c…` verified (без пяти проверок/маркировки/доказательства — 400 с полями) |
| 17 | закупка до 7 дней наблюдения | 409 `PUB_OBSERVATION_PENDING` |
| 18 | сдвиг публикации на 8 дней (SQL стенда, только даты) | shiftedDays 8 |
| 19 | согласование → резерв → оказано 400 → оплата 1 000 (повтор opKey) → заказ → публикация → проверка | `placementId cmv6jyxnl007j…` verified_complete, paid; до оплаты available 500 000, openCommitment 100 000, deliveredUnpaid 40 000; после — available 500 000, netPaid 300 000, cash {paid 300 000, economicDelivered 40 000, advances 260 000} |
| 27 | решение по отчёту — основание 3-й закупки | `reportId cmv6jzpr9…`, decision `cmv6jzps4…` |
| 28 | рост цены после согласования | `cmv6jzptp…`: 409 `PUB_APPROVAL_STALE {price_changed}` |
| 29 | истёкшее согласование | `cmv6jzpzq…`: 409 `PUB_APPROVAL_EXPIRED` |
| 30 | «два претендента» | **на деле — два параллельных резерва ОДНОЙ закупки**: `["OK","PUB_APPROVAL_REQUIRED"]`, available 500 000 → 300 000 (DEF-C-02) |
| 31 | unknown | гейт purchases missing `reconcile`; заказ `PUB_RECONCILE_REQUIRED` (записан, не утверждается — DEF-C-03); сверка void снимает блок |
| 32 | отмена и возврат | openCommitment 200 000 → 0; netPaid 300 000 → 280 000; возврат сверх оплаты → `PUB_VALIDATION` |

### Контрольная арифметика (план §12 E2E-03, ТЗ §17)

Проверена дважды, на настоящей базе:

1. **Стенд E2E, шаг 19** — до оплаты: лимит 10 000, оплачено 2 000 (инструменты, шаг 19 «tools 200 000 confirmed»), обязательство 1 000 (900 + комиссия 100), из них оказано и не оплачено 400, защищённый резерв 2 000 (шаг 15) → **available 5 000** (500 000 коп.), а не 4 600: delivered_unpaid 400 повторно не вычитается. После оплаты обязательства 1 000 (повтор тем же opKey — одна запись, netPaid 3 000, а не 4 000) → **available 5 000**; open 0.
   Ручной пересчёт: 10 000 − 2 000 − 1 000 − 2 000 = 5 000; после оплаты 10 000 − 3 000 − 0 − 2 000 = 5 000. ✔
2. **jest `budget-flow.spec`** (HTTP-маршруты P-C, `kind=test`, TD-08) — утверждает все компоненты ответа `/budget`: `total 1 000 000, netPaid 200 000, openCommitment 100 000, deliveredUnpaid 40 000, protectedReserve 200 000, available 500 000`; после оплаты `netPaid 300 000, openCommitment 0, available 500 000`; перевод резерва 500 — только PO (оператор 403), лимит 10 000 не растёт, `placements.limit 650 000`; счётчики строки лимита = эталону записей. Лог `logs/jest/budget-flow.spec.log` md5 `837a5313b067b58a6d39e8f0f7bc40b3`. Чистая функция — `budget-math.spec` (12/12).

Ожидание «без действующего согласования заказ не выполняется; обязательство не теряется; повтор не создаёт оплату; аванс не является оказанной услугой» — выполнено (19, 28, 29, 31; advances 2 600 отдельно от economicDelivered 400). Элемент «два претендента на остаток» сквозным протоколом **не исполняется** — доказан только jest `budget-reserve-concurrency.spec` (два HTTP-резерва 3 000 на остаток 5 000 → 200 и 409; 20 претендентов → один успех). Карточки DEF-C-02, DEF-C-03.

## E2E-04 Отказ и восстановление — **passed с замечаниями** (7 шагов)

| Шаг | Что | Факт |
|---|---|---|
| 36 | «AI недоступен» | 409 `PUB_GATE_CLOSED` ai_use `not_evaluated` (`callId aic_56b0…`, `taskId ait_ec58…`), ручной путь — вопрос `cmv6jzqst…` создан. Проверен закрытый гейт, а не отказ провайдера (DEF-C-05) |
| 37 | сбой уведомления, повтор | повтор `OK`, статусы failed (бот недоступен), заявка цела |
| 38 | аналитика отключена | `web_analytics disconnected` → гейт purchases закрыт; восстановление → открыт |
| 39 | резервная копия до удаления/отзыва | `backupId bk_1b78aaaa…`, manual, sha256 `369e6dc4…`, 35 540 Б, счётчики таблиц |
| 40 | удаление контакта и отзыв источника | `pl_ef904c7b…` erased, раскрытие `PUB_NOT_FOUND`; источник revoked; задач 9 |
| 41 | восстановление в `restored` | dry-run: связей 574, висячих 0; apply → продукт `cmv6jzr6600ae…`, restore `cmv6jzr6900af…`; `applied {erasures 1, revocations 1, claimsNeedsReview 1, roleGrantsRevoked 6, leadRowsSuppressed 1}`; `suppressed {leadOutbox 0, notifications 0, externalActions none}`; история payments 1, publications 2, expenseEntries 9 |
| 44 | снятие материала → site-revalidate | 1-й проход 200, 2-й — pending 0 (повтора нет); API 410, сайт 410 через 0 мс |

Ожидание «сохранённая заявка остаётся; ручная альтернатива AI доступна; внешние действия не повторяются; удаление/отзыв применяются после восстановления» — выполнено. Не исполнено по плану: отключение **импорта** (URL-импорт) в сквозном прогоне отсутствует; отказ AI проверен как закрытый гейт, а не как сбой/таймаут провайдера (они покрыты jest `ai-gateway.spec` «таймаут → timeout, резерв держится» и `ai-http.spec` «таймаут — 503 PUB_AI_UNAVAILABLE»; импорт — `content-import-ssrf.spec` «имя не резолвится → timeout»). DEF-C-05.

## E2E-05 Отчёт и решение — **passed** (8 шагов, часы стенда)

| Шаг | Что | Факт |
|---|---|---|
| 33 | недельный снимок | `reportId cmv6jzqm6…`, inputsHash `a386adb6…`; pending 3 ≠ qualified 1; деньги: operational 400 «не менее», cash 3 000, advances 2 600; контактов нет |
| 34 | поздняя квалификация → наследник | `cmv6jzqpo…` recomputeReason `late_decision`, исходный superseded, не изменён |
| 35 | решение — новая строка | decision `cmv6jzqr1…`, второе решение `PUB_CONFLICT` |
| 45 | синтетический календарь | t0 `2026-10-13T10:43:19.932Z`, t42 `2026-11-24T11:43:19.932Z` (через переход на зимнее время — +1 ч UTC), сессии в t42 − 1 мс и ровно t42 (время ставит сервер БД стенда) |
| 46 | D42 | `cmwuoqzhb…` (system:report-milestones): когорта [t0,t42), sessions 2; независимый пересчёт `<t42` = 2, `≤t42` = 3; outsideCohort.nextPeriod 1; signalD42 not_met (2/5 qualified, 1/2 proposals, sessions unknown); zeroDenominators — CAC «не рассчитывается» с числителем |
| 47 | D72 | `cmy1jyjjv…`: windowClosed true, pending 3 отдельно от qualifiedUnique 2 |
| 48 | поздняя квалификация после D72 | наследник `cmy1jyjpu…` late_decision: qualifiedUnique 2 → 3, pending 3 → 2; исходный D72 не изменён |
| 49 | D90 | `cmyr9vvk8…`: период [t0,t90); searchSignalD90 inconclusive (данных поиска нет — не «не выполнено»); история d90/d72/d42/weekly |

Ожидание «когорта [t0,t42) не включает сессию ровно в t42; pending не считается qualified; позднее решение создаёт новый снимок; cash, оказанные затраты, операционные и инвестиционные метрики разделены; связь канала не объявляется причинной» — выполнено (последнее — формулировки отчёта; отдельной проверки текста «не причинно» в E2E нет, есть в `reports-signal`/`reports-economics`).

Наблюдение: в истории D90 снимок d42-наследника имеет `snapshotAt` 2026-12-24 (момент позднего решения), а не t42 — это наследник «с тем же определением», что ожидаемо по AT-CORE-19; внешнему аудитору стоит сверить, что отчёт D42 в интерфейсе показывает исходный срез и наследника раздельно.

---

## Стенд: отличия копии скрипта от оригинала

```
< ROOT=$(cd "$(dirname "$0")/.." && pwd)
> ROOT=/home/claude/v5 ; DIST=${DIST:?} ; SITE_DIR=${SITE_DIR:?}
< DB=sites_pube2e  PORT=4141  SITE_PORT=3020
> DB=sites_pac     PORT=4241  SITE_PORT=3220
< node dist/main.js
> NODE_PATH=$ROOT/sites-backend/node_modules node $DIST/main.js
< cd "$ROOT/publisher-site"
> cd "$SITE_DIR"
< stop_site
> [ -n "${KEEP_SITE:-}" ] || stop_site
```
md5 копии `1966874f939173f8606489fbbd449a04`. Драйвер сайта `z-e2e-site.mjs` жёстко слушает :443 — параллельные прогоны невозможны (DEF-C-01).

Дополнительные прогоны того же стенда (не протокол E2E, а среда для C3): `c3/stand-run.log` (`PUB_E2E_ONLY=E2E-01,E2E-02,E2E-03`, 34/34 + сайт 7/7, сайт и API оставлены для C3), `load/stand-run.log` (`E2E-01` без сайта, 16/16, API для нагрузочной пробы).


## Прогон Z-2c на финальном дереве (после исправлений предаудита)

Источник — отчёт интегратора Z-2c (`pub-z2c-report.md` §5), Р-PUB-Z2-28. Скрипт `scripts/publisher-e2e.sh --site` (сам собирает `dist` по метке, сайт — в своей копии, https-домен через CONNECT-прокси на свободном порту).

| Сценарий | Шагов | passed | failed | blocked | Что добавлено/изменено против прогона этапа C (49/49) |
|---|---|---|---|---|---|
| SETUP | 2 | 2 | 0 | 0 | — |
| E2E-01 | 14 | 14 | 0 | 0 | утверждается настоящий текст уведомления (заглушка → 400); `launch_evidence_d0` ссылается на прогон из сида (свободная строка → 409 `qa_run_not_found`, неполный → 409 `qa_run_incomplete` с AT-CORE-03) |
| E2E-02 | 7 | 7 | 0 | 0 | раскрытие контакта — POST; проба GET → 405, POST добавляет ровно одну запись `reveal_contact` (D1-02) |
| E2E-03 | 11 | 11 | 0 | 0 | «два претендента»: резерв первой и параллельное создание ВТОРОЙ закупки — вторая остаток не получает (`PUB_GATE_CLOSED previous_purchase`); при `unknown` проверяется отказ заказа `PUB_RECONCILE_REQUIRED` (DEF-C-02/03) |
| E2E-04 | 9 | 9 | 0 | 0 | + сбой провайдера AI при открытом гейте (`PUB_AI_UNAVAILABLE`, вызов в журнале `unavailable`, ручной путь работает); + отказ импорта по URL (timeout и ssrf, источник не создан) (DEF-C-05) |
| E2E-05 | 8 | 8 | 0 | 0 | — |
| **Итого** | **51** | **51** | **0** | **0** | сайт 7/7 |

Доказательства: `pube2e7/e2e.json` md5 `34f1aae3f007c15d1059f886d822d713`, `pube2e7/site.json` md5 `83d87674e1ba4077b31fb84caaf01eb5`, `pube2e7/seed.json` md5 `d64cc69a985dc660a5919da5a341fb17`. После прогона изменён только `sites-backend/test/publisher-e2e/seed.cjs` (сид стенда).

Ограничения, сохраняющиеся после Z-2c:

- «Два претендента» через API проверяет порядок закупок пилота (P3-10), а не гонку двух закупок за остаток; атомарность резерва доказана jest `budget-reserve-concurrency.spec`.
- E2E-03 без шага «оплачено, не опубликовано → претензия» (jest AT-CORE-16); E2E-05 без «обращения на границе 30-дневного окна» и «поздней оплаты» (jest AT-CORE-19, `reports-revenue`).
- Копия — на локальном хранилище стенда (Р-PUB-Z2-22), не на Vercel Blob.
- Синтетические даты наблюдения и истечения согласования — сдвиг SQL-ом стенда; календарь D42/D72/D90 — часами стенда.
- Протокол приёмки в qa-catalog засеян сидом стенда (помеченная инфраструктура), живого прохождения 44 AT в qa-catalog нет.
- Внутренний прогон, не внешний; джоба CI `publisher-stand` в GitHub Actions ещё не запускалась.
