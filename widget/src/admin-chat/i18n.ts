/** Тексты чата сотрудника (uk/ru/en) — Э7. */
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
  },
};
