/**
 * AI Publisher — совместимость отчёта приёмки P-E с импортом qa-catalog
 * (§16.7 `qa/at-report.ts`, §17.1 этап Z «импорт AT-отчёта в qa-catalog»):
 * отчёт с честным `metadata.source = 'jest'` проходит `parseQaReport`
 * целиком (qa-catalog принимает `jest` — интеграция Z-1, Р-PUB-Z1-5).
 */
import { parseQaReport } from '../../modules/qa-catalog/qa-report-input';
import { buildAtReport } from '../../modules/publisher/reports/qa/at-report';

describe('Отчёт AT для qa-catalog (schemaVersion 1)', () => {
  const jest = {
    success: true,
    startTime: Date.UTC(2026, 9, 13, 7, 0, 0),
    testResults: [
      {
        name: 'x.spec.ts',
        assertionResults: [
          {
            ancestorTitles: ['[AT-CORE-23] Пороги'],
            title: 'a',
            status: 'passed' as const,
            duration: 4,
          },
          {
            // jest-часть AT-CORE-18 прошла, ui-часть P-G2 — нет: blocked.
            ancestorTitles: ['[AT-CORE-18] Нулевой знаменатель'],
            title: 'b',
            status: 'passed' as const,
            duration: 3,
          },
        ],
      },
    ],
  };

  it('формат совместим с parseQaReport, источник — jest', () => {
    const honest = buildAtReport(jest);
    expect(honest.metadata.source).toBe('jest');
    const parsed = parseQaReport({
      expectedRevision: 1,
      project: 'jest',
      report: honest,
    });
    expect(parsed.metadata.source).toBe('jest');
    expect(parsed.cases).toHaveLength(44);
    expect(
      parsed.attempts.find((a) => a.caseKey === 'AT-CORE-23'),
    ).toMatchObject({ status: 'passed', sourceAttempt: 0 });
    expect(
      parsed.attempts.find((a) => a.caseKey === 'AT-CORE-18'),
    ).toMatchObject({ status: 'blocked' });
    expect(honest.summary.partial).toEqual(['AT-CORE-18']);
    expect(parsed.attempts.filter((a) => a.status === 'blocked')).toHaveLength(
      43,
    );
  });
});
