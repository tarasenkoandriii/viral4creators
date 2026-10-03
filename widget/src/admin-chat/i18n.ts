/** Тексты чата сотрудника (uk/ru/en) — Э7; карточка подтверждения — Э8. */
export type AdminLang = 'uk' | 'ru' | 'en';

export interface AdminTexts {
  title: string;
  close: string;
  placeholder: string;
  send: string;
  banner: string;
  good: string;
  bad: string;
  fixPlaceholder: string;
  fixSend: string;
  fixThanks: string;
  connecting: string;
  thinking: string;
  unavailable: string;
  expired: string;
  reload: string;
  rejected: string;
  off: string;
  loggedOut: string;
  // Э8: карточка подтверждения действия (ТЗ §5.4 п.5, §4-бис.5)
  cardTitle: string;
  cardUndoTitle: string;
  yes: string;
  edit: string;
  no: string;
  editHint: string;
  phraseHint: string;
  unrequested: string;
  noUndo: string;
  noPreview: string;
  dryFailed: string;
  executing: string;
  stDone: string;
  stFailed: string;
  stUnknown: string;
  stRejected: string;
  stExpired: string;
  check: string;
  checkNone: string;
  retry: string;
  retryAck: string;
  undo: string;
  memoStep: string;
  amount: string;
  actionError: string;
}

export const T: Record<AdminLang, AdminTexts> = {
  uk: {
    title: 'Помічник співробітника',
    close: 'Закрити',
    placeholder: 'Питання про регламент, замовлення…',
    send: 'Надіслати',
    banner: 'Власник бачить статистику ваших запитів.',
    good: 'Корисна відповідь',
    bad: 'Неправильна відповідь',
    fixPlaceholder: 'Як правильно? (піде власнику на перевірку)',
    fixSend: 'Надіслати виправлення',
    fixThanks: 'Дякуємо — власник перевірить виправлення.',
    connecting: 'Підключаємось…',
    thinking: 'Шукаю відповідь…',
    unavailable: 'Помічник тимчасово недоступний.',
    expired: 'Сесія помічника закінчилась — оновіть сторінку.',
    reload: 'Співробітник змінився в іншій вкладці — оновіть сторінку.',
    rejected: 'Не вдалося підтвердити співробітника — оновіть сторінку.',
    off: 'Помічник співробітника вимкнено.',
    loggedOut: 'Ви вийшли з адмінки.',
    cardTitle: 'Я збираюсь:',
    cardUndoTitle: 'Скасування попередньої дії:',
    yes: 'Так',
    edit: 'Змінити',
    no: 'Ні',
    editHint: 'Напишіть, що змінити, — запропоную нову дію.',
    phraseHint: 'Щоб підтвердити, наберіть:',
    unrequested: 'Асистент запропонував це сам, без вашого прохання.',
    noUndo: 'Скасувати цю дію не можна.',
    noPreview: 'Без попереднього перегляду: показано лише нові значення.',
    dryFailed: 'Перевірка системою не пройшла:',
    executing: 'Виконую…',
    stDone: 'Готово.',
    stFailed: 'Система відхилила дію. Нічого не змінено.',
    stUnknown: 'Не знаю, чи застосувалась дія. Перевірте в адмінці.',
    stRejected: 'Відхилено — нічого не змінено.',
    stExpired: 'Пропозиція застаріла — повторіть команду.',
    check: 'Перевірити',
    checkNone: 'Перевірити тут неможливо — подивіться в адмінці.',
    retry: 'Повторити з тим самим ключем',
    retryAck: 'Я перевірив: дія не застосувалась',
    undo: 'Запропонувати скасування',
    memoStep: 'Крок мемо',
    amount: 'Сума',
    actionError: 'Не вдалося — спробуйте ще раз.',
  },
  ru: {
    title: 'Помощник сотрудника',
    close: 'Закрыть',
    placeholder: 'Вопрос о регламенте, заказе…',
    send: 'Отправить',
    banner: 'Владелец видит статистику ваших запросов.',
    good: 'Полезный ответ',
    bad: 'Неправильный ответ',
    fixPlaceholder: 'Как правильно? (уйдёт владельцу на проверку)',
    fixSend: 'Отправить исправление',
    fixThanks: 'Спасибо — владелец проверит исправление.',
    connecting: 'Подключаемся…',
    thinking: 'Ищу ответ…',
    unavailable: 'Помощник временно недоступен.',
    expired: 'Сессия помощника истекла — обновите страницу.',
    reload: 'Сотрудник сменился в другой вкладке — обновите страницу.',
    rejected: 'Не удалось подтвердить сотрудника — обновите страницу.',
    off: 'Помощник сотрудника выключен.',
    loggedOut: 'Вы вышли из админки.',
    cardTitle: 'Я собираюсь:',
    cardUndoTitle: 'Отмена предыдущего действия:',
    yes: 'Да',
    edit: 'Изменить',
    no: 'Нет',
    editHint: 'Напишите, что изменить, — предложу новое действие.',
    phraseHint: 'Чтобы подтвердить, наберите:',
    unrequested: 'Ассистент предложил это сам, без вашей просьбы.',
    noUndo: 'Отменить это действие нельзя.',
    noPreview: 'Без предпросмотра: показаны только новые значения.',
    dryFailed: 'Проверка системой не прошла:',
    executing: 'Выполняю…',
    stDone: 'Готово.',
    stFailed: 'Система отклонила действие. Ничего не изменено.',
    stUnknown: 'Не знаю, применилось ли действие. Проверьте в админке.',
    stRejected: 'Отклонено — ничего не изменено.',
    stExpired: 'Предложение устарело — повторите команду.',
    check: 'Проверить',
    checkNone: 'Проверить здесь нельзя — посмотрите в админке.',
    retry: 'Повторить с тем же ключом',
    retryAck: 'Я проверил: действие не применилось',
    undo: 'Предложить отмену',
    memoStep: 'Шаг мемо',
    amount: 'Сумма',
    actionError: 'Не получилось — попробуйте ещё раз.',
  },
  en: {
    title: 'Staff assistant',
    close: 'Close',
    placeholder: 'Ask about a policy or an order…',
    send: 'Send',
    banner: 'The owner can see statistics of your requests.',
    good: 'Helpful answer',
    bad: 'Wrong answer',
    fixPlaceholder: "What's correct? (goes to the owner for review)",
    fixSend: 'Send correction',
    fixThanks: 'Thanks — the owner will review your correction.',
    connecting: 'Connecting…',
    thinking: 'Looking for an answer…',
    unavailable: 'The assistant is temporarily unavailable.',
    expired: 'The assistant session has expired — reload the page.',
    reload: 'Another employee signed in in a different tab — reload the page.',
    rejected: "Couldn't verify the employee — reload the page.",
    off: 'The staff assistant is turned off.',
    loggedOut: 'You signed out of the admin panel.',
    cardTitle: "I'm about to:",
    cardUndoTitle: 'Undo the previous action:',
    yes: 'Yes',
    edit: 'Change',
    no: 'No',
    editHint: 'Write what to change — I will propose a new action.',
    phraseHint: 'To confirm, type:',
    unrequested:
      'The assistant suggested this on its own, without your request.',
    noUndo: 'This action cannot be undone.',
    noPreview: 'No preview: only the new values are shown.',
    dryFailed: 'The system check failed:',
    executing: 'Working…',
    stDone: 'Done.',
    stFailed: 'The system rejected the action. Nothing was changed.',
    stUnknown:
      "I don't know whether the action was applied. Check in the admin panel.",
    stRejected: 'Rejected — nothing was changed.',
    stExpired: 'The proposal has expired — repeat the command.',
    check: 'Check',
    checkNone: "Can't check here — look in the admin panel.",
    retry: 'Retry with the same key',
    retryAck: "I checked: the action wasn't applied",
    undo: 'Propose an undo',
    memoStep: 'Memo step',
    amount: 'Amount',
    actionError: "That didn't work — try again.",
  },
};
