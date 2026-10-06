/**
 * tutorial-theme-rotation.ts — светлая и тёмная темы ролика обучалки как
 * ОТДЕЛЬНЫЕ ролики одной пары (TODO II «Актуальное демо трёх лендингов и
 * TMA», заход 3, 06.10.2026).
 *
 * ## Что такое «пара» после этого захода
 *
 * Пара — это (subjectKey, locale, theme). Сценарий (`TutorialScenario`)
 * по-прежнему один на (subjectKey, locale): шаги от темы не зависят, и
 * снимать тёмный ролик по другому сценарию значило бы держать два
 * расходящихся набора шагов. Тема — свойство ПРОГОНА: один и тот же
 * сценарий проигрывается то в светлой, то в тёмной теме, и каждый
 * прогон даёт ролик своей темы. Отпечаток кадров, счёт провалов,
 * подметальщик и одобрение считаются по паре с темой: тёмный ролик не
 * вытесняет светлый и не сличается с ним.
 *
 * ## Бюджет тика не растёт
 *
 * Тик берёт столько же СЦЕНАРИЕВ, сколько и раньше (`RUN_BATCH_LIMIT`), и
 * каждый — РОВНО ОДИН раз, в одной теме: в той, что дольше не снималась
 * (`planThemedRuns`). Две темы означают, что круг по всем парам вдвое
 * длиннее, а не что тик вдвое дороже.
 *
 * ## Где живёт «когда снималась тема»
 *
 * У `TutorialScenario` есть только `lastRunAt/lastRunStatus/lastRunError`
 * — один прогон, без темы. Схему не меняем (решение захода): по-темные
 * отметки лежат в настройке-карте `tutorial.scenarioThemeRuns` —
 * тот же приём, что у карты одобрений `tutorial.videoApprovedAt`
 * (`tutorial-video-retention.ts`). Колонки сценария при этом
 * по-прежнему пишутся — как «последний прогон любой темы» для витрины
 * сценариев в админке.
 *
 * Прежние прогоны все были светлыми (`SCENARIO_THEME = 'light'` до этого
 * захода), поэтому у сценария без отметки светлой темы светлая берёт
 * колонки строки — иначе после выката светлые прогоны выглядели бы «ни
 * разу не исполнявшимися» и встали бы в очередь вперёд тёмных.
 *
 * Чистые функции, без Prisma и настроек — правило проверяется без
 * моков базы.
 */
import { createHash } from 'node:crypto';

/** Порядок — порядок предпочтения при равной давности (светлая —
 *  прежнее умолчание, её ролики уже одобрены). */
export const SCENARIO_THEMES = ['light', 'dark'] as const;
export type ScenarioTheme = (typeof SCENARIO_THEMES)[number];

export function isScenarioTheme(raw: unknown): raw is ScenarioTheme {
  return (
    typeof raw === 'string' &&
    (SCENARIO_THEMES as readonly string[]).includes(raw)
  );
}

/** Настройка-карта по-темных отметок прогонов. */
export const THEME_RUNS_SETTING_KEY = 'tutorial.scenarioThemeRuns';

/** Отметки старше этого выпадают при записи: сценарий, который месяц не
 *  исполнялся (локаль снята из списка, сценарий удалён), снова встанет
 *  первым — это безопасная сторона. */
const THEME_RUNS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Текст ошибки в карте — обрезанный: нужен для сличения «та же
 *  причина», а не для чтения. Сличаются обрезанные с обрезанными. */
export const THEME_RUN_ERROR_LIMIT = 500;

export interface ThemeRunRecord {
  /** ISO-время прогона. */
  at: string;
  status: 'ok' | 'failed';
  error: string | null;
  /** Отпечаток шагов, на которых прошёл прогон (`stepsSha`). Другой
   *  отпечаток — шаги переписаны, ждать интервала повтора не надо. */
  stepsSha: string;
}

/** scenarioId → тема → отметка. */
export type ThemeRuns = Map<
  string,
  Partial<Record<ScenarioTheme, ThemeRunRecord>>
>;

export function clipRunError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.length > THEME_RUN_ERROR_LIMIT
    ? error.slice(0, THEME_RUN_ERROR_LIMIT)
    : error;
}

/** Короткий отпечаток шагов сценария. */
export function stepsSha(steps: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(steps ?? null))
    .digest('hex')
    .slice(0, 16);
}

/** Терпимый разбор: мусор — пустая карта, а не исключение. */
export function parseThemeRuns(raw: string | null | undefined): ThemeRuns {
  const out: ThemeRuns = new Map();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return out;
  }
  for (const [id, byTheme] of Object.entries(parsed)) {
    if (!byTheme || typeof byTheme !== 'object' || Array.isArray(byTheme)) {
      continue;
    }
    const entry: Partial<Record<ScenarioTheme, ThemeRunRecord>> = {};
    for (const theme of SCENARIO_THEMES) {
      const r = (byTheme as Record<string, unknown>)[theme];
      if (!r || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec.at !== 'string' || !Number.isFinite(Date.parse(rec.at))) {
        continue;
      }
      if (rec.status !== 'ok' && rec.status !== 'failed') continue;
      entry[theme] = {
        at: rec.at,
        status: rec.status,
        error: typeof rec.error === 'string' ? rec.error : null,
        stepsSha: typeof rec.stepsSha === 'string' ? rec.stepsSha : '',
      };
    }
    if (Object.keys(entry).length > 0) out.set(id, entry);
  }
  return out;
}

/**
 * Записать отметку прогона (в памяти).
 *
 * `scenario` — строка сценария В ТОМ ВИДЕ, в каком её прочли ДО прогона.
 * Нужна ради одного случая: у сценария ещё нет отметки светлой темы, а
 * пишется тёмная. Колонки строки после этого прогона станут тёмными, и
 * запасной путь `themeRunState` («светлая без отметки — из колонок»)
 * прочёл бы тёмный прогон как светлый. Поэтому светлая отметка
 * засевается из колонок, пока они ещё её.
 */
export function recordThemeRun(
  runs: ThemeRuns,
  scenario: RotationScenario,
  theme: ScenarioTheme,
  record: ThemeRunRecord,
): void {
  const entry = runs.get(scenario.id) ?? {};
  if (
    theme !== 'light' &&
    !entry.light &&
    scenario.lastRunAt &&
    (scenario.lastRunStatus === 'ok' || scenario.lastRunStatus === 'failed')
  ) {
    entry.light = {
      at: scenario.lastRunAt.toISOString(),
      status: scenario.lastRunStatus,
      error: clipRunError(scenario.lastRunError),
      // Шаги того прогона неизвестны: пустой отпечаток читается как
      // «нет отпечатка», и «те же шаги» держится признаком строки.
      stepsSha: '',
    };
  }
  entry[theme] = { ...record, error: clipRunError(record.error) };
  runs.set(scenario.id, entry);
}

/** Карта строкой для настройки — без отметок старше месяца. */
export function serializeThemeRuns(runs: ThemeRuns, now: number): string {
  const out: Record<
    string,
    Partial<Record<ScenarioTheme, ThemeRunRecord>>
  > = {};
  for (const [id, byTheme] of runs) {
    const kept: Partial<Record<ScenarioTheme, ThemeRunRecord>> = {};
    for (const theme of SCENARIO_THEMES) {
      const r = byTheme[theme];
      if (r && now - Date.parse(r.at) <= THEME_RUNS_KEEP_MS) kept[theme] = r;
    }
    if (Object.keys(kept).length > 0) out[id] = kept;
  }
  return JSON.stringify(out);
}

/** Что известно о прошлом прогоне темы — из карты или, для светлой без
 *  отметки, из колонок строки сценария (см. шапку файла). */
export interface ThemeRunState {
  at: number | null;
  status: string | null;
  error: string | null;
  /** `null` — отпечатка шагов нет (прогон до карты): «те же шаги»
   *  держится тогда признаком `lastRunStatus`, как до захода. */
  stepsSha: string | null;
}

export interface RotationScenario {
  id: string;
  steps: unknown;
  createdAt?: Date | null;
  lastRunAt?: Date | null;
  lastRunStatus?: string | null;
  lastRunError?: string | null;
}

export function themeRunState(
  scenario: RotationScenario,
  theme: ScenarioTheme,
  runs: ThemeRuns,
): ThemeRunState {
  const rec = runs.get(scenario.id)?.[theme];
  if (rec) {
    return {
      at: Date.parse(rec.at),
      status: rec.status,
      error: rec.error,
      stepsSha: rec.stepsSha || null,
    };
  }
  if (theme === 'light') {
    return {
      at: scenario.lastRunAt ? scenario.lastRunAt.getTime() : null,
      status: scenario.lastRunStatus ?? null,
      error: clipRunError(scenario.lastRunError),
      stepsSha: null,
    };
  }
  return { at: null, status: null, error: null, stepsSha: null };
}

/**
 * Нужен ли прогон теме сейчас — то же правило, что раньше стояло в
 * выборке `tutorial-scenario-run` («прошедший на тех же шагах — не чаще
 * `okRerunMs`»), только по теме.
 *
 * «Те же шаги»: оба места, переписывающие шаги, стирают
 * `lastRunStatus` у строки — это признак для ВСЕХ тем; а у отметки с
 * отпечатком шагов признак ещё и прямой — отпечаток разошёлся.
 */
export function themeRunDue(
  scenario: RotationScenario,
  state: ThemeRunState,
  sha: string,
  now: number,
  okRerunMs: number,
): boolean {
  if (scenario.lastRunStatus == null) return true;
  if (state.at === null || state.status !== 'ok') return true;
  if (state.stepsSha !== null && state.stepsSha !== sha) return true;
  return state.at < now - okRerunMs;
}

export interface ThemedRun<S extends RotationScenario> {
  scenario: S;
  theme: ScenarioTheme;
  /** Чем эта тема упала в прошлый раз — для «та же поломка». */
  lastError: string | null;
  stepsSha: string;
}

/**
 * Очередь тика: по одному прогону на сценарий, в теме, которая дольше
 * не снималась, — и сценарии по давности ЭТОЙ темы (ни разу не
 * снимавшиеся — первыми), затем по `createdAt`. Сценарий, у которого ни
 * одной теме прогон не нужен, в очередь не попадает.
 *
 * Вход — в порядке базы (`lastRunAt asc nulls first, createdAt asc`);
 * сортировка устойчивая, так что при равной давности порядок базы
 * сохраняется.
 */
export function planThemedRuns<S extends RotationScenario>(
  scenarios: readonly S[],
  runs: ThemeRuns,
  now: number,
  okRerunMs: number,
  limit: number,
): ThemedRun<S>[] {
  const planned: Array<ThemedRun<S> & { at: number | null; order: number }> =
    [];
  scenarios.forEach((scenario, order) => {
    const sha = stepsSha(scenario.steps);
    let best: { theme: ScenarioTheme; state: ThemeRunState } | null = null;
    for (const theme of SCENARIO_THEMES) {
      const state = themeRunState(scenario, theme, runs);
      if (!themeRunDue(scenario, state, sha, now, okRerunMs)) continue;
      if (!best || olderThan(state.at, best.state.at)) {
        best = { theme, state };
      }
    }
    if (!best) return;
    planned.push({
      scenario,
      theme: best.theme,
      lastError: best.state.error,
      stepsSha: sha,
      at: best.state.at,
      order,
    });
  });
  planned.sort((a, b) => {
    if (a.at !== b.at) {
      if (a.at === null) return -1;
      if (b.at === null) return 1;
      return a.at - b.at;
    }
    return a.order - b.order;
  });
  return planned
    .slice(0, limit)
    .map(({ scenario, theme, lastError, stepsSha: sha }) => ({
      scenario,
      theme,
      lastError,
      stepsSha: sha,
    }));
}

/** `a` давнее `b` (никогда — давнее всего). При равенстве — нет: тогда
 *  остаётся тема, найденная раньше (`SCENARIO_THEMES`). */
function olderThan(a: number | null, b: number | null): boolean {
  if (a === b) return false;
  if (a === null) return true;
  if (b === null) return false;
  return a < b;
}

/**
 * Условие Prisma «ролик этой темы». Светлая включает строки без темы:
 * всё, что снималось до тем, снималось светлым (`SCENARIO_THEME` до
 * захода; миграция пометила `light` только собранные — провалы и
 * незавершённые остались без темы).
 */
export function assetThemeWhere(theme: ScenarioTheme): Record<string, unknown> {
  return theme === 'light'
    ? { OR: [{ theme: 'light' }, { theme: null }] }
    : { theme };
}

/** Тема строки ролика для группировки: без темы — светлая (см. выше). */
export function assetTheme(raw: string | null | undefined): ScenarioTheme {
  return raw === 'dark' ? 'dark' : 'light';
}

/**
 * Параметры темы Telegram WebApp для съёмки «как внутри Telegram».
 *
 * Значения — палитры клиентов Telegram по умолчанию (дневная и ночная).
 * Фронтенду важен только `bg_color`: SDK (`telegram-web-app.js`) выводит
 * из его яркости `WebApp.colorScheme`, а `applyTheme()` во фронтенде
 * следует `colorScheme`, когда явного выбора темы человеком нет. Остальные
 * ключи — чтобы `themeParams` выглядели так, как их отдаёт настоящий
 * клиент, а не одним полем.
 */
export const TELEGRAM_THEME_PARAMS: Record<
  ScenarioTheme,
  Readonly<Record<string, string>>
> = {
  light: {
    bg_color: '#ffffff',
    secondary_bg_color: '#f1f1f1',
    text_color: '#000000',
    hint_color: '#999999',
    link_color: '#2481cc',
    button_color: '#2481cc',
    button_text_color: '#ffffff',
    header_bg_color: '#ffffff',
  },
  dark: {
    bg_color: '#17212b',
    secondary_bg_color: '#232e3c',
    text_color: '#f5f5f5',
    hint_color: '#708499',
    link_color: '#6ab3f3',
    button_color: '#5288c1',
    button_text_color: '#ffffff',
    header_bg_color: '#17212b',
  },
};

/** Ключи `sessionStorage`, из которых SDK Telegram берёт параметры
 *  запуска и тему при загрузке страницы (`__telegram__` + имя). */
export const TELEGRAM_SDK_INIT_PARAMS_KEY = '__telegram__initParams';
export const TELEGRAM_SDK_THEME_PARAMS_KEY = '__telegram__themeParams';

/** Чем на деле оказалась нарисована тема кадров. */
export type CaptureThemeVia =
  /** SDK Telegram загрузился и отдал `colorScheme` нужной темы, класс
   *  `dark` на `<html>` ей соответствует — путь «как в Telegram». */
  | 'telegram'
  /** SDK не отдал нужной темы (не загрузился), но фронтенд нарисовал её
   *  по `prefers-color-scheme` — запасной путь браузера. */
  | 'media-query'
  /** Нарисована НЕ та тема — ролик собирать нельзя. */
  | 'mismatch';

export interface CaptureThemeProbe {
  /** Класс `dark` на `<html>`. */
  dark: boolean;
  /** `window.Telegram.WebApp.colorScheme`, если SDK есть. */
  tgColorScheme: string | null;
  /** `window.Telegram.WebApp.themeParams.bg_color`, если есть. */
  tgBgColor: string | null;
}

/** Разбор замера темы. `null` на входе — замер не удался: решения нет. */
export function captureThemeVia(
  wanted: ScenarioTheme,
  probe: CaptureThemeProbe | null,
): CaptureThemeVia | null {
  if (!probe) return null;
  if (probe.dark !== (wanted === 'dark')) return 'mismatch';
  return probe.tgColorScheme === wanted && probe.tgBgColor
    ? 'telegram'
    : 'media-query';
}
