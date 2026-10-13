import * as fs from 'fs';
import * as path from 'path';
import { AT_CATALOG, isAtId, qaCaseInput } from './at-catalog';
import {
  buildAtReport,
  hasPartsOutsideJest,
  labelsOf,
  type JestJson,
} from './at-report';

describe('qa/at-catalog: 44 обязательных P0-сценария (§18.1)', () => {
  it('44 уникальных AT-ID; D0 = 21, закупка = 30, объединение = 32, «42» = 12 (контроль счёта §18.1)', () => {
    const ids = AT_CATALOG.map((c) => c.id);
    expect(ids).toHaveLength(44);
    expect(new Set(ids).size).toBe(44);
    expect(ids.every(isAtId)).toBe(true);
    const has = (g: string) =>
      AT_CATALOG.filter((c) => (c.gates as readonly string[]).includes(g))
        .length;
    expect([has('D0'), has('Z'), has('42')]).toEqual([21, 30, 12]);
    expect(
      AT_CATALOG.filter((c) => c.gates.includes('D0') || c.gates.includes('Z'))
        .length,
    ).toBe(32);
  });

  it('карточка qa-catalog: тип automated, ручной остаток в описании, ограничения длины ввода', () => {
    for (const c of AT_CATALOG) {
      const q = qaCaseInput(c);
      expect(q.title.length).toBeLessThanOrEqual(200);
      expect(q.purpose.length).toBeLessThanOrEqual(2000);
      expect(q.tags.length).toBeLessThanOrEqual(20);
      expect(q.requirementIds).toEqual([c.id]);
      // ручной остаток — проверка ниже
    }
    const withManual = AT_CATALOG.filter((c) => c.manual);
    expect(withManual.length).toBeGreaterThan(0);
    expect(
      withManual.every((c) =>
        qaCaseInput(c).purpose.includes('Ручний залишок'),
      ),
    ).toBe(true);
    const core20 = AT_CATALOG.find((c) => c.id === 'AT-CORE-20');
    expect(core20).toMatchObject({ packages: ['P-E'], gates: ['D0', 'Z'] });
  });

  it('у каждого сценария пакета P-E есть тест с меткой в src/acceptance/publisher/{reports,restore}-*.spec.ts', () => {
    const dir = path.join(__dirname, '../../../../acceptance/publisher');
    const text = fs
      .readdirSync(dir)
      .filter((f) => /^(reports|restore)-.*\.spec\.ts$/.test(f))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    const pe = AT_CATALOG.filter((c) => c.packages.includes('P-E')).map(
      (c) => c.id,
    );
    expect(pe.sort()).toEqual(
      [
        'AT-CORE-06',
        'AT-CORE-07',
        'AT-CORE-09',
        'AT-CORE-12',
        'AT-CORE-18',
        'AT-CORE-19',
        'AT-CORE-20',
        'AT-CORE-23',
        'AT-CORE-24',
        'AT-F17-01',
        'AT-F17-02',
      ].sort(),
    );
    const missing = pe.filter((id) => !text.includes(`[${id}]`));
    expect(missing).toEqual([]);
    // Файлы трассировки P-E (`reports-*`, `restore-*`) существуют (аудит P-E
    // S2-2: ссылка на несуществующий `reports-coverage.spec`).
    const own = AT_CATALOG.flatMap((c) => c.files).filter((f) =>
      /^(reports|restore)-.*\.spec$/.test(f),
    );
    const files = new Set(fs.readdirSync(dir));
    expect(own.filter((f) => !files.has(`${f}.ts`))).toEqual([]);
  });
});

describe('qa/at-report: jest JSON → отчёт qa-catalog schemaVersion 1', () => {
  const jest: JestJson = {
    success: false,
    startTime: Date.UTC(2026, 9, 13, 7, 0, 0),
    testResults: [
      {
        name: 'a.spec.ts',
        assertionResults: [
          {
            ancestorTitles: ['[AT-CORE-18] Нулевой знаменатель'],
            title: 'x',
            status: 'passed',
            duration: 5,
          },
          {
            ancestorTitles: ['[AT-CORE-18] Нулевой знаменатель'],
            title: 'y',
            status: 'passed',
            duration: 7,
          },
          {
            ancestorTitles: ['[AT-CORE-19] окна'],
            title: 'z',
            status: 'failed',
            duration: 3,
          },
          {
            ancestorTitles: ['[AT-CORE-19] окна'],
            title: 'w',
            status: 'passed',
            duration: 1,
          },
          {
            ancestorTitles: ['[AT-CORE-20] восстановление'],
            title: 'q',
            status: 'pending',
            duration: 0,
          },
          {
            ancestorTitles: ['без метки'],
            title: '[AT-F99-01] опечатка',
            status: 'passed',
            duration: 1,
          },
          {
            ancestorTitles: ['[AT-CORE-23] пороги'],
            title: 'v',
            status: 'passed',
            duration: 2,
          },
        ],
      },
    ],
  };

  it('метки из describe и it; статусы: passed / failed / skipped (нет базы) / blocked (нет тестов или есть части вне jest — partial); неизвестная метка — unknownTests', () => {
    expect(
      labelsOf({
        ancestorTitles: ['[AT-CORE-07] a', 'b'],
        title: '[AT-F17-02] c',
      }),
    ).toEqual(['AT-CORE-07', 'AT-F17-02']);
    const r = buildAtReport(jest);
    const st = (id: string) => r.results.find((x) => x.caseId === id)?.status;
    // AT-CORE-18: jest-часть прошла, но у кейса есть ui (P-G2) — не passed.
    expect([
      st('AT-CORE-23'),
      st('AT-CORE-18'),
      st('AT-CORE-19'),
      st('AT-CORE-20'),
      st('AT-CORE-01'),
    ]).toEqual(['passed', 'blocked', 'failed', 'skipped', 'blocked']);
    expect(r.summary.partial).toEqual(['AT-CORE-18']);
    expect(r.summary.passed).toEqual(['AT-CORE-23']);
    expect(r.results.find((x) => x.caseId === 'AT-CORE-18')?.durationMs).toBe(
      12,
    );
    expect(r.unknownTests).toBe(1);
    expect(r.summary.unknownLabels).toEqual(['AT-F99-01']);
    expect(r.runnerStatus).toBe('failed');
    expect(r).toMatchObject({
      schemaVersion: 1,
      metadata: {
        source: 'jest',
        startedAt: '2026-10-13T07:00:00.000Z',
        testSourceSha: null,
        deployedSha: null,
      },
    });
    expect(r.cases).toHaveLength(44);
    expect(r.results).toHaveLength(44);
    expect(
      r.results.every(
        (x) =>
          x.attempt === 0 && x.origin === 'automated' && x.project === 'jest',
      ),
    ).toBe(true);
    expect(r.summary.blocked.length).toBe(41);
    // Ни один кейс с e2e/ui/eval или ручным остатком не бывает passed в jest-отчёте.
    const all: JestJson = {
      success: true,
      testResults: [
        {
          name: 'all.spec.ts',
          assertionResults: AT_CATALOG.map((c) => ({
            ancestorTitles: [`[${c.id}]`],
            title: 't',
            status: 'passed' as const,
          })),
        },
      ],
    };
    const full = buildAtReport(all);
    const outside = AT_CATALOG.filter(hasPartsOutsideJest).map((c) => c.id);
    expect(outside.length).toBe(16);
    expect(full.summary.partial.sort()).toEqual(outside.sort());
    expect(full.summary.passed.length).toBe(44 - 16);
  });
});
