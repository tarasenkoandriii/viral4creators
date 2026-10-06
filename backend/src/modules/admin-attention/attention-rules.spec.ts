import {
  assemblyStuckItems,
  AttentionItem,
  buildView,
  clientDraftItems,
  compareItems,
  CronJobInput,
  cronItems,
  DAY_MS,
  demoMatrixItems,
  DemoCellInput,
  HOUR_MS,
  makeItem,
  moderationItems,
  onlySkipItems,
  pairLabel,
  QUALITY_CARDS_CAP,
  QualityCheckRow,
  qualityItems,
  scrubText,
  snapshotChangedItems,
  snapshotErrorItems,
  tempoApprovalItems,
  tutorialReviewItems,
} from './attention-rules';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const LOCK_MS = 11 * 60_000;

function job(over: Partial<CronJobInput> = {}): CronJobInput {
  return {
    jobKey: 'tutorial-scenario-run',
    expected: 15,
    scheduledRunsInWindow: 15,
    missed: 0,
    expectedSinceJob: ago(DAY_MS),
    byStatus: { RUNNING: 0, SUCCESS: 15, FAILED: 0 },
    lastSuccessAt: ago(HOUR_MS),
    lastFailureAt: null,
    stuckRunning: 0,
    recentFailures: [],
    ...over,
  };
}

function item(over: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    severity: 'info',
    kind: 'demo-missing',
    title: 't',
    reason: 'r',
    since: NOW.toISOString(),
    ageMs: 0,
    owner: 'operator',
    href: '/',
    ...over,
  };
}

describe('scrubText', () => {
  it('вырезает почту, ссылки, длинные числа, телефоны и токены', () => {
    const out = scrubText(
      'user 123456789 a.b@mail.ru https://blob.vercel.com/x?sig=1 +380 (67) 123-45-67 token=abc Bearer xyz',
    );
    expect(out).not.toMatch(/123456789/);
    expect(out).not.toMatch(/mail\.ru/);
    expect(out).not.toMatch(/blob\.vercel/);
    expect(out).not.toMatch(/123-45-67/);
    expect(out).not.toMatch(/abc/);
    expect(out).not.toMatch(/xyz/);
    expect(out).toContain('[почта]');
    expect(out).toContain('[ссылка]');
    expect(out).toContain('[номер]');
  });

  it('не трогает обычные числа и даты, обрезает длину', () => {
    expect(scrubText('шаг 3 упал 2026-10-06, 600000 мс')).toBe(
      'шаг 3 упал 2026-10-06, 600000 мс',
    );
    expect(scrubText('x'.repeat(500), 10)).toBe(`${'x'.repeat(10)}…`);
    expect(scrubText(null)).toBeNull();
    expect(scrubText('   ')).toBeNull();
  });
});

describe('makeItem / compareItems / buildView', () => {
  it('возраст считается от since и не бывает отрицательным', () => {
    const a = makeItem(
      {
        id: 'a',
        severity: 'info',
        kind: 'demo-missing',
        title: '',
        reason: '',
        owner: 'operator',
        href: '/',
      },
      ago(3 * HOUR_MS),
      NOW,
    );
    expect(a.ageMs).toBe(3 * HOUR_MS);
    expect(a.since).toBe(ago(3 * HOUR_MS).toISOString());
    expect('count' in a).toBe(false);
    const undef = makeItem(
      {
        id: 'u',
        severity: 'info',
        kind: 'cron-missed',
        title: '',
        reason: '',
        owner: 'system',
        href: '/',
        count: undefined,
      },
      NOW,
      NOW,
    );
    expect(Object.keys(undef)).not.toContain('count');
    const future = makeItem(
      {
        id: 'b',
        severity: 'info',
        kind: 'demo-missing',
        title: '',
        reason: '',
        owner: 'operator',
        href: '/',
      },
      new Date(NOW.getTime() + 1000),
      NOW,
    );
    expect(future.ageMs).toBe(0);
  });

  it('сортировка: blocker → decision → info, внутри — старшие первыми', () => {
    const items = [
      item({ id: 'info-old', severity: 'info', ageMs: 9 * DAY_MS }),
      item({ id: 'dec-new', severity: 'decision', ageMs: HOUR_MS }),
      item({ id: 'blk-new', severity: 'blocker', ageMs: 1 }),
      item({ id: 'dec-old', severity: 'decision', ageMs: 2 * DAY_MS }),
      item({ id: 'blk-old', severity: 'blocker', ageMs: DAY_MS }),
    ];
    expect([...items].sort(compareItems).map((i) => i.id)).toEqual([
      'blk-old',
      'blk-new',
      'dec-old',
      'dec-new',
      'info-old',
    ]);
  });

  it('равный возраст — стабильный порядок по id', () => {
    const a = item({ id: 'a', ageMs: 5 });
    const b = item({ id: 'b', ageMs: 5 });
    expect(compareItems(a, b)).toBeLessThan(0);
    expect(compareItems(b, a)).toBeGreaterThan(0);
  });

  it('дедупликация по id, счётчики, потолок и truncated', () => {
    const view = buildView(
      [
        item({ id: 'x', severity: 'info', ageMs: 1 }),
        item({ id: 'x', severity: 'blocker', ageMs: 1 }),
        item({ id: 'y', severity: 'decision' }),
        item({ id: 'z', severity: 'info' }),
      ],
      [],
      NOW,
      2,
    );
    expect(view.generatedAt).toBe(NOW.toISOString());
    expect(view.items.map((i) => i.id)).toEqual(['x', 'y']);
    expect(view.items[0].severity).toBe('blocker');
    expect(view.counts).toEqual({ blocker: 1, decision: 1, info: 1, total: 3 });
    expect(view.truncated).toBe(true);
    expect(buildView([item({ id: 'q' })], [], NOW).truncated).toBe(false);
    // Ровно потолок карточек — ничего не срезано.
    const exact = buildView([item({ id: 'a' }), item({ id: 'b' })], [], NOW, 2);
    expect(exact.items).toHaveLength(2);
    expect(exact.truncated).toBe(false);
  });

  it('при дубле с равной срочностью остаётся более старая карточка', () => {
    const view = buildView(
      [
        item({ id: 'x', ageMs: 1, title: 'new' }),
        item({ id: 'x', ageMs: 9, title: 'old' }),
      ],
      [],
      NOW,
    );
    expect(view.items).toHaveLength(1);
    expect(view.items[0].title).toBe('old');
  });
});

describe('pairLabel', () => {
  it('шаг по номеру, иначе тема', () => {
    expect(pairLabel('3', 'ru')).toBe('шаг 3 · ru');
    expect(pairLabel('greeting-brief', 'en')).toBe(
      'тема «greeting-brief» · en',
    );
  });
});

describe('cronItems', () => {
  it('здоровый крон — ни одной карточки', () => {
    expect(cronItems([job()], [], LOCK_MS, NOW)).toEqual([]);
  });

  it('сбой после последнего успеха — blocker с началом полосы сбоев', () => {
    const items = cronItems(
      [
        job({
          byStatus: { RUNNING: 0, SUCCESS: 10, FAILED: 3 },
          lastSuccessAt: ago(5 * HOUR_MS),
          lastFailureAt: ago(HOUR_MS),
          recentFailures: [
            {
              startedAt: ago(HOUR_MS),
              summary: null,
              errorMessage: 'Gemini 429 для 123456789',
            },
            { startedAt: ago(2 * HOUR_MS), summary: null, errorMessage: 'x' },
            { startedAt: ago(4 * HOUR_MS), summary: null, errorMessage: 'y' },
            {
              startedAt: ago(6 * HOUR_MS),
              summary: null,
              errorMessage: 'до успеха',
            },
          ],
        }),
      ],
      [],
      LOCK_MS,
      NOW,
    );
    expect(items).toHaveLength(1);
    const [it] = items;
    expect(it).toMatchObject({
      id: 'cron-failed:tutorial-scenario-run',
      severity: 'blocker',
      kind: 'cron-failed',
      owner: 'owner',
      href: '/cron',
      count: 3,
      ageMs: 4 * HOUR_MS,
    });
    expect(it.reason).toContain('Gemini 429');
    expect(it.reason).not.toContain('123456789');
  });

  it('сбой без единого успеха — blocker с текстом «успешных нет»', () => {
    const [it] = cronItems(
      [
        job({
          byStatus: { RUNNING: 0, SUCCESS: 0, FAILED: 1 },
          lastSuccessAt: null,
          lastFailureAt: ago(HOUR_MS),
          recentFailures: [
            {
              startedAt: ago(HOUR_MS),
              summary: 'Ошибка: boom',
              errorMessage: null,
            },
          ],
        }),
      ],
      [],
      LOCK_MS,
      NOW,
    );
    expect(it.kind).toBe('cron-failed');
    expect(it.reason).toContain('Успешных прогонов в журнале нет');
    expect(it.reason).toContain('boom');
    expect(it.ageMs).toBe(HOUR_MS);
  });

  it('сбой, после которого был успех — только info', () => {
    const items = cronItems(
      [
        job({
          byStatus: { RUNNING: 0, SUCCESS: 10, FAILED: 2 },
          lastSuccessAt: ago(HOUR_MS),
          lastFailureAt: ago(3 * HOUR_MS),
          recentFailures: [
            { startedAt: ago(3 * HOUR_MS), summary: null, errorMessage: 'e' },
          ],
        }),
      ],
      [],
      LOCK_MS,
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'cron-recovered',
      severity: 'info',
      owner: 'system',
      count: 2,
      ageMs: 3 * HOUR_MS,
    });
  });

  it('сбой и успех в одну миллисекунду — не «падает»', () => {
    const t = ago(HOUR_MS);
    const items = cronItems(
      [
        job({
          byStatus: { RUNNING: 0, SUCCESS: 1, FAILED: 1 },
          lastSuccessAt: t,
          lastFailureAt: t,
        }),
      ],
      [],
      LOCK_MS,
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['cron-recovered']);
  });

  it('старый сбой вне окна (FAILED=0 за сутки) — карточки нет', () => {
    expect(
      cronItems(
        [
          job({
            lastFailureAt: ago(5 * DAY_MS),
            lastSuccessAt: ago(6 * DAY_MS),
          }),
        ],
        [],
        LOCK_MS,
        NOW,
      ),
    ).toEqual([]);
  });

  it('зависший RUNNING — blocker от самого старого зависшего', () => {
    const [it] = cronItems(
      [job({ stuckRunning: 2 })],
      [
        { jobKey: 'other', startedAt: ago(20 * HOUR_MS) },
        { jobKey: 'tutorial-scenario-run', startedAt: ago(3 * HOUR_MS) },
        { jobKey: 'tutorial-scenario-run', startedAt: ago(HOUR_MS) },
      ],
      LOCK_MS,
      NOW,
    );
    expect(it).toMatchObject({
      kind: 'cron-stuck',
      severity: 'blocker',
      count: 2,
      ageMs: 3 * HOUR_MS,
    });
    expect(it.reason).toContain('11 мин');
  });

  it('зависший без строк — возраст от замка', () => {
    const [it] = cronItems([job({ stuckRunning: 1 })], [], LOCK_MS, NOW);
    expect(it.ageMs).toBe(LOCK_MS);
  });

  it('ни одного запуска по расписанию — blocker «не запускается»', () => {
    const [it] = cronItems(
      [
        job({
          expected: 15,
          scheduledRunsInWindow: 0,
          missed: 15,
          lastSuccessAt: ago(2 * DAY_MS),
          lastFailureAt: ago(3 * DAY_MS),
        }),
      ],
      [],
      LOCK_MS,
      NOW,
    );
    expect(it).toMatchObject({
      id: 'cron-silent:tutorial-scenario-run',
      kind: 'cron-silent',
      severity: 'blocker',
      count: 15,
      ageMs: 2 * DAY_MS,
    });
  });

  it('молчит и ни разу не запускался — возраст от начала окна', () => {
    const [it] = cronItems(
      [job({ scheduledRunsInWindow: 0, missed: 15, lastSuccessAt: null })],
      [],
      LOCK_MS,
      NOW,
    );
    expect(it.ageMs).toBe(DAY_MS);
  });

  it('часть запусков пропущена — info, не блокер', () => {
    const [it] = cronItems(
      [job({ scheduledRunsInWindow: 13, missed: 2 })],
      [],
      LOCK_MS,
      NOW,
    );
    expect(it).toMatchObject({
      kind: 'cron-missed',
      severity: 'info',
      count: 2,
    });
    expect(it.reason).toContain('2 из 15');
  });

  it('ночной перерыв: расписание его не ждёт (expected=0) — карточки нет', () => {
    expect(
      cronItems(
        [job({ expected: 0, scheduledRunsInWindow: 0, missed: 0 })],
        [],
        LOCK_MS,
        NOW,
      ),
    ).toEqual([]);
  });

  it('expected=0 — пропуски не считаются, даже если сводка их насчитала', () => {
    expect(
      cronItems(
        [job({ expected: 0, scheduledRunsInWindow: 0, missed: 1 })],
        [],
        LOCK_MS,
        NOW,
      ),
    ).toEqual([]);
  });

  it('без расписания (expected=null) пропуски не считаются', () => {
    expect(
      cronItems(
        [job({ expected: null, scheduledRunsInWindow: 0, missed: null })],
        [],
        LOCK_MS,
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('onlySkipItems', () => {
  it('сутки только пропуски — info с причиной', () => {
    const [it] = onlySkipItems(
      [
        {
          jobKey: 'ui-snapshot-run',
          lastSuccess: { startedAt: ago(3 * DAY_MS).toISOString() },
          lastSkip: {
            startedAt: ago(HOUR_MS).toISOString(),
            summary: 'пропущен — фикстура не настроена',
          },
        },
      ],
      NOW,
    );
    expect(it).toMatchObject({
      kind: 'cron-only-skips',
      severity: 'info',
      ageMs: 3 * DAY_MS,
    });
    expect(it.reason).toContain('фикстура не настроена');
  });

  it('успех позже пропуска — не «только пропуски», даже если оба старые', () => {
    expect(
      onlySkipItems(
        [
          {
            jobKey: 'old',
            lastSuccess: { startedAt: ago(2 * DAY_MS).toISOString() },
            lastSkip: {
              startedAt: ago(3 * DAY_MS).toISOString(),
              summary: null,
            },
          },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('недавний успех или успех после пропуска — карточки нет', () => {
    expect(
      onlySkipItems(
        [
          {
            jobKey: 'a',
            lastSuccess: { startedAt: ago(2 * HOUR_MS).toISOString() },
            lastSkip: { startedAt: ago(HOUR_MS).toISOString(), summary: null },
          },
          {
            jobKey: 'b',
            lastSuccess: { startedAt: ago(HOUR_MS).toISOString() },
            lastSkip: {
              startedAt: ago(3 * DAY_MS).toISOString(),
              summary: null,
            },
          },
          { jobKey: 'c', lastSuccess: null, lastSkip: null },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('пропуски без единого успеха — от последнего пропуска', () => {
    const [it] = onlySkipItems(
      [
        {
          jobKey: 'x',
          lastSuccess: null,
          lastSkip: { startedAt: ago(HOUR_MS).toISOString(), summary: null },
        },
      ],
      NOW,
    );
    expect(it.ageMs).toBe(HOUR_MS);
    expect(it.reason).toContain('Настоящих успехов в журнале нет');
  });
});

describe('snapshotErrorItems / snapshotChangedItems', () => {
  const snap = {
    routeKey: 'home',
    locale: 'ru',
    theme: 'light',
    lastAt: ago(10 * 60_000).toISOString(),
    lastOkAt: ago(3 * HOUR_MS).toISOString() as string | null,
    error: 'timeout at https://tma.example/x' as string | null,
  };

  it('долгая ошибка — blocker со ссылкой на маршрут, без адреса', () => {
    const [it] = snapshotErrorItems([snap], NOW);
    expect(it).toMatchObject({
      id: 'ui-snapshot-error:home:ru:light',
      severity: 'blocker',
      href: '/ui-snapshots?route=home',
      ageMs: 3 * HOUR_MS,
    });
    expect(it.reason).not.toContain('tma.example');
  });

  it('разовая осечка (удачный был недавно) — info', () => {
    const [it] = snapshotErrorItems(
      [{ ...snap, lastOkAt: ago(20 * 60_000).toISOString() }],
      NOW,
    );
    expect(it.severity).toBe('info');
  });

  it('удачных не было — blocker от последнего снимка', () => {
    const [it] = snapshotErrorItems([{ ...snap, lastOkAt: null }], NOW);
    expect(it.severity).toBe('blocker');
    expect(it.ageMs).toBe(10 * 60_000);
  });

  it('без ошибки — карточки нет', () => {
    expect(snapshotErrorItems([{ ...snap, error: null }], NOW)).toEqual([]);
  });

  it('изменения за сутки — decision с числом', () => {
    const items = snapshotChangedItems(
      [
        {
          routeKey: 'home',
          locale: 'ru',
          theme: 'dark',
          count: 3,
          firstAt: ago(5 * HOUR_MS),
        },
        {
          routeKey: 'x',
          locale: 'ru',
          theme: 'light',
          count: 0,
          firstAt: ago(HOUR_MS),
        },
      ],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'ui-snapshot-changed:home:ru:dark',
      severity: 'decision',
      owner: 'operator',
      count: 3,
      ageMs: 5 * HOUR_MS,
    });
  });
});

describe('demoMatrixItems', () => {
  const approved = (
    over: Partial<NonNullable<DemoCellInput['approved']>> = {},
  ) => ({
    approvedRowCreatedAt: ago(2 * DAY_MS).toISOString(),
    capturedAt: ago(2 * DAY_MS).toISOString() as string | null,
    captureBuild: 'abc1234' as string | null,
    ...over,
  });
  const cell = (over: Partial<DemoCellInput>): DemoCellInput => ({
    subjectKey: '1',
    locale: 'ru',
    family: 'step',
    approved: approved(),
    approvedThemes: ['light', 'dark'],
    ...over,
  });

  it('обе темы, свежий, текущая сборка — пусто', () => {
    expect(
      demoMatrixItems(
        [cell({})],
        { requiredLocales: ['ru'], currentBuild: 'abc1234' },
        NOW,
      ),
    ).toEqual([]);
  });

  it('ячейки демо обучающего лендинга не считаются ни пробелом, ни пропуском, ни устаревшими', () => {
    const items = demoMatrixItems(
      [
        cell({ subjectKey: 'site-tutorial-demo-1', approvedThemes: ['light'] }),
        cell({
          subjectKey: 'site-tutorial-demo-2',
          approved: null,
          approvedThemes: [],
        }),
        cell({
          subjectKey: 'site-tutorial-demo-3',
          approved: approved({ captureBuild: 'landing:zzz' }),
        }),
      ],
      { requiredLocales: ['ru'], currentBuild: 'abc1234' },
      NOW,
    );
    expect(items).toEqual([]);
  });

  it('пробел темы — одна decision-карточка на все пары', () => {
    const items = demoMatrixItems(
      [
        cell({ subjectKey: '1', approvedThemes: ['light'] }),
        cell({ subjectKey: '2', approvedThemes: ['dark', null] }),
        cell({ subjectKey: '3', approvedThemes: [null] }),
        cell({ subjectKey: '9', family: 'other', approvedThemes: ['light'] }),
      ],
      { requiredLocales: ['ru'], currentBuild: 'abc1234' },
      NOW,
    );
    const gap = items.find((i) => i.kind === 'demo-theme-gap');
    expect(gap).toMatchObject({
      severity: 'decision',
      count: 2,
      ageMs: 2 * DAY_MS,
    });
    expect(gap?.reason).toContain('шаг 1 · ru: нет тёмной');
    expect(gap?.reason).toContain('шаг 2 · ru: нет светлой');
    expect(gap?.reason).not.toContain('шаг 3');
    expect(gap?.reason).not.toContain('шаг 9');
  });

  it('нет ни одного — info только для обязательных языков', () => {
    const items = demoMatrixItems(
      [
        cell({ subjectKey: '1', approved: null, approvedThemes: [] }),
        cell({
          subjectKey: '1',
          locale: 'de',
          approved: null,
          approvedThemes: [],
        }),
      ],
      { requiredLocales: ['ru'], currentBuild: null },
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'demo-missing',
      severity: 'info',
      count: 1,
    });
    expect(items[0].reason).toContain('шаг 1 · ru');
    expect(items[0].reason).not.toContain('· de');
  });

  it('устаревший по сборке, если текущая известна', () => {
    const [it] = demoMatrixItems(
      [cell({ approved: approved({ captureBuild: 'old0001' }) })],
      { requiredLocales: [], currentBuild: 'new0002' },
      NOW,
    );
    expect(it).toMatchObject({ kind: 'demo-stale', count: 1 });
    expect(it.reason).toContain('old0001');
    expect(it.reason).toContain('new0002');
  });

  it('сборка совпала — не устарел, даже если стар', () => {
    expect(
      demoMatrixItems(
        [
          cell({
            approved: approved({
              captureBuild: 'abc1234',
              capturedAt: ago(90 * DAY_MS).toISOString(),
            }),
          }),
        ],
        { requiredLocales: [], currentBuild: 'abc1234' },
        NOW,
      ),
    ).toEqual([]);
  });

  it('сборка неизвестна — устарел только старше 30 дней', () => {
    const items = demoMatrixItems(
      [
        cell({
          subjectKey: '1',
          approved: approved({
            captureBuild: null,
            capturedAt: ago(31 * DAY_MS).toISOString(),
          }),
        }),
        cell({
          subjectKey: '2',
          approved: approved({
            captureBuild: 'dev',
            capturedAt: ago(29 * DAY_MS).toISOString(),
          }),
        }),
        cell({
          subjectKey: '3',
          approved: approved({
            captureBuild: null,
            capturedAt: null,
            approvedRowCreatedAt: ago(40 * DAY_MS).toISOString(),
          }),
        }),
      ],
      { requiredLocales: [], currentBuild: 'dev' },
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'demo-stale',
      count: 2,
      ageMs: 40 * DAY_MS,
    });
    expect(items[0].reason).toContain('Текущая сборка фронтенда неизвестна');
  });
});

describe('очереди решений', () => {
  it('ролики на одобрении — одна карточка, ссылка с фильтром для одной пары', () => {
    const [single] = tutorialReviewItems(
      [{ subjectKey: '2', locale: 'ru', count: 3, oldestAt: ago(DAY_MS) }],
      NOW,
    );
    expect(single).toMatchObject({
      kind: 'tutorial-review',
      severity: 'decision',
      count: 3,
      href: '/assistant?tab=videos&reviewed=false&subjectKey=2&locale=ru',
      ageMs: DAY_MS,
    });
    const [many] = tutorialReviewItems(
      [
        { subjectKey: '2', locale: 'ru', count: 3, oldestAt: ago(DAY_MS) },
        {
          subjectKey: 'greeting-brief',
          locale: 'en',
          count: 1,
          oldestAt: ago(3 * DAY_MS),
        },
        { subjectKey: '5', locale: 'ru', count: 0, oldestAt: ago(9 * DAY_MS) },
      ],
      NOW,
    );
    expect(many.count).toBe(4);
    expect(many.href).toBe('/assistant?tab=videos&reviewed=false');
    expect(many.ageMs).toBe(3 * DAY_MS);
    expect(many.reason.indexOf('greeting-brief')).toBeLessThan(
      many.reason.indexOf('шаг 2'),
    );
    expect(tutorialReviewItems([], NOW)).toEqual([]);
  });

  it('версии темпа — карточка на ролик со ссылкой на панель темпа', () => {
    const items = tempoApprovalItems(
      [
        {
          assetId: 'a1',
          subjectKey: '4',
          locale: 'ru',
          tempoFactor: 1.5,
          readyAt: ago(HOUR_MS),
        },
        {
          assetId: 'a1',
          subjectKey: '4',
          locale: 'ru',
          tempoFactor: 0.4,
          readyAt: ago(2 * HOUR_MS),
        },
        {
          assetId: 'a2',
          subjectKey: '7',
          locale: 'uk',
          tempoFactor: null,
          readyAt: ago(HOUR_MS),
        },
      ],
      NOW,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'tempo-approval:a1',
      severity: 'decision',
      count: 2,
      ageMs: 2 * HOUR_MS,
      href: '/assistant?tab=videos&subjectKey=4&locale=ru&tempo=a1',
    });
    expect(items[0].reason).toContain('×1,5');
    expect(items[0].reason).toContain('×0,4');
    expect(items[1].reason).not.toContain('×');
  });

  it('модерация — только непустые очереди, блог к сведению', () => {
    const items = moderationItems(
      [
        { kind: 'publication-review', count: 2, oldestAt: ago(DAY_MS) },
        { kind: 'shared-video-review', count: 0, oldestAt: null },
        { kind: 'blog-review', count: 5, oldestAt: ago(HOUR_MS) },
        { kind: 'auction-review', count: 1, oldestAt: null },
      ],
      NOW,
    );
    expect(items.map((i) => [i.kind, i.severity, i.href, i.count])).toEqual([
      ['publication-review', 'decision', '/publications', 2],
      ['blog-review', 'info', '/blog', 5],
      ['auction-review', 'decision', '/auctions', 1],
    ]);
    expect(items[0].ageMs).toBe(DAY_MS);
    expect(items[2].ageMs).toBe(0);
  });

  it('черновики заказчиков: скоро сотрётся vs ждёт, без ПД', () => {
    const items = clientDraftItems(
      [
        { id: 'd1', updatedAt: ago(25 * DAY_MS), framesPurgedAt: null },
        { id: 'd2', updatedAt: ago(2 * DAY_MS), framesPurgedAt: null },
        { id: 'd3', updatedAt: ago(40 * DAY_MS), framesPurgedAt: ago(DAY_MS) },
      ],
      { retentionDays: 30, warnDays: 7 },
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual([
      'client-draft-expiring',
      'client-draft-review',
      'client-draft-review',
    ]);
    expect(items[0].reason).toContain('через 5 дн.');
    expect(items[0].href).toBe('/site-tutorial-drafts?open=d1');
    expect(items[2].reason).toContain('уже стёрты');
    expect(items.every((i) => i.severity === 'decision')).toBe(true);
  });

  it('черновик ровно на границе предупреждения — уже «скоро сотрётся»', () => {
    const [it] = clientDraftItems(
      [{ id: 'd', updatedAt: ago(23 * DAY_MS), framesPurgedAt: null }],
      { retentionDays: 30, warnDays: 7 },
      NOW,
    );
    expect(it.kind).toBe('client-draft-expiring');
  });

  it('зависшие сборки — один blocker, пусто без зависших', () => {
    expect(
      assemblyStuckItems(
        {
          assets: 0,
          assetsOldestAt: null,
          versions: 0,
          versionsOldestAt: null,
        },
        NOW,
      ),
    ).toEqual([]);
    const [it] = assemblyStuckItems(
      {
        assets: 2,
        assetsOldestAt: ago(5 * HOUR_MS),
        versions: 1,
        versionsOldestAt: ago(9 * HOUR_MS),
      },
      NOW,
    );
    expect(it).toMatchObject({
      kind: 'assembly-stuck',
      severity: 'blocker',
      count: 3,
      ageMs: 9 * HOUR_MS,
    });
    expect(it.reason).toContain('роликов: 2');
    expect(it.reason).toContain('версий темпа: 1');
    const [one] = assemblyStuckItems(
      {
        assets: 1,
        assetsOldestAt: ago(HOUR_MS),
        versions: 0,
        versionsOldestAt: null,
      },
      NOW,
    );
    expect(one.reason).toContain('роликов: 1');
    expect(one.reason).not.toContain('версий темпа');
  });
});

describe('qualityItems — проверка качества демо', () => {
  const row = (over: Partial<QualityCheckRow> = {}): QualityCheckRow => ({
    assetId: 'a1',
    status: 'complete',
    verdict: 'fail',
    checkedAt: ago(3 * HOUR_MS),
    updatedAt: ago(3 * HOUR_MS),
    subjectKey: '2',
    locale: 'ru',
    theme: 'dark',
    summary: 'чёрный кадр на 0:03, почта user@example.com',
    issueCount: 2,
    ...over,
  });

  it('fail — решение оператора, со ссылкой на ролик и возрастом от проверки', () => {
    const [item] = qualityItems([row()], NOW);
    expect(item).toMatchObject({
      id: 'demo-quality-fail:a1',
      severity: 'decision',
      kind: 'demo-quality-fail',
      owner: 'operator',
      href: '/assistant?tab=videos&subjectKey=2&locale=ru&quality=a1',
      ageMs: 3 * HOUR_MS,
    });
    expect(item.title).toContain('шаг 2 · ru · dark');
    expect(item.reason).toContain('замечаний: 2');
    expect(item.reason).not.toContain('user@example.com');
    expect(item.reason).toContain('Одобрение ролика проверка не меняет');
  });

  it('warn — к сведению; ok, в очереди и без вердикта — без карточки', () => {
    const items = qualityItems(
      [
        row({ assetId: 'w', verdict: 'warn' }),
        row({ assetId: 'o', verdict: 'ok' }),
        row({ assetId: 'p', status: 'pending', verdict: null }),
        row({ assetId: 'r', status: 'running', verdict: 'fail' }),
      ],
      NOW,
    );
    expect(items.map((i) => [i.id, i.severity])).toEqual([
      ['demo-quality-warn:w', 'info'],
    ]);
  });

  it('исчерпанные повторы — одна агрегированная карточка, не вердикт', () => {
    const items = qualityItems(
      [
        row({
          assetId: 'e1',
          status: 'error',
          verdict: null,
          updatedAt: ago(HOUR_MS),
        }),
        row({
          assetId: 'e2',
          status: 'error',
          verdict: null,
          updatedAt: ago(5 * HOUR_MS),
          subjectKey: '7',
        }),
      ],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'demo-quality-error',
      kind: 'demo-quality-error',
      severity: 'info',
      count: 2,
      ageMs: 5 * HOUR_MS,
    });
    expect(items[0].reason).toContain('шаг 7 · ru');
  });

  it('без темы — без суффикса; без даты проверки — возраст от обновления', () => {
    const [item] = qualityItems(
      [
        row({
          theme: null,
          checkedAt: null,
          updatedAt: ago(2 * HOUR_MS),
          summary: null,
          issueCount: 0,
        }),
      ],
      NOW,
    );
    expect(item.title.endsWith('шаг 2 · ru')).toBe(true);
    expect(item.ageMs).toBe(2 * HOUR_MS);
    expect(item.reason).toBe(
      'ИИ-проверка нашла блокирующий дефект. Одобрение ролика проверка не меняет.',
    );
  });

  it('поимённых карточек на вердикт не больше потолка', () => {
    const rows = Array.from({ length: QUALITY_CARDS_CAP + 5 }, (_, i) =>
      row({ assetId: `a${i}` }),
    );
    expect(qualityItems(rows, NOW)).toHaveLength(QUALITY_CARDS_CAP);
  });
});
