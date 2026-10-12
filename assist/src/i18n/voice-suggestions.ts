/**
 * Заход 13 (Р-З13-Б3): «Обучение → Голос» — карточки терминов
 * распознавания и «вела не туда» (принять / перепривязать / не предлагать,
 * «Отменить»). uk/ru/en; сверка ключей — scripts/voice-suggestions.test.ts.
 */
import type { Locale } from '../kit/i18n';

export interface VoiceSuggestionTexts {
  title: string;
  intro: string;
  empty: string;
  term: string;
  addTerm: string;
  termsFull: string;
  wrong: string;
  to: string;
  choose: string;
  rebind: string;
  nameClash: string;
  mute: string;
  muted: string;
  termDone: string;
  rebindDone: string;
  detached: string;
  undo: string;
  undone: string;
  undoLate: string;
  conflict: string;
  noTargets: string;
  openMap: string;
  scope: Record<'site' | 'template' | 'page', string>;
}

const uk: VoiceSuggestionTexts = {
  title: 'Підказки з голосу',
  intro:
    'За {d} днів: слова, які розпізнавання чує невпевнено, і команди, що вели не туди (відвідувачі одразу зупиняли). Прийняте лягає в чернетку карти — опублікуйте її в голосовій карті.',
  empty: 'Нових підказок немає.',
  term: 'Розпізнавання не впевнене в «{p}» (відвідувачів: {v}) — додати до словника термінів?',
  addTerm: 'Додати термін',
  termsFull:
    'Словник термінів заповнений (100) — приберіть зайві в голосовій карті.',
  wrong:
    '«{p}» вела на «{k}», а відвідувачі ({v}) одразу зупиняли — перепривʼязати?',
  to: 'Правильна ціль',
  choose: '— оберіть ціль —',
  rebind: 'Перепривʼязати',
  nameClash:
    'Увага: «{p}» — це назва цілі «{k}». Після перепривʼязки публікацію зупинить конфлікт фраз — спершу перейменуйте «{k}» у голосовій карті.',
  mute: 'Не пропонувати',
  muted: 'Не пропонуватиму 30 днів.',
  termDone: '«{p}» — у чернетці словника термінів.',
  rebindDone: '«{p}» тепер веде на «{k}» (у чернетці).',
  detached: 'Зі старої цілі «{k}» фразу знято.',
  undo: 'Скасувати',
  undone: 'Скасовано — чернетка як була.',
  undoLate:
    'Карту вже змінили — скасувати не вийшло. Поправте в голосовій карті.',
  conflict: 'Карту змінили в іншій вкладці — список оновлено, повторіть.',
  noTargets: 'У карті немає цілей, яким можна дати фразу.',
  openMap: 'До голосової карти',
  scope: { site: 'весь сайт', template: 'шаблон', page: 'сторінка' },
};

const ru: VoiceSuggestionTexts = {
  title: 'Подсказки из голоса',
  intro:
    'За {d} дней: слова, которые распознавание слышит неуверенно, и команды, которые вели не туда (посетители сразу останавливали). Принятое ложится в черновик карты — опубликуйте его в голосовой карте.',
  empty: 'Новых подсказок нет.',
  term: 'Распознавание не уверено в «{p}» (посетителей: {v}) — добавить в словарь терминов?',
  addTerm: 'Добавить термин',
  termsFull:
    'Словарь терминов заполнен (100) — уберите лишние в голосовой карте.',
  wrong:
    '«{p}» вела на «{k}», а посетители ({v}) сразу останавливали — перепривязать?',
  to: 'Правильная цель',
  choose: '— выберите цель —',
  rebind: 'Перепривязать',
  nameClash:
    'Внимание: «{p}» — это название цели «{k}». После перепривязки публикацию остановит конфликт фраз — сначала переименуйте «{k}» в голосовой карте.',
  mute: 'Не предлагать',
  muted: 'Не буду предлагать 30 дней.',
  termDone: '«{p}» — в черновике словаря терминов.',
  rebindDone: '«{p}» теперь ведёт на «{k}» (в черновике).',
  detached: 'Со старой цели «{k}» фраза снята.',
  undo: 'Отменить',
  undone: 'Отменено — черновик как был.',
  undoLate:
    'Карту уже изменили — отменить не получилось. Поправьте в голосовой карте.',
  conflict: 'Карту изменили в другой вкладке — список обновлён, повторите.',
  noTargets: 'В карте нет целей, которым можно дать фразу.',
  openMap: 'К голосовой карте',
  scope: { site: 'весь сайт', template: 'шаблон', page: 'страница' },
};

const en: VoiceSuggestionTexts = {
  title: 'Voice suggestions',
  intro:
    'Over {d} days: words speech recognition hears with low confidence, and commands that went to the wrong place (visitors stopped them at once). Accepted items go to the map draft — publish it in the voice map.',
  empty: 'No new suggestions.',
  term: 'Speech recognition is unsure about “{p}” (visitors: {v}) — add it to the term dictionary?',
  addTerm: 'Add term',
  termsFull:
    'The term dictionary is full (100) — remove unneeded ones in the voice map.',
  wrong:
    '“{p}” led to “{k}”, and visitors ({v}) stopped it at once — rebind it?',
  to: 'Correct target',
  choose: '— choose a target —',
  rebind: 'Rebind',
  nameClash:
    'Note: “{p}” is the name of the target “{k}”. After rebinding, publishing will stop on a phrase conflict — rename “{k}” in the voice map first.',
  mute: 'Don’t suggest',
  muted: 'Won’t suggest it for 30 days.',
  termDone: '“{p}” is in the term dictionary draft.',
  rebindDone: '“{p}” now leads to “{k}” (in the draft).',
  detached: 'The phrase was removed from the old target “{k}”.',
  undo: 'Undo',
  undone: 'Undone — the draft is as it was.',
  undoLate: 'The map has changed since — undo failed. Fix it in the voice map.',
  conflict:
    'The map was changed in another tab — the list is refreshed, try again.',
  noTargets: 'The map has no targets that can take a phrase.',
  openMap: 'To the voice map',
  scope: { site: 'whole site', template: 'template', page: 'page' },
};

export const VOICE_SUGGESTION_TEXTS: Record<Locale, VoiceSuggestionTexts> = {
  uk,
  ru,
  en,
};
