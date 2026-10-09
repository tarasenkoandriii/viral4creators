/**
 * №29, Р-З10-19: Т-3 по расписанию — «автотест» голосового управления
 * (§5-бис.12, §5-бис.14 п.5) без человека и без кликов. Монитор Т-4
 * (`voice-monitor.service.ts`) раз в сутки на сайт ставит сверку
 * опубликованной голосовой карты и контрольных команд браузерным воркером
 * (источник очереди `voice-autotest`, вид `descriptor-resolve` — тот же
 * код, что «Звірка» карты); отчёт — строка `assist_site_voice_tests` вида
 * `autotest` (в TMA — рядом с отчётами мастера; годность для `on` он НЕ
 * даёт: её считает только отчёт мастера).
 *
 * Чистый модуль: порт к очереди воркера (его реализует
 * `assist-site-voice-map` — правило графа `browser-jobs-zone` пускает к
 * очереди только его) и разбор итога в отчёт.
 */
import { maskLabel } from '../../assist-ui-core/snapshot';
import type { UiSnapshot } from '../../assist-ui-core/types';
import {
  findInSnapshot,
  type VoiceMapDescriptor,
} from '../../assist-ui-core/voice-map';

export const AUTOTEST_KIND = 'autotest';
/** Срок «служебного» токена строки отчёта (входа по нему нет). */
export const AUTOTEST_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * Аудит P3 (5): при стойком провале тревога владельцу — не чаще раза в
 * этот срок (инцидент пишется каждый раз, с `notified = 0`).
 */
export const AUTOTEST_ALERT_PAUSE_MS = 7 * 24 * 60 * 60_000;
/** Аудит P3 (5): строки автотеста старше — удаляются (по одной в сутки). */
export const AUTOTEST_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Сколько отчётов автотеста показывать рядом с отчётами мастера. */
export const AUTOTEST_LIST_MAX = 5;

/** Почему Т-3 сайта не поставлен. */
export type AutotestSkip =
  | 'worker_disabled'
  | 'no_port'
  | 'no_host'
  | 'nothing_to_check'
  | 'limit'
  | 'error';

export interface AutotestEnqueue {
  accountId: string;
  siteId: string;
  /** id строки отчёта (`assist_site_voice_tests.id`) — связь с заданием. */
  testId: string;
  /** Страницы контрольных команд (пути). */
  paths: string[];
}

export type AutotestTicket =
  | { jobId: string; host: string; origin: string; version: number | null }
  | { skipped: AutotestSkip };

/** Итог сверки воркером (разобран стороной карты). */
export interface AutotestOutcome {
  pages: Array<{ path: string; ok: boolean; error: string | null }>;
  snapshots: Array<{ path: string; snapshot: UiSnapshot }>;
  /** Сверка опубликованной карты (`WorkerCheckReport`); null — карты нет. */
  map: {
    version: number;
    targets: Array<{ key: string; lost: boolean; stability: string }>;
    lost: number;
    fragile: number;
  } | null;
}

export interface VoiceAutotestPort {
  enqueue(i: AutotestEnqueue): Promise<AutotestTicket>;
}

export interface ControlCommandRow {
  id: string;
  pagePath: string;
  expected: unknown;
  /** Заход 11: фраза команды (уже маскирована при записи) — для TMA. */
  utteranceMasked?: string | null;
}

/** Заход 11: длина фразы команды в отчёте (TMA показывает её владельцу). */
export const AUTOTEST_COMMAND_TEXT_MAX = 120;

/** Управляющие и bidi-символы (как CONTROL в assist-ui-core/snapshot.ts). */
// eslint-disable-next-line no-control-regex
const CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Аудит з11 P2-1: фраза команды в отчёте — ВТОРОЙ слой маски, как у
 * подписей «Снимка» (`maskLabel`: e-mail, телефоны, ключи, длинные цифры —
 * в т.ч. карта с двойными пробелами), без управляющих символов, затем
 * обрезка ≤ 120 с «…» — не посреди метки маски `[…]` и суррогатной пары.
 */
export function autotestCommandText(raw: string | null | undefined): string {
  const s = maskLabel((raw ?? '').replace(CONTROL, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= AUTOTEST_COMMAND_TEXT_MAX) return s;
  let cut = s.slice(0, AUTOTEST_COMMAND_TEXT_MAX - 1);
  const open = cut.lastIndexOf('[');
  if (open > cut.lastIndexOf(']')) cut = cut.slice(0, open);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export interface AutotestCommandResult {
  id: string;
  path: string;
  /**
   * Заход 11: фраза контрольной команды (маскированная, ≤ 120) — id строк
   * команд пересоздаются, поэтому подпись хранится в самом отчёте; в
   * отчётах до захода 11 поля нет.
   */
  text: string;
  /** found — цель первого шага однозначно нашлась; lost — нет; unchecked — страница не открылась. */
  status: 'found' | 'lost' | 'unchecked';
}

/**
 * Отчёт автотеста — форма, которую TMA уже читает как отчёт мастера
 * (`page`, `result`, пустые списки), плюс подробности в `autotest`.
 */
export interface AutotestReport {
  v: 1;
  kind: 'autotest';
  page: string;
  result: 'pass' | 'partial' | 'fail' | null;
  items: [];
  never: [];
  denySuggestions: [];
  forbidden: [];
  fragment: '';
  markup: { total: number; withId: number; unnamed: [] };
  autotest: {
    version: number | null;
    pages: AutotestOutcome['pages'];
    lostTargets: string[];
    /** Заход 11 (аудит P3-8): всего потерянных целей (список — ≤ 60). */
    lostTargetsTotal: number;
    fragileTargets: number;
    commands: AutotestCommandResult[];
    checked: number;
    lost: number;
    error: string | null;
  };
}

/** Цель первого шага команды (без кликов разрешима только она). */
function firstDescriptor(expected: unknown): VoiceMapDescriptor | null {
  if (!Array.isArray(expected) || !expected.length) return null;
  const d = expected[0] as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return null;
  const str = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.slice(0, 200) : null;
  const text = str(d.text);
  const assistId = str(d.assistId);
  if (!text && !assistId) return null;
  const role = str(d.role);
  return {
    tag: role === 'link' ? 'a' : 'button',
    role,
    text: text ?? '',
    assistId,
    hrefPath: null,
    hrefHost: null,
    heading: null,
  } as unknown as VoiceMapDescriptor;
}

/** Порог «провала»: потеряна половина проверенного и больше. */
export const AUTOTEST_FAIL_SHARE = 0.5;

export function autotestReport(
  commands: readonly ControlCommandRow[],
  outcome: AutotestOutcome,
): { report: AutotestReport; commands: AutotestCommandResult[] } {
  const snaps = new Map(outcome.snapshots.map((s) => [s.path, s.snapshot]));
  const results: AutotestCommandResult[] = [];
  for (const c of commands) {
    const d = firstDescriptor(c.expected);
    const snap = snaps.get(c.pagePath);
    const text = autotestCommandText(c.utteranceMasked);
    if (!d || !snap) {
      results.push({ id: c.id, path: c.pagePath, text, status: 'unchecked' });
      continue;
    }
    results.push({
      id: c.id,
      path: c.pagePath,
      text,
      status: findInSnapshot(d, snap.elements) ? 'found' : 'lost',
    });
  }
  const lostTargets = (outcome.map?.targets ?? [])
    .filter((t) => t.lost)
    .map((t) => t.key);
  const checkedCommands = results.filter((r) => r.status !== 'unchecked');
  const checked = (outcome.map?.targets.length ?? 0) + checkedCommands.length;
  const lost =
    lostTargets.length +
    checkedCommands.filter((r) => r.status === 'lost').length;
  const anyPage = outcome.pages.some((p) => p.ok);
  const result: AutotestReport['result'] =
    !anyPage || checked === 0
      ? null
      : lost === 0
        ? 'pass'
        : lost / checked >= AUTOTEST_FAIL_SHARE
          ? 'fail'
          : 'partial';
  return {
    commands: results,
    report: {
      v: 1,
      kind: 'autotest',
      page: outcome.pages[0]?.path ?? '/',
      result,
      items: [],
      never: [],
      denySuggestions: [],
      forbidden: [],
      fragment: '',
      markup: { total: 0, withId: 0, unnamed: [] },
      autotest: {
        version: outcome.map?.version ?? null,
        pages: outcome.pages,
        lostTargets: lostTargets.slice(0, 60),
        lostTargetsTotal: lostTargets.length,
        fragileTargets: outcome.map?.fragile ?? 0,
        commands: results.slice(0, 40),
        checked,
        lost,
        error: !anyPage
          ? 'pages_failed'
          : checked === 0
            ? 'nothing_checked'
            : null,
      },
    },
  };
}

/** Отчёт об отказе воркера (сайт не виноват — результата нет). */
export function autotestFailedReport(code: string): AutotestReport {
  return {
    v: 1,
    kind: 'autotest',
    page: '/',
    result: null,
    items: [],
    never: [],
    denySuggestions: [],
    forbidden: [],
    fragment: '',
    markup: { total: 0, withId: 0, unnamed: [] },
    autotest: {
      version: null,
      pages: [],
      lostTargets: [],
      lostTargetsTotal: 0,
      fragileTargets: 0,
      commands: [],
      checked: 0,
      lost: 0,
      error: /^[a-z_]{1,40}$/.test(code) ? code : 'internal',
    },
  };
}
