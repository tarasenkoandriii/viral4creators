/**
 * Заход 10: находки недели «Админки» (код), проверка чисел выводов модели,
 * отчёт недели и push тревоги компенсаций на языке получателя.
 */
import {
  EMPTY_WEEK,
  FINDING_RULES,
  type AdminFinding,
  addDaysIso,
  compensationAlertText,
  dryFindingLine,
  numbersIn,
  parseInsightItems,
  sumWeek,
  weekFindings,
  weekStartOf,
  weeklyReportText,
} from './admin-report-text';
import { AdminWeekly } from './admin-weekly.service';

const week = (o: Partial<typeof EMPTY_WEEK>) => ({ ...EMPTY_WEEK, ...o });

describe('№57 — находки недели «Админки» (код)', () => {
  it('«не знаю» ≥ 20% при ≥ 10 вопросах; ниже порога выборки — нет находки', () => {
    expect(
      weekFindings({
        totals: week({ questions: 10, refused: 2 }),
        labels: [],
        learningNew: 0,
      }),
    ).toEqual([{ id: 'refusals', kind: 'refusals', n: 10, value: 2, pct: 20 }]);
    expect(
      weekFindings({
        totals: week({ questions: 9, refused: 9 }),
        labels: [],
        learningNew: 0,
      }),
    ).toEqual([]);
    expect(FINDING_RULES.refusals.minQuestions).toBe(10);
  });

  it('«не нашёл ответ» по типу задачи (≥ 5 размеченных, ≥ 30%), ошибки инструментов, сбои действий, очередь обучения', () => {
    const labels = [
      ...Array.from({ length: 3 }, () => ({
        taskType: 'how_to',
        answerFound: 'no',
        status: 'ok',
      })),
      ...Array.from({ length: 3 }, () => ({
        taskType: 'how_to',
        answerFound: 'yes',
        status: 'ok',
      })),
      { taskType: 'lookup', answerFound: 'no', status: 'failed' },
    ];
    const f = weekFindings({
      totals: week({ toolErrors: 5, confirmed: 10, actionsFailed: 3 }),
      labels,
      learningNew: 7,
    });
    expect(f.map((x) => x.id)).toEqual([
      'not_found:how_to',
      'tool_errors',
      'actions_failed',
      'learning_queue',
    ]);
    expect(f[0]).toMatchObject({ n: 6, value: 3, pct: 50 });
  });

  it('свёртка недели суммирует только числа', () => {
    expect(
      sumWeek([
        { questions: 2, refused: 1 },
        { questions: 3, minutesSaved: 5 },
      ]),
    ).toMatchObject({ questions: 5, refused: 1, minutesSaved: 5 });
  });
});

describe('№57 — выводы моделью: числа только из находок', () => {
  const findings: AdminFinding[] = [
    { id: 'refusals', kind: 'refusals', n: 40, value: 12, pct: 30 },
  ];
  const item = (title: string) => ({
    findingIds: ['refusals'],
    uk: { title, action: 'Додайте регламент повернень.' },
    ru: { title: 'Много «не знаю»', action: 'Добавьте регламент возвратов.' },
    en: { title: 'Many "I don\'t know"', action: 'Add the returns policy.' },
  });

  it('число из находки — пункт годен; чужое число («37%») — пункт выброшен', () => {
    expect(
      parseInsightItems(
        JSON.stringify({ items: [item('30% відповідей — «не знаю»')] }),
        findings,
      ),
    ).toHaveLength(1);
    expect(
      parseInsightItems(
        JSON.stringify({ items: [item('37% відповідей — «не знаю»')] }),
        findings,
      ),
    ).toBeNull();
  });

  it('id не из находок, нет языка, контакт в тексте, не JSON — null', () => {
    expect(
      parseInsightItems(
        JSON.stringify({ items: [{ ...item('x'), findingIds: ['nope'] }] }),
        findings,
      ),
    ).toBeNull();
    const noEn = { ...item('x') } as Record<string, unknown>;
    delete noEn.en;
    expect(
      parseInsightItems(JSON.stringify({ items: [noEn] }), findings),
    ).toBeNull();
    expect(
      parseInsightItems(
        JSON.stringify({ items: [item('пишіть boss@shop.ua')] }),
        findings,
      ),
    ).toBeNull();
    expect(parseInsightItems('nope', findings)).toBeNull();
    expect(numbersIn('12,5 і 30%')).toEqual(['12.5', '30']);
  });
});

describe('№57 — отчёт недели и Р-З10-13 push — на языке получателя', () => {
  const base = {
    siteName: 'Shop',
    weekStart: '2026-10-05',
    totals: week({
      conversations: 12,
      questions: 40,
      refused: 12,
      labeled: 10,
      answerYes: 7,
      minutesSaved: 90,
    }),
    prev: week({ conversations: 10, questions: 41 }),
    findings: [
      {
        id: 'refusals',
        kind: 'refusals',
        n: 40,
        value: 12,
        pct: 30,
      } as AdminFinding,
    ],
    items: null,
  };

  it('uk / ru / en — разные тексты и кнопки; Δ к прошлой неделе; ≈ часы', () => {
    const uk = weeklyReportText({ ...base, lang: 'uk' });
    const ru = weeklyReportText({ ...base, lang: 'ru' });
    const en = weeklyReportText({ ...base, lang: 'en' });
    expect(uk.text).toContain('Діалогів співробітників: 12 (+2)');
    expect(ru.text).toContain('Диалогов сотрудников: 12 (+2)');
    expect(en.text).toContain('Staff conversations: 12 (+2)');
    expect(uk.text).toContain('≈ 1.5 год');
    expect(ru.button).toBe('Открыть статистику');
    expect(en.text).toContain(dryFindingLine(base.findings[0], 'en'));
    expect(uk.text).not.toContain(dryFindingLine(base.findings[0], 'ru'));
  });

  it('вывод модели заменяет сухую строку своей находки; предел Telegram 4 096', () => {
    const items = [
      {
        findingIds: ['refusals'],
        uk: { title: 'Багато «не знаю»', action: 'Додайте регламент.' },
        ru: { title: 'Много «не знаю»', action: 'Добавьте регламент.' },
        en: { title: 'Many unknowns', action: 'Add the policy.' },
      },
    ];
    const ru = weeklyReportText({ ...base, lang: 'ru', items });
    expect(ru.text).toContain('• Много «не знаю» — Добавьте регламент.');
    expect(ru.text).not.toContain(dryFindingLine(base.findings[0], 'ru'));
    const long = weeklyReportText({
      ...base,
      lang: 'uk',
      siteName: 'x'.repeat(5000),
    });
    expect(long.text.length).toBeLessThanOrEqual(4096);
  });

  it('push тревоги компенсаций: числа окна, язык получателя', () => {
    const p = { siteName: 'Shop', attempts: 10, ok: 6 };
    expect(compensationAlertText('uk', p).text).toContain('успішно 6 з 10');
    expect(compensationAlertText('ru', p).text).toContain('успешно 6 из 10');
    expect(compensationAlertText('en', p).text).toContain('6 of 10');
    expect(compensationAlertText('en', p).text).toContain('(60%)');
  });

  it('неделя: понедельник UTC; работа — с понедельника 06:00 UTC за прошлую неделю', () => {
    expect(weekStartOf(new Date('2026-10-11T23:00:00Z'))).toBe('2026-10-05');
    expect(weekStartOf(new Date('2026-10-12T00:00:00Z'))).toBe('2026-10-12');
    expect(addDaysIso('2026-10-12', -7)).toBe('2026-10-05');
    expect(AdminWeekly.dueWeek(new Date('2026-10-12T05:59:00Z'))).toBeNull();
    expect(AdminWeekly.dueWeek(new Date('2026-10-12T06:00:00Z'))).toBe(
      '2026-10-05',
    );
  });
});
