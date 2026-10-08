/**
 * Тексты вкладки «Голос» «Админки» (Э6-бис (б), ТЗ §5-бис.2, §5-бис.13;
 * Р-Э6б-1…12) — uk/ru/en. Сверка ключей трёх языков — scripts/i18n.test.ts
 * (через admin-voice-api.test.ts).
 */
import type { Locale } from '../kit/i18n';
import type {
  AdminVcItemCode,
  AdminVcMicStatus,
  AdminVcProbeKind,
} from '../lib/admin-voice-api';

export interface AdminVoiceTexts {
  title: string;
  intro: string;
  states: Record<'off' | 'test' | 'on' | 'degraded', string>;
  stateHelp: Record<'off' | 'test' | 'on' | 'degraded', string>;
  needPlan: string;
  needAdminMode: string;
  needVoice: string;
  platformOff: string;
  changed: string;
  risks: {
    title: string;
    items: string[];
    siteName: string;
    accept: string;
  };
  hostsTitle: string;
  hostsHelp: string;
  hostTest: string;
  noHosts: string;
  wizard: {
    title: string;
    intro: string;
    path: string;
    link: string;
    linkReady: string;
    workHost: string;
    testHost: string;
    last: string;
    none: string;
    report: string;
    results: Record<'pass' | 'partial' | 'fail', string>;
    attempts: string;
    submits: string;
    forbiddenLeak: string;
    partialAck: string;
    /**
     * Пункты отчёта (аудит Э6-бис (б) (1)): текст на каждый код сервера;
     * `{n}`, `{ok}`, `{need}`, `{done}`, `{of}`, `{status}` — числа пункта.
     */
    items: Record<AdminVcItemCode, string> & {
      /** `forbidden_leak` «Админки» по регистратору страницы. */
      attemptsLeak: string;
      /** Код, которого нет в словаре (новый сервер, старый TMA). */
      unknown: string;
    };
    probes: Record<AdminVcProbeKind, string>;
    /** Состояние микрофона в пункте `mic_owner_problem` ({status}). */
    mic: Record<AdminVcMicStatus, string>;
    forbidden: string;
    blocked: string;
    leaked: string;
    viaApi: string;
    dangerButtons: string;
    dry: string;
    dryLine: string;
    save: string;
    saveDone: string;
    saveFailed: string;
    fragment: string;
    problems: Record<
      | 'none'
      | 'failed'
      | 'partial_ack'
      | 'expired'
      | 'loader_changed'
      | 'markup_changed'
      | 'older_than_state',
      string
    >;
  };
  metrics: string;
  save: string;
  saved: string;
  errors: Record<string, string>;
}

const uk: AdminVoiceTexts = {
  title: 'Голосове керування «Адмінкою»',
  intro:
    'Співробітник каже або набирає команду у вікні помічника — помічник натискає в адмінці сам, у нього на очах. Видалення, скасування й повернення — ніколи кліками (лише через API з «Так» або руками). Збереження — лише після «Так» з переліком полів.',
  states: {
    off: 'Вимкнено',
    test: 'Перевірка',
    on: 'Увімкнено',
    degraded: 'Лише підказки',
  },
  stateHelp: {
    off: 'Помічник не натискає нічого.',
    test: 'Лише за посиланням майстра — для вас.',
    on: 'Для всіх співробітників (після звіту майстра).',
    degraded: 'Помічник лише підсвічує, натискають самі.',
  },
  needPlan: 'Потрібен тариф Pro («Адмінка: дії»).',
  needAdminMode: 'Спершу увімкніть «Адмінку» і підтвердіть адресу адмінки.',
  needVoice: 'Розпізнавання голосу зараз недоступне — команди лише набором.',
  platformOff: 'Голосове керування тимчасово вимкнене платформою.',
  changed: 'Змінено {date}: {who}{why}',
  risks: {
    title: 'Ризики — прочитайте перед увімкненням',
    items: [
      'Помічник натискає кнопки адмінки від імені співробітника, з його правами в адмінці.',
      'Модель може помилитися з ціллю: кожен крок видно, «Стоп» і Esc — завжди; збереження — лише після «Так» з переліком полів.',
      'Видалення, скасування, повернення коштів, оплата — кліками ніколи; зміни з операцією API — через картку «Так» у чаті.',
      'Рядки таблиць з даними клієнтів у знімок сторінки не потрапляють (крім номера, який назвав співробітник).',
      'Майстер перевірки на робочому хості нічого не зберігає; збереження перевіряйте на тестовому хості.',
      'Порушення заборони вимикає режим автоматично; ви отримаєте сповіщення.',
    ],
    siteName: 'Введіть назву сайту «{name}», щоб підтвердити',
    accept: 'Прочитав(ла) і приймаю',
  },
  hostsTitle: 'Адреси адмінки',
  hostsHelp:
    'Позначте тестову адресу (staging): лише на ній майстер перевіряє «Зберегти».',
  hostTest: 'тестовий',
  noHosts: 'Немає підтвердженої адреси адмінки — додайте її в «Режим».',
  wizard: {
    title: 'Майстер перевірки',
    intro:
      'Одноразове посилання відкриває адмінку з помічником у режимі перевірки: оточення, розмітка, заборони, сухий прогін, прогін з натисканням. «Увімкнено» — лише з годним звітом.',
    path: 'Сторінка адмінки (шлях)',
    link: 'Отримати посилання',
    linkReady: 'Відкрийте посилання в браузері, де ви увійшли в адмінку:',
    workHost: 'Робочий хост: збереження лише підсвічується.',
    testHost: 'Тестовий хост: збереження перевіряється.',
    last: 'Останній звіт: {result}, {date}',
    none: 'Звітів ще немає.',
    report: 'Звіт',
    results: {
      pass: 'пройдено',
      partial: 'частково',
      fail: 'не пройдено',
    },
    attempts: 'Спроб по заборонених цілях: {n}',
    submits: 'Заглушено відправок на робочому хості: {n}',
    forbiddenLeak: 'Пропущено заборонених команд: {n}',
    partialAck: 'Звіт «частково» — вмикаю, розуміючи зауваження',
    items: {
      ok: 'Готово',
      widget_missing: 'Крок {step}: помічник не відповів на сторінці адмінки',
      chunks_blocked: 'Крок {step}: CSP адмінки блокує скрипти помічника',
      csp_violations: 'Крок {step}: порушень CSP через помічника — {n}',
      tt_violations: 'Крок {step}: порушень Trusted Types — {n}',
      mic_policy_denied:
        'Крок {step}: політика адмінки (Permissions-Policy) забороняє мікрофон',
      mic_owner_problem:
        'Крок {step}: мікрофон вашого пристрою ({status}) — команди набором працюють',
      dry_low:
        'Крок {step}: сухий прогін — вірних кроків {ok}, потрібно {need}',
      safe_low:
        'Крок {step}: з натисканням виконано {done} з {of} команд (потрібно 2)',
      safe_none: 'Крок {step}: жодної команди з натисканням не виконано',
      forbidden_leak: 'Крок {step}: заборонених команд не заблоковано — {n}',
      suspicious_unreviewed:
        'Крок {step}: не переглянуто «схожих на небезпечні» кнопок — {n}',
      unnamed_elements: 'Крок {step}: кнопок без імені — {n}',
      closed_shadow: 'Крок {step}: кнопок у закритих shadow-коренях — {n}',
      ext_iframes:
        'Крок {step}: зовнішніх iframe — {n} (помічник у них не заходить)',
      duplicates: 'Крок {step}: однакових назв кнопок — {n}',
      undo_unresolved: 'Крок {step}: не знайдено, як скасувати {n} з {of} дій',
      attemptsLeak:
        'Крок {step}: спроб натиснути заборонену ціль — {attempts}, збережень на робочому хості — {submitOnWork}',
      unknown: 'Крок {step}: зауваження (оновіть застосунок)',
    },
    probes: {
      delete: 'видалення',
      cancel: 'скасування',
      refund: 'повернення коштів',
      charge: 'списання',
      mass: 'масова дія',
      pay: 'оплата',
      password: 'поле пароля',
      external: 'чуже посилання',
    },
    mic: {
      ok: 'працює',
      denied_policy: 'заборонено політикою адмінки',
      denied_user: 'доступ не дано в браузері',
      no_device: 'мікрофон не знайдено',
      ios_gesture: 'iOS: потрібне натискання',
      skipped: 'не перевірявся',
    },
    forbidden: 'Заборони без звуку',
    blocked: 'заблоковано',
    leaked: 'НЕ заблоковано',
    viaApi: 'через API: {key}',
    dangerButtons: 'Кнопки, які помічник не натисне ніколи',
    dry: 'Сухий прогін',
    dryLine: '«{command}» — вірно {ok} з {steps}',
    save: '«Зберегти» на тестовому хості',
    saveDone: 'виконано, полів {n}',
    saveFailed: 'не виконано',
    fragment: 'Фрагмент розмітки для розробника адмінки',
    problems: {
      none: 'Спершу пройдіть майстер перевірки.',
      failed: 'Останній звіт — «не пройдено».',
      partial_ack: 'Звіт «частково» — підтвердьте зауваження.',
      expired: 'Звіт застарів — пройдіть майстер ще раз.',
      loader_changed: 'Виконавець оновився — пройдіть майстер ще раз.',
      markup_changed: 'Розмітка змінилася — пройдіть майстер ще раз.',
      older_than_state:
        'Режим вимикався після звіту — пройдіть майстер ще раз.',
    },
  },
  metrics:
    'За 24 год: команд {plans}, виконано {done}, «натисніть самі» {manual}, збоїв {failed}, зупинок {stopped}, порушень {violations}',
  save: 'Зберегти',
  saved: 'Збережено.',
  errors: {
    ADMIN_VC_PLAN_REQUIRED: 'Потрібен тариф Pro.',
    ADMIN_VC_MODE_REQUIRED: 'Спершу увімкніть «Адмінку».',
    ADMIN_VC_VOICE_REQUIRED: 'Голос недоступний на платформі.',
    ADMIN_VC_RISKS_REQUIRED: 'Прочитайте ризики й введіть назву сайту.',
    ADMIN_VC_SITE_NAME: 'Назва сайту не збігається.',
    ADMIN_VC_TEST_REQUIRED: 'Потрібен годний звіт майстра перевірки.',
    ADMIN_VC_HOST_REQUIRED: 'Потрібна підтверджена https-адреса адмінки.',
    ADMIN_VC_INVALID: 'Перевірте поля.',
  },
};

const ru: AdminVoiceTexts = {
  title: 'Голосовое управление «Админкой»',
  intro:
    'Сотрудник говорит или набирает команду в окне помощника — помощник нажимает в админке сам, у него на глазах. Удаление, отмена и возврат — никогда кликами (только через API с «Да» или руками). Сохранение — только после «Да» с перечнем полей.',
  states: {
    off: 'Выключено',
    test: 'Проверка',
    on: 'Включено',
    degraded: 'Только подсказки',
  },
  stateHelp: {
    off: 'Помощник ничего не нажимает.',
    test: 'Только по ссылке мастера — для вас.',
    on: 'Для всех сотрудников (после отчёта мастера).',
    degraded: 'Помощник только подсвечивает, нажимают сами.',
  },
  needPlan: 'Нужен тариф Pro («Админка: действия»).',
  needAdminMode: 'Сначала включите «Админку» и подтвердите адрес админки.',
  needVoice: 'Распознавание голоса сейчас недоступно — команды только набором.',
  platformOff: 'Голосовое управление временно выключено платформой.',
  changed: 'Изменено {date}: {who}{why}',
  risks: {
    title: 'Риски — прочитайте перед включением',
    items: [
      'Помощник нажимает кнопки админки от имени сотрудника, с его правами в админке.',
      'Модель может ошибиться с целью: каждый шаг виден, «Стоп» и Esc — всегда; сохранение — только после «Да» с перечнем полей.',
      'Удаление, отмена, возврат денег, оплата — кликами никогда; изменения с операцией API — через карточку «Да» в чате.',
      'Строки таблиц с данными клиентов в снимок страницы не попадают (кроме номера, который назвал сотрудник).',
      'Мастер проверки на рабочем хосте ничего не сохраняет; сохранение проверяйте на тестовом хосте.',
      'Нарушение запрета выключает режим автоматически; вы получите уведомление.',
    ],
    siteName: 'Введите название сайта «{name}», чтобы подтвердить',
    accept: 'Прочитал(а) и принимаю',
  },
  hostsTitle: 'Адреса админки',
  hostsHelp:
    'Отметьте тестовый адрес (staging): только на нём мастер проверяет «Сохранить».',
  hostTest: 'тестовый',
  noHosts: 'Нет подтверждённого адреса админки — добавьте его в «Режим».',
  wizard: {
    title: 'Мастер проверки',
    intro:
      'Одноразовая ссылка открывает админку с помощником в режиме проверки: окружение, разметка, запреты, сухой прогон, прогон с нажатием. «Включено» — только с годным отчётом.',
    path: 'Страница админки (путь)',
    link: 'Получить ссылку',
    linkReady: 'Откройте ссылку в браузере, где вы вошли в админку:',
    workHost: 'Рабочий хост: сохранение только подсвечивается.',
    testHost: 'Тестовый хост: сохранение проверяется.',
    last: 'Последний отчёт: {result}, {date}',
    none: 'Отчётов ещё нет.',
    report: 'Отчёт',
    results: {
      pass: 'пройдено',
      partial: 'частично',
      fail: 'не пройдено',
    },
    attempts: 'Попыток по запрещённым целям: {n}',
    submits: 'Заглушено отправок на рабочем хосте: {n}',
    forbiddenLeak: 'Пропущено запрещённых команд: {n}',
    partialAck: 'Отчёт «частично» — включаю, понимая замечания',
    items: {
      ok: 'Готово',
      widget_missing: 'Шаг {step}: помощник не ответил на странице админки',
      chunks_blocked: 'Шаг {step}: CSP админки блокирует скрипты помощника',
      csp_violations: 'Шаг {step}: нарушений CSP из-за помощника — {n}',
      tt_violations: 'Шаг {step}: нарушений Trusted Types — {n}',
      mic_policy_denied:
        'Шаг {step}: политика админки (Permissions-Policy) запрещает микрофон',
      mic_owner_problem:
        'Шаг {step}: микрофон вашего устройства ({status}) — команды набором работают',
      dry_low: 'Шаг {step}: сухой прогон — верных шагов {ok}, нужно {need}',
      safe_low:
        'Шаг {step}: с нажатием выполнено {done} из {of} команд (нужно 2)',
      safe_none: 'Шаг {step}: ни одной команды с нажатием не выполнено',
      forbidden_leak: 'Шаг {step}: запрещённых команд не заблокировано — {n}',
      suspicious_unreviewed:
        'Шаг {step}: не просмотрено «похожих на опасные» кнопок — {n}',
      unnamed_elements: 'Шаг {step}: кнопок без имени — {n}',
      closed_shadow: 'Шаг {step}: кнопок в закрытых shadow-корнях — {n}',
      ext_iframes:
        'Шаг {step}: внешних iframe — {n} (помощник в них не заходит)',
      duplicates: 'Шаг {step}: одинаковых названий кнопок — {n}',
      undo_unresolved:
        'Шаг {step}: не найдено, как отменить {n} из {of} действий',
      attemptsLeak:
        'Шаг {step}: попыток нажать запрещённую цель — {attempts}, сохранений на рабочем хосте — {submitOnWork}',
      unknown: 'Шаг {step}: замечание (обновите приложение)',
    },
    probes: {
      delete: 'удаление',
      cancel: 'отмена',
      refund: 'возврат денег',
      charge: 'списание',
      mass: 'массовое действие',
      pay: 'оплата',
      password: 'поле пароля',
      external: 'чужая ссылка',
    },
    mic: {
      ok: 'работает',
      denied_policy: 'запрещён политикой админки',
      denied_user: 'доступ не дан в браузере',
      no_device: 'микрофон не найден',
      ios_gesture: 'iOS: нужно нажатие',
      skipped: 'не проверялся',
    },
    forbidden: 'Запреты без звука',
    blocked: 'заблокировано',
    leaked: 'НЕ заблокировано',
    viaApi: 'через API: {key}',
    dangerButtons: 'Кнопки, которые помощник не нажмёт никогда',
    dry: 'Сухой прогон',
    dryLine: '«{command}» — верно {ok} из {steps}',
    save: '«Сохранить» на тестовом хосте',
    saveDone: 'выполнено, полей {n}',
    saveFailed: 'не выполнено',
    fragment: 'Фрагмент разметки для разработчика админки',
    problems: {
      none: 'Сначала пройдите мастер проверки.',
      failed: 'Последний отчёт — «не пройдено».',
      partial_ack: 'Отчёт «частично» — подтвердите замечания.',
      expired: 'Отчёт устарел — пройдите мастер ещё раз.',
      loader_changed: 'Исполнитель обновился — пройдите мастер ещё раз.',
      markup_changed: 'Разметка изменилась — пройдите мастер ещё раз.',
      older_than_state:
        'Режим выключался после отчёта — пройдите мастер ещё раз.',
    },
  },
  metrics:
    'За 24 ч: команд {plans}, выполнено {done}, «нажмите сами» {manual}, сбоев {failed}, остановок {stopped}, нарушений {violations}',
  save: 'Сохранить',
  saved: 'Сохранено.',
  errors: {
    ADMIN_VC_PLAN_REQUIRED: 'Нужен тариф Pro.',
    ADMIN_VC_MODE_REQUIRED: 'Сначала включите «Админку».',
    ADMIN_VC_VOICE_REQUIRED: 'Голос недоступен на платформе.',
    ADMIN_VC_RISKS_REQUIRED: 'Прочитайте риски и введите название сайта.',
    ADMIN_VC_SITE_NAME: 'Название сайта не совпадает.',
    ADMIN_VC_TEST_REQUIRED: 'Нужен годный отчёт мастера проверки.',
    ADMIN_VC_HOST_REQUIRED: 'Нужен подтверждённый https-адрес админки.',
    ADMIN_VC_INVALID: 'Проверьте поля.',
  },
};

const en: AdminVoiceTexts = {
  title: 'Voice control of the admin panel',
  intro:
    'A staff member says or types a command in the assistant window — the assistant clicks in the admin panel itself, in front of them. Deleting, cancelling and refunds — never by clicks (only via API with “Yes” or by hand). Saving — only after “Yes” with the list of fields.',
  states: {
    off: 'Off',
    test: 'Check',
    on: 'On',
    degraded: 'Hints only',
  },
  stateHelp: {
    off: 'The assistant clicks nothing.',
    test: 'Only via the check link — for you.',
    on: 'For all staff (after the check report).',
    degraded: 'The assistant only highlights; people click themselves.',
  },
  needPlan: 'The Pro plan is required (“Admin: actions”).',
  needAdminMode: 'First enable “Admin” and verify the admin panel address.',
  needVoice: 'Speech recognition is unavailable now — typed commands only.',
  platformOff: 'Voice control is temporarily disabled by the platform.',
  changed: 'Changed {date}: {who}{why}',
  risks: {
    title: 'Risks — read before enabling',
    items: [
      'The assistant clicks admin buttons on behalf of the staff member, with their admin rights.',
      'The model may pick a wrong target: every step is visible, “Stop” and Esc always work; saving — only after “Yes” with the list of fields.',
      'Deleting, cancelling, refunds, payments — never by clicks; changes with an API operation go through the “Yes” card in chat.',
      'Table rows with customer data are not sent in the page snapshot (except the number the staff member said).',
      'The check on the production host saves nothing; check saving on the test host.',
      'A restriction violation turns the mode off automatically; you will be notified.',
    ],
    siteName: 'Type the site name “{name}” to confirm',
    accept: 'I have read and accept',
  },
  hostsTitle: 'Admin panel addresses',
  hostsHelp:
    'Mark the test address (staging): only there the check verifies “Save”.',
  hostTest: 'test',
  noHosts: 'No verified admin panel address — add it in “Mode”.',
  wizard: {
    title: 'Check wizard',
    intro:
      'A one-time link opens the admin panel with the assistant in check mode: environment, markup, restrictions, dry run, run with clicks. “On” — only with a good report.',
    path: 'Admin page (path)',
    link: 'Get the link',
    linkReady: 'Open the link in the browser where you are logged in:',
    workHost: 'Production host: saving is only highlighted.',
    testHost: 'Test host: saving is checked.',
    last: 'Last report: {result}, {date}',
    none: 'No reports yet.',
    report: 'Report',
    results: {
      pass: 'passed',
      partial: 'partial',
      fail: 'failed',
    },
    attempts: 'Attempts on forbidden targets: {n}',
    submits: 'Submissions blocked on the production host: {n}',
    forbiddenLeak: 'Forbidden commands leaked: {n}',
    partialAck: 'Report “partial” — I enable it understanding the notes',
    items: {
      ok: 'Done',
      widget_missing:
        'Step {step}: the assistant did not respond on the admin page',
      chunks_blocked: 'Step {step}: the admin CSP blocks the assistant scripts',
      csp_violations:
        'Step {step}: CSP violations caused by the assistant — {n}',
      tt_violations: 'Step {step}: Trusted Types violations — {n}',
      mic_policy_denied:
        'Step {step}: the admin policy (Permissions-Policy) forbids the microphone',
      mic_owner_problem:
        'Step {step}: your device microphone ({status}) — typed commands work',
      dry_low: 'Step {step}: dry run — {ok} correct steps, {need} needed',
      safe_low:
        'Step {step}: with clicks, {done} of {of} commands done (2 needed)',
      safe_none: 'Step {step}: no command with clicks was done',
      forbidden_leak: 'Step {step}: forbidden commands not blocked — {n}',
      suspicious_unreviewed:
        'Step {step}: “looks dangerous” buttons not reviewed — {n}',
      unnamed_elements: 'Step {step}: buttons without a name — {n}',
      closed_shadow: 'Step {step}: buttons in closed shadow roots — {n}',
      ext_iframes:
        'Step {step}: external iframes — {n} (the assistant does not enter them)',
      duplicates: 'Step {step}: duplicate button names — {n}',
      undo_unresolved:
        'Step {step}: no way to undo found for {n} of {of} actions',
      attemptsLeak:
        'Step {step}: attempts to press a forbidden target — {attempts}, saves on the production host — {submitOnWork}',
      unknown: 'Step {step}: a note (update the app)',
    },
    probes: {
      delete: 'deletion',
      cancel: 'cancellation',
      refund: 'refund',
      charge: 'charge',
      mass: 'bulk action',
      pay: 'payment',
      password: 'password field',
      external: 'external link',
    },
    mic: {
      ok: 'working',
      denied_policy: 'blocked by the admin policy',
      denied_user: 'access not granted in the browser',
      no_device: 'no microphone found',
      ios_gesture: 'iOS: a tap is needed',
      skipped: 'not checked',
    },
    forbidden: 'Silent restriction checks',
    blocked: 'blocked',
    leaked: 'NOT blocked',
    viaApi: 'via API: {key}',
    dangerButtons: 'Buttons the assistant will never press',
    dry: 'Dry run',
    dryLine: '“{command}” — {ok} of {steps} correct',
    save: '“Save” on the test host',
    saveDone: 'done, fields {n}',
    saveFailed: 'not done',
    fragment: 'Markup fragment for the admin developer',
    problems: {
      none: 'Pass the check wizard first.',
      failed: 'The last report failed.',
      partial_ack: 'Report “partial” — confirm the notes.',
      expired: 'The report has expired — run the wizard again.',
      loader_changed: 'The executor was updated — run the wizard again.',
      markup_changed: 'The markup changed — run the wizard again.',
      older_than_state:
        'The mode was turned off after the report — run the wizard again.',
    },
  },
  metrics:
    'Last 24 h: commands {plans}, done {done}, “press yourself” {manual}, failures {failed}, stops {stopped}, violations {violations}',
  save: 'Save',
  saved: 'Saved.',
  errors: {
    ADMIN_VC_PLAN_REQUIRED: 'The Pro plan is required.',
    ADMIN_VC_MODE_REQUIRED: 'Enable “Admin” first.',
    ADMIN_VC_VOICE_REQUIRED: 'Voice is unavailable on the platform.',
    ADMIN_VC_RISKS_REQUIRED: 'Read the risks and type the site name.',
    ADMIN_VC_SITE_NAME: 'The site name does not match.',
    ADMIN_VC_TEST_REQUIRED: 'A good check report is required.',
    ADMIN_VC_HOST_REQUIRED: 'A verified https admin address is required.',
    ADMIN_VC_INVALID: 'Check the fields.',
  },
};

export const ADMIN_VOICE_TEXTS: Record<Locale, AdminVoiceTexts> = {
  uk,
  ru,
  en,
};
