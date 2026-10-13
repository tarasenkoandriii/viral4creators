/**
 * AI Publisher — каталог 44 обязательных P0-сценариев приёмки для
 * qa-catalog (P-E, проектный документ §18.1, §16.7; план приёмки
 * `pilot-acceptance-v2`). Источник — таблица трассировки §18.1 (шлюз,
 * пакет, файл, тип, автоматизация и ручной остаток) и названия сценариев
 * плана приёмки. `caseKey` = AT-ID.
 *
 * Автоматизированная часть сценария проверяется тестами с меткой
 * `[AT-…]` в `describe`/`it` (`src/acceptance/publisher/<префикс>-*.spec.ts`
 * и др.); ручной остаток (`manual`) отчётом НЕ закрывается — он остаётся
 * отдельным протоколом владельца (§17.3: без подмены ручных частей).
 *
 * Чистый модуль (данные).
 */
export type AtGate = 'D0' | 'Z' | '42';
export type AtTestType = 'unit' | 'db' | 'http' | 'e2e' | 'ui' | 'eval';

export interface AtCase {
  /** AT-ID — `caseKey` qa-catalog. */
  id: string;
  title: string;
  /** Шлюзы: D0 (21), закупка Z (30), дополнительно к D42 (12). */
  gates: readonly AtGate[];
  packages: readonly string[];
  /** Файлы тестов по трассировке (имена без путей). */
  files: readonly string[];
  types: readonly AtTestType[];
  /** Что проверяют автотесты. */
  automated: string;
  /** Ручной остаток (протокол), null — нет. */
  manual: string | null;
}

export const AT_CATALOG: readonly AtCase[] = [
  {
    id: 'AT-CORE-01',
    title: 'Доступность материала',
    gates: ['D0', 'Z'],
    packages: ['P-F', 'P-B1'],
    files: ['check-built.ts', 'e2e.mjs', 'content-public-read.spec'],
    types: ['e2e', 'http'],
    automated:
      'HTTPS-origin, title/description/canonical, sitemap, noindex на тестовой сборке и index на сборке с двумя ключами, основной текст без JS, CTA',
    manual: 'телефон, повтор на публичном URL после выпуска',
  },
  {
    id: 'AT-CORE-02',
    title: 'Клавиатура и ошибки формы',
    gates: ['D0', 'Z'],
    packages: ['P-F', 'P-D'],
    files: [
      'e2e.mjs',
      'axe-check.mjs',
      'public-rate-limit.spec',
      'public-limits.http.spec',
    ],
    types: ['e2e', 'db', 'http'],
    automated:
      'клавиатура, ошибка текстом у поля, данные не исчезают, 320 px, axe/контраст ≥ 4,5:1, консоль 0, 6-я новая отправка за 600 с → 429 с альтернативным контактом (скользящее окно), сброс счётчика между сценариями',
    manual: 'телефон',
  },
  {
    id: 'AT-CORE-03',
    title: 'Неудачная отправка',
    gates: ['D0', 'Z'],
    packages: ['P-F', 'P-D'],
    files: ['e2e.mjs', 'public-lead-intake.spec'],
    types: ['e2e', 'db'],
    automated:
      'нет успеха и нет `lead_submit_success` при откате/ошибке; кнопка повтора и альтернативный контакт; повтор после обрыва с тем же ключом → та же заявка, даже после исчерпания лимита',
    manual: null,
  },
  {
    id: 'AT-CORE-04',
    title: 'Однократное сохранение',
    gates: ['D0', 'Z'],
    packages: ['P-D', 'P-F'],
    files: ['public-lead-idempotency.spec', 'e2e.mjs'],
    types: ['db', 'e2e'],
    automated:
      'один `submissionKey` ×10 параллельно → 1 заявка, тот же `leadRef`; другой контент с тем же ключом → 409; 5 разных параллельно → 5 или честная ошибка; другая задача того же человека — новая заявка; лимит сброшен',
    manual: null,
  },
  {
    id: 'AT-CORE-05',
    title: 'Уведомление менеджеру недоступно',
    gates: ['D0', 'Z'],
    packages: ['P-D'],
    files: ['leads-notifications.spec'],
    types: ['db'],
    automated:
      'фейк бота бросает → заявка, событие и outbox сохранены, уведомление `failed`, ретрай не плодит заявки, очередь видна',
    manual: 'ежедневная отметка `pub_queue_checks` (регламент)',
  },
  {
    id: 'AT-CORE-06',
    title: 'Тесты исключены из спроса',
    gates: ['D0', 'Z'],
    packages: ['P-D', 'P-E'],
    files: ['leads-test-flag.spec', 'reports-exclusion.spec'],
    types: ['db'],
    automated:
      'тестовые сессия/событие/заявка/квалификация есть в диагностике, отсутствуют в метриках отчёта и в публичном контенте; смена `testFlag` — решение с причиной в истории',
    manual: null,
  },
  {
    id: 'AT-CORE-07',
    title: 'Квалификация и причины',
    gates: ['D0', 'Z'],
    packages: ['P-D', 'P-E'],
    files: ['leads-qualification.spec', 'reports-cohorts.spec'],
    types: ['db', 'unit'],
    automated:
      'квалификация с подтверждением, отказ поставщику с кодом причины, AI-маршрута нет (граф + отсутствие эндпоинта), бюджет `unknown` допустим, две задачи одного проспекта считаются одним',
    manual: null,
  },
  {
    id: 'AT-CORE-08',
    title: 'Второй продукт и чужие данные',
    gates: ['42'],
    packages: ['Z', 'P-A1'],
    files: ['z-isolation.spec', 'route-enumerator'],
    types: ['db', 'http'],
    automated:
      'реестр контрактов = роутер приложения; каждый маршрут с `:pid`/`:siteId` от чужого кабинета → 404, неотличимо от несуществующего; id объекта чужого кабинета в своём продукте — как несуществующий; отозванные роли и наблюдатель на мутациях — 403; без побочных эффектов; маршрут вне матрицы ролей роняет тест; составной FK не даёт связать; выгрузки только своего',
    manual: 'отметка «второй продукт не подключён»',
  },
  {
    id: 'AT-CORE-09',
    title: 'Контакты не попали в аналитику',
    gates: ['D0', 'Z'],
    packages: ['Z', 'P-D', 'P-B2', 'P-E'],
    files: [
      'z-pii-scan.spec',
      'ai-context.spec',
      'leads-retention.spec',
      'restore-export.spec',
      'leads-contact-reveal.http.spec',
    ],
    types: ['db', 'unit', 'http'],
    automated:
      'после раскрытия контакта синтетический контакт найден только в шифротекстах (сырой поиск по всем колонкам `pub_*`, включая `pub_idempotency_keys` и `pub_audit_events`, вне явного списка разрешённых колонок; плюс журналы приложения, промпт модели, ответы и ошибки API, тексты уведомлений), UTM с email → `[redacted]`, AI-контекст без лидов, свободный текст с телефоном отвергнут, раскрытие только SA/PO; закрытая заявка: `reviewDueAt = closedAt+90`, удаление и обезличенная запись; открытая — дата и основание',
    manual: 'текст уведомления о данных и `consent_map` утверждены',
  },
  {
    id: 'AT-CORE-10',
    title: 'Версия и согласование',
    gates: ['D0', 'Z'],
    packages: ['P-B1', 'P-A1', 'P-G1'],
    files: [
      'content-approval-hash.spec',
      'core-revision.spec',
      'publisher-view.test',
    ],
    types: ['db', 'ui'],
    automated:
      'новая версия после правки факта/claim требует нового решения; прежний hash не разрешает новый текст (hash включает содержимое claims и источников); опубликованная v1 остаётся на сайте до публикации v2; параллельная правка → 409 и сообщение; `pub_public_contents` отдаёт только согласованный hash',
    manual: null,
  },
  {
    id: 'AT-CORE-11',
    title: 'Доступы и отзыв роли',
    gates: ['D0', 'Z'],
    packages: ['P-A1', 'P-B2'],
    files: ['core-role-revoke.spec'],
    types: ['db', 'eval'],
    automated:
      'после отзыва `operator` — 403 на согласования, бюджет, заявки на следующем запросе; удалённый участник — гранты отозваны заданием; текст «я владелец» в AI-запросе не меняет роли (нет инструмента + AI-28)',
    manual: null,
  },
  {
    id: 'AT-CORE-12',
    title: 'Неполная аналитика',
    gates: ['Z'],
    packages: ['P-E', 'P-C', 'P-G2'],
    // «Неполный период без нулей» проверяют `reports-integrations` и
    // `reports-signal` (аудит P-E S2-2; трассировка §18.1 исправлена на
    // интеграции Z-2a — прежняя ссылка `reports-coverage.spec`).
    files: [
      'reports-integrations.spec',
      'budget-purchase-gate.spec',
      'reports-signal.spec',
    ],
    types: ['db', 'ui'],
    automated:
      'интеграция `degraded/disconnected` или устарела → `PUB_GATE_CLOSED` на резерв; отчёт показывает `lastSyncedAt` и неполный период без нулей',
    manual: null,
  },
  {
    id: 'AT-CORE-13',
    title: 'Валюта и полная цена',
    gates: ['Z'],
    packages: ['P-C'],
    files: ['budget-price-fx.spec'],
    types: ['db'],
    automated:
      'цена без комиссий не утверждается; иная валюта без курса/источника/времени → `PUB_FX_REQUIRED`; с ними — сумма в валюте лимита',
    manual: null,
  },
  {
    id: 'AT-CORE-14',
    title: 'Два претендента на остаток бюджета',
    gates: ['Z'],
    packages: ['P-C'],
    files: ['budget-reserve-concurrency.spec'],
    types: ['db'],
    automated:
      'две транзакции на один остаток → одна успешна; 20 повторов: ровно один успех, остальные INSUFFICIENT/BUSY; сверка счётчиков',
    manual: null,
  },
  {
    id: 'AT-CORE-15',
    title: 'Неизвестная оплата',
    gates: ['Z'],
    packages: ['P-C'],
    files: ['budget-payment-unknown.spec'],
    types: ['db'],
    automated:
      '`unknown` удерживает обязательство, повтор оплаты/заказа → `PUB_RECONCILE_REQUIRED`, сверка ответственным с документом',
    manual: null,
  },
  {
    id: 'AT-CORE-16',
    title: 'Оплачено, но не опубликовано',
    gates: ['Z'],
    packages: ['P-C'],
    files: ['dist-paid-unpublished.spec'],
    types: ['db'],
    automated:
      'оплата `paid`, публикация `publication_pending/disputed`, владелец претензии и `nextActionAt` обязательны; трафик не создаётся',
    manual: null,
  },
  {
    id: 'AT-CORE-17',
    title: 'Отмена и возврат',
    gates: ['Z'],
    packages: ['P-C'],
    files: ['budget-cancel-refund.spec', 'budget-math.spec'],
    types: ['db', 'unit'],
    automated:
      'отмена освобождает только подтверждённую сумму; обещанный возврат не меняет `net_paid`, подтверждённый — меняет',
    manual: null,
  },
  {
    id: 'AT-CORE-18',
    title: 'Нулевой знаменатель',
    gates: ['Z'],
    packages: ['P-E', 'P-G2'],
    files: ['reports-economics.spec', 'publisher-ops-view.test'],
    types: ['unit', 'ui'],
    automated:
      '0 заявок/оплат → `not_computable` с числителем; неизвестная ставка → «не менее»; экран «не розраховується»',
    manual: null,
  },
  {
    id: 'AT-CORE-19',
    title: 'Предварительные окна',
    gates: ['42'],
    packages: ['P-E', 'P-A1'],
    files: [
      'core-kyiv-time.spec',
      'reports-cohorts.spec',
      'reports-snapshots.spec',
    ],
    types: ['unit', 'db'],
    automated:
      'TD-09: границы t42, окно 30 дней включительно, pending отдельно, позднее решение → снимок-наследник (`report-staleness`), поздняя публикация → отдельная когорта с явным концом, состояние окна размещения',
    manual: 'живые окна закрываются только на D72',
  },
  {
    id: 'AT-CORE-20',
    title: 'Восстановление экспорта',
    gates: ['D0', 'Z'],
    packages: ['P-E'],
    files: ['restore-apply.spec'],
    types: ['db'],
    automated: 'раздел 15.4',
    manual:
      'срок ротации копий записан параметром, старые ключи сохранены до `rotationUntil`',
  },
  {
    id: 'AT-CORE-21',
    title: 'Удаление разрешённого ранее источника',
    gates: ['D0', 'Z'],
    packages: ['P-B1'],
    files: ['content-source-revoke.spec'],
    types: ['db'],
    automated:
      'отозванный источник не попадает в новый контекст (`context-preview`) и общие выгрузки; связанные claims/версии/адаптации/публикации получают задачи',
    manual: null,
  },
  {
    id: 'AT-CORE-22',
    title: 'Внешний URL с недопустимой целью',
    gates: ['D0', 'Z'],
    packages: ['P-B1'],
    files: ['content-import-ssrf.spec'],
    types: ['db', 'unit'],
    automated:
      'внутренние/локальные адреса, rebinding, редиректы → отказ без запроса во внутреннюю сеть',
    manual: null,
  },
  {
    id: 'AT-CORE-23',
    title: 'Порог не переписан задним числом',
    gates: ['42'],
    packages: ['P-E'],
    files: ['reports-experiment-immutable.spec', 'reports-signal.spec'],
    types: ['db', 'unit'],
    automated:
      'пороги (включая `minSampleForConclusion`) заморожены триггером; результат ниже порога → `not_met`; новая гипотеза — новая версия; `t0` ставится один раз',
    manual: null,
  },
  {
    id: 'AT-CORE-24',
    title: 'Оплата и внутренний клиент',
    gates: ['42'],
    packages: ['P-D', 'P-E'],
    files: ['leads-payments-kinds.spec', 'reports-revenue.spec'],
    types: ['db', 'unit'],
    automated:
      'внутренняя/тестовая оплата не выручка и не CAC; без подтверждённой внешней — «коммерческая валидация не подтверждена» в отчёте',
    manual: null,
  },
  {
    id: 'AT-F01-01',
    title:
      'Импортировать десять вопросов с источниками; получить группы и шесть тем, у каждой исходные фрагменты и объяснение приоритета',
    gates: ['42'],
    packages: ['P-B1'],
    files: ['content-questions.spec'],
    types: ['db'],
    automated:
      '10 вопросов с источниками → группы (вручную; AI-кластеризация выключена, ДТ-2) → 6 тем с фрагментами и пояснением к каждой из четырёх оценок 0–2',
    manual: null,
  },
  {
    id: 'AT-F01-02',
    title:
      'Убрать данные частотности и добавить два вопроса с одинаковыми словами, но разными задачами; частотность неизвестна, разные намерения не склеены автоматически',
    gates: ['42'],
    packages: ['P-B1'],
    files: ['content-questions-merge.spec'],
    types: ['db', 'unit'],
    automated:
      'без частотности поле `NULL` и «невідомо»; два вопроса с общими словами и разными задачами не склеиваются без решения человека',
    manual: null,
  },
  {
    id: 'AT-F02-01',
    title:
      'Сформировать контекст из утверждённого профиля; цена и условия соответствуют активной версии',
    gates: ['D0', 'Z'],
    packages: ['P-B1'],
    files: ['content-brand-context.spec'],
    types: ['db'],
    automated: 'контекст содержит активную цену и условия, не v1',
    manual: null,
  },
  {
    id: 'AT-F02-02',
    title:
      'Добавить конфликтующую цену и неутверждённый кейс; они не используются как факт, создаётся задача разрешить конфликт. Изменение утверждённого оффера переводит связанные опубликованные материалы и адаптации на проверку даже при неизменном hash текста',
    gates: ['D0', 'Z'],
    packages: ['P-B1'],
    files: ['content-brand-conflict.spec', 'content-offer-cascade.spec'],
    types: ['db'],
    automated:
      'конфликт → `needs_resolution` + задача; неутверждённый кейс вне контекста; новый оффер или изменённый факт (`pub_version_facts`) → опубликованные материалы и адаптации в проверку при неизменном hash; неопубликованные согласования → `superseded`',
    manual: null,
  },
  {
    id: 'AT-F03-01',
    title:
      'По подтверждённому вопросу получить бриф с собственным вкладом, источником и уместным CTA',
    gates: ['D0'],
    packages: ['P-B1'],
    files: ['content-brief.spec'],
    types: ['db'],
    automated:
      'готовый бриф: вклад, источник, CTA с пояснением уместности (вручную или через `pub.brief.draft` на фейке)',
    manual: null,
  },
  {
    id: 'AT-F03-02',
    title:
      'Удалить собственный вклад либо подменить оффер; бриф не становится готовым до исправления',
    gates: ['D0'],
    packages: ['P-B1'],
    files: ['content-brief-not-ready.spec'],
    types: ['db'],
    automated: 'без вклада или с неактивным оффером → `PUB_BRIEF_NOT_READY`',
    manual: null,
  },
  {
    id: 'AT-F04-01',
    title:
      'Выделить claims и связать критические утверждения с источниками и ручным подтверждением',
    gates: ['D0', 'Z'],
    packages: ['P-B1'],
    files: ['content-claims.spec'],
    types: ['db'],
    automated:
      'claims введены редактором (извлечение AI выключено, ДТ-2), критические связаны с источниками и человеческим подтверждением; `pub.qa.review` на фейке даёт предложение',
    manual: null,
  },
  {
    id: 'AT-F04-02',
    title:
      'Источник не подтверждает цифру; QA блокирует фразу, а не принимает ссылку как достаточную проверку',
    gates: ['D0', 'Z'],
    packages: ['P-B1'],
    files: ['content-claims-unsupported.spec'],
    types: ['db'],
    automated:
      '`supports=no` → критический claim не `supported`, согласование версии → `PUB_BLOCKERS_OPEN`',
    manual: null,
  },
  {
    id: 'AT-F06-01',
    title:
      'Из одной версии получить пост, карточки и сценарий, каждый с самостоятельной пользой и parent_version',
    gates: ['42'],
    packages: ['P-B1'],
    files: ['content-adaptations.spec'],
    types: ['db'],
    automated:
      'пост, карточки, сценарий с `parentVersionId`, своим заголовком и CTA; сценарий помечен как сценарий',
    manual: null,
  },
  {
    id: 'AT-F06-02',
    title:
      'Изменить ключевой claim; зависимые адаптации получают статус проверки и не распространяют старую гарантию',
    gates: ['42'],
    packages: ['P-B1'],
    files: ['content-adaptation-cascade.spec'],
    types: ['db'],
    automated:
      'изменение ключевого claim (новая строка) → адаптации в проверку, распространение с `criticalStale` отвергнуто',
    manual: null,
  },
  {
    id: 'AT-F09-01',
    title:
      'Сформировать календарь по адаптациям; у действий есть формат, владелец, версия и измеряемая ссылка',
    gates: ['42'],
    packages: ['P-C'],
    files: ['dist-calendar.spec'],
    types: ['db'],
    automated:
      'календарь (вручную; AI-план выключен, ДТ-2): формат, владелец, версия, измеряемая ссылка с UTM',
    manual: null,
  },
  {
    id: 'AT-F09-02',
    title:
      'Канал запрещает рекламу либо недоступен; задача блокируется, публикация не записывается как выполненная',
    gates: ['42'],
    packages: ['P-C'],
    files: ['dist-blocked.spec'],
    types: ['db'],
    automated:
      'канал без рекламы/недоступен → `blocked` с причиной, `done` без публикации невозможен',
    manual: null,
  },
  {
    id: 'AT-F10-01',
    title:
      'Сравнить кандидатов по одинаковым критериям; у пяти проверенных карточек есть условия и источник данных',
    gates: ['Z'],
    packages: ['P-C', 'P-G2'],
    files: ['dist-venues.spec', 'publisher-ops-view.test'],
    types: ['db', 'ui'],
    automated:
      'одинаковые критерии, пять `verified` с условиями и доказательствами (`pub_venue_evidence`), полнота отдельно от балла',
    manual: null,
  },
  {
    id: 'AT-F10-02',
    title:
      'Высокая общая посещаемость без соответствия аудитории; площадка не получает обещанного прогноза переходов и не проходит обязательную проверку только за рейтинг',
    gates: ['Z'],
    packages: ['P-C'],
    files: ['dist-venues-traffic.spec'],
    types: ['db', 'unit'],
    automated:
      'нет поля прогноза; высокий балл без соответствия аудитории → не `verified`',
    manual: null,
  },
  {
    id: 'AT-F11-01',
    title:
      'Пройти тестовый путь по внешней метке и отправить форму; после внутреннего перехода и сохранения формы доступные материал, публикация и источник восстанавливаются в CRM и отчёте через допустимый session_ref; карта событий, consent_state и дедупликация event_id совпадают с ТЗ',
    gates: ['D0', 'Z'],
    packages: ['P-D', 'P-F'],
    files: ['leads-traffic-passport.spec', 'e2e.mjs'],
    types: ['db', 'e2e'],
    automated:
      'метка → внутренняя страница → форма → заявка; после обогащения — материал, размещение, `sessionRef`; дедупликация `eventId`; `consentState` записан; поля событий ≡ утверждённой `event_map`',
    manual: null,
  },
  {
    id: 'AT-F11-02',
    title:
      'Удалить UTM и запретить историю; неизвестный источник не восстанавливается догадкой, две модели не удваивают заявку',
    gates: ['D0', 'Z'],
    packages: ['P-D', 'P-F'],
    files: ['leads-attribution-unknown.spec', 'e2e.mjs'],
    types: ['db', 'e2e'],
    automated:
      'без UTM и хранения → `unknown`, первая/последняя модели не удваивают',
    manual: null,
  },
  {
    id: 'AT-F12-01',
    title:
      'Согласовать операцию, зарезервировать, оплатить и проверить; перенос из обязательства в факт не уменьшает остаток дважды. Проверить пример раздела 17 ТЗ: 10 000 − 2 000 paid − 1 000 обязательств − 2 000 защищённого резерва = 5 000; delivered_unpaid 400 внутри обязательств не вычитается повторно. Оплата 1 000 сохраняет остаток 5 000; перевод резерва требует решения и не увеличивает общий лимит',
    gates: ['Z'],
    packages: ['P-C'],
    files: ['budget-flow.spec'],
    types: ['db', 'unit'],
    automated:
      'вектор §17 (5 000 → 5 000 после оплаты), перевод резерва без роста лимита',
    manual: null,
  },
  {
    id: 'AT-F12-02',
    title:
      'Увеличить итоговую цену или повторить неизвестную операцию; требуется новое согласование либо сверка, второй расход не создаётся. Истёкшее согласование тоже не разрешает закупку даже при прежней цене',
    gates: ['Z'],
    packages: ['P-C'],
    files: ['budget-approval-stale.spec'],
    types: ['db'],
    automated:
      'рост цены → новое согласование; повтор неизвестной операции → сверка; истёкшее согласование не работает при прежней цене; положительная корректировка без согласования отвергнута',
    manual: null,
  },
  {
    id: 'AT-F17-01',
    title:
      'Зарегистрировать изменение до запуска, собрать доступные данные и записать решение с лимитом',
    gates: ['42'],
    packages: ['P-E'],
    files: ['reports-experiments.spec'],
    types: ['db'],
    automated: 'регистрация до применения, данные, решение с лимитом',
    manual: null,
  },
  {
    id: 'AT-F17-02',
    title:
      'Одна заявка либо незакрытое окно; система не объявляет статистически значимого победителя',
    gates: ['42'],
    packages: ['P-E'],
    files: ['reports-experiment-conclusion.spec'],
    types: ['db', 'unit'],
    automated:
      'одна заявка/открытое окно/выборка меньше порога → только «невизначено»',
    manual: null,
  },
];

/** Версия каталога для qa-catalog (`caseVersion`); растёт при правке сценариев. */
export const AT_CATALOG_VERSION = 1;

const AT_ID_RE = /^AT-(CORE|F\d{2})-\d{2}$/;

export function isAtId(v: string): boolean {
  return AT_ID_RE.test(v);
}

/** Карточка кейса в формате ввода qa-catalog (`parseCaseInput`). */
export function qaCaseInput(c: AtCase): {
  title: string;
  purpose: string;
  preconditions: string;
  steps: Array<{ action: string; expected: string }>;
  type: 'automated';
  priority: 'critical' | 'high';
  tags: string[];
  requirementIds: string[];
  archived: false;
} {
  return {
    title: `${c.id} ${c.title}`.slice(0, 200),
    purpose: c.manual
      ? `Автоматизовано: ${c.automated}. Ручний залишок (окремий протокол): ${c.manual}.`.slice(
          0,
          2000,
        )
      : `Автоматизовано: ${c.automated}.`.slice(0, 2000),
    preconditions:
      'Продукт kind=test на тестовому сайті кабінету; синтетичні контакти; без реальних оплат.',
    steps: [
      {
        action:
          `Запустити тести з міткою [${c.id}] (${c.files.join(', ')})`.slice(
            0,
            2000,
          ),
        expected: c.automated.slice(0, 2000),
      },
    ],
    type: 'automated',
    priority:
      c.gates.includes('D0') || c.gates.includes('Z') ? 'critical' : 'high',
    tags: [
      ...c.gates.map((g) => `gate-${g}`),
      ...c.packages.map((p) => p.toLowerCase()),
    ],
    requirementIds: [c.id],
    archived: false,
  };
}
