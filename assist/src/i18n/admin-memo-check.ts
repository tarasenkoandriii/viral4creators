/**
 * Тексты TMA: сухой прогон мемо «Админки», «требует проверки» и статистика
 * (аудит 06.10.2026; ТЗ §5-бис.17 п.7, п.8, п.13, п.14). uk/ru/en.
 */
import type { Locale } from '../kit';

export interface AdminMemoCheckTexts {
  needsReview: string;
  reasons: Record<
    'failures' | 'pin_mismatch' | 'goal_low',
    (r: {
      step: number | null;
      employees: number | null;
      runs: number | null;
      reached: number | null;
    }) => string
  >;
  reviewExit: string;
  stats: (s: {
    days: number;
    runs: number;
    rate: string;
    failed: number;
  }) => string;
  noRuns: (days: number) => string;
  lastRun: string;
  stats7Title: string;
  statsLine: (s: {
    reached: number;
    notReached: number;
    unknown: number;
    stopped: number;
    pin: number;
    employees: number;
  }) => string;
  failureLine: (f: {
    step: number;
    n: number;
    employees: number;
    pin: boolean;
  }) => string;
  checkTitle: string;
  checkHint: string;
  checkNone: string;
  checkResult: Record<'pass' | 'partial' | 'fail', string>;
  checkInherited: (v: number) => string;
  checkProblem: (step: number, code: string) => string;
  problemCodes: Record<string, string>;
  phraseConflicts: (n: number) => string;
  path: string;
  run: string;
  link: string;
  linkReady: string;
  open: string;
  refresh: string;
  needBuild: string;
  errors: Record<string, string>;
}

const uk: AdminMemoCheckTexts = {
  needsReview: 'потребує перевірки',
  reasons: {
    failures: (r) =>
      `Збої на кроці ${r.step ?? '?'} у ${r.employees ?? 3}+ різних співробітників за 7 днів.`,
    pin_mismatch: (r) =>
      `Крок ${r.step ?? '?'} не знаходиться на сторінці адмінки (сторінка змінилася) у ${r.employees ?? 3}+ співробітників.`,
    goal_low: (r) =>
      `До мети дійшли ${r.reached ?? 0} з ${r.runs ?? 0} запусків за 7 днів (менше 60%).`,
  },
  reviewExit:
    'Поки що співробітникам мемо не виконується. Виправте, зберіть нову версію, прогоніть і опублікуйте.',
  stats: (s) =>
    `${s.days} дн.: запусків ${s.runs}, до мети ${s.rate}, збоїв ${s.failed}`,
  noRuns: (d) => `${d} дн.: запусків ще не було`,
  lastRun: 'Останній запуск',
  stats7Title: 'Опублікована версія, 7 днів',
  statsLine: (s) =>
    `дійшли ${s.reached}, не дійшли ${s.notReached}, невідомо ${s.unknown}; «Ні» співробітника ${s.stopped}; відбиток не зійшовся ${s.pin}; співробітників ${s.employees}`,
  failureLine: (f) =>
    `Крок ${f.step}: збоїв ${f.n} у ${f.employees} співробітників${f.pin ? ' (ціль не знайдено на сторінці)' : ''}`,
  checkTitle: 'Прогін в адмінці',
  checkHint:
    'Публікація — лише після прогону поточної версії: відкрийте посилання у своїй адмінці, перевірте сторінки кроків і завершіть прогін. Кроки API в прогоні не виконуються — перевіряються операція і права.',
  checkNone: 'Цю версію ще не проганяли.',
  checkResult: {
    pass: 'Прогін пройдено — можна публікувати.',
    partial: 'Прогін частково пройдено — можна публікувати, див. зауваження.',
    fail: 'Прогін не пройдено — версію затримано.',
  },
  checkInherited: (v) =>
    `Змінено лише назву/фрази — результат прогону версії ${v} перенесено.`,
  checkProblem: (step, code) => `Крок ${step}: ${code}`,
  problemCodes: {
    missing: 'ціль не знайдено',
    ambiguous: 'кілька однакових цілей',
    pin_mismatch: 'ціль не та (роль/текст)',
    risk_up: 'дія ризикованіша, ніж збережено',
    never: 'дія з серверним ефектом — кліком не можна',
    unchecked: 'сторінку кроку не перевірено',
    operation_missing: 'операції немає в коннекторі',
    operation_unsupported: 'операцію не підтримано',
    operation_disabled: 'операцію вимкнено',
    forbidden: 'у того, хто проганяв, немає прав на операцію',
  },
  phraseConflicts: (n) => `Фраз уже зайнято іншим мемо: ${n}.`,
  path: 'Сторінка адмінки для початку (шлях від кореня)',
  run: 'Прогнати',
  link: 'Відкрити в адмінці',
  linkReady: 'Посилання прогону (30 хв, одноразове)',
  open: 'Відкрити',
  refresh: 'Оновити результат',
  needBuild: 'Спершу зберіть версію (ворота).',
  errors: {
    MEMO_GATES: 'Спершу зберіть версію, що пройшла ворота.',
    MEMO_CHECK_REQUIRED:
      'Опублікувати можна після прогону цієї версії в адмінці («Прогнати»).',
    ADMIN_VC_MODE_REQUIRED:
      'Прогін — в адмінці зі скриптом помічника: увімкніть доступ «скрипт» і підтвердьте хост адмінки.',
    ADMIN_VC_HOST_REQUIRED: 'Потрібен підтверджений https-хост самої адмінки.',
    ADMIN_VC_INVALID: 'Шлях сторінки — від кореня, без «//» і параметрів.',
  },
};

const ru: AdminMemoCheckTexts = {
  needsReview: 'требует проверки',
  reasons: {
    failures: (r) =>
      `Сбои на шаге ${r.step ?? '?'} у ${r.employees ?? 3}+ разных сотрудников за 7 дней.`,
    pin_mismatch: (r) =>
      `Шаг ${r.step ?? '?'} не находится на странице админки (страница изменилась) у ${r.employees ?? 3}+ сотрудников.`,
    goal_low: (r) =>
      `До цели дошли ${r.reached ?? 0} из ${r.runs ?? 0} запусков за 7 дней (меньше 60%).`,
  },
  reviewExit:
    'Пока сотрудникам мемо не выполняется. Исправьте, соберите новую версию, прогоните и опубликуйте.',
  stats: (s) =>
    `${s.days} дн.: запусков ${s.runs}, до цели ${s.rate}, сбоев ${s.failed}`,
  noRuns: (d) => `${d} дн.: запусков ещё не было`,
  lastRun: 'Последний запуск',
  stats7Title: 'Опубликованная версия, 7 дней',
  statsLine: (s) =>
    `дошли ${s.reached}, не дошли ${s.notReached}, неизвестно ${s.unknown}; «Нет» сотрудника ${s.stopped}; отпечаток не сошёлся ${s.pin}; сотрудников ${s.employees}`,
  failureLine: (f) =>
    `Шаг ${f.step}: сбоев ${f.n} у ${f.employees} сотрудников${f.pin ? ' (цель не найдена на странице)' : ''}`,
  checkTitle: 'Прогон в админке',
  checkHint:
    'Публикация — только после прогона текущей версии: откройте ссылку в своей админке, проверьте страницы шагов и завершите прогон. Шаги API в прогоне не выполняются — проверяются операция и права.',
  checkNone: 'Эту версию ещё не прогоняли.',
  checkResult: {
    pass: 'Прогон пройден — можно публиковать.',
    partial: 'Прогон пройден частично — можно публиковать, см. замечания.',
    fail: 'Прогон не пройден — версия задержана.',
  },
  checkInherited: (v) =>
    `Изменено только имя/фразы — результат прогона версии ${v} перенесён.`,
  checkProblem: (step, code) => `Шаг ${step}: ${code}`,
  problemCodes: {
    missing: 'цель не найдена',
    ambiguous: 'несколько одинаковых целей',
    pin_mismatch: 'цель не та (роль/текст)',
    risk_up: 'действие рискованнее, чем сохранено',
    never: 'действие с серверным эффектом — кликом нельзя',
    unchecked: 'страница шага не проверена',
    operation_missing: 'операции нет в коннекторе',
    operation_unsupported: 'операция не поддерживается',
    operation_disabled: 'операция выключена',
    forbidden: 'у проверявшего нет прав на операцию',
  },
  phraseConflicts: (n) => `Фраз уже занято другим мемо: ${n}.`,
  path: 'Страница админки для начала (путь от корня)',
  run: 'Прогнать',
  link: 'Открыть в админке',
  linkReady: 'Ссылка прогона (30 мин, одноразовая)',
  open: 'Открыть',
  refresh: 'Обновить результат',
  needBuild: 'Сначала соберите версию (ворота).',
  errors: {
    MEMO_GATES: 'Сначала соберите версию, прошедшую ворота.',
    MEMO_CHECK_REQUIRED:
      'Опубликовать можно после прогона этой версии в админке («Прогнать»).',
    ADMIN_VC_MODE_REQUIRED:
      'Прогон — в админке со скриптом помощника: включите доступ «скрипт» и подтвердите хост админки.',
    ADMIN_VC_HOST_REQUIRED: 'Нужен подтверждённый https-хост самой админки.',
    ADMIN_VC_INVALID: 'Путь страницы — от корня, без «//» и параметров.',
  },
};

const en: AdminMemoCheckTexts = {
  needsReview: 'needs review',
  reasons: {
    failures: (r) =>
      `Failures at step ${r.step ?? '?'} for ${r.employees ?? 3}+ different employees in 7 days.`,
    pin_mismatch: (r) =>
      `Step ${r.step ?? '?'} is not found on the admin page (the page changed) for ${r.employees ?? 3}+ employees.`,
    goal_low: (r) =>
      `${r.reached ?? 0} of ${r.runs ?? 0} runs reached the goal in 7 days (below 60%).`,
  },
  reviewExit:
    'Employees cannot run the memo for now. Fix it, build a new version, run it and publish.',
  stats: (s) =>
    `${s.days} d: ${s.runs} runs, goal ${s.rate}, ${s.failed} failures`,
  noRuns: (d) => `${d} d: no runs yet`,
  lastRun: 'Last run',
  stats7Title: 'Published version, 7 days',
  statsLine: (s) =>
    `reached ${s.reached}, not reached ${s.notReached}, unknown ${s.unknown}; employee “No” ${s.stopped}; fingerprint mismatch ${s.pin}; employees ${s.employees}`,
  failureLine: (f) =>
    `Step ${f.step}: ${f.n} failures for ${f.employees} employees${f.pin ? ' (target not found on the page)' : ''}`,
  checkTitle: 'Run in the admin',
  checkHint:
    'Publishing is possible only after a run of the current version: open the link in your admin, check the pages of the steps and finish the run. API steps are not executed in a run — the operation and rights are checked.',
  checkNone: 'This version has not been run yet.',
  checkResult: {
    pass: 'Run passed — you can publish.',
    partial: 'Run partially passed — you can publish, see the notes.',
    fail: 'Run failed — the version is held.',
  },
  checkInherited: (v) =>
    `Only the name/phrases changed — the run result of version ${v} is carried over.`,
  checkProblem: (step, code) => `Step ${step}: ${code}`,
  problemCodes: {
    missing: 'target not found',
    ambiguous: 'several identical targets',
    pin_mismatch: 'wrong target (role/text)',
    risk_up: 'the action is riskier than saved',
    never: 'an action with a server effect — not by click',
    unchecked: 'the page of the step was not checked',
    operation_missing: 'the operation is not in the connector',
    operation_unsupported: 'the operation is not supported',
    operation_disabled: 'the operation is disabled',
    forbidden: 'the person who ran it has no rights for the operation',
  },
  phraseConflicts: (n) => `Phrases already taken by another memo: ${n}.`,
  path: 'Admin page to start from (path from the root)',
  run: 'Run',
  link: 'Open in the admin',
  linkReady: 'Run link (30 min, one-time)',
  open: 'Open',
  refresh: 'Refresh the result',
  needBuild: 'Build a version first (gates).',
  errors: {
    MEMO_GATES: 'Build a version that passed the gates first.',
    MEMO_CHECK_REQUIRED:
      'You can publish after running this version in the admin (“Run”).',
    ADMIN_VC_MODE_REQUIRED:
      'A run needs the assistant script in your admin: enable “script” access and verify the admin host.',
    ADMIN_VC_HOST_REQUIRED:
      'A verified https host of the admin itself is needed.',
    ADMIN_VC_INVALID:
      'The page path starts at the root, without “//” and parameters.',
  },
};

export const ADMIN_MEMO_CHECK_TEXTS: Record<Locale, AdminMemoCheckTexts> = {
  uk,
  ru,
  en,
};
