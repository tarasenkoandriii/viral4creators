import type { AccountMember, Locale } from '../kit';
import type { QaCasePayload } from './qa-catalog-api';
export function qaAccess(member: Pick<AccountMember, 'role' | 'productRoles'>) {
  return {
    read: member.role === 'owner' || member.productRoles.qa !== 'none',
    write: member.role === 'owner' || member.productRoles.qa === 'admin',
  };
}
export const emptyQaCase = (): QaCasePayload => ({
  title: '',
  purpose: '',
  preconditions: '',
  steps: [{ action: '', expected: '' }],
  type: 'manual',
  priority: 'normal',
  tags: [],
  requirementIds: [],
  archived: false,
});
export function qaLabels(locale: Locale) {
  const i = locale === 'uk' ? 1 : locale === 'en' ? 2 : 0;
  const rows = {
    title: ['QA: тестовые кейсы', 'QA: тестові кейси', 'QA: test cases'],
    newCase: ['Новый кейс', 'Новий кейс', 'New case'],
    key: [
      'Стабильный ID (например SBX-LOGIN)',
      'Стабільний ID (наприклад SBX-LOGIN)',
      'Stable ID (e.g. SBX-LOGIN)',
    ],
    name: ['Название', 'Назва', 'Title'],
    purpose: ['Цель', 'Мета', 'Purpose'],
    preconditions: ['Предусловия', 'Передумови', 'Preconditions'],
    action: ['Действие', 'Дія', 'Action'],
    expected: [
      'Ожидаемый результат',
      'Очікуваний результат',
      'Expected result',
    ],
    addStep: ['Добавить шаг', 'Додати крок', 'Add step'],
    remove: ['Удалить шаг', 'Видалити крок', 'Remove step'],
    type: ['Тип', 'Тип', 'Type'],
    manual: ['Ручной', 'Ручний', 'Manual'],
    automated: ['Автоматизированный', 'Автоматизований', 'Automated'],
    priority: ['Приоритет', 'Пріоритет', 'Priority'],
    low: ['Низкий', 'Низький', 'Low'],
    normal: ['Обычный', 'Звичайний', 'Normal'],
    high: ['Высокий', 'Високий', 'High'],
    critical: ['Критический', 'Критичний', 'Critical'],
    tags: [
      'Теги (через запятую)',
      'Теги (через кому)',
      'Tags (comma separated)',
    ],
    requirements: [
      'ID требований (через запятую)',
      'ID вимог (через кому)',
      'Requirement IDs (comma separated)',
    ],
    archived: ['В архиве', 'В архіві', 'Archived'],
    save: [
      'Сохранить новую версию',
      'Зберегти нову версію',
      'Save new version',
    ],
    saved: ['Версия сохранена.', 'Версію збережено.', 'Version saved.'],
    history: ['История версий', 'Історія версій', 'Version history'],
    restore: [
      'Взять эту версию в черновик',
      'Взяти цю версію в чернетку',
      'Use this version as draft',
    ],
    more: ['Загрузить ещё', 'Завантажити ще', 'Load more'],
    empty: ['Кейсов пока нет.', 'Кейсів поки немає.', 'No cases yet.'],
    denied: [
      'Нет доступа к QA-каталогу.',
      'Немає доступу до QA-каталогу.',
      'No access to the QA catalog.',
    ],
    readOnly: ['Только чтение', 'Лише читання', 'Read only'],
    discard: [
      'Заменить несохранённый черновик?',
      'Замінити незбережену чернетку?',
      'Replace the unsaved draft?',
    ],
    conflict: [
      'Кейс изменён другим пользователем или ID уже занят. Черновик сохранён на экране.',
      'Кейс змінено іншим користувачем або ID вже зайнятий. Чернетка залишилася на екрані.',
      'The case changed or this ID is already taken. Your draft remains on screen.',
    ],
    reload: [
      'Загрузить актуальную версию',
      'Завантажити актуальну версію',
      'Load latest version',
    ],
    error: [
      'Не удалось выполнить запрос. Повторите попытку.',
      'Не вдалося виконати запит. Спробуйте ще раз.',
      'Request failed. Try again.',
    ],
    limits: [
      'До 20 уникальных тегов и ID, каждый до 64 символов.',
      'До 20 унікальних тегів та ID, кожен до 64 символів.',
      'Up to 20 unique tags and IDs, each up to 64 characters.',
    ],
    retry: ['Повторить', 'Повторити', 'Retry'],
    scope: [
      'Тип «автоматизированный» описывает кейс; запуск тестов из этого редактора пока не подключён.',
      'Тип «автоматизований» описує кейс; запуск тестів із цього редактора ще не підключено.',
      'Automated describes the case; running tests from this editor is not connected yet.',
    ],
  };
  return Object.fromEntries(
    Object.entries(rows).map(([k, v]) => [k, v[i]])
  ) as Record<keyof typeof rows, string>;
}
export function qaListInput(text: string): string[] | null {
  const values = text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length <= 20 &&
    values.every((v) => v.length <= 64) &&
    new Set(values).size === values.length
    ? values
    : null;
}
