/**
 * Тексты вкладки «Голос» «Админки» (Э6-бис (б), ТЗ §5-бис.2, §5-бис.13;
 * Р-Э6б-1…12) — uk/ru/en. Сверка ключей трёх языков — scripts/i18n.test.ts
 * (через admin-voice-api.test.ts).
 */
import type { Locale } from '../kit/i18n';

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
