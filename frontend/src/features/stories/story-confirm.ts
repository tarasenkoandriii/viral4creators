/**
 * Подтверждения закрытого раздела Story‑Tales (аудит 2, ST2-U-01/U-07):
 * что именно сотрётся при удалении сказки и сколько резервирует платный
 * вызов. Без React и сети — проверяется `scripts/story-confirm.test.ts`.
 *
 * Цифры берутся только из ответов сервера (смета `estimate`, резерв
 * `reservedMicroUsd`); если сервер цену не прислал, диалог прямо говорит
 * «платная операция» без суммы — цифра не выдумывается на клиенте.
 */
import { formatUsd, type StoryEstimate } from './story-wizard';

export type StoryConfirmText = {
  title: string;
  /** Абзацы тела диалога. */
  body: string[];
  /** Пункты списка «что сотрётся» (пусто — списка нет). */
  items: string[];
  /** Абзац после списка (необязательно). */
  note?: string;
  confirmLabel: string;
  danger: boolean;
};

/** Удаление сказки (ST2-U-01): перечень того, что стирается без возврата. */
export function deleteGiftConfirm(gift: {
  title: string;
  status: string;
  hasGiftPhoto: boolean;
}): StoryConfirmText {
  const voiced = ['READY', 'APPROVED'].includes(gift.status);
  const items = [
    voiced
      ? 'озвучка (MP3) и результат её проверки — новая озвучка оплачивается заново;'
      : null,
    voiced
      ? 'все сборки видео этого подарка с отдельными дорожками и субтитрами;'
      : null,
    'ваши записи вступления и озвученные сегменты этого подарка;',
    gift.hasGiftPhoto ? 'фото подарка и его описание;' : null,
    'текст выпуска, повод и реплика о подарке.',
  ].filter((v): v is string => v !== null);
  return {
    title: `Удалить сказку «${gift.title}» и всё её медиа?`,
    body: ['Будут стёрты без возможности восстановления:'],
    items,
    note:
      gift.status === 'APPROVED'
        ? 'Выпуск уже одобрен. Уже потраченное на озвучку и сборки не возвращается; восстановить выпуск нельзя — только создать и оплатить заново.'
        : 'Уже потраченное на озвучку и сборки не возвращается.',
    confirmLabel: 'Удалить сказку и медиа',
    danger: true,
  };
}

function line(estimate: StoryEstimate | undefined, id: string) {
  return estimate?.lines.find((l) => l.id === id && l.status === 'included');
}

/** Подпись на кнопке: « · резерв $X» или пусто, если суммы нет. */
export function reserveSuffix(microUsd: number | null | undefined): string {
  return typeof microUsd === 'number' && microUsd > 0
    ? ` · резерв ${formatUsd(microUsd)}`
    : '';
}

/** Подпись проверки, оплаченной из уже созданного резерва. */
export function includedInReserve(microUsd: number | null | undefined): string {
  return typeof microUsd === 'number' && microUsd > 0
    ? ` · входит в резерв ${formatUsd(microUsd)}`
    : ' · входит в резерв';
}

/** Озвучка Nova (ST2-U-07): резерв аудиопилота сказки — из ответа сервера. */
export function novaConfirm(gift: {
  reservedMicroUsd: number;
  budgetCents: number;
  estimate?: StoryEstimate;
}): StoryConfirmText {
  const voice = line(gift.estimate, 'voice');
  const body = [
    gift.reservedMicroUsd > 0
      ? `Платная операция: синтез голосом Nova (Resemble) с одной проверкой речи. Резерв ${formatUsd(gift.reservedMicroUsd)} из бюджета ${formatUsd(gift.budgetCents * 10_000)}${voice ? `, оценка синтеза ≈ ${formatUsd(voice.costMicroUsd)}` : ''}.`
      : 'Платная операция: синтез голосом Nova (Resemble). Сумма резерва не пришла с сервера — обновите статус, если хотите увидеть её до запуска.',
    'Текст и фото фиксируются при запуске. Повторная озвучка автоматически не запускается — повтор той же кнопки не оплачивается второй раз.',
  ];
  return {
    title: 'Озвучить сказку голосом Nova?',
    body,
    items: [],
    confirmLabel: 'Озвучить',
    danger: false,
  };
}

/**
 * Проверка озвучки Soniox (ST2-U-07). Её резерв уже входит в резерв
 * аудиопилота (строка `qa` сметы), отдельного списания резерва нет.
 */
export function audioQaConfirm(gift: {
  reservedMicroUsd: number;
  estimate?: StoryEstimate;
}): StoryConfirmText {
  const qa = line(gift.estimate, 'qa');
  return {
    title: 'Проверить озвучку через Soniox?',
    body: [
      qa
        ? `Платная операция: распознавание речи Soniox, оценка ≈ ${formatUsd(qa.costMicroUsd)}. Она уже входит в резерв выпуска ${formatUsd(gift.reservedMicroUsd)} — новый резерв не создаётся.`
        : `Платная операция: распознавание речи Soniox. Она входит в резерв выпуска${gift.reservedMicroUsd > 0 ? ` ${formatUsd(gift.reservedMicroUsd)}` : ''}; точной оценки в ответе сервера нет.`,
      'Проверка запускается один раз; автоматического повтора нет.',
    ],
    items: [],
    confirmLabel: 'Проверить',
    danger: false,
  };
}

/**
 * Проверка речи готового видео (ST2-U-07): входит в резерв этой сборки;
 * оценку Soniox по длине экспорта присылает сервер (`qaEstimateMicroUsd`).
 */
export function videoQaConfirm(render: {
  reservedMicroUsd: number;
  qaEstimateMicroUsd?: number | null;
}): StoryConfirmText {
  const estimate =
    typeof render.qaEstimateMicroUsd === 'number'
      ? `, оценка ≈ ${formatUsd(render.qaEstimateMicroUsd)}`
      : '';
  return {
    title: 'Проверить речь готового видео через Soniox?',
    body: [
      render.reservedMicroUsd > 0
        ? `Платная операция: распознавание речи Soniox по итоговому MP4${estimate}. Она входит в резерв этой сборки ${formatUsd(render.reservedMicroUsd)} — новый резерв не создаётся.`
        : `Платная операция: распознавание речи Soniox по итоговому MP4${estimate}.`,
      'Проверка запускается один раз; автоматического повтора нет.',
    ],
    items: [],
    confirmLabel: 'Проверить',
    danger: false,
  };
}

/** Цена разбора от сервера (`GET …/references/quota` → `analysis`). */
export type StoryAnalysisPrice = {
  estimateMicroUsd: number | null;
  reserveMicroUsd: number | null;
  maxSeconds: number;
} | null;

/** Подпись кнопки разбора: «· до $X» по цене сервера, иначе «· платно». */
export function analyzeButtonSuffix(
  analysis: StoryAnalysisPrice | undefined
): string {
  const top = analysis?.reserveMicroUsd ?? analysis?.estimateMicroUsd;
  return typeof top === 'number' ? ` · до ${formatUsd(top)}` : ' · платно';
}

/**
 * Разбор референса Gemini (ST2-U-07). Цена — оценка сервера для ролика
 * максимальной длины (5 мин); имя модели не показывается. Если у модели
 * нет ставки (суммы null) — «платная операция» без суммы.
 */
export function analyzeConfirm(opts: {
  retry: boolean;
  quota: { remaining: number; limit: number } | null;
  analysis?: StoryAnalysisPrice;
}): StoryConfirmText {
  const quotaLine = opts.quota
    ? `Сегодня осталось ${opts.quota.remaining} из ${opts.quota.limit} платных разборов (UTC).`
    : 'Не больше трёх платных разборов в сутки UTC.';
  const a = opts.analysis;
  const minutes = Math.round((a?.maxSeconds ?? 300) / 60);
  const price =
    a && typeof a.estimateMicroUsd === 'number'
      ? `Оценка для ролика до ${minutes} мин: до ${formatUsd(a.reserveMicroUsd ?? a.estimateMicroUsd)} — оплачивается отдельно от бюджета подарка.`
      : 'Сумма разбора сервером не сообщается — она оплачивается отдельно от бюджета подарка.';
  return {
    title: opts.retry
      ? 'Повторить разбор — новый платный вызов?'
      : 'Запустить разбор ролика?',
    body: opts.retry
      ? [
          `Платная операция: ролик заново отправится модели Gemini, прежний неподтверждённый результат будет заменён. ${price}`,
          quotaLine,
        ]
      : [
          `Платная операция: ролик отправится модели Gemini. ${price} Если эта ссылка уже разобрана, вернётся прежний результат без оплаты.`,
          quotaLine,
        ],
    items: [],
    confirmLabel: opts.retry ? 'Повторить разбор' : 'Разобрать',
    danger: false,
  };
}

/**
 * Удаление записи вступления. Сервер стирает запись и её сегменты, сборки
 * с ней становятся FAILED (видео недоступно), а уже оплаченная основная
 * речь сохраняется и переиспользуется без новой оплаты — ответ
 * `{ deleted, rendersDeleted, segmentsErased, mainNarrationKept }`. Пока
 * сборка с записью идёт или ждёт оператора — 409 `STORY_RECORDING_IN_USE`
 * (текст сервера показывается как есть).
 */
export function deleteRecordingConfirm(recording: {
  seconds: number;
}): StoryConfirmText {
  return {
    title: `Удалить запись вступления (${recording.seconds.toFixed(1)} с)?`,
    body: ['Без возможности восстановления:'],
    items: [
      'запись вашего голоса и озвученные с ней сегменты будут стёрты;',
      'версии видео, собранные с этой записью, станут недоступны — новую сборку придётся заказать заново.',
    ],
    note: 'Уже оплаченная основная речь сказки сохраняется и переиспользуется в новой сборке без новой оплаты. Пока сборка с этой записью идёт или ждёт проверки оператора, удалить запись нельзя.',
    confirmLabel: 'Удалить запись',
    danger: true,
  };
}
export type RecordingDeleted = {
  deleted?: boolean;
  rendersDeleted?: number;
  segmentsErased?: number;
  mainNarrationKept?: boolean;
};
export function recordingDeletedNotice(
  res: RecordingDeleted | null | undefined
): string {
  const n = typeof res?.rendersDeleted === 'number' ? res.rendersDeleted : 0;
  return [
    'Запись удалена.',
    n > 0
      ? `Видео с ней стали недоступны: ${n}.`
      : 'Собранных с ней видео не было.',
    res?.mainNarrationKept
      ? 'Основная речь сохранена — новая сборка переиспользует её без новой оплаты.'
      : null,
  ]
    .filter(Boolean)
    .join(' ');
}
