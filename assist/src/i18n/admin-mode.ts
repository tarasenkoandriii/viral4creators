/**
 * Тексты экранов «Админки» (Э7, ТЗ §3.8): режим, коннекторы, журнал,
 * «Обучение (сотрудники)», «Статистика (сотрудники)», чат сотрудника (7a).
 * Отдельный словарь (не в AppDictionary): экраны «Админки» — своя зона.
 */
import type { Locale } from '../kit';

export interface AdminModeTexts {
  title: string;
  open: string;
  openChat: string;
  tabs: Record<
    | 'settings'
    | 'connectors'
    | 'log'
    | 'memos'
    | 'learning'
    | 'stats'
    | 'voice',
    string
  >;
  noAccess: string;
  settings: {
    enabled: string;
    access: string;
    accessTma: string;
    accessScript: string;
    accessBoth: string;
    needVerified: string;
    planNeeded: string;
    adminHosts: string;
    adminHostsHint: string;
    instructions: string;
    roleMap: string;
    roleMapHint: string;
    tmaEmployeeRole: string;
    statsPerEmployee: string;
    statsPerEmployeeHint: string;
    /** Р-З9-17: тестовый ключ ходит в коннекторы. */
    testKeyConnectors: string;
    testKeyConnectorsHint: string;
    save: string;
    saved: string;
    secretTitle: string;
    secretSet: string;
    secretNotSet: string;
    secretIssue: string;
    secretReissueHint: string;
    /** Р-З9-18: секрет уже перевыпустили в другом окне. */
    secretChanged: string;
    /** Аудит Э7 (а), (в): рекомендации заказчику по JWT сотрудника. */
    jwtAdvice: string;
    secretOnce: string;
    snippet: string;
    snippetCsp: string;
    snippetNoKey: string;
    crawlTitle: string;
    crawlHint: string;
    crawlHost: string;
    crawlAccount: string;
    crawlNoAccounts: string;
    crawlEnable: string;
    crawlDisable: string;
    crawlRun: string;
    crawlWaiting: string;
    /** Э-С Ш3: статусы задания обхода и подсказка про продукт учётки. */
    crawlStatus: Record<string, string>;
    crawlNeedsProduct: string;
  };
  connectors: {
    add: string;
    name: string;
    specUrl: string;
    specFile: string;
    baseUrl: string;
    saas: string;
    import: string;
    empty: string;
    hostVerified: string;
    hostSaas: string;
    secret: string;
    secretSet: string;
    secretNone: string;
    authKind: string;
    headerName: string;
    secretValue: string;
    saveSecret: string;
    /** Р-З9-14: маскирование ПД в данных API до модели. */
    maskPd: string;
    maskPdHint: string;
    statusAuthFailed: string;
    statusPaused: string;
    enable: string;
    roles: string;
    rolesHint: string;
    dailyLimit: string;
    raise: string;
    kind: Record<'read' | 'write' | 'danger', string>;
    unsupported: string;
    remove: string;
  };
  log: { empty: string; columns: [string, string, string, string, string] };
  learning: {
    empty: string;
    kinds: Record<string, string>;
    proposed: string;
    answer: string;
    accept: string;
    reject: string;
    cluster: string;
    accepted: string;
  };
  stats: {
    days7: string;
    days30: string;
    conversations: string;
    questions: string;
    refused: string;
    thumbsDown: string;
    learningNew: string;
    topQuestions: string;
    tools: string;
    byRole: string;
    byEmployee: string;
    noRating: string;
    /** Э8-хвост (6): блок «Действия». */
    actions: {
      title: string;
      proposed: string;
      yesShare: string;
      done: string;
      failed: string;
      unknown: string;
      unrequested: string;
      traces: string;
      compensations: string;
      compSuccess: string;
      compAlert: string;
      none: string;
    };
  };
  chat: {
    title: string;
    placeholder: string;
    send: string;
    thinking: string;
    knowledgeOnly: string;
    fix: string;
    fixSend: string;
    thanks: string;
  };
}

const uk: AdminModeTexts = {
  title: '«Адмінка»: помічник співробітників',
  open: 'Помічник співробітників («Адмінка»)',
  openChat: 'Запитати помічника співробітників',
  tabs: {
    settings: 'Режим',
    connectors: 'API',
    log: 'Журнал',
    memos: 'Мемо АМ',
    learning: 'Навчання (співробітники)',
    stats: 'Статистика (співробітники)',
    voice: 'Голос',
  },
  noAccess: 'Розділ лише для власника «Адмінки».',
  settings: {
    enabled: 'Помічник співробітників увімкнений',
    access: 'Де працює',
    accessTma: 'Лише в TMA',
    accessScript: 'Скрипт в адмінці',
    accessBoth: 'Обидва',
    needVerified: 'Потрібен хоча б один підтверджений хост сайту.',
    planNeeded: '«Адмінка: читання» — у тарифах Business і Pro.',
    adminHosts: 'Хости самої адмінки (для скрипта)',
    adminHostsHint:
      'Лише підтверджені хости: з них можна вбудувати чат співробітника.',
    instructions: 'Вказівки для співробітників (тон, порядок роботи)',
    roleMap: 'Ролі з вашого JWT → ролі помічника',
    roleMapHint:
      'По рядку: «manager=orders». Невідома роль — лише знання, без API.',
    tmaEmployeeRole: 'Роль помічника для співробітників у TMA',
    statsPerEmployee: 'Статистика в розрізі співробітника',
    statsPerEmployeeHint:
      'Співробітник бачитиме плашку «власник бачить статистику ваших запитів».',
    testKeyConnectors: 'Тестовий ключ pk_test має доступ до API',
    testKeyConnectorsHint:
      'Типово ні: сесія з pk_test (зокрема на localhost) працює лише за знаннями. Вмикайте, лише якщо тестуєте з тестовим API або на тестових даних.',
    save: 'Зберегти',
    saved: 'Збережено',
    secretTitle: 'Секрет підпису співробітників (JWT HS256)',
    secretSet: 'Секрет випущено',
    secretNotSet: 'Секрет ще не випущено',
    secretIssue: 'Випустити секрет',
    secretReissueHint:
      'Старий секрет і всі сесії співробітників перестануть діяти.',
    secretChanged:
      'Секрет уже перевипустили в іншому вікні — екран оновлено. Діє останній показаний секрет.',
    jwtAdvice:
      'Безпека: JWT співробітника діє до кінця exp (до 15 хв) і може бути використаний повторно — краще data-identity-endpoint і exp 2–5 хв. У sub — непрозорий id співробітника, не e-mail: він іде в журнал «Адмінки» (рік) і в заголовку X-V4C-Actor — у ваш API.',
    secretOnce:
      'Скопіюйте зараз — більше його не буде видно. Передайте розробнику бекенду адмінки.',
    snippet: 'Код вставки в адмінку',
    snippetCsp: 'Фрагмент CSP адмінки',
    snippetNoKey:
      'Спершу випустіть публічний ключ сайту (Віджет → Встановлення).',
    crawlTitle: 'Обхід адмінки за логіном (тестовий акаунт)',
    crawlHint:
      'Лише знання про інтерфейс. Виконує ізольований браузерний воркер — до його запуску завдання чекають.',
    crawlHost: 'Хост адмінки',
    crawlAccount: 'Тестовий обліковий запис',
    crawlNoAccounts: 'Немає тестових облікових записів для цього хоста.',
    crawlEnable: 'Увімкнути обхід',
    crawlDisable: 'Вимкнути обхід',
    crawlRun: 'Поставити в чергу',
    crawlWaiting: 'Чекає браузерного воркера',
    crawlStatus: {
      queued: 'У черзі воркера',
      running: 'Обхід іде',
      done: 'Готово',
      failed: 'Не вдалося',
      cancelled: 'Скасовано',
    },
    crawlNeedsProduct:
      'Дозвольте обліковому запису продукт «Помічник: обхід Адмінки» у реєстрі тестових облікових записів.',
  },
  connectors: {
    add: 'Додати API (OpenAPI 3.x)',
    name: 'Назва',
    specUrl: 'URL опису OpenAPI (JSON)',
    specFile: 'або файл JSON',
    baseUrl: 'Базовий URL API (якщо немає в описі)',
    saas: 'Це наш акаунт у сервісі (хост не підтверджено як хост сайту)',
    import: 'Імпортувати',
    empty: 'API ще не підключено.',
    hostVerified: 'хост підтверджено',
    hostSaas: 'акаунт у сервісі',
    secret: 'Ключ API',
    secretSet: 'задано',
    secretNone: 'не задано',
    authKind: 'Спосіб',
    headerName: 'Ім’я заголовка',
    secretValue: 'Значення ключа',
    saveSecret: 'Зберегти ключ',
    maskPd: 'Приховувати персональні дані від моделі',
    maskPdHint:
      'E-mail, телефони та ключі у відповідях цього API замінюються до того, як їх побачить модель. Помічник тоді не зможе назвати телефон клієнта.',
    statusAuthFailed: 'Ключ відхилено API — операції на паузі',
    statusPaused: 'На паузі',
    enable: 'Увімкнено',
    roles: 'Ролі',
    rolesHint: 'через кому',
    dailyLimit: 'Ліміт/добу',
    raise: 'Підвищити клас',
    kind: { read: 'читання', write: 'зміна', danger: 'небезпечно' },
    unsupported: 'Обов’язковий заголовок — помічник не викличе',
    remove: 'Видалити API',
  },
  log: {
    empty: 'Викликів ще не було.',
    columns: ['Коли', 'Хто', 'Операція', 'Результат', 'Запит'],
  },
  learning: {
    empty: 'Черга порожня.',
    kinds: {
      thumbs_down: '👎 співробітника',
      employee_fix: 'Виправлення співробітника',
      refused: '«Не знаю»',
      tool_param_error: 'Помилка параметрів',
      tool_failure: 'Збій API',
    },
    proposed: 'Пропозиція співробітника',
    answer: 'Перевірена відповідь',
    accept: 'Опублікувати у знання співробітників',
    reject: 'Відхилити',
    cluster: 'подібних',
    accepted: 'Опубліковано',
  },
  stats: {
    days7: '7 днів',
    days30: '30 днів',
    conversations: 'Діалогів',
    questions: 'Питань',
    refused: 'Частка «не знаю»',
    thumbsDown: '👎',
    learningNew: 'Нових у черзі',
    topQuestions: 'Часті питання',
    tools: 'Виклики API',
    byRole: 'За ролями',
    byEmployee: 'За співробітниками',
    noRating: 'Рейтингу співробітників немає (§5-тер.13).',
    actions: {
      title: 'Дії (зміни через API)',
      proposed: 'Запропоновано',
      yesShare: 'Частка «Так»',
      done: 'Виконано',
      failed: 'Відхилено системою',
      unknown: 'Результат невідомий',
      unrequested: 'Без прохання співробітника',
      traces: 'Ланцюжки зі слідами після збою',
      compensations: 'Скасування (компенсації)',
      compSuccess: 'успішних',
      compAlert:
        'Скасування вдаються рідше ніж у 80% випадків за добу — перевірте x-assist-compensation у специфікації API.',
      none: 'Дій за період не було.',
    },
  },
  chat: {
    title: 'Помічник співробітників',
    placeholder: 'Питання про регламент або замовлення…',
    send: 'Надіслати',
    thinking: 'Шукаю відповідь…',
    knowledgeOnly: 'Без ролі для API — лише внутрішні знання.',
    fix: 'Як правильно?',
    fixSend: 'Надіслати виправлення',
    thanks: 'Дякуємо — власник перевірить.',
  },
};

const ru: AdminModeTexts = {
  ...uk,
  title: '«Админка»: помощник сотрудников',
  open: 'Помощник сотрудников («Админка»)',
  openChat: 'Спросить помощника сотрудников',
  tabs: {
    settings: 'Режим',
    connectors: 'API',
    log: 'Журнал',
    memos: 'Мемо АМ',
    learning: 'Обучение (сотрудники)',
    stats: 'Статистика (сотрудники)',
    voice: 'Голос',
  },
  noAccess: 'Раздел только для владельца «Админки».',
  settings: {
    ...uk.settings,
    enabled: 'Помощник сотрудников включён',
    access: 'Где работает',
    accessTma: 'Только в TMA',
    accessScript: 'Скрипт в админке',
    accessBoth: 'Оба',
    needVerified: 'Нужен хотя бы один подтверждённый хост сайта.',
    planNeeded: '«Админка: чтение» — в тарифах Business и Pro.',
    adminHosts: 'Хосты самой админки (для скрипта)',
    adminHostsHint:
      'Только подтверждённые хосты: с них можно встроить чат сотрудника.',
    instructions: 'Указания для сотрудников (тон, порядок работы)',
    roleMap: 'Роли из вашего JWT → роли помощника',
    roleMapHint:
      'По строке: «manager=orders». Неизвестная роль — только знания, без API.',
    tmaEmployeeRole: 'Роль помощника для сотрудников в TMA',
    statsPerEmployee: 'Статистика в разрезе сотрудника',
    statsPerEmployeeHint:
      'Сотрудник увидит плашку «владелец видит статистику ваших запросов».',
    testKeyConnectors: 'Тестовый ключ pk_test ходит в API',
    testKeyConnectorsHint:
      'По умолчанию нет: сессия по pk_test (в том числе на localhost) работает только по знаниям. Включайте, только если тестируете с тестовым API или на тестовых данных.',
    save: 'Сохранить',
    saved: 'Сохранено',
    secretTitle: 'Секрет подписи сотрудников (JWT HS256)',
    secretSet: 'Секрет выпущен',
    secretNotSet: 'Секрет ещё не выпущен',
    secretIssue: 'Выпустить секрет',
    secretReissueHint:
      'Старый секрет и все сессии сотрудников перестанут действовать.',
    secretChanged:
      'Секрет уже перевыпустили в другом окне — экран обновлён. Действует последний показанный секрет.',
    jwtAdvice:
      'Безопасность: JWT сотрудника действует до конца exp (до 15 мин) и может быть использован повторно — лучше data-identity-endpoint и exp 2–5 мин. В sub — непрозрачный id сотрудника, не e-mail: он попадает в журнал «Админки» (год) и в заголовке X-V4C-Actor — в ваш API.',
    secretOnce:
      'Скопируйте сейчас — больше он показан не будет. Передайте разработчику бэкенда админки.',
    snippet: 'Код вставки в админку',
    snippetCsp: 'Фрагмент CSP админки',
    snippetNoKey:
      'Сначала выпустите публичный ключ сайта (Виджет → Установка).',
    crawlTitle: 'Обход админки за логином (тестовый аккаунт)',
    crawlHint:
      'Только знания об интерфейсе. Выполняет изолированный браузерный воркер — до его запуска задания ждут.',
    crawlHost: 'Хост админки',
    crawlAccount: 'Тестовая учётная запись',
    crawlNoAccounts: 'Нет тестовых учётных записей для этого хоста.',
    crawlEnable: 'Включить обход',
    crawlDisable: 'Выключить обход',
    crawlRun: 'Поставить в очередь',
    crawlWaiting: 'Ждёт браузерного воркера',
    crawlStatus: {
      queued: 'В очереди воркера',
      running: 'Обход идёт',
      done: 'Готово',
      failed: 'Не удалось',
      cancelled: 'Отменено',
    },
    crawlNeedsProduct:
      'Разрешите учётной записи продукт «Помощник: обход Админки» в реестре тестовых учётных записей.',
  },
  connectors: {
    ...uk.connectors,
    add: 'Добавить API (OpenAPI 3.x)',
    name: 'Название',
    specUrl: 'URL описания OpenAPI (JSON)',
    specFile: 'или файл JSON',
    baseUrl: 'Базовый URL API (если нет в описании)',
    saas: 'Это наш аккаунт в сервисе (хост не подтверждён как хост сайта)',
    import: 'Импортировать',
    empty: 'API ещё не подключено.',
    hostVerified: 'хост подтверждён',
    hostSaas: 'аккаунт в сервисе',
    secret: 'Ключ API',
    secretSet: 'задан',
    secretNone: 'не задан',
    authKind: 'Способ',
    headerName: 'Имя заголовка',
    secretValue: 'Значение ключа',
    saveSecret: 'Сохранить ключ',
    maskPd: 'Скрывать персональные данные от модели',
    maskPdHint:
      'E-mail, телефоны и ключи в ответах этого API заменяются до того, как их увидит модель. Помощник тогда не сможет назвать телефон клиента.',
    statusAuthFailed: 'Ключ отклонён API — операции на паузе',
    statusPaused: 'На паузе',
    enable: 'Включено',
    roles: 'Роли',
    rolesHint: 'через запятую',
    dailyLimit: 'Лимит/сутки',
    raise: 'Поднять класс',
    kind: { read: 'чтение', write: 'изменение', danger: 'опасно' },
    unsupported: 'Обязательный заголовок — помощник не вызовет',
    remove: 'Удалить API',
  },
  log: {
    empty: 'Вызовов ещё не было.',
    columns: ['Когда', 'Кто', 'Операция', 'Итог', 'Запрос'],
  },
  learning: {
    ...uk.learning,
    empty: 'Очередь пуста.',
    kinds: {
      thumbs_down: '👎 сотрудника',
      employee_fix: 'Исправление сотрудника',
      refused: '«Не знаю»',
      tool_param_error: 'Ошибка параметров',
      tool_failure: 'Сбой API',
    },
    proposed: 'Предложение сотрудника',
    answer: 'Проверенный ответ',
    accept: 'Опубликовать в знания сотрудников',
    reject: 'Отклонить',
    cluster: 'похожих',
    accepted: 'Опубликовано',
  },
  stats: {
    ...uk.stats,
    days7: '7 дней',
    days30: '30 дней',
    conversations: 'Диалогов',
    questions: 'Вопросов',
    refused: 'Доля «не знаю»',
    learningNew: 'Новых в очереди',
    topQuestions: 'Частые вопросы',
    tools: 'Вызовы API',
    byRole: 'По ролям',
    byEmployee: 'По сотрудникам',
    noRating: 'Рейтинга сотрудников нет (§5-тер.13).',
    actions: {
      title: 'Действия (изменения через API)',
      proposed: 'Предложено',
      yesShare: 'Доля «Да»',
      done: 'Выполнено',
      failed: 'Отклонено системой',
      unknown: 'Исход неизвестен',
      unrequested: 'Без просьбы сотрудника',
      traces: 'Цепочки со следами после сбоя',
      compensations: 'Отмены (компенсации)',
      compSuccess: 'успешных',
      compAlert:
        'Отмены удаются реже чем в 80% случаев за сутки — проверьте x-assist-compensation в спецификации API.',
      none: 'Действий за период не было.',
    },
  },
  chat: {
    title: 'Помощник сотрудников',
    placeholder: 'Вопрос о регламенте или заказе…',
    send: 'Отправить',
    thinking: 'Ищу ответ…',
    knowledgeOnly: 'Без роли для API — только внутренние знания.',
    fix: 'Как правильно?',
    fixSend: 'Отправить исправление',
    thanks: 'Спасибо — владелец проверит.',
  },
};

const en: AdminModeTexts = {
  ...uk,
  title: 'Admin mode: staff assistant',
  open: 'Staff assistant (admin mode)',
  openChat: 'Ask the staff assistant',
  tabs: {
    settings: 'Mode',
    connectors: 'API',
    log: 'Log',
    memos: 'AM memos',
    learning: 'Training (staff)',
    stats: 'Statistics (staff)',
    voice: 'Voice',
  },
  noAccess: 'Only the admin-mode owner can open this section.',
  settings: {
    enabled: 'Staff assistant is on',
    access: 'Where it works',
    accessTma: 'Only in the mini app',
    accessScript: 'Script in the admin panel',
    accessBoth: 'Both',
    needVerified: 'At least one verified site host is required.',
    planNeeded: 'Admin read access is included in Business and Pro.',
    adminHosts: 'Admin panel hosts (for the script)',
    adminHostsHint:
      'Verified hosts only: the staff chat can be embedded there.',
    instructions: 'Instructions for staff (tone, workflow)',
    roleMap: 'Roles from your JWT → assistant roles',
    roleMapHint:
      'One per line: “manager=orders”. Unknown role — knowledge only, no API.',
    tmaEmployeeRole: 'Assistant role for staff in the mini app',
    statsPerEmployee: 'Per-employee statistics',
    statsPerEmployeeHint:
      'Staff will see “the owner can see statistics of your requests”.',
    testKeyConnectors: 'Test key pk_test can use the API',
    testKeyConnectorsHint:
      'Off by default: a pk_test session (including on localhost) uses knowledge only. Turn on only when testing against a test API or test data.',
    save: 'Save',
    saved: 'Saved',
    secretTitle: 'Staff signing secret (JWT HS256)',
    secretSet: 'Secret issued',
    secretNotSet: 'No secret yet',
    secretIssue: 'Issue secret',
    secretReissueHint: 'The old secret and all staff sessions stop working.',
    secretChanged:
      'The secret was already reissued in another window — the screen is refreshed. The last shown secret is the valid one.',
    jwtAdvice:
      'Security: an employee JWT is valid until exp (up to 15 min) and can be replayed — prefer data-identity-endpoint and exp of 2–5 min. Put an opaque employee id in sub, not an e-mail: it goes to the admin log (kept a year) and, in the X-V4C-Actor header, to your API.',
    secretOnce:
      "Copy it now — it won't be shown again. Give it to your admin backend developer.",
    snippet: 'Admin panel embed code',
    snippetCsp: 'Admin panel CSP fragment',
    snippetNoKey: 'Issue the site public key first (Widget → Install).',
    crawlTitle: 'Logged-in admin crawl (test account)',
    crawlHint:
      'Interface knowledge only. Runs in an isolated browser worker — jobs wait until it is connected.',
    crawlHost: 'Admin host',
    crawlAccount: 'Test account',
    crawlNoAccounts: 'No test accounts for this host.',
    crawlEnable: 'Enable crawl',
    crawlDisable: 'Disable crawl',
    crawlRun: 'Queue a crawl',
    crawlWaiting: 'Waiting for the browser worker',
    crawlStatus: {
      queued: 'Queued for the worker',
      running: 'Crawling',
      done: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    crawlNeedsProduct:
      'Allow the "Assistant: admin panel crawl" product for this account in the test accounts registry.',
  },
  connectors: {
    add: 'Add an API (OpenAPI 3.x)',
    name: 'Name',
    specUrl: 'OpenAPI description URL (JSON)',
    specFile: 'or a JSON file',
    baseUrl: 'API base URL (if not in the description)',
    saas: 'This is our account in a SaaS (host not verified as a site host)',
    import: 'Import',
    empty: 'No API connected yet.',
    hostVerified: 'host verified',
    hostSaas: 'SaaS account',
    secret: 'API key',
    secretSet: 'set',
    secretNone: 'not set',
    authKind: 'Method',
    headerName: 'Header name',
    secretValue: 'Key value',
    saveSecret: 'Save key',
    maskPd: 'Hide personal data from the model',
    maskPdHint:
      'E-mails, phone numbers and keys in this API’s responses are replaced before the model sees them. The assistant then can’t tell a customer’s phone number.',
    statusAuthFailed: 'Key rejected by the API — operations paused',
    statusPaused: 'Paused',
    enable: 'Enabled',
    roles: 'Roles',
    rolesHint: 'comma-separated',
    dailyLimit: 'Limit/day',
    raise: 'Raise class',
    kind: { read: 'read', write: 'write', danger: 'danger' },
    unsupported: 'Required header — the assistant cannot call it',
    remove: 'Remove API',
  },
  log: {
    empty: 'No calls yet.',
    columns: ['When', 'Who', 'Operation', 'Result', 'Request'],
  },
  learning: {
    empty: 'The queue is empty.',
    kinds: {
      thumbs_down: 'Staff 👎',
      employee_fix: 'Staff correction',
      refused: '“Don’t know”',
      tool_param_error: 'Parameter error',
      tool_failure: 'API failure',
    },
    proposed: 'Staff suggestion',
    answer: 'Verified answer',
    accept: 'Publish to staff knowledge',
    reject: 'Reject',
    cluster: 'similar',
    accepted: 'Published',
  },
  stats: {
    days7: '7 days',
    days30: '30 days',
    conversations: 'Conversations',
    questions: 'Questions',
    refused: '“Don’t know” share',
    thumbsDown: '👎',
    learningNew: 'New in queue',
    topQuestions: 'Top questions',
    tools: 'API calls',
    byRole: 'By role',
    byEmployee: 'By employee',
    noRating: 'There is no employee rating (§5-ter.13).',
    actions: {
      title: 'Actions (changes via API)',
      proposed: 'Proposed',
      yesShare: '"Yes" share',
      done: 'Done',
      failed: 'Rejected by the system',
      unknown: 'Outcome unknown',
      unrequested: 'Not requested by the employee',
      traces: 'Chains with traces after a failure',
      compensations: 'Undo (compensations)',
      compSuccess: 'successful',
      compAlert:
        'Undo succeeds in less than 80% of cases over the last day — check x-assist-compensation in the API spec.',
      none: 'No actions in this period.',
    },
  },
  chat: {
    title: 'Staff assistant',
    placeholder: 'Ask about a policy or an order…',
    send: 'Send',
    thinking: 'Looking for an answer…',
    knowledgeOnly: 'No API role — internal knowledge only.',
    fix: "What's correct?",
    fixSend: 'Send correction',
    thanks: 'Thanks — the owner will review it.',
  },
};

export const ADMIN_MODE_TEXTS: Record<Locale, AdminModeTexts> = { uk, ru, en };
