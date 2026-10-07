// Помощники страницы «Кадры лендинга поздравлений» (заход 8; порядок
// работы — doc/GREETING-FRAMES-CAPTURE.md). Чистые функции: страница
// решает по ним, спрашивать ли «платно», опрашивать ли ролик сам и как
// назвать файлы, — и эти решения проверяет greeting-frames.test.ts.
import { usd } from './money';
import type {
  GreetingFixtureVideoAction,
  GreetingFixtureVideoStage,
  GreetingFixtureVideoState,
} from './types';

/** Локали лендинга — те же, что `SUPPORTED_LOCALES` бэкенда. */
export const GREETING_FRAME_LOCALES = ['ru', 'uk', 'en', 'de', 'es'] as const;
export type GreetingFrameLocale = (typeof GREETING_FRAME_LOCALES)[number];

export const GREETING_LOCALE_LABEL: Record<GreetingFrameLocale, string> = {
  ru: 'Русский',
  uk: 'Українська',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
};

/** Кадры по порядку — `GREETING_FRAME_SHOTS` бэкенда (§5.2 п.3 ТЗ). */
export const GREETING_FRAME_CARDS: ReadonlyArray<{ card: number; label: string }> = [
  { card: 1, label: 'Повод и бриф' },
  { card: 2, label: '«Характер ролика»' },
  { card: 3, label: 'Сценарий' },
  { card: 4, label: 'Готовый ролик' },
];

/** Раз в сколько опрашивать идущий рендер — документ советует 20–30 с. */
export const FIXTURE_POLL_INTERVAL_MS = 25_000;

const POLL_ACTIONS: readonly GreetingFixtureVideoAction[] = ['poll', 'poll-post'];

export const STAGE_LABEL: Record<GreetingFixtureVideoStage, string> = {
  missing: 'ролика нет',
  started: 'рендер запущен',
  rendering: 'рендерится',
  'post-processing': 'постобработка (своя озвучка) — слушать рано',
  complete: 'готов',
  failed: 'провайдер отказал',
};

export const ACTION_LABEL: Record<GreetingFixtureVideoAction, string> = {
  none: 'ничего: ролик готов',
  poll: 'опросит идущий рендер',
  'poll-post': 'опросит постобработку',
  'script-and-render': 'соберёт сценарий настоящим конвейером и запустит рендер',
  render: 'запустит рендер по готовому сценарию',
  'new-version-render': 'заведёт новую версию сессии тем же сценарием и отрендерит её',
};

/** Тон плашки стадии — классы `badge-status-*` админки. */
export function stageTone(stage: GreetingFixtureVideoStage | undefined): 'ok' | 'warning' | 'critical' {
  if (stage === 'complete') return 'ok';
  if (stage === 'failed' || stage === 'missing') return 'critical';
  return 'warning';
}

/**
 * Можно ли нажимать «Опросить» самой странице, без человека: только если
 * СЛЕДУЮЩИЙ шаг сервера — бесплатный опрос. Всё платное — только руками
 * через подтверждение, даже если перед этим шёл опрос (рендер упал между
 * двумя опросами — следующий POST уже запустил бы его заново).
 */
export function shouldAutoPoll(state: GreetingFixtureVideoState | null): boolean {
  const next = state?.next;
  return !!next && !next.paid && POLL_ACTIONS.includes(next.action);
}

/**
 * «платно, ~$X» — по журналу расходов (прошлый прогон с рендером); журнал
 * не знает — без числа, но с тем, ЗА ЧТО платим.
 */
export function costText(state: GreetingFixtureVideoState | null): string {
  const last = state?.lastRun;
  if (!last || last.costMicroUsd <= 0) {
    return 'платно: сценарий (Gemini) и рендер ролика (Grok) — сумму прошлого прогона журнал расходов не знает';
  }
  return `платно, ~${usd(last.costMicroUsd)} — столько стоил прошлый прогон${
    last.unpriced ? ' (часть вызовов без ставки в прайсе — на деле дороже)' : ''
  }`;
}

/**
 * Шаг, который страница ожидает от сервера (`expect` в POST): тот, что
 * она только что прочла и, если он платный, подтвердила. `null` — шага
 * нет (переснимать нечего). Сервер, решив иначе и платно, ответит 409.
 */
export function expectedAction(
  state: GreetingFixtureVideoState | null,
  rerender: boolean,
): GreetingFixtureVideoAction | null {
  const step = rerender ? state?.rerender : state?.next;
  return step?.action ?? null;
}

/** Текст подтверждения платного шага; `null` — шаг бесплатный, спрашивать нечего. */
export function paidConfirmText(
  state: GreetingFixtureVideoState | null,
  rerender: boolean,
): string | null {
  const step = rerender ? state?.rerender : state?.next;
  if (!step?.paid) return null;
  const lead = rerender
    ? 'Переснять готовый ролик фикстуры? Прежний останется в старой версии сессии.'
    : 'Запустить ролик фикстуры?';
  return `${lead}\n\nСервер ${ACTION_LABEL[step.action]}.\n\nЭто ${costText(state)}. Повторное нажатие на идущем рендере не платит.`;
}

/** Имя файла кадра — то же, что у итоговой картинки лендинга (`greet-shot-<locale>-<n>`). */
export function frameFileName(locale: string, card: number): string {
  return `greet-shot-${locale}-${card}.png`;
}

/** Команда обработки скачанных PNG (сама обработка — не здесь). */
export function processCommand(locale: string): string {
  const files = GREETING_FRAME_CARDS.map((c) => frameFileName(locale, c.card)).join(' ');
  return `node scripts/tutorial-frames-process.mjs --greeting ${locale} ${files}`;
}

/** Номера кадров, которых нет в ответе съёмки. */
export function missingCards(cards: Record<string, string> | undefined): number[] {
  return GREETING_FRAME_CARDS.map((c) => c.card).filter((n) => !cards?.[String(n)]);
}

/** Адрес Vercel Blob «скачать файлом» (`?download=1`) — запасной путь, когда fetch не дали. */
export function blobDownloadUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('download', '1');
    return u.toString();
  } catch {
    return url;
  }
}

/** Последняя съёмка локали — запоминается в браузере оператора. */
export interface StoredLocaleFrames {
  at: string;
  cards: Record<string, string>;
  problems: string[];
}

export const FRAMES_STORAGE_KEY = 'v4c-admin-greeting-frames';

/**
 * Разбор запомненных съёмок: только известные локали, номера 1–4 и
 * https-адреса. Мусор (старый формат, ручная правка) — отброшен, а не
 * показан ссылкой «скачать» на что попало.
 */
export function parseStoredFrames(raw: string | null): Partial<Record<GreetingFrameLocale, StoredLocaleFrames>> {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<GreetingFrameLocale, StoredLocaleFrames>> = {};
  for (const locale of GREETING_FRAME_LOCALES) {
    const entry = (value as Record<string, unknown>)[locale];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { at?: unknown; cards?: unknown; problems?: unknown };
    if (typeof e.at !== 'string' || !e.cards || typeof e.cards !== 'object') continue;
    const cards: Record<string, string> = {};
    for (const { card } of GREETING_FRAME_CARDS) {
      const url = (e.cards as Record<string, unknown>)[String(card)];
      if (typeof url === 'string' && /^https:\/\//.test(url)) cards[String(card)] = url;
    }
    const problems = Array.isArray(e.problems)
      ? e.problems.filter((p): p is string => typeof p === 'string')
      : [];
    out[locale] = { at: e.at, cards, problems };
  }
  return out;
}

/**
 * Предупреждение перед съёмкой: кадр 4 снимается с готового ролика, и до
 * `complete` в плеере окажется пустота или ролик без своей озвучки.
 */
export function frame4Warning(state: GreetingFixtureVideoState | null): string | null {
  if (!state || state.skipped) return 'Состояние ролика фикстуры неизвестно — кадр 4 может выйти пустым.';
  if (state.stage === 'complete') {
    return state.video?.postError
      ? 'Постобработка ролика упала — в кадре 4 будет ролик без своей озвучки; лучше переснять ролик.'
      : null;
  }
  return 'Ролик фикстуры ещё не готов (шаг 1) — кадр 4 выйдет пустым или без своей озвучки.';
}
