/**
 * Тексты блока «Из обучалки» (Э6-тер (к)) — отдельно от словарей
 * приложения: блок новый и самостоятельный, словари раздела мемо правят
 * параллельно (полноту трёх языков держит scripts/memo-tutorial-api.test.ts).
 */
import type { Locale } from '../../kit';
import type { MemoTutorialErrorCode } from '../../lib/memo-tutorial-api';

export interface MemoTutorialTexts {
  open: string;
  close: string;
  intro: string;
  empty: string;
  notConfigured: string;
  create: string;
  openMemo: string;
  login: string;
  created: string;
  unresolved: string;
  droppedLogin: string;
  overflow: string;
  errors: Record<MemoTutorialErrorCode, string>;
}

export const MEMO_TUTORIAL_TEXTS: Record<Locale, MemoTutorialTexts> = {
  uk: {
    open: 'Із обучалки',
    close: 'Сховати обучалки',
    intro:
      'Схвалені обучалки цього сайту (режим A). Зі сценарію робиться чернетка мемо: кроки входу, паролі й введені значення не переносяться — поля стають слотами.',
    empty: 'Схвалених обучалок для цього сайту ще немає.',
    notConfigured: 'Зв’язок із генератором обучалок не налаштовано.',
    create: 'Створити чернетку',
    openMemo: 'Відкрити М-{n}',
    login:
      'знята за входом — мемо лише для закритої зони, перевірка — у вашому браузері',
    created: 'Створено чернетку М-{n}.',
    unresolved:
      'Кроки без цілі в карті сторінки: {list} — оберіть ціль у картці або редакторі.',
    droppedLogin: 'Кроків входу відкинуто: {n}.',
    overflow: 'Полів понад 5 — без слота: {n}.',
    errors: {
      MEMO_TUTORIAL_NOT_FOUND:
        'Обучалку не знайдено серед схвалених для цього сайту.',
      MEMO_TUTORIAL_EXISTS: 'Мемо з цієї обучалки вже є.',
      MEMO_TUTORIAL_NOT_ELIGIBLE:
        'Ця обучалка не підходить: сайт не підтверджено (режим B), адреса не цього сайту або після входу немає кроків.',
      MEMO_TUTORIAL_UNAVAILABLE:
        'Генератор обучалок зараз недоступний — спробуйте пізніше.',
    },
  },
  ru: {
    open: 'Из обучалки',
    close: 'Скрыть обучалки',
    intro:
      'Одобренные обучалки этого сайта (режим A). Из сценария делается черновик мемо: шаги входа, пароли и введённые значения не переносятся — поля становятся слотами.',
    empty: 'Одобренных обучалок для этого сайта пока нет.',
    notConfigured: 'Связь с генератором обучалок не настроена.',
    create: 'Создать черновик',
    openMemo: 'Открыть М-{n}',
    login:
      'снята за входом — мемо только для закрытой зоны, проверка — в вашем браузере',
    created: 'Создан черновик М-{n}.',
    unresolved:
      'Шаги без цели в карте страницы: {list} — выберите цель в карточке или редакторе.',
    droppedLogin: 'Шагов входа отброшено: {n}.',
    overflow: 'Полей сверх 5 — без слота: {n}.',
    errors: {
      MEMO_TUTORIAL_NOT_FOUND:
        'Обучалка не найдена среди одобренных для этого сайта.',
      MEMO_TUTORIAL_EXISTS: 'Мемо из этой обучалки уже есть.',
      MEMO_TUTORIAL_NOT_ELIGIBLE:
        'Эта обучалка не подходит: сайт не подтверждён (режим B), адрес не этого сайта или после входа нет шагов.',
      MEMO_TUTORIAL_UNAVAILABLE:
        'Генератор обучалок сейчас недоступен — попробуйте позже.',
    },
  },
  en: {
    open: 'From tutorial',
    close: 'Hide tutorials',
    intro:
      'Approved tutorials of this site (mode A). A memo draft is made from the scenario: login steps, passwords and typed values are not carried over — fields become slots.',
    empty: 'No approved tutorials for this site yet.',
    notConfigured: 'The link to the tutorial generator is not configured.',
    create: 'Create draft',
    openMemo: 'Open M-{n}',
    login:
      'recorded behind a login — memo for the closed area only, checked in your browser',
    created: 'Draft M-{n} created.',
    unresolved:
      'Steps without a target in the page map: {list} — pick the target in the card or the editor.',
    droppedLogin: 'Login steps dropped: {n}.',
    overflow: 'Fields beyond 5 — without a slot: {n}.',
    errors: {
      MEMO_TUTORIAL_NOT_FOUND:
        'Tutorial not found among the approved ones for this site.',
      MEMO_TUTORIAL_EXISTS: 'A memo from this tutorial already exists.',
      MEMO_TUTORIAL_NOT_ELIGIBLE:
        'This tutorial does not fit: the site is not verified (mode B), the address is not this site’s, or there are no steps after login.',
      MEMO_TUTORIAL_UNAVAILABLE:
        'The tutorial generator is unavailable now — try again later.',
    },
  },
};
