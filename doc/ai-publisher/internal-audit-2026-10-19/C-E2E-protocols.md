# C1. Протоколы сквозных маршрутов E2E-01…05 — внутренний аудит v2

> Внутренний аудит AI Publisher по плану v2 (19.10.2026), пакет C. Внутренняя независимость ролей, не внешний аудит; не заменяет внешнее заключение. Код и требования аудитор не менял. Сырые доказательства — `/tmp/ia-c-*` (md5 ниже).

## Условия прогона

| Поле | Значение |
|---|---|
| Run ID | **IA-C-E2E-r1** (основной, все пять маршрутов); IA-C-E2E-c3 — подмножество E2E-01/02/03 как стенд для C3 |
| Commit | `4e644293b3a40e834b28a603ff8ba01c0782f707`, рабочее дерево без изменений в проверяемых путях |
| Команда | `WORK=/tmp/ia-c-site-r1 PG=postgresql://postgres:postgres@localhost:5432 DB=ia_c_site PORT=4141 SITE_PORT=3020 BACKEND_ROOT=/tmp/ia-c-backend PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers bash scripts/publisher-e2e.sh --site` |
| Сборка backend | `tsc -p tsconfig.build.json --outDir /tmp/ia-c-backend/dist` из `src` commit'а (exit 0); `BACKEND_ROOT` — штатный режим скрипта «готовый dist вне дерева» |
| Сайт | скрипт сам копирует `publisher-site` в `$WORK/site` (свой `.next`), `next build` / `next start -p 3020`, https-домен `pubsite.test` через CONNECT-прокси на свободном порту (не :443) |
| База | `ia_c_site` — все 50 миграций + `stand-db-clock.sql` + `seed.cjs`; логин-роли `publisher_public_ci`/`assist_widget_ci` — тем же SQL, что `ci.yml` (строки 300–315) |
| Окружение процесса | задаёт скрипт: `NODE_ENV=development`, fake-AI, часы и файловое хранилище копий стенда, `TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128`; бот Telegram недоступен |
| Среда | Node 22.22.0 (CI — 24), PostgreSQL 16.15 + pgvector 0.6.0, Chromium 141.0.7390.37, Next 15.5.27 |
| Время | 2026-10-19 11:03:54Z – 11:06:56Z |
| Итог | **51 шаг: 51 passed, 0 failed, 0 blocked**; сайт (`z-e2e-site.mjs`) **7/7** |
| Доказательства | `e2e.json` md5 `40f0efb52df6be2fe599fde916004ebe`; `e2e-a.json` `b3c7551e8e7f6c454d413ba38c6c280d`; `site.json` `83cee5f1fa7f7cce43fcfd722bdb6b2b`; `seed.json` `67c80f435732d0e2240c27b86f79315d`; `run.log` `afe6051c3210605427690abafe88e3d5`; `phase-a.log` `648d60748225ab016388f0e2ddf7c663`; `server.log` `70a88de78136f4f27d636eac22d524c3`; `site-build.log` `fc4b1056c765dc18d75a7ec5663f1534`; `site.log` `07a2c6adf72b8fa73e2a654ca8df3736` |

Контрольный продукт: `productId cmvf5fn4w0000i47dv3174233`, ключ `pp_3MCC…` (публичный), шесть участников с ролями PO/editor/operator/analyst/sales/viewer (шаг 2). В журнале сервера за прогон 2 строки ERROR/WARN, обе ожидаемые инъекцией сбоев: 503 `PUB_AI_UNAVAILABLE` (шаг 37) и 405 на GET раскрытия контакта (шаг 25; код тела ответа при этом `INTERNAL_SERVER_ERROR` — IA-C-03, S3).

Прогон IA-C-E2E-c3 (`/tmp/ia-c-c3-r1`, `PUB_E2E_ONLY=E2E-01,E2E-02,E2E-03`, база `ia_c_c3`): 34/34 passed, сайт 7/7 (`stand-run.log` md5 `4277a6dcc5623a3804ec97a9a4847ec5`, `e2e.json` `e1377f039b0e2a43c49b8da3697c9e6e`, `site.json` `1905d48afa800543965547237bb08f71`).

Нумерация шагов ниже — порядок `results` в `e2e.json` (1…51).

---

## E2E-01 Подготовка и выпуск контента — **passed** (12 шагов + 2 хвостовых)

| Шаг | Что | Цепочка ID / факт |
|---|---|---|
| 3 | оффер (PO) | `offerId cmvf5fngq001l…` active |
| 4 | разрешённые источники | `cmvf5fnjp001q…`, `cmvf5fnkz001s…` allowed |
| 5 | вопрос | `questionId cmvf5fnlq001u…` selected |
| 6 | бриф | `briefId cmvf5fnnz001y…` ready |
| 7 | черновик с критическим claim | `contentId cmvf5fnpy0023…`, `versionId cmvf5fnrm0027…`, `claimId cmvf5fnqp0025…`, hash `abe0059f…` |
| 8 | неподтверждённый факт блокирует | 409 `PUB_BLOCKERS_OPEN` `claim_not_supported` |
| 9 | claim подтверждён → согласование hash | прежняя версия `PUB_APPROVAL_STALE`; новая `cmvf5fnzh002n…`, `approvalId cmvf5fo58002z…`, hash `df273797…`, selfReview false |
| 10 | эксперимент pilot до t0 | `cmvf5fo6o0032…` v2 registered |
| 11 | гейт `public_publish` | заглушка уведомления → 400 `draft_placeholder` (DEF-C-04); `launch_evidence_d0` свободной строкой → 409 `qa_run_not_found`, неполный прогон → 409 `qa_run_incomplete`; затем гейты `public_publish` и `real_leads` open |
| 12 | live, публикация | `publicationId cmvf5fphy0056…` published, URL `https://pubsite.test/materials/yak-obraty-nlddeijh` |
| 13 | публичный текст = согласованная версия | API сайта: versionHash `df273797…` = hash согласования шага 9 |
| 14 | три адаптации | post/cards/checklist: до смысловой QA `PUB_BLOCKERS_OPEN`, затем approvals `cmvf5fpp1…`, `cmvf5fpuw…`, `cmvf5fq03…` |
| 44 | смена цены (новый оффер) | `cmvf5gbrm00bb…`; статья `correction_required`, 7 задач, прежнее согласование остаётся active до решения |
| 45 | смена ключевого claim | `cmvf5gbuh00bn…` заменяет `cmvf5fnqp0025…`; задачи `claim_changed` по версиям, контенту, публикации |

Ожидание плана §12 («неподтверждённый факт блокируется; новая версия требует решения; адаптации получают повторную проверку; публичный текст соответствует разрешённой версии») — выполнено (8, 9, 13, 14, 44, 45). Снимок публичной страницы — `site.json` (h1 = согласованной версии, текст в HTML без JS). Замечание предаудита сохраняется: в шаге 44 `cascade.correctionRequired=[]` при статусе статьи `correction_required` — по правилу AT-F02-02 «страница с прежним hash остаётся до решения» это ожидаемо, но статусы адаптаций в доказательство шага не выводятся (видно только число задач).

## E2E-02 Обращение и продажа — **passed** (7 шагов + 7 проверок сайта)

| Шаг | Что | Цепочка ID / факт |
|---|---|---|
| 20 | сайт: Chromium, мобильный вьюпорт, `https://pubsite.test`, `utm_source=venue&utm_medium=paid&placement=<код>` → материал → внутренний переход → CTA → форма; двойной клик | 7/7; `leadRef L-SIWBKQOSCQ`, `sessionRef nsewBUR7…`; ошибок консоли в контрольном пути 0 (единственная запись — 404 от намеренного перехода на несуществующий материал после проверки) |
| 21 | заявка в кабинете | `leadId pl_bf11e44b…`, contentId `cmvf5fnpy0023…`, placementId `cmvf5fqxf007u…`, campaignId `cmvf5fn64…`, first/last = paid_placement; одна заявка на двойной клик |
| 22 | сбой уведомления | 2 уведомления pending, outbox done, заявка `new` цела |
| 23 | повтор того же submissionKey | `L-WYYERUJ7R5`: 201 → 200, одна заявка |
| 24 | без метки и без хранения | `pl_bed7bcbf…`: coverage `unknown`, sessionRef null — догадки нет |
| 25 | менеджер: раскрытие (POST; GET → 405 без записи), контакт, квалификация, предложение, тестовая оплата | prospect `pr_41048029…`, `proposal_sent`, payment `cmvf5g9ej008p…` payerKind `test`, pending |
| 26 | вторая задача того же клиента | `pl_9408c662…` → тот же `pr_41048029…`; проспектов 3 (не выросло) |

Ожидание («нет ложного успеха; одна заявка на одну операцию; unknown не восстанавливается догадкой; две задачи одного клиента не увеличивают число уникальных prospect_id») — выполнено. Снимок отчёта без контактов — шаг 33 (E2E-05). Офлайн, потерянный ответ, 500, 5 параллельных, лимит, недоступный приём событий — на настоящем стенде в `C3-nonfunctional.md`, все без ложного успеха.

## E2E-03 Закупка и денежная сверка — **passed с замечаниями** (11 шагов)

| Шаг | Что | Цепочка ID / факт |
|---|---|---|
| 15 | бюджет 10 000 / 6 000 / 2 000 / 2 000 | total 1 000 000 коп. |
| 16 | площадка | `venueId cmvf5fqnj007n…` verified; без пяти проверок/маркировки/доказательства — 400 с полями |
| 17 | закупка до 7 дней наблюдения | 409 `PUB_OBSERVATION_PENDING` |
| 18 | сдвиг публикации на 8 дней (SQL стенда, только даты) | shiftedDays 8 |
| 19 | согласование → резерв → заказ → оплата → публикация → проверка | `placementId cmvf5fqxf007u…` verified_complete, paid; до оплаты available 500 000, openCommitment 100 000, deliveredUnpaid 40 000; после — available 500 000, netPaid 300 000, cash {paid 300 000, economicDelivered 40 000, advances 260 000} |
| 27 | решение по отчёту — основание для 3-й закупки | `reportId cmvf5g9lv…`, decision `cmvf5g9np…` |
| 28 | рост цены после согласования | `cmvf5g9po…`: 409 `PUB_APPROVAL_STALE {price_changed}` |
| 29 | истёкшее согласование | `cmvf5g9vh…`: 409 `PUB_APPROVAL_EXPIRED` |
| 30 | два претендента | повторный резерв той же: `["PUB_APPROVAL_REQUIRED","OK"]`, available 500 000 → 300 000; вторая РАЗНАЯ закупка параллельно → 409 `PUB_GATE_CLOSED previous_purchase` (утверждается драйвером) |
| 31 | unknown | гейт purchases `reconcile pending_or_unknown:1`; заказ → `PUB_RECONCILE_REQUIRED` (утверждается, DEF-C-03); сверка void снимает блок |
| 32 | отмена и возврат | openCommitment 200 000 → 0; netPaid 300 000 → 280 000; возврат сверх оплаты → `PUB_VALIDATION` |

**Контрольная арифметика (§12, ТЗ §17):** до оплаты 10 000 − 2 000 (инструменты, оплачено) − 1 000 (обязательство) − 2 000 (защищённый резерв) = **5 000** = available 500 000 коп.; delivered_unpaid 400 повторно не вычитается (не 4 600). После оплаты 1 000: 10 000 − 3 000 − 0 − 2 000 = **5 000**. Ручной пересчёт совпал с шагом 19; jest `budget-flow.spec` (2/2 passed) утверждает те же компоненты HTTP-ответа `/budget`.

Ожидание («без действующего согласования заказ не выполняется; обязательство не теряется; повтор не создаёт оплату; аванс не является оказанной услугой») — выполнено (19, 28, 29, 31; advances 2 600 отдельно от economicDelivered 400). Замечания (не дефекты кода, ограничения протокола): «два претендента на остаток» через API проверяет правило «закупки по одной» (P3-10), атомарность резерва — jest `budget-reserve-concurrency.spec` (3/3); шага «оплачено, не опубликовано → претензия» в E2E нет — jest `dist-paid-unpublished.spec` (AT-CORE-16).

## E2E-04 Отказ и восстановление — **passed** (9 шагов)

| Шаг | Что | Факт |
|---|---|---|
| 36 | «AI недоступен» — закрытый гейт | 409 `PUB_GATE_CLOSED ai_use` (параметры assumption), ручной путь — вопрос `cmvf5gapt…` создан |
| 37 | сбой провайдера AI при открытом гейте | 503 `PUB_AI_UNAVAILABLE`, вызов в журнале `unavailable`, ручной путь работает (DEF-C-05) |
| 38 | отказ импорта по URL | `https://unreachable.e2e.invalid` → 400 `PUB_IMPORT_BLOCKED timeout`; `https://10.0.0.1/internal` → `ssrf`; источник не создан, ручной ввод `cmvf5gb1i…` (DEF-C-05) |
| 39 | сбой уведомления, повтор | повтор OK, статусы failed (бот недоступен), заявка цела |
| 40 | аналитика отключена | `web_analytics disconnected` → гейт purchases закрыт; восстановление → открыт |
| 41 | резервная копия | `bk_a6e8dbb0…`, manual, sha256 `0c4b97a9…`, 39 137 Б, счётчики таблиц |
| 42 | удаление контакта, отзыв источника | `pl_9408c662…` erased, раскрытие `PUB_NOT_FOUND`; источник revoked; задач 9 |
| 43 | восстановление в `restored` | dry-run: связей 620, висячих 0, расшифровка 4/4; apply — удалённый контакт и отозванный источник не вернулись, внешние действия подавлены |
| 46 | снятие материала → site-revalidate | 1-й проход 200 (processed 4), 2-й — pending 0; API 410, сайт 410 сразу |

Ожидание («сохранённая заявка остаётся; ручная альтернатива AI доступна; внешние действия не повторяются; удаление/отзыв применяются после восстановления») — выполнено. Ограничения: копия — в файловом хранилище стенда (Р-PUB-Z2-22), не в Vercel Blob; реальный бот и Vercel Cron не проверяются.

## E2E-05 Отчёт и решение — **passed с замечаниями** (8 шагов, часы стенда)

| Шаг | Что | Факт |
|---|---|---|
| 33 | недельный снимок | `cmvf5gafv009q…`, inputsHash `664902f4…`; inPeriod 4, pending 3 ≠ qualifiedUnique 1; деньги раздельно; контактов нет |
| 34 | поздняя квалификация → наследник | `cmvf5gam9009v…` `late_decision`, supersedes исходный, исходный не изменён |
| 35 | решение — новая строка | decision `cmvf5ganw009y…`; второе решение `PUB_CONFLICT` |
| 47 | синтетический календарь | t0 `2026-10-19T11:06:26.099Z`, t42 `2026-11-30T12:06:26.099Z` (+1 ч UTC — переход на зимнее время Kyiv); сессии в t42 − 1 мс и ровно t42 ставит сервер БД стенда |
| 48 | D42 | `cmx3a7t2b…` (system:report-milestones): когорта [t0,t42), sessions 2 (сессия ровно в t42 вне), независимый пересчёт совпал; нулевые знаменатели — «не рассчитывается» |
| 49 | D72 | `cmya5fd2a…`: windowClosed true, pending 3 отдельно от qualifiedUnique 2 |
| 50 | поздняя квалификация после D72 | наследник `cmya5fd9u…` late_decision: qualifiedUnique 2 → 3, pending 3 → 2; исходный D72 не изменён |
| 51 | D90 | `cmyzvcp27…`: период [t0,t90), searchSignalD90 inconclusive (данных поиска нет), история d90/d72/d42/weekly |

Ожидание («[t0,t42) не включает сессию ровно в t42; pending не считается qualified; позднее решение создаёт новый снимок; cash, оказанные затраты, операционные и инвестиционные метрики разделены; связь канала не объявляется причинной») — выполнено; последнее — формулировки отчёта (jest `reports-signal`, `reports-economics`), отдельной проверки текста в E2E нет. Замечания: в E2E нет обращения на границе собственного 30-дневного окна сессии и поздней оплаты — доказаны jest `reports-cohorts` и `reports-revenue` (AT-CORE-19/24).

---

## Что изменилось против предаудита (Z-2c, 51/51) и почему перезапуск

Код Publisher после 13.10 получил подсистему Reddit (M1/M2, Админка), импорт исследования, изменения `qa-run-evidence.ts` (связь доказательств с попытками прогона), второй канал телеметрии сайта (`LandingVisits`/`Track`) и правку отсечки недельного снимка в драйвере (`publisher-e2e.ts`, коммит `db6d68df`). Перенос старых доказательств без перезапуска недопустим (§4 E внешнего плана) — все маршруты исполнены заново на `4e644293`. Новые шаги по сравнению с Z-2c не добавлялись; состав 51 шага тот же.

## Перепроверка находок предаудита по стенду

| Находка | Исходный сценарий | Повтор на 4e644293 | Статус |
|---|---|---|---|
| DEF-C-01 | драйвер не получал порт сайта (`fetch failed` на шаге revalidate), :443 жёстко, общий `.next`, устаревший `dist` | скрипт передаёт `PUB_E2E_SITE_PORT=$SITE_PORT` (драйвер стр. 2036), сайт — в `$WORK/site` со своим `.next`, https — CONNECT-прокси на свободном порту; шаг 46 (revalidate сайта) passed; динамически: без `BACKEND_ROOT`, без `dist` и с `PUB_E2E_NO_BUILD=1` скрипт отказывает «dist устарел (нет dist/main.js) — соберите sites-backend», exit 1, сборки нет (`/tmp/ia-c-nobuild/run.log` md5 `a86f7bb2568a33dda7175f7be8c092d6`) | verified_closed |
| DEF-C-02 | «два претендента» исполнял повторный резерв одной закупки | шаг 30 — вторая РАЗНАЯ закупка параллельно, отказ `previous_purchase` утверждается | verified_closed (остаток: гонка через API недостижима — jest) |
| DEF-C-03 | отказ заказа при unknown не утверждался | шаг 31: `expect(blocked1.code === 'PUB_RECONCILE_REQUIRED')` | verified_closed |
| DEF-C-05 | E2E-04 без отказа импорта и сбоя провайдера AI | шаги 37, 38 | verified_closed |
| DEF-C-04 | заглушка уведомления утверждалась | шаг 11: заглушка → 400 `draft_placeholder`; jest `launch-evidence`, `gates.db` | verified_closed (AT-CORE-09 остаётся blocked по иной причине) |
| DEF-C-07 (дубль B1-F-03; статус B1-F-03 ведёт пакет A/B) | `qaRunId` свободной строкой открывал гейт | шаг 11: свободная строка → 409 `qa_run_not_found`, неполный → `qa_run_incomplete`; jest `qa-run-evidence`, `qa-catalog.database` («blocks acceptance after an interrupted runner») | verified_closed |

---

## Перепроверка 19.10 после исправлений (E1)

**Проверенная версия:** HEAD `4e644293` + незакоммиченные исправления FX-A/FX-B/FX-C: `git diff` 48 файлов (+1771/−235), sha256 диффа `0f11b3c23aa258f5a3fcf6bccbb739951b2d630af58a714be9a262d391ace7a0`; 13 новых файлов (в т. ч. миграция `20261026100000_publisher_reddit_policy_version`, `publisher-site/src/lib/landing-visits.ts`), список sha256 — `/tmp/ia-c-e1/untracked-sha256.txt` (sha256 `5256651d…e563225`). Дифф перепроверен в конце прогонов — не менялся. Сборка backend — `tsc` в `/tmp/ia-c-e1/backend/dist` (exit 0); все стенды — `flock -o` (фоновые серверы замок не держат). Время 12:56–13:19 UTC. Среда та же, что в первом проходе.

Команда та же, что в первом проходе, с `WORK=/tmp/ia-c-e1/site-r2 DB=ia_c_site2 BACKEND_ROOT=/tmp/ia-c-e1/backend` (скрипт теперь экспортирует `PUBLISHER_RELEASE_SHA`, сид требует её и пишет попытки протокола как импорт отчёта jest). Время 12:57:04–12:57:48Z. **51 шаг: 51 passed**, сайт 7/7 (`L-2M52OFVDDZ`). Доказательства: `e2e.json` md5 `d74fbf716cf2f5e171c6d9c5c1786c83`, `site.json` `7902477bee6a9f22723efb33033a7b54`, `seed.json` `956467dddbe0e7628a78f0d676c07c58`, `run.log` `76704304c43264a067a0143ec2f9331a`, `server.log` `2271397a03905b40b3b656f2cd23f1e5`.

- E2E-01…05 — **passed** (составы шагов и замечания первого прохода без изменений).
- Шаг 11 (утверждение `launch_evidence_d0`): свободная строка → 409 `qa_run_not_found`; неполный прогон (AT-CORE-03 = failed) → 409 `qa_run_incomplete` + `releaseSha`; полный → `approved`; `public_publish` и `real_leads` open.
- Шаг 25: GET раскрытия → **405 METHOD_NOT_ALLOWED** (IA-C-03 закрыт; в первом проходе код тела был `INTERNAL_SERVER_ERROR`).
- Стенд C3 (`/tmp/ia-c-e1/c3-r2`, `c3-r3`, `PUB_E2E_ONLY=E2E-01,E2E-02,E2E-03`): 34/34 и 34/34.
