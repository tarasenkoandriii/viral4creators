import {
  assetTheme,
  assetThemeWhere,
  captureThemeVia,
  parseThemeRuns,
  planThemedRuns,
  recordThemeRun,
  serializeThemeRuns,
  stepsSha,
  TELEGRAM_THEME_PARAMS,
  ThemeRuns,
  themeRunState,
} from './tutorial-theme-rotation';

const H = 3600_000;
const OK_RERUN = 20 * H;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H);

function scenario(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    steps: [{ kind: 'goto', route: 'generate' }],
    lastRunAt: null as Date | null,
    lastRunStatus: null as string | null,
    lastRunError: null as string | null,
    ...over,
  };
}

function runs(
  map: Record<
    string,
    Record<
      string,
      { hoursAgo: number; status?: string; error?: string | null; sha?: string }
    >
  >,
  steps: unknown = [{ kind: 'goto', route: 'generate' }],
): ThemeRuns {
  const raw: Record<string, Record<string, unknown>> = {};
  for (const [id, byTheme] of Object.entries(map)) {
    raw[id] = {};
    for (const [theme, r] of Object.entries(byTheme)) {
      raw[id][theme] = {
        at: at(r.hoursAgo).toISOString(),
        status: r.status ?? 'ok',
        error: r.error ?? null,
        stepsSha: r.sha ?? stepsSha(steps),
      };
    }
  }
  return parseThemeRuns(JSON.stringify(raw));
}

const plan = (rows: ReturnType<typeof scenario>[], r: ThemeRuns, limit = 30) =>
  planThemedRuns(rows, r, NOW, OK_RERUN, limit).map(
    (p) => `${p.scenario.id}/${p.theme}`,
  );

describe('planThemedRuns', () => {
  it('ни разу не снимавшийся сценарий — светлая первой (порядок тем при равной давности)', () => {
    expect(plan([scenario('a')], new Map())).toEqual(['a/light']);
  });

  it('светлая из колонок строки, тёмной не было — тёмная', () => {
    expect(
      plan(
        [scenario('a', { lastRunAt: at(1), lastRunStatus: 'ok' })],
        new Map(),
      ),
    ).toEqual(['a/dark']);
  });

  it('обе темы свежие и ok на тех же шагах — сценарий не берётся', () => {
    const rows = [scenario('a', { lastRunAt: at(1), lastRunStatus: 'ok' })];
    expect(
      plan(
        rows,
        runs({ a: { light: { hoursAgo: 1 }, dark: { hoursAgo: 2 } } }),
      ),
    ).toEqual([]);
  });

  it('свежая, но упавшая тема — берётся без ожидания', () => {
    const rows = [scenario('a', { lastRunAt: at(1), lastRunStatus: 'ok' })];
    expect(
      plan(
        rows,
        runs({
          a: {
            light: { hoursAgo: 1 },
            dark: { hoursAgo: 2, status: 'failed' },
          },
        }),
      ),
    ).toEqual(['a/dark']);
  });

  it('шаги переписаны: другой отпечаток или стёртый lastRunStatus — берётся', () => {
    const fresh = { light: { hoursAgo: 1 }, dark: { hoursAgo: 2 } };
    expect(
      plan(
        [scenario('a', { lastRunAt: at(1), lastRunStatus: 'ok', steps: [] })],
        runs({ a: fresh }),
      ),
    ).toEqual(['a/dark']);
    expect(
      plan(
        [scenario('a', { lastRunAt: at(1), lastRunStatus: null })],
        runs({ a: fresh }),
      ),
    ).toEqual(['a/dark']);
  });

  it('старше 20 ч — берётся, и из двух тем — давняя', () => {
    const rows = [scenario('a', { lastRunAt: at(21), lastRunStatus: 'ok' })];
    expect(
      plan(
        rows,
        runs({ a: { light: { hoursAgo: 25 }, dark: { hoursAgo: 21 } } }),
      ),
    ).toEqual(['a/light']);
  });

  it('очередь — по давности ВЫБРАННОЙ темы, не по колонке строки', () => {
    const rows = [
      scenario('a', { lastRunAt: at(21), lastRunStatus: 'ok' }),
      scenario('b', { lastRunAt: at(22), lastRunStatus: 'ok' }),
      scenario('c', { lastRunAt: at(23), lastRunStatus: 'ok' }),
    ];
    expect(
      plan(
        rows,
        runs({
          a: { light: { hoursAgo: 21 }, dark: { hoursAgo: 48 } },
          b: { light: { hoursAgo: 22 } },
          c: { light: { hoursAgo: 23 }, dark: { hoursAgo: 30 } },
        }),
      ),
    ).toEqual(['b/dark', 'a/dark', 'c/dark']);
  });

  it('потолок — число СЦЕНАРИЕВ тика, по одной теме на каждый', () => {
    const rows = Array.from({ length: 5 }, (_, i) => scenario(`s${i}`));
    const out = plan(rows, new Map(), 3);
    expect(out).toEqual(['s0/light', 's1/light', 's2/light']);
  });

  it('прошлая ошибка — у выбранной темы', () => {
    const rows = [
      scenario('a', {
        lastRunAt: at(1),
        lastRunStatus: 'failed',
        lastRunError: 'светлая',
      }),
    ];
    const r = runs({
      a: { dark: { hoursAgo: 30, status: 'failed', error: 'тёмная' } },
    });
    const [p] = planThemedRuns(rows, r, NOW, OK_RERUN, 30);
    expect(p.theme).toBe('dark');
    expect(p.lastError).toBe('тёмная');
  });
});

describe('карта по-темных отметок', () => {
  it('мусор — пустая карта, а не исключение', () => {
    for (const raw of [
      null,
      '',
      'нет',
      '[1]',
      '{"a":5}',
      '{"a":{"dark":{"at":"x","status":"ok"}}}',
    ]) {
      expect(parseThemeRuns(raw).size).toBe(0);
    }
  });

  it('запись и чтение — круг; старше месяца выпадает при записи', () => {
    const r: ThemeRuns = new Map();
    recordThemeRun(r, scenario('a'), 'light', {
      at: at(1).toISOString(),
      status: 'ok',
      error: null,
      stepsSha: 'x',
    });
    recordThemeRun(r, scenario('b'), 'light', {
      at: at(31 * 24).toISOString(),
      status: 'ok',
      error: null,
      stepsSha: 'x',
    });
    const back = parseThemeRuns(serializeThemeRuns(r, NOW));
    expect([...back.keys()]).toEqual(['a']);
    expect(back.get('a')!.light!.stepsSha).toBe('x');
  });

  it('тёмная отметка засевает светлую из колонок строки — только если светлой нет', () => {
    const row = scenario('a', {
      lastRunAt: at(5),
      lastRunStatus: 'failed',
      lastRunError: 'x'.repeat(900),
    });
    const r: ThemeRuns = new Map();
    recordThemeRun(r, row, 'dark', {
      at: at(0).toISOString(),
      status: 'ok',
      error: null,
      stepsSha: 's',
    });
    expect(r.get('a')!.light).toEqual({
      at: at(5).toISOString(),
      status: 'failed',
      error: 'x'.repeat(500),
      stepsSha: '',
    });
    // Засеянная светлая читается без отпечатка: «те же шаги» — по строке.
    expect(themeRunState(row, 'light', r).stepsSha).toBeNull();
    // Есть светлая — не трогается.
    recordThemeRun(r, { ...row, lastRunAt: at(0) }, 'dark', {
      at: at(0).toISOString(),
      status: 'ok',
      error: null,
      stepsSha: 's',
    });
    expect(r.get('a')!.light!.at).toBe(at(5).toISOString());
    // Светлую сам светлый прогон не засевает поверх себя.
    const r2: ThemeRuns = new Map();
    recordThemeRun(r2, row, 'light', {
      at: at(0).toISOString(),
      status: 'ok',
      error: null,
      stepsSha: 's',
    });
    expect(r2.get('a')!.light!.status).toBe('ok');
    expect(r2.get('a')!.dark).toBeUndefined();
  });
});

describe('тема строки ролика', () => {
  it('светлая включает строки без темы, тёмная — только тёмные', () => {
    expect(assetThemeWhere('light')).toEqual({
      OR: [{ theme: 'light' }, { theme: null }],
    });
    expect(assetThemeWhere('dark')).toEqual({ theme: 'dark' });
    expect(assetTheme(null)).toBe('light');
    expect(assetTheme('dark')).toBe('dark');
    expect(assetTheme('мусор')).toBe('light');
  });
});

describe('captureThemeVia', () => {
  it('замера нет — решения нет', () => {
    expect(captureThemeVia('dark', null)).toBeNull();
  });
  it('нарисована не та тема — mismatch, в обе стороны', () => {
    expect(
      captureThemeVia('dark', {
        dark: false,
        tgColorScheme: 'dark',
        tgBgColor: '#17212b',
      }),
    ).toBe('mismatch');
    expect(
      captureThemeVia('light', {
        dark: true,
        tgColorScheme: null,
        tgBgColor: null,
      }),
    ).toBe('mismatch');
  });
  it('SDK отдал нужную тему с параметрами — telegram; иначе media-query', () => {
    expect(
      captureThemeVia('dark', {
        dark: true,
        tgColorScheme: 'dark',
        tgBgColor: '#17212b',
      }),
    ).toBe('telegram');
    expect(
      captureThemeVia('dark', {
        dark: true,
        tgColorScheme: 'dark',
        tgBgColor: null,
      }),
    ).toBe('media-query');
    expect(
      captureThemeVia('dark', {
        dark: true,
        tgColorScheme: 'light',
        tgBgColor: '#fff',
      }),
    ).toBe('media-query');
  });
  it('параметры Telegram: тёмный фон тёмный, светлый — светлый', () => {
    // SDK выводит colorScheme из яркости bg_color — перепутанные
    // палитры дали бы «тёмный» ролик в светлой теме.
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    };
    expect(luminance(TELEGRAM_THEME_PARAMS.dark.bg_color)).toBeLessThan(120);
    expect(luminance(TELEGRAM_THEME_PARAMS.light.bg_color)).toBeGreaterThan(
      120,
    );
  });
});
