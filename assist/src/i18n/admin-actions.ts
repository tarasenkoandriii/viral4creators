/**
 * Тексты «Админки: действия» (Э8, ТЗ §3.8 п.3–4, п.6; §5.4–5.7; §5-бис.17
 * п.14): карточка подтверждения, настройки write/danger операции, журнал
 * действий с откатом, мемо АМ-N. Отдельный словарь, как admin-mode.ts.
 * Слова «откатил/отменил/вернул как было» для серверных действий не
 * используются (§5-бис.15 п.10): говорим, ЧТО сделано.
 */
import type { Locale } from '../kit';

export interface AdminActionsTexts {
  card: {
    title: string;
    undoTitle: string;
    yes: string;
    no: string;
    phraseHint: string;
    unrequested: string;
    noUndo: string;
    noPreview: string;
    dryFailed: string;
    status: Record<
      | 'pending'
      | 'executing'
      | 'done'
      | 'failed'
      | 'unknown'
      | 'rejected'
      | 'expired',
      string
    >;
    check: string;
    checkNone: string;
    retry: string;
    retryAck: string;
    undo: string;
    memoStep: string;
    amount: string;
    chain: Record<string, string>;
  };
  op: {
    actionsTitle: string;
    planPro: string;
    idempotent: string;
    preview: string;
    compensation: string;
    linkHint: string;
    none: string;
    dryRunParam: string;
    amountParam: string;
    maxAmount: string;
    dailyAmountCap: string;
    amountRequired: string;
    confirmWord: string;
    save: string;
    signing: string;
    signingSet: string;
    signingIssue: string;
    signingOnce: string;
  };
  settings: {
    title: string;
    dailyCap: string;
    notifyDanger: string;
    planPro: string;
  };
  log: {
    actionsTitle: string;
    review: string;
    all: string;
    rollback: string;
    noRollback: string;
    verify: string;
    verifyOk: string;
    verifyBroken: string;
    empty: string;
    by: string;
  };
  memo: {
    title: string;
    hint: string;
    planPro: string;
    used: (used: number, limit: number) => string;
    create: string;
    names: string;
    triggers: string;
    triggersHint: string;
    goal: string;
    slots: string;
    slotsHint: string;
    steps: string;
    stepsHint: string;
    saveDraft: string;
    build: string;
    publish: string;
    disable: string;
    enable: string;
    remove: string;
    version: string;
    passed: string;
    held: string;
    statuses: Record<string, string>;
    empty: string;
    invalidJson: string;
  };
}

const uk: AdminActionsTexts = {
  card: {
    title: 'Я збираюсь:',
    undoTitle: 'Скасування попередньої дії:',
    yes: 'Так',
    no: 'Ні',
    phraseHint: 'Щоб підтвердити, наберіть:',
    unrequested: 'Асистент запропонував це сам, без вашого прохання.',
    noUndo: 'Скасувати цю дію не можна.',
    noPreview: 'Без попереднього перегляду: показано лише нові значення.',
    dryFailed: 'Перевірка системою не пройшла:',
    status: {
      pending: 'Чекає вашого «Так»',
      executing: 'Виконую…',
      done: 'Готово.',
      failed: 'Система відхилила дію. Нічого не змінено.',
      unknown: 'Не знаю, чи застосувалась дія. Перевірте в адмінці.',
      rejected: 'Відхилено — нічого не змінено.',
      expired: 'Пропозиція застаріла — повторіть команду.',
    },
    check: 'Перевірити',
    checkNone: 'Перевірити тут неможливо — подивіться в адмінці.',
    retry: 'Повторити з тим самим ключем',
    retryAck: 'Я перевірив: дія не застосувалась',
    undo: 'Запропонувати скасування',
    memoStep: 'Крок мемо',
    amount: 'Сума',
    chain: {
      committed: 'виконано',
      compensated: 'компенсацію виконано',
      compensation_failed: 'компенсація не вдалась — розберіть вручну',
      unknown: 'результат невідомий — розберіть вручну',
    },
  },
  op: {
    actionsTitle: 'Дія (з підтвердженням «Так»)',
    planPro: 'Дії (write/danger) — у тарифі Pro.',
    idempotent: 'API не створює дубль за Idempotency-Key',
    preview: 'Попередній перегляд «було» (операція читання)',
    compensation: 'Компенсація (скасування) — операція',
    linkHint:
      'Параметри: ім’я=$.request.поле або $.preview.поле, по одному в рядку',
    none: '— немає —',
    dryRunParam: 'Сухий прогін: булевий параметр dryRun',
    amountParam: 'Параметр суми',
    maxAmount: 'Максимум за дію',
    dailyAmountCap: 'Сума за добу',
    amountRequired:
      'Грошова операція: задайте обидва ліміти, інакше не ввімкнеться.',
    confirmWord: 'Слово підтвердження (danger)',
    save: 'Зберегти налаштування дії',
    signing: 'Підпис змінюючих запитів (X-V4C-Signature)',
    signingSet: 'Секрет підпису видано',
    signingIssue: 'Видати секрет підпису',
    signingOnce:
      'Скопіюйте зараз — більше не покажемо. Перевіряйте підпис на своєму API.',
  },
  settings: {
    title: 'Дії в адмінці',
    dailyCap: 'Ліміт виконаних дій сайту за добу',
    notifyDanger: 'Сповіщати мене про кожну небезпечну дію',
    planPro: '«Адмінка: дії» — у тарифі Pro: зараз помічник лише читає дані.',
  },
  log: {
    actionsTitle: 'Дії співробітників',
    review: 'На розбір',
    all: 'Усі',
    rollback: 'Запропонувати скасування',
    noRollback: 'Скасування не оголошено — розбір вручну за журналом',
    verify: 'Перевірити ланцюжок журналу',
    verifyOk: 'Ланцюжок цілий.',
    verifyBroken: 'Ланцюжок порушено в рядку',
    empty: 'Дій ще не було.',
    by: 'хто',
  },
  memo: {
    title: 'Мемо «Адмінки» (АМ-N)',
    hint: 'Іменований ланцюжок операцій API: співробітник викликає «АМ-5 1042». Кожна зміна — окреме «Так».',
    planPro: 'Мемо «Адмінки» — у тарифі Pro.',
    used: (u, l) => `${u} з ${l}`,
    create: 'Нове мемо',
    names: 'Назва (uk)',
    triggers: 'Фрази виклику (uk), по одній у рядку',
    triggersHint:
      'Співробітник може писати фразу або номер АМ-N; далі — значення слотів.',
    goal: 'Мета (для людей)',
    slots: 'Слоти (JSON)',
    slotsHint:
      '[{"name":"order","kind":"number"}] — kind: text|number|date|option',
    steps: 'Кроки (JSON)',
    stepsHint:
      '[{"action":"api","op":"<id операції>","args":{"id":{"slot":"order"},"status":{"const":"shipped"}}}] — кліків немає',
    saveDraft: 'Зберегти чернетку',
    build: 'Перевірити (ворота)',
    publish: 'Опублікувати версію',
    disable: 'Вимкнути',
    enable: 'Увімкнути',
    remove: 'Видалити мемо',
    version: 'Версія',
    passed: 'пройшла перевірку',
    held: 'затримана',
    statuses: {
      draft: 'чернетка',
      checking: 'перевірено',
      held: 'затримано',
      published: 'опубліковано',
      disabled: 'вимкнено',
    },
    empty: 'Мемо ще немає.',
    invalidJson: 'Некоректний JSON у слотах або кроках.',
  },
};

const ru: AdminActionsTexts = {
  card: {
    title: 'Я собираюсь:',
    undoTitle: 'Отмена предыдущего действия:',
    yes: 'Да',
    no: 'Нет',
    phraseHint: 'Чтобы подтвердить, наберите:',
    unrequested: 'Ассистент предложил это сам, без вашей просьбы.',
    noUndo: 'Отменить это действие нельзя.',
    noPreview: 'Без предпросмотра: показаны только новые значения.',
    dryFailed: 'Проверка системой не прошла:',
    status: {
      pending: 'Ждёт вашего «Да»',
      executing: 'Выполняю…',
      done: 'Готово.',
      failed: 'Система отклонила действие. Ничего не изменено.',
      unknown: 'Не знаю, применилось ли действие. Проверьте в админке.',
      rejected: 'Отклонено — ничего не изменено.',
      expired: 'Предложение устарело — повторите команду.',
    },
    check: 'Проверить',
    checkNone: 'Проверить здесь нельзя — посмотрите в админке.',
    retry: 'Повторить с тем же ключом',
    retryAck: 'Я проверил: действие не применилось',
    undo: 'Предложить отмену',
    memoStep: 'Шаг мемо',
    amount: 'Сумма',
    chain: {
      committed: 'выполнено',
      compensated: 'компенсация выполнена',
      compensation_failed: 'компенсация не удалась — разберите вручную',
      unknown: 'исход неизвестен — разберите вручную',
    },
  },
  op: {
    actionsTitle: 'Действие (с подтверждением «Да»)',
    planPro: 'Действия (write/danger) — в тарифе Pro.',
    idempotent: 'API не создаёт дубль по Idempotency-Key',
    preview: 'Предпросмотр «было» (операция чтения)',
    compensation: 'Компенсация (отмена) — операция',
    linkHint:
      'Параметры: имя=$.request.поле или $.preview.поле, по одному в строке',
    none: '— нет —',
    dryRunParam: 'Сухой прогон: булев параметр dryRun',
    amountParam: 'Параметр суммы',
    maxAmount: 'Максимум за действие',
    dailyAmountCap: 'Сумма за сутки',
    amountRequired:
      'Денежная операция: задайте оба лимита, иначе не включится.',
    confirmWord: 'Слово подтверждения (danger)',
    save: 'Сохранить настройки действия',
    signing: 'Подпись изменяющих запросов (X-V4C-Signature)',
    signingSet: 'Секрет подписи выпущен',
    signingIssue: 'Выпустить секрет подписи',
    signingOnce:
      'Скопируйте сейчас — больше не покажем. Проверяйте подпись на своём API.',
  },
  settings: {
    title: 'Действия в админке',
    dailyCap: 'Лимит выполненных действий сайта за сутки',
    notifyDanger: 'Уведомлять меня о каждом опасном действии',
    planPro:
      '«Админка: действия» — в тарифе Pro: сейчас помощник только читает данные.',
  },
  log: {
    actionsTitle: 'Действия сотрудников',
    review: 'На разбор',
    all: 'Все',
    rollback: 'Предложить отмену',
    noRollback: 'Отмена не объявлена — разбор вручную по журналу',
    verify: 'Проверить цепочку журнала',
    verifyOk: 'Цепочка цела.',
    verifyBroken: 'Цепочка нарушена в строке',
    empty: 'Действий ещё не было.',
    by: 'кто',
  },
  memo: {
    title: 'Мемо «Админки» (АМ-N)',
    hint: 'Именованная цепочка операций API: сотрудник вызывает «АМ-5 1042». Каждое изменение — отдельное «Да».',
    planPro: 'Мемо «Админки» — в тарифе Pro.',
    used: (u, l) => `${u} из ${l}`,
    create: 'Новое мемо',
    names: 'Название (uk)',
    triggers: 'Фразы вызова (uk), по одной в строке',
    triggersHint:
      'Сотрудник может писать фразу или номер АМ-N; дальше — значения слотов.',
    goal: 'Цель (для людей)',
    slots: 'Слоты (JSON)',
    slotsHint:
      '[{"name":"order","kind":"number"}] — kind: text|number|date|option',
    steps: 'Шаги (JSON)',
    stepsHint:
      '[{"action":"api","op":"<id операции>","args":{"id":{"slot":"order"},"status":{"const":"shipped"}}}] — кликов нет',
    saveDraft: 'Сохранить черновик',
    build: 'Проверить (ворота)',
    publish: 'Опубликовать версию',
    disable: 'Выключить',
    enable: 'Включить',
    remove: 'Удалить мемо',
    version: 'Версия',
    passed: 'прошла проверку',
    held: 'задержана',
    statuses: {
      draft: 'черновик',
      checking: 'проверено',
      held: 'задержано',
      published: 'опубликовано',
      disabled: 'выключено',
    },
    empty: 'Мемо ещё нет.',
    invalidJson: 'Некорректный JSON в слотах или шагах.',
  },
};

const en: AdminActionsTexts = {
  card: {
    title: "I'm about to:",
    undoTitle: 'Undo of a previous action:',
    yes: 'Yes',
    no: 'No',
    phraseHint: 'To confirm, type:',
    unrequested:
      'The assistant suggested this on its own, without your request.',
    noUndo: 'This action cannot be undone.',
    noPreview: 'No preview: only the new values are shown.',
    dryFailed: 'The system check failed:',
    status: {
      pending: 'Waiting for your "Yes"',
      executing: 'Working…',
      done: 'Done.',
      failed: 'The system rejected the action. Nothing was changed.',
      unknown:
        "I don't know whether the action was applied. Check in the admin panel.",
      rejected: 'Rejected — nothing was changed.',
      expired: 'The proposal has expired — repeat the command.',
    },
    check: 'Check',
    checkNone: "Can't check here — look in the admin panel.",
    retry: 'Retry with the same key',
    retryAck: "I checked: the action wasn't applied",
    undo: 'Propose an undo',
    memoStep: 'Memo step',
    amount: 'Amount',
    chain: {
      committed: 'done',
      compensated: 'compensation executed',
      compensation_failed: 'compensation failed — review manually',
      unknown: 'outcome unknown — review manually',
    },
  },
  op: {
    actionsTitle: 'Action (confirmed with "Yes")',
    planPro: 'Actions (write/danger) are in the Pro plan.',
    idempotent: "API doesn't create duplicates for the same Idempotency-Key",
    preview: '"Before" preview (a read operation)',
    compensation: 'Compensation (undo) operation',
    linkHint:
      'Parameters: name=$.request.field or $.preview.field, one per line',
    none: '— none —',
    dryRunParam: 'Dry run: boolean dryRun parameter',
    amountParam: 'Amount parameter',
    maxAmount: 'Maximum per action',
    dailyAmountCap: 'Total per day',
    amountRequired:
      "Money operation: set both limits, otherwise it won't enable.",
    confirmWord: 'Confirmation word (danger)',
    save: 'Save action settings',
    signing: 'Signing of changing requests (X-V4C-Signature)',
    signingSet: 'Signing secret issued',
    signingIssue: 'Issue signing secret',
    signingOnce:
      "Copy it now — we won't show it again. Verify the signature on your API.",
  },
  settings: {
    title: 'Admin actions',
    dailyCap: 'Site limit of executed actions per day',
    notifyDanger: 'Notify me about every dangerous action',
    planPro:
      '"Admin: actions" is in the Pro plan: for now the assistant only reads data.',
  },
  log: {
    actionsTitle: 'Staff actions',
    review: 'To review',
    all: 'All',
    rollback: 'Propose an undo',
    noRollback: 'No undo declared — review manually using the log',
    verify: 'Verify the log chain',
    verifyOk: 'The chain is intact.',
    verifyBroken: 'The chain is broken at row',
    empty: 'No actions yet.',
    by: 'by',
  },
  memo: {
    title: 'Admin memos (AM-N)',
    hint: 'A named chain of API operations: staff call "AM-5 1042". Each change is a separate "Yes".',
    planPro: 'Admin memos are in the Pro plan.',
    used: (u, l) => `${u} of ${l}`,
    create: 'New memo',
    names: 'Name (uk)',
    triggers: 'Call phrases (uk), one per line',
    triggersHint:
      'Staff can type a phrase or the AM-N number, then slot values.',
    goal: 'Goal (for people)',
    slots: 'Slots (JSON)',
    slotsHint:
      '[{"name":"order","kind":"number"}] — kind: text|number|date|option',
    steps: 'Steps (JSON)',
    stepsHint:
      '[{"action":"api","op":"<operation id>","args":{"id":{"slot":"order"},"status":{"const":"shipped"}}}] — no clicks',
    saveDraft: 'Save draft',
    build: 'Check (gates)',
    publish: 'Publish version',
    disable: 'Disable',
    enable: 'Enable',
    remove: 'Delete memo',
    version: 'Version',
    passed: 'passed the check',
    held: 'held',
    statuses: {
      draft: 'draft',
      checking: 'checked',
      held: 'held',
      published: 'published',
      disabled: 'disabled',
    },
    empty: 'No memos yet.',
    invalidJson: 'Invalid JSON in slots or steps.',
  },
};

export const ADMIN_ACTIONS_TEXTS: Record<Locale, AdminActionsTexts> = {
  uk,
  ru,
  en,
};
