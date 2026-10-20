/**
 * Подтверждения закрытого раздела Story‑Tales (аудит 2, ST2-U-01/U-07):
 * что именно сотрётся при удалении сказки и сколько резервирует платный
 * вызов. Без React и сети — проверяется `scripts/story-confirm.test.ts`.
 *
 * Цифры берутся только из ответов сервера (смета `estimate`, резерв
 * `reservedMicroUsd`); если сервер цену не прислал, диалог прямо говорит
 * «платная операция» без суммы — цифра не выдумывается на клиенте.
 */
import ru from '../../dictionaries/ru.json';
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
  /**
   * Обязательный флажок в диалоге (ST3: согласие рассказчика на публикацию):
   * пока он не отмечен, кнопка подтверждения неактивна.
   */
  requiredCheck?: string;
};

/** Тексты подтверждений (`storyUi.confirm`); по умолчанию — русские. */
export type StoryConfirmStrings = typeof RU_CONFIRM;
const RU_CONFIRM = ru.storyUi.confirm;
const f = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{\{(\w+)\}\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m
  );

/** Удаление сказки (ST2-U-01): перечень того, что стирается без возврата. */
export function deleteGiftConfirm(
  gift: {
    title: string;
    status: string;
    hasGiftPhoto: boolean;
  },
  s: StoryConfirmStrings = RU_CONFIRM
): StoryConfirmText {
  const voiced = ['READY', 'APPROVED'].includes(gift.status);
  const items = [
    voiced ? s.deleteVoice : null,
    voiced ? s.deleteRenders : null,
    s.deleteRecordings,
    gift.hasGiftPhoto ? s.deletePhoto : null,
    s.deleteText,
  ].filter((v): v is string => v !== null);
  return {
    title: f(s.deleteTitle, { title: gift.title }),
    body: [s.deleteBody],
    items,
    note: gift.status === 'APPROVED' ? s.deleteNoteApproved : s.deleteNote,
    confirmLabel: s.deleteLabel,
    danger: true,
  };
}

function line(estimate: StoryEstimate | undefined, id: string) {
  return estimate?.lines.find((l) => l.id === id && l.status === 'included');
}

/** Подпись на кнопке: « · резерв $X» или пусто, если суммы нет. */
export function reserveSuffix(
  microUsd: number | null | undefined,
  s: StoryConfirmStrings = RU_CONFIRM
): string {
  return typeof microUsd === 'number' && microUsd > 0
    ? f(s.reserveSuffix, { usd: formatUsd(microUsd) })
    : '';
}

/** Подпись проверки, оплаченной из уже созданного резерва. */
export function includedInReserve(
  microUsd: number | null | undefined,
  s: StoryConfirmStrings = RU_CONFIRM
): string {
  return typeof microUsd === 'number' && microUsd > 0
    ? f(s.includedSuffix, { usd: formatUsd(microUsd) })
    : s.includedSuffixBare;
}

/** Озвучка Nova (ST2-U-07): резерв аудиопилота сказки — из ответа сервера. */
export function novaConfirm(
  gift: {
    reservedMicroUsd: number;
    budgetCents: number;
    estimate?: StoryEstimate;
  },
  s: StoryConfirmStrings = RU_CONFIRM
): StoryConfirmText {
  const voice = line(gift.estimate, 'voice');
  const body = [
    gift.reservedMicroUsd > 0
      ? f(s.novaReserve, {
          reserve: formatUsd(gift.reservedMicroUsd),
          budget: formatUsd(gift.budgetCents * 10_000),
          estimate: voice
            ? f(s.novaEstimate, { usd: formatUsd(voice.costMicroUsd) })
            : '',
        })
      : s.novaNoReserve,
    s.novaFixed,
  ];
  return {
    title: s.novaTitle,
    body,
    items: [],
    confirmLabel: s.novaLabel,
    danger: false,
  };
}

/**
 * ST3-U-03: подтверждение озвучки для не-владельца — только цена в
 * кредитах (абзацы `charge`, их собирает вызывающий) без резерва и бюджета
 * провайдера; бесплатная — «Запустить бесплатную сборку?».
 */
export function novaConfirmMember(
  chargeParagraphs: string[],
  free: boolean,
  freeTitle: string,
  s: StoryConfirmStrings = RU_CONFIRM
): StoryConfirmText {
  return {
    title: free ? freeTitle : s.novaTitleMember,
    body: [...chargeParagraphs, s.launchFixed],
    items: [],
    confirmLabel: s.novaLabel,
    danger: false,
  };
}

/** ST3-U-03: проверка речи для не-владельца — входит в цену, без сумм. */
export function qaConfirmMember(
  kind: 'audio' | 'video',
  s: StoryConfirmStrings = RU_CONFIRM
): StoryConfirmText {
  return {
    title: kind === 'audio' ? s.audioQaTitleMember : s.videoQaTitleMember,
    body: [kind === 'audio' ? s.qaMember : s.videoQaMember, s.qaOnce],
    items: [],
    confirmLabel: s.qaLabel,
    danger: false,
  };
}

/**
 * Проверка озвучки Soniox (ST2-U-07). Её резерв уже входит в резерв
 * аудиопилота (строка `qa` сметы), отдельного списания резерва нет.
 */
export function audioQaConfirm(
  gift: {
    reservedMicroUsd: number;
    estimate?: StoryEstimate;
  },
  s: StoryConfirmStrings = RU_CONFIRM
): StoryConfirmText {
  const qa = line(gift.estimate, 'qa');
  return {
    title: s.audioQaTitle,
    body: [
      qa
        ? f(s.audioQaEstimate, {
            usd: formatUsd(qa.costMicroUsd),
            reserve: formatUsd(gift.reservedMicroUsd),
          })
        : f(s.audioQaNoEstimate, {
            reserve:
              gift.reservedMicroUsd > 0
                ? ` ${formatUsd(gift.reservedMicroUsd)}`
                : '',
          }),
      s.qaOnce,
    ],
    items: [],
    confirmLabel: s.qaLabel,
    danger: false,
  };
}

/**
 * Проверка речи готового видео (ST2-U-07): входит в резерв этой сборки;
 * оценку Soniox по длине экспорта присылает сервер (`qaEstimateMicroUsd`).
 */
export function videoQaConfirm(
  render: {
    reservedMicroUsd: number;
    qaEstimateMicroUsd?: number | null;
  },
  s: StoryConfirmStrings = RU_CONFIRM
): StoryConfirmText {
  const estimate =
    typeof render.qaEstimateMicroUsd === 'number'
      ? f(s.videoQaEstimate, { usd: formatUsd(render.qaEstimateMicroUsd) })
      : '';
  return {
    title: s.videoQaTitle,
    body: [
      render.reservedMicroUsd > 0
        ? f(s.videoQaReserve, {
            estimate,
            reserve: formatUsd(render.reservedMicroUsd),
          })
        : f(s.videoQaNoReserve, { estimate }),
      s.qaOnce,
    ],
    items: [],
    confirmLabel: s.qaLabel,
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
export function deleteRecordingConfirm(
  recording: {
    seconds: number;
  },
  s: StoryConfirmStrings = RU_CONFIRM
): StoryConfirmText {
  return {
    title: f(s.recordingTitle, { n: recording.seconds.toFixed(1) }),
    body: [s.recordingBody],
    items: [s.recordingItemVoice, s.recordingItemVideos],
    note: s.recordingNote,
    confirmLabel: s.recordingLabel,
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
  res: RecordingDeleted | null | undefined,
  s: StoryConfirmStrings = RU_CONFIRM
): string {
  const n = typeof res?.rendersDeleted === 'number' ? res.rendersDeleted : 0;
  return [
    s.recordingDeleted,
    n > 0 ? f(s.recordingVideos, { n }) : s.recordingNoVideos,
    res?.mainNarrationKept ? s.recordingKept : null,
  ]
    .filter(Boolean)
    .join(' ');
}
