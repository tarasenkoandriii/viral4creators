/**
 * Тексты раздела «Голосова карта адмінки» (заход 11, №117; ТЗ §5-кватер.9,
 * §5-кватер.13; В-55) — uk/ru/en. Сверка ключей трёх языков и покрытия кодов
 * сервера — scripts/admin-voice-map-api.test.ts.
 */
import type { Locale } from '../kit/i18n';
import type {
  AdminVoiceMapErrorCode,
  MapLang,
  MapTargetRole,
} from '../lib/admin-voice-map-api';
import type { MapGateCode, MapVersionStatus } from '../lib/voice-map-api';

export interface AdminVoiceMapTexts {
  title: string;
  intro: string;
  needPlan: string;
  noHosts: string;
  published: string;
  none: string;
  draft: string;
  dirty: string;
  gatesOk: string;
  gatesBad: string;
  open: string;
  linkHint: string;
  sessions: string;
  revoke: string;
  revoked: string;
  targetsTitle: string;
  targetsEmpty: string;
  element: string;
  scopes: Record<'site' | 'page' | 'template', string>;
  risks: Record<'now' | 'confirm' | 'never', string>;
  denylisted: string;
  removed: string;
  langs: Record<MapLang, string>;
  name: string;
  synonyms: string;
  synonymsHint: string;
  edit: string;
  save: string;
  cancel: string;
  remove: string;
  restore: string;
  add: string;
  addTitle: string;
  key: string;
  keyHint: string;
  text: string;
  role: string;
  roles: Record<MapTargetRole, string>;
  assistId: string;
  scope: string;
  pagePath: string;
  template: string;
  deny: string;
  saved: string;
  templatesTitle: string;
  templateName: string;
  templateMask: string;
  templateAdd: string;
  build: string;
  versions: string;
  diff: string;
  viaEditor: string;
  publish: string;
  publishedOk: string;
  discard: string;
  rollback: string;
  rollbackOk: string;
  export: string;
  import: string;
  imported: string;
  importSigned: string;
  status: Record<MapVersionStatus, string>;
  gates: Record<MapGateCode, string>;
  errors: Record<AdminVoiceMapErrorCode, string>;
}

const uk: AdminVoiceMapTexts = {
  title: 'Голосова карта адмінки',
  intro:
    'Як співробітники називають цілі на сторінках адмінки — імена й синоніми трьома мовами. Карта адмінки окрема від карти сайту: синоніми однієї ніколи не діють в іншій.',
  needPlan:
    'Голосова карта адмінки — у тарифі Pro. Зараз її можна лише переглянути.',
  noHosts:
    'Немає підтвердженої адреси самої адмінки — редактор відкривається лише на ній.',
  published: 'опублікована v{v}',
  none: 'Карту ще не опубліковано — команди йдуть через знімок сторінки й модель.',
  draft: 'Чернетка: {t} цілей · {d} заборонено · {s} шаблонів · {f} крихких',
  dirty: 'Чернетка відрізняється від опублікованої — зберіть версію.',
  gatesOk: 'Ворота: зелені',
  gatesBad: 'Ворота: {n} проблем',
  open: 'Відкрити редактор в адмінці',
  linkHint:
    'Одноразове посилання на 10 хв відкриється в браузері; потрібна відкрита сесія помічника співробітника в адмінці.',
  sessions: 'Активних сесій редактора: {n}',
  revoke: 'Завершити всі',
  revoked: 'Сесії редактора завершено',
  targetsTitle: 'Цілі',
  targetsEmpty:
    'Цілей ще немає — додайте тут або в редакторі на сторінці адмінки.',
  element: 'Елемент',
  scopes: { site: 'уся адмінка', page: 'сторінка', template: 'шаблон' },
  risks: {
    now: 'одразу',
    confirm: 'з підтвердженням',
    never: 'ніколи',
  },
  denylisted: 'заборонено',
  removed: 'видалено (до публікації)',
  langs: { uk: 'UK', ru: 'RU', en: 'EN' },
  name: 'Назва',
  synonyms: 'Синоніми',
  synonymsHint: 'через кому, до 20',
  edit: 'Змінити',
  save: 'Зберегти',
  cancel: 'Скасувати',
  remove: 'Видалити',
  restore: 'Повернути',
  add: 'Додати ціль',
  addTitle: 'Нова ціль',
  key: 'Ключ',
  keyHint: 'латиниця, цифри й дефіс (orders, order-history)',
  text: 'Текст на елементі',
  role: 'Тип елемента',
  roles: {
    link: 'посилання',
    button: 'кнопка',
    tab: 'вкладка',
    menuitem: 'пункт меню',
    textbox: 'поле',
    searchbox: 'пошук',
    combobox: 'список',
    checkbox: 'прапорець',
  },
  assistId: 'data-assist-id (якщо є)',
  scope: 'Де діє',
  pagePath: 'Шлях сторінки',
  template: 'Шаблон',
  deny: 'Заборонити (без імен)',
  saved: 'Чернетку збережено',
  templatesTitle: 'Шаблони сторінок',
  templateName: 'Назва шаблону',
  templateMask: 'Маска шляху (/admin/orders/*)',
  templateAdd: 'Додати шаблон',
  build: 'Зібрати версію',
  versions: 'Версії',
  diff: '+{a} ~{c} −{r}',
  viaEditor: 'з редактора',
  publish: 'Опублікувати',
  publishedOk: 'Версію v{n} опубліковано',
  discard: 'Відхилити',
  rollback: 'Повернути цю версію',
  rollbackOk: 'Зібрано нову версію v{n} зі змістом обраної — опублікуйте її',
  export: 'Експорт',
  import: 'Імпорт',
  imported: 'Імпортовано: {a}, відхилено: {r}{s}',
  importSigned: ' · файл наш, без правок',
  status: {
    building: 'збирається',
    checking: 'на перевірці',
    published: 'опублікована',
    held: 'затримана',
    discarded: 'відхилена',
  },
  gates: {
    risk_lowered: 'ризик знижено',
    never_named: 'імена в цілі «ніколи»',
    never_attr: 'data-assist="never" не в забороненому',
    phrase_conflict: 'одна фраза — дві цілі',
    memo_phrase: 'фраза зайнята мемо АМ',
    text: 'недопустимий текст',
    not_found: 'понад 30% цілей не знайдено',
    empty: 'карта порожня',
  },
  errors: {
    VOICE_MAP_CONFLICT: 'Карту змінили в іншій вкладці — оновіть',
    VOICE_MAP_INVALID: 'Зміна карти не пройшла перевірку',
    VOICE_MAP_VERSION_NOT_FOUND: 'Версію не знайдено',
    VOICE_MAP_VERSION_STATE:
      'Цю дію для версії в такому стані виконати не можна',
    VOICE_MAP_HELD: 'Ворота не пройдено — версію затримано',
    VOICE_MAP_PHRASE_TAKEN: 'Фразу карти вже зайняло мемо — перейменуйте',
    VOICE_MAP_IMPORT_KIND:
      'Це файл карти сайту — у карту адмінки не імпортується',
    VOICE_MAP_IMPORT_FORMAT: 'Це не файл голосової карти',
    ADMIN_VOICE_MAP_PLAN_REQUIRED: 'Голосова карта адмінки — у тарифі Pro',
    ADMIN_VOICE_MAP_HOST_REQUIRED:
      'Редактор — лише на підтвердженій адресі самої адмінки',
    ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED:
      'Редактор карти відкриває лише власник: у «Ролях» адмінки зіставте свою роль у системі з роллю помічника owner',
    EDITOR_OWNER_REQUIRED:
      'Редактор — лише власнику: роль співробітника має відповідати ролі owner',
    EDITOR_LINK_INVALID: 'Посилання редактора недійсне — візьміть нове',
    EDITOR_SESSION_EXPIRED: 'Сесію редактора завершено',
    EDITOR_PUBLISH_FORBIDDEN: 'Публікація — лише тут, у Telegram',
    EDITOR_TRY_LIMIT: 'Перевірок «Сказати зараз» на сьогодні більше немає',
    EDITOR_PUBLISH_LIMIT: 'Запит публікації вже надіслано',
    EDITOR_BAD_REQUEST: 'Некоректний запит редактора',
  },
};

const ru: AdminVoiceMapTexts = {
  title: 'Голосовая карта админки',
  intro:
    'Как сотрудники называют цели на страницах админки — имена и синонимы на трёх языках. Карта админки отдельна от карты сайта: синонимы одной никогда не действуют в другой.',
  needPlan:
    'Голосовая карта админки — в тарифе Pro. Сейчас её можно только посмотреть.',
  noHosts:
    'Нет подтверждённого адреса самой админки — редактор открывается только на нём.',
  published: 'опубликована v{v}',
  none: 'Карта ещё не опубликована — команды идут через снимок страницы и модель.',
  draft: 'Черновик: {t} целей · {d} запрещено · {s} шаблонов · {f} хрупких',
  dirty: 'Черновик отличается от опубликованной — соберите версию.',
  gatesOk: 'Ворота: зелёные',
  gatesBad: 'Ворота: {n} проблем',
  open: 'Открыть редактор в админке',
  linkHint:
    'Одноразовая ссылка на 10 мин откроется в браузере; нужна открытая сессия помощника сотрудника в админке.',
  sessions: 'Активных сессий редактора: {n}',
  revoke: 'Завершить все',
  revoked: 'Сессии редактора завершены',
  targetsTitle: 'Цели',
  targetsEmpty:
    'Целей ещё нет — добавьте здесь или в редакторе на странице админки.',
  element: 'Элемент',
  scopes: { site: 'вся админка', page: 'страница', template: 'шаблон' },
  risks: {
    now: 'сразу',
    confirm: 'с подтверждением',
    never: 'никогда',
  },
  denylisted: 'запрещено',
  removed: 'удалено (до публикации)',
  langs: { uk: 'UK', ru: 'RU', en: 'EN' },
  name: 'Название',
  synonyms: 'Синонимы',
  synonymsHint: 'через запятую, до 20',
  edit: 'Изменить',
  save: 'Сохранить',
  cancel: 'Отмена',
  remove: 'Удалить',
  restore: 'Вернуть',
  add: 'Добавить цель',
  addTitle: 'Новая цель',
  key: 'Ключ',
  keyHint: 'латиница, цифры и дефис (orders, order-history)',
  text: 'Текст на элементе',
  role: 'Тип элемента',
  roles: {
    link: 'ссылка',
    button: 'кнопка',
    tab: 'вкладка',
    menuitem: 'пункт меню',
    textbox: 'поле',
    searchbox: 'поиск',
    combobox: 'список',
    checkbox: 'флажок',
  },
  assistId: 'data-assist-id (если есть)',
  scope: 'Где действует',
  pagePath: 'Путь страницы',
  template: 'Шаблон',
  deny: 'Запретить (без имён)',
  saved: 'Черновик сохранён',
  templatesTitle: 'Шаблоны страниц',
  templateName: 'Название шаблона',
  templateMask: 'Маска пути (/admin/orders/*)',
  templateAdd: 'Добавить шаблон',
  build: 'Собрать версию',
  versions: 'Версии',
  diff: '+{a} ~{c} −{r}',
  viaEditor: 'из редактора',
  publish: 'Опубликовать',
  publishedOk: 'Версия v{n} опубликована',
  discard: 'Отклонить',
  rollback: 'Вернуть эту версию',
  rollbackOk:
    'Собрана новая версия v{n} с содержимым выбранной — опубликуйте её',
  export: 'Экспорт',
  import: 'Импорт',
  imported: 'Импортировано: {a}, отклонено: {r}{s}',
  importSigned: ' · файл наш, без правок',
  status: {
    building: 'собирается',
    checking: 'на проверке',
    published: 'опубликована',
    held: 'задержана',
    discarded: 'отклонена',
  },
  gates: {
    risk_lowered: 'риск понижен',
    never_named: 'имена у цели «никогда»',
    never_attr: 'data-assist="never" не в запрещённом',
    phrase_conflict: 'одна фраза — две цели',
    memo_phrase: 'фраза занята мемо АМ',
    text: 'недопустимый текст',
    not_found: 'больше 30% целей не найдено',
    empty: 'карта пуста',
  },
  errors: {
    VOICE_MAP_CONFLICT: 'Карту изменили в другой вкладке — обновите',
    VOICE_MAP_INVALID: 'Изменение карты не прошло проверку',
    VOICE_MAP_VERSION_NOT_FOUND: 'Версия не найдена',
    VOICE_MAP_VERSION_STATE:
      'Это действие для версии в таком состоянии выполнить нельзя',
    VOICE_MAP_HELD: 'Ворота не пройдены — версия задержана',
    VOICE_MAP_PHRASE_TAKEN: 'Фраза карты уже занята мемо — переименуйте',
    VOICE_MAP_IMPORT_KIND:
      'Это файл карты сайта — в карту админки не импортируется',
    VOICE_MAP_IMPORT_FORMAT: 'Это не файл голосовой карты',
    ADMIN_VOICE_MAP_PLAN_REQUIRED: 'Голосовая карта админки — в тарифе Pro',
    ADMIN_VOICE_MAP_HOST_REQUIRED:
      'Редактор — только на подтверждённом адресе самой админки',
    ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED:
      'Редактор карты открывает только владелец: в «Ролях» админки сопоставьте свою роль в системе с ролью помощника owner',
    EDITOR_OWNER_REQUIRED:
      'Редактор — только владельцу: роль сотрудника должна соответствовать роли owner',
    EDITOR_LINK_INVALID: 'Ссылка редактора недействительна — возьмите новую',
    EDITOR_SESSION_EXPIRED: 'Сессия редактора завершена',
    EDITOR_PUBLISH_FORBIDDEN: 'Публикация — только здесь, в Telegram',
    EDITOR_TRY_LIMIT: 'Проверок «Сказать сейчас» на сегодня больше нет',
    EDITOR_PUBLISH_LIMIT: 'Запрос публикации уже отправлен',
    EDITOR_BAD_REQUEST: 'Некорректный запрос редактора',
  },
};

const en: AdminVoiceMapTexts = {
  title: 'Admin voice map',
  intro:
    'How staff name targets on admin pages — names and synonyms in three languages. The admin map is separate from the site map: synonyms of one never work in the other.',
  needPlan:
    'The admin voice map is part of the Pro plan. For now you can only view it.',
  noHosts:
    'No verified address of the admin itself — the editor opens only there.',
  published: 'published v{v}',
  none: 'The map is not published yet — commands go through the page snapshot and the model.',
  draft: 'Draft: {t} targets · {d} forbidden · {s} templates · {f} fragile',
  dirty: 'The draft differs from the published map — build a version.',
  gatesOk: 'Gates: green',
  gatesBad: 'Gates: {n} problems',
  open: 'Open the editor in the admin',
  linkHint:
    'A one-time 10-minute link opens in the browser; a staff assistant session must be open in the admin.',
  sessions: 'Active editor sessions: {n}',
  revoke: 'End all',
  revoked: 'Editor sessions ended',
  targetsTitle: 'Targets',
  targetsEmpty:
    'No targets yet — add them here or in the editor on an admin page.',
  element: 'Element',
  scopes: { site: 'whole admin', page: 'page', template: 'template' },
  risks: {
    now: 'at once',
    confirm: 'with confirmation',
    never: 'never',
  },
  denylisted: 'forbidden',
  removed: 'removed (until published)',
  langs: { uk: 'UK', ru: 'RU', en: 'EN' },
  name: 'Name',
  synonyms: 'Synonyms',
  synonymsHint: 'comma-separated, up to 20',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  remove: 'Remove',
  restore: 'Restore',
  add: 'Add target',
  addTitle: 'New target',
  key: 'Key',
  keyHint: 'latin letters, digits and dashes (orders, order-history)',
  text: 'Text on the element',
  role: 'Element type',
  roles: {
    link: 'link',
    button: 'button',
    tab: 'tab',
    menuitem: 'menu item',
    textbox: 'field',
    searchbox: 'search',
    combobox: 'list',
    checkbox: 'checkbox',
  },
  assistId: 'data-assist-id (if any)',
  scope: 'Where it works',
  pagePath: 'Page path',
  template: 'Template',
  deny: 'Forbid (no names)',
  saved: 'Draft saved',
  templatesTitle: 'Page templates',
  templateName: 'Template name',
  templateMask: 'Path mask (/admin/orders/*)',
  templateAdd: 'Add template',
  build: 'Build version',
  versions: 'Versions',
  diff: '+{a} ~{c} −{r}',
  viaEditor: 'from the editor',
  publish: 'Publish',
  publishedOk: 'Version v{n} published',
  discard: 'Discard',
  rollback: 'Restore this version',
  rollbackOk: 'Built a new version v{n} with the chosen content — publish it',
  export: 'Export',
  import: 'Import',
  imported: 'Imported: {a}, rejected: {r}{s}',
  importSigned: ' · our file, unmodified',
  status: {
    building: 'building',
    checking: 'checking',
    published: 'published',
    held: 'held',
    discarded: 'discarded',
  },
  gates: {
    risk_lowered: 'risk lowered',
    never_named: 'names on a “never” target',
    never_attr: 'data-assist="never" not forbidden',
    phrase_conflict: 'one phrase — two targets',
    memo_phrase: 'phrase taken by an AM memo',
    text: 'invalid text',
    not_found: 'over 30% of targets not found',
    empty: 'the map is empty',
  },
  errors: {
    VOICE_MAP_CONFLICT: 'The map was changed in another tab — refresh',
    VOICE_MAP_INVALID: 'The map change did not pass the checks',
    VOICE_MAP_VERSION_NOT_FOUND: 'Version not found',
    VOICE_MAP_VERSION_STATE:
      'This action is not possible for a version in this state',
    VOICE_MAP_HELD: 'Gates not passed — the version is held',
    VOICE_MAP_PHRASE_TAKEN:
      'A map phrase is already taken by a memo — rename it',
    VOICE_MAP_IMPORT_KIND:
      'This is a site map file — it cannot be imported into the admin map',
    VOICE_MAP_IMPORT_FORMAT: 'This is not a voice map file',
    ADMIN_VOICE_MAP_PLAN_REQUIRED:
      'The admin voice map is part of the Pro plan',
    ADMIN_VOICE_MAP_HOST_REQUIRED:
      'The editor works only on a verified address of the admin itself',
    ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED:
      'Only the owner opens the map editor: in the admin role map, map your role to the assistant role owner',
    EDITOR_OWNER_REQUIRED:
      'The editor is for the owner only: the staff role must map to owner',
    EDITOR_LINK_INVALID: 'The editor link is invalid — get a new one',
    EDITOR_SESSION_EXPIRED: 'The editor session has ended',
    EDITOR_PUBLISH_FORBIDDEN: 'Publishing — only here, in Telegram',
    EDITOR_TRY_LIMIT: 'No more “Say it now” checks today',
    EDITOR_PUBLISH_LIMIT: 'A publish request has already been sent',
    EDITOR_BAD_REQUEST: 'Bad editor request',
  },
};

export const ADMIN_VOICE_MAP_TEXTS: Record<Locale, AdminVoiceMapTexts> = {
  uk,
  ru,
  en,
};
