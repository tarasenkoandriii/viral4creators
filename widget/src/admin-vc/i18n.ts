/**
 * Тексты голосового управления «Админкой» в iframe `wa.` (Э6-бис (б)) —
 * uk/ru/en. Ключи `vc*` — те же, что читает контроллер плана «Сайта»
 * (`chat/ui-plan.ts`, переиспользуется как есть), но формулировки — для
 * сотрудника; остальное — микрофон, согласие на сессию, карточка с
 * перечнем полей, мастер проверки. Сверка ключей трёх языков —
 * scripts/admin.test.ts.
 */
import type { Dict } from '../chat/i18n';

type VcKeys =
  | 'vcPlan'
  | 'vcDone'
  | 'vcStopped'
  | 'vcSelf'
  | 'vcInterrupted'
  | 'vcExpired'
  | 'vcFailed'
  | 'vcNoSnapshot'
  | 'vcNothing'
  | 'vcRevoked'
  | 'vcPnrTail'
  | 'vcDoneList'
  | 'vcKept'
  | 'vcFieldBack'
  | 'vcFieldUnknown'
  | 'vcFieldsGone'
  | 'vcManualUndo'
  | 'vcUnknownPnr'
  | 'vcAfterPnr'
  | 'vcUndoNothing'
  | 'vcUndoExpired'
  | 'vcUndoUnknown'
  | 'vcUndoSelf'
  | 'vcMemoDone'
  | 'vcMemoNotReached'
  | 'vcSkills'
  | 'vcStep'
  | 'vcWhy';

export interface VcTexts extends Pick<Dict, VcKeys> {
  mic: string;
  micStop: string;
  micDenied: string;
  micBusy: string;
  consent: string;
  consentYes: string;
  no: string;
  yes: string;
  stop: string;
  thinking: string;
  running: string;
  confirm: string;
  pnrCard: string;
  fields: string;
  offer: string;
  offerUndo: string;
  offerKeep: string;
  apiMissing: string;
  vtTitle: string;
  vtExpired: string;
  vtWork: string;
  vtTest: string;
  vtCheck: string;
  vtEnv: string;
  vtMarkup: string;
  vtForbidden: string;
  vtSuspicious: string;
  vtDeny: string;
  vtSafe: string;
  vtDry: string;
  vtDryOk: string;
  vtDryBad: string;
  /** Итог сухого прогона команды после отметки каждого шага. */
  vtDryOf: string;
  vtSafeRun: string;
  vtReport: string;
  vtResult: Record<'pass' | 'partial' | 'fail', string>;
  vtAttempts: string;
  /** Прогон мемо «Админки» (аудит 06.10). */
  mcTitle: string;
  mcHint: string;
  mcPage: string;
  mcNone: string;
  mcFinish: string;
  mcResult: Record<'pass' | 'partial' | 'fail', string>;
}

const uk: VcTexts = {
  vcPlan: 'Зроблю: {steps}',
  vcDone: 'Готово.',
  vcStopped: 'Зупинено.',
  vcSelf: 'Не вийшло — натисніть самі: «{t}».',
  vcInterrupted:
    'Сторінка оновилася під час кроку «{t}» — повторювати не буду: перевірте результат.',
  vcExpired: 'Пропозиція застаріла — повторіть команду.',
  vcFailed: 'Не вдалося виконати команду — спробуйте ще раз або зробіть самі.',
  vcNoSnapshot: 'Не вдалося прочитати сторінку — зробіть самі.',
  vcNothing: 'Не знайшов, що натиснути на цій сторінці.',
  vcRevoked: 'Добре: без нового дозволу не натискатиму.',
  vcPnrTail: '(після цього скасувати не можна)',
  vcDoneList: 'Уже зроблено: {list}.',
  vcKept: 'Добре, залишаю як є.',
  vcFieldBack: 'Повернув попереднє значення поля «{t}».',
  vcFieldUnknown: 'Не знаю, чи повернулося поле «{t}» — перевірте.',
  vcFieldsGone: 'Поля на попередній сторінці повернути не можу.',
  vcManualUndo: 'Приберіть самі: «{t}» — серверну дію помічник не повертає.',
  vcUnknownPnr: 'Не знаю, чи збереглося — перевірте сторінку.',
  vcAfterPnr: 'Уже збережено — повернути кліками не можу.',
  vcUndoNothing: 'Повертати нічого.',
  vcUndoExpired: 'Минуло більше 10 хвилин — зробіть це самі.',
  vcUndoUnknown: 'Не знаю, що саме спрацювало, — перевірте сторінку.',
  vcUndoSelf: 'Зараз помічник лише підказує — поверніть самі.',
  vcMemoDone: 'Готово: {g}.',
  vcMemoNotReached: 'Не дійшов до мети «{g}» — перевірте сторінку.',
  vcSkills: 'Я вмію: {list}.',
  vcStep: {
    click: 'натисну «{t}»',
    fill: 'введу «{v}» у «{t}»',
    select: 'виберу «{v}» у «{t}»',
    check: 'відмічу «{t}»',
    scroll: 'прокручу до «{t}»',
    highlight: 'покажу «{t}»',
    navigate: 'відкрию «{t}»',
    wait: 'зачекаю',
    say: '{t}',
  },
  vcWhy: {
    no_target: 'не знайшов елемент',
    bad_kind: 'такого не вмію',
    denied: '«{t}» — власник заборонив',
    danger: '«{t}» — видалення, скасування й повернення кліками не роблю',
    payment: '«{t}» — оплату не роблю',
    sensitive_field: 'паролі й картки не заповнюю',
    value_not_said: 'введу лише те, що ви сказали',
    offhost: '«{t}» — інший сайт, натисніть самі',
    gesture: '«{t}» — потрібен ваш власний клік',
    degraded: '«{t}» — натисніть самі',
    limit: 'за раз — не більше кількох кроків',
    disabled: '«{t}» зараз недоступна',
    second_pnr: '«{t}» — окремою командою після збереження',
    pin_mismatch: '«{t}» — кнопка змінилася, натисніть самі',
  },
  mic: 'Сказати команду',
  micStop: 'Закінчити',
  micDenied: 'Мікрофон недоступний — наберіть команду текстом.',
  micBusy: 'Слухаю…',
  consent:
    'Помічник може натискати кнопки цієї адмінки за вас до кінця сесії — дозволити? Кожен крок видно, «Стоп» — завжди. Видалення, скасування й повернення кліками — ніколи.',
  consentYes: 'Дозволити',
  no: 'Ні',
  yes: 'Так',
  stop: 'Стоп',
  thinking: 'Дивлюся на сторінку…',
  running: 'Помічник виконує — можна зупинити',
  confirm: 'Підтвердіть — помічник зробить:',
  pnrCard: 'Зараз збережу — після цього скасувати кліками не можна. Так?',
  fields: 'Зміняться поля:',
  offer: 'Повернути поля як було?',
  offerUndo: 'Повернути',
  offerKeep: 'Залишити',
  apiMissing:
    'Такої операції в API немає, а кліками це не роблю — зробіть самі.',
  vtTitle: 'Перевірка голосового керування',
  vtExpired: 'Посилання перевірки недійсне — візьміть нове в кабінеті.',
  vtWork: 'Робочий хост: збереження лише підсвічується, відправки вимкнено.',
  vtTest: 'Тестовий хост: можна перевірити й збереження.',
  vtCheck: 'Перевірити сторінку',
  vtEnv: 'Оточення: CSP {csp}, Trusted Types {tt}, чанки {chunks}.',
  vtMarkup: 'Розмітка: елементів {total}, з data-assist-id {withId}.',
  vtForbidden: 'Заборони: {n} перевірок, пропущено {leak}.',
  vtSuspicious: 'Схоже на небезпечне — позначте:',
  vtDeny: 'Заборонити',
  vtSafe: 'Безпечно',
  vtDry: 'Сухий прогін',
  vtDryOk: 'Вірно',
  vtDryBad: 'Не те',
  vtDryOf: 'Вірно {ok} з {n} кроків',
  vtSafeRun: 'Виконати',
  vtReport: 'Сформувати звіт',
  vtResult: {
    pass: 'Перевірку пройдено.',
    partial: 'Частково: див. зауваження в кабінеті.',
    fail: 'Не пройдено — увімкнути не можна.',
  },
  vtAttempts: 'Спроб по заборонених цілях: {n}.',
  mcTitle: 'Прогін мемо АМ-{n} «{name}»',
  mcHint:
    'Відкрийте сторінки кроків і перевірте кожну. Нічого не натискається, кроки API не виконуються.',
  mcPage: '{path}: кроків {n}, проблем {bad}.',
  mcNone: 'кроків мемо не знайдено.',
  mcFinish: 'Завершити прогін',
  mcResult: {
    pass: 'Прогін пройдено — опублікуйте мемо в кабінеті.',
    partial: 'Частково (див. кабінет) — опублікувати можна.',
    fail: 'Не пройдено — виправте мемо в кабінеті.',
  },
};

const ru: VcTexts = {
  vcPlan: 'Сделаю: {steps}',
  vcDone: 'Готово.',
  vcStopped: 'Остановлено.',
  vcSelf: 'Не получилось — нажмите сами: «{t}».',
  vcInterrupted:
    'Страница обновилась во время шага «{t}» — повторять не буду: проверьте результат.',
  vcExpired: 'Предложение устарело — повторите команду.',
  vcFailed:
    'Не удалось выполнить команду — попробуйте ещё раз или сделайте сами.',
  vcNoSnapshot: 'Не удалось прочитать страницу — сделайте сами.',
  vcNothing: 'Не нашёл, что нажать на этой странице.',
  vcRevoked: 'Хорошо: без нового разрешения нажимать не буду.',
  vcPnrTail: '(после этого отменить нельзя)',
  vcDoneList: 'Уже сделано: {list}.',
  vcKept: 'Хорошо, оставляю как есть.',
  vcFieldBack: 'Вернул прежнее значение поля «{t}».',
  vcFieldUnknown: 'Не знаю, вернулось ли поле «{t}» — проверьте.',
  vcFieldsGone: 'Поля на прежней странице вернуть не могу.',
  vcManualUndo:
    'Уберите сами: «{t}» — серверное действие помощник не возвращает.',
  vcUnknownPnr: 'Не знаю, сохранилось ли — проверьте страницу.',
  vcAfterPnr: 'Уже сохранено — вернуть кликами не могу.',
  vcUndoNothing: 'Возвращать нечего.',
  vcUndoExpired: 'Прошло больше 10 минут — сделайте это сами.',
  vcUndoUnknown: 'Не знаю, что именно сработало, — проверьте страницу.',
  vcUndoSelf: 'Сейчас помощник только подсказывает — верните сами.',
  vcMemoDone: 'Готово: {g}.',
  vcMemoNotReached: 'Не дошёл до цели «{g}» — проверьте страницу.',
  vcSkills: 'Я умею: {list}.',
  vcStep: {
    click: 'нажму «{t}»',
    fill: 'введу «{v}» в «{t}»',
    select: 'выберу «{v}» в «{t}»',
    check: 'отмечу «{t}»',
    scroll: 'прокручу к «{t}»',
    highlight: 'покажу «{t}»',
    navigate: 'открою «{t}»',
    wait: 'подожду',
    say: '{t}',
  },
  vcWhy: {
    no_target: 'не нашёл элемент',
    bad_kind: 'такого не умею',
    denied: '«{t}» — владелец запретил',
    danger: '«{t}» — удаление, отмену и возврат кликами не делаю',
    payment: '«{t}» — оплату не делаю',
    sensitive_field: 'пароли и карты не заполняю',
    value_not_said: 'введу только то, что вы сказали',
    offhost: '«{t}» — другой сайт, нажмите сами',
    gesture: '«{t}» — нужен ваш собственный клик',
    degraded: '«{t}» — нажмите сами',
    limit: 'за раз — не больше нескольких шагов',
    disabled: '«{t}» сейчас недоступна',
    second_pnr: '«{t}» — отдельной командой после сохранения',
    pin_mismatch: '«{t}» — кнопка изменилась, нажмите сами',
  },
  mic: 'Сказать команду',
  micStop: 'Закончить',
  micDenied: 'Микрофон недоступен — наберите команду текстом.',
  micBusy: 'Слушаю…',
  consent:
    'Помощник может нажимать кнопки этой админки за вас до конца сессии — разрешить? Каждый шаг виден, «Стоп» — всегда. Удаление, отмену и возврат кликами — никогда.',
  consentYes: 'Разрешить',
  no: 'Нет',
  yes: 'Да',
  stop: 'Стоп',
  thinking: 'Смотрю на страницу…',
  running: 'Помощник выполняет — можно остановить',
  confirm: 'Подтвердите — помощник сделает:',
  pnrCard: 'Сейчас сохраню — после этого отменить кликами нельзя. Да?',
  fields: 'Изменятся поля:',
  offer: 'Вернуть поля как было?',
  offerUndo: 'Вернуть',
  offerKeep: 'Оставить',
  apiMissing:
    'Такой операции в API нет, а кликами это не делаю — сделайте сами.',
  vtTitle: 'Проверка голосового управления',
  vtExpired: 'Ссылка проверки недействительна — возьмите новую в кабинете.',
  vtWork: 'Рабочий хост: сохранение только подсвечивается, отправки выключены.',
  vtTest: 'Тестовый хост: можно проверить и сохранение.',
  vtCheck: 'Проверить страницу',
  vtEnv: 'Окружение: CSP {csp}, Trusted Types {tt}, чанки {chunks}.',
  vtMarkup: 'Разметка: элементов {total}, с data-assist-id {withId}.',
  vtForbidden: 'Запреты: {n} проверок, пропущено {leak}.',
  vtSuspicious: 'Похоже на опасное — отметьте:',
  vtDeny: 'Запретить',
  vtSafe: 'Безопасно',
  vtDry: 'Сухой прогон',
  vtDryOk: 'Верно',
  vtDryBad: 'Не то',
  vtDryOf: 'Верно {ok} из {n} шагов',
  vtSafeRun: 'Выполнить',
  vtReport: 'Сформировать отчёт',
  vtResult: {
    pass: 'Проверка пройдена.',
    partial: 'Частично: см. замечания в кабинете.',
    fail: 'Не пройдено — включить нельзя.',
  },
  vtAttempts: 'Попыток по запрещённым целям: {n}.',
  mcTitle: 'Прогон мемо АМ-{n} «{name}»',
  mcHint:
    'Откройте страницы шагов и проверьте каждую. Ничего не нажимается, шаги API не выполняются.',
  mcPage: '{path}: шагов {n}, проблем {bad}.',
  mcNone: 'шагов мемо не найдено.',
  mcFinish: 'Завершить прогон',
  mcResult: {
    pass: 'Прогон пройден — опубликуйте мемо в кабинете.',
    partial: 'Частично (см. кабинет) — опубликовать можно.',
    fail: 'Не пройден — исправьте мемо в кабинете.',
  },
};

const en: VcTexts = {
  vcPlan: 'I will: {steps}',
  vcDone: 'Done.',
  vcStopped: 'Stopped.',
  vcSelf: "Didn't work — please press it yourself: “{t}”.",
  vcInterrupted:
    'The page reloaded during “{t}” — I won’t repeat it: please check the result.',
  vcExpired: 'The suggestion has expired — please repeat the command.',
  vcFailed: "Couldn't complete the command — try again or do it yourself.",
  vcNoSnapshot: "Couldn't read the page — please do it yourself.",
  vcNothing: 'Found nothing to press on this page.',
  vcRevoked: "OK: I won't click without a new permission.",
  vcPnrTail: '(this cannot be undone)',
  vcDoneList: 'Already done: {list}.',
  vcKept: 'Okay, leaving everything as it is.',
  vcFieldBack: 'Restored the previous value of “{t}”.',
  vcFieldUnknown: 'Not sure whether “{t}” was restored — please check.',
  vcFieldsGone: 'I cannot restore fields on the previous page.',
  vcManualUndo:
    'Please remove it yourself: “{t}” — the assistant does not reverse server actions.',
  vcUnknownPnr: 'Not sure whether it was saved — please check the page.',
  vcAfterPnr: 'Already saved — I cannot put it back with clicks.',
  vcUndoNothing: 'Nothing to put back.',
  vcUndoExpired: 'More than 10 minutes have passed — please do it yourself.',
  vcUndoUnknown: 'Not sure what exactly happened — please check the page.',
  vcUndoSelf: 'The assistant is only giving hints now — please do it yourself.',
  vcMemoDone: 'Done: {g}.',
  vcMemoNotReached: 'Did not reach the goal “{g}” — please check the page.',
  vcSkills: 'I can: {list}.',
  vcStep: {
    click: 'press “{t}”',
    fill: 'type “{v}” into “{t}”',
    select: 'choose “{v}” in “{t}”',
    check: 'tick “{t}”',
    scroll: 'scroll to “{t}”',
    highlight: 'show “{t}”',
    navigate: 'open “{t}”',
    wait: 'wait',
    say: '{t}',
  },
  vcWhy: {
    no_target: "couldn't find the element",
    bad_kind: "can't do that",
    denied: '“{t}” — disabled by the owner',
    danger: "“{t}” — I don't delete, cancel or refund with clicks",
    payment: "“{t}” — I don't make payments",
    sensitive_field: "I don't fill in passwords or cards",
    value_not_said: 'I only type what you said',
    offhost: '“{t}” — another site, please press it yourself',
    gesture: '“{t}” — needs your own click',
    degraded: '“{t}” — please press it yourself',
    limit: 'only a few steps at a time',
    disabled: '“{t}” is unavailable right now',
    second_pnr: '“{t}” — as a separate command after saving',
    pin_mismatch: '“{t}” — the button has changed, please press it yourself',
  },
  mic: 'Say a command',
  micStop: 'Finish',
  micDenied: 'Microphone unavailable — type the command instead.',
  micBusy: 'Listening…',
  consent:
    'The assistant can press buttons in this admin panel for you until the session ends — allow it? Every step is visible, “Stop” always works. Deleting, cancelling and refunds by clicks — never.',
  consentYes: 'Allow',
  no: 'No',
  yes: 'Yes',
  stop: 'Stop',
  thinking: 'Looking at the page…',
  running: 'The assistant is working — you can stop it',
  confirm: 'Please confirm — the assistant will:',
  pnrCard: 'I am about to save — this cannot be undone with clicks. Proceed?',
  fields: 'Fields to change:',
  offer: 'Put the fields back as they were?',
  offerUndo: 'Put back',
  offerKeep: 'Keep',
  apiMissing:
    "There is no such API operation, and I don't do this with clicks — please do it yourself.",
  vtTitle: 'Voice control check',
  vtExpired:
    'The check link is no longer valid — get a new one in the dashboard.',
  vtWork: 'Production host: saving is only highlighted, submissions are off.',
  vtTest: 'Test host: saving can be checked too.',
  vtCheck: 'Check the page',
  vtEnv: 'Environment: CSP {csp}, Trusted Types {tt}, chunks {chunks}.',
  vtMarkup: 'Markup: {total} elements, {withId} with data-assist-id.',
  vtForbidden: 'Restrictions: {n} probes, {leak} leaked.',
  vtSuspicious: 'Looks dangerous — please mark:',
  vtDeny: 'Forbid',
  vtSafe: 'Safe',
  vtDry: 'Dry run',
  vtDryOk: 'Correct',
  vtDryBad: 'Wrong',
  vtDryOf: '{ok} of {n} steps correct',
  vtSafeRun: 'Run',
  vtReport: 'Build the report',
  vtResult: {
    pass: 'Check passed.',
    partial: 'Partially: see the notes in the dashboard.',
    fail: 'Not passed — it cannot be enabled.',
  },
  vtAttempts: 'Attempts on forbidden targets: {n}.',
  mcTitle: 'Memo run AM-{n} «{name}»',
  mcHint:
    'Open the pages of the steps and check each one. Nothing is clicked, API steps are not executed.',
  mcPage: '{path}: {n} steps, {bad} problems.',
  mcNone: 'no memo steps found.',
  mcFinish: 'Finish the run',
  mcResult: {
    pass: 'Run passed — publish the memo in the dashboard.',
    partial: 'Partially (see the dashboard) — it can be published.',
    fail: 'Not passed — fix the memo in the dashboard.',
  },
};

export const VC_TEXTS: Record<'uk' | 'ru' | 'en', VcTexts> = { uk, ru, en };
