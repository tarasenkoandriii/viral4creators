/**
 * Тексты экранов «Админки» (Э7, ТЗ §3.8): режим, коннекторы, журнал,
 * «Обучение (сотрудники)», «Статистика (сотрудники)», чат сотрудника (7a).
 * Заход 10 (№63): словарь — часть AppDictionary (`appDict.adminMode`), ключи
 * прежние; паритет uk/ru/en и плейсхолдеры сторожит scripts/i18n.test.ts.
 */

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
    /** Р-З10-16 (Ш6 (7)): «админка — Telegram Mini App». */
    tmaFrame: string;
    tmaFrameHint: string;
    /** Р-З10-15 (Ш6 (4)): подпись кнопки помощника в админке. */
    widgetLabel: string;
    widgetLabelHint: string;
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
  /** Заход 10, №57: аналитика «Админки» (ТЗ §5-тер.13). */
  analytics: {
    title: string;
    labeling: string;
    labelingOff: string;
    noModel: string;
    conversations: string;
    labeled: string;
    found: string;
    partial: string;
    notFound: string;
    toolErrors: string;
    saved: string;
    minutesTitle: string;
    minutesHint: string;
    weeklyReport: string;
    save: string;
    saved2: string;
    taskTypes: Record<
      | 'lookup'
      | 'order_status'
      | 'how_to'
      | 'data_change'
      | 'report'
      | 'policy'
      | 'troubleshooting'
      | 'other',
      string
    >;
    insightsTitle: string;
    insightsNone: string;
    week: string;
    done: string;
    dismiss: string;
    reopen: string;
    findings: Record<
      | 'refusals'
      | 'not_found'
      | 'tool_errors'
      | 'actions_failed'
      | 'learning_queue',
      string
    >;
    exportTitle: string;
    exportHint: string;
    exportKinds: Record<'daily' | 'labels' | 'actions', string>;
    exportFrom: string;
    exportTo: string;
    exportRequest: string;
    exportStatus: Record<
      'queued' | 'running' | 'done' | 'failed' | 'expired',
      string
    >;
    exportDownload: string;
    exportTooMany: string;
  };
  /** Заход 10 (аудит P3 (6)): коды отказов «Админки» захода 10. */
  errors: Record<
    | 'ADMIN_LABEL_INVALID'
    | 'ADMIN_TASK_MINUTES_INVALID'
    | 'ADMIN_EXPORT_INVALID'
    | 'ADMIN_EXPORT_NOT_FOUND'
    | 'ADMIN_EXPORT_BUSY'
    | 'ADMIN_INSIGHT_NOT_FOUND',
    string
  >;
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

export const adminModeUk: AdminModeTexts = {
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
    tmaFrame: '«Адмінка» — Telegram Mini App (працює й у Telegram Web)',
    tmaFrameHint:
      'Дозволяє вікну помічника відкриватися всередині Telegram Web — лише разом із підтвердженими хостами самої адмінки.',
    widgetLabel: 'Підпис кнопки помічника в адмінці',
    widgetLabelHint:
      'До 40 символів, без HTML. Порожньо — «Помічник співробітника». Підставляється в код вставки (data-label).',
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
  analytics: {
    title: 'Розмітка діалогів (ШІ)',
    labeling: 'Розмічати діалоги співробітників за допомогою ШІ',
    labelingOff: 'Розмітку вимкнено — нижче лише вже розмічені діалоги.',
    noModel:
      'Модель розмітки ще не налаштована на платформі — числа з’являться, щойно її ввімкнуть.',
    conversations: 'Діалогів',
    labeled: 'Розмічено',
    found: 'Відповідь знайдено',
    partial: 'Частково',
    notFound: 'Не знайдено',
    toolErrors: 'З помилками інструментів',
    saved: '≈ {hours} год заощаджено',
    minutesTitle: 'Хвилин на тип задачі',
    minutesHint:
      'Скільки хвилин співробітник витрачав би без помічника — для «≈ годин заощаджено». 0 — не рахувати.',
    weeklyReport: 'Щотижневий звіт «Адмінки» в Telegram (щопонеділка)',
    save: 'Зберегти',
    saved2: 'Збережено',
    taskTypes: {
      lookup: 'Пошук інформації',
      order_status: 'Статус замовлення/запису',
      how_to: 'Як зробити в системі',
      data_change: 'Зміна даних',
      report: 'Звіти й цифри',
      policy: 'Правила компанії',
      troubleshooting: 'Помилки й проблеми',
      other: 'Інше',
    },
    insightsTitle: 'Висновки тижня',
    insightsNone: 'Висновків ще немає — вони з’являються щопонеділка.',
    week: 'Тиждень з {date}',
    done: 'Зроблено',
    dismiss: 'Не актуально',
    reopen: 'Повернути',
    findings: {
      refusals: '«Не знаю» у {pct}% відповідей ({value} з {n}).',
      not_found:
        'Задачі «{task}»: відповідь не знайдено в {pct}% ({value} з {n}).',
      tool_errors: 'Помилок інструментів (API) за тиждень: {value}.',
      actions_failed: 'Збоїв дій після «Так»: {value} з {n} ({pct}%).',
      learning_queue: 'У черзі навчання {value} нових питань.',
    },
    exportTitle: 'Вивантаження CSV',
    exportHint:
      'Без тексту реплік; співробітник — лише якщо ввімкнено розріз «по співробітнику». До 50 000 рядків, посилання діє 24 год.',
    exportKinds: {
      daily: 'Зведення по днях і ролях',
      labels: 'Розмітка діалогів',
      actions: 'Дії (пропозиції «Так»)',
    },
    exportFrom: 'З',
    exportTo: 'По',
    exportRequest: 'Сформувати',
    exportStatus: {
      queued: 'У черзі',
      running: 'Формується',
      done: 'Готово',
      failed: 'Не вдалося',
      expired: 'Посилання застаріло',
    },
    exportDownload: 'Завантажити',
    exportTooMany: 'Понад 50 000 рядків — оберіть коротший період.',
  },
  errors: {
    ADMIN_LABEL_INVALID:
      'Підпис кнопки — до 40 символів, без < і > та службових символів.',
    ADMIN_TASK_MINUTES_INVALID:
      'Хвилини на тип задачі — цілі числа від 0 до 480.',
    ADMIN_EXPORT_INVALID:
      'Перевірте період: «з» не пізніше «по», не довше 400 днів.',
    ADMIN_EXPORT_NOT_FOUND: 'Вивантаження не знайдено — оновіть список.',
    ADMIN_EXPORT_BUSY:
      'Уже формуються три вивантаження — дочекайтеся, поки вони будуть готові.',
    ADMIN_INSIGHT_NOT_FOUND: 'Висновок не знайдено — оновіть екран.',
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
