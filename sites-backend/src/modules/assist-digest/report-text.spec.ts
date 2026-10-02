/**
 * Тексты сводки и отчёта недели (A, §5-тер.16 п.9): ≤ 4 096 символов на
 * самом длинном входе; раздел «Админка» — только если передан; слова
 * атрибуции — строго §5-тер.2; каждое число — из входа.
 */
import {
  FINDINGS_MAX,
  FINDING_MAX,
  TELEGRAM_TEXT_LIMIT,
  fitTelegram,
  dailyDigestText,
  weeklyReportText,
  type SiteDigestFacts,
} from './report-text';

const facts: SiteDigestFacts = {
  siteName: 'Магазин «Тепло»',
  period: { from: '2026-09-28', to: '2026-10-04' },
  dialogs: 120,
  dialogsPrev: 100,
  resolved: 80,
  operatorHours: 4,
  handoffs: 9,
  handoffsMissed: 2,
  leads: 7,
  conversionsDirect: 5,
  conversionsAssisted: 11,
  newTopics: 4,
  heldVersions: 1,
  goldenConflicts: 3,
  alerts: ['handoff_spike'],
  findings: [
    'Без ответа: «доставка в Польшу» — спросили 23 разных посетителей',
  ],
};

describe('report-text (A)', () => {
  it('отчёт недели: числа из входа, Δ, слова атрибуции §5-тер.2, находки; без «Админки»', () => {
    const t = weeklyReportText(facts, null);
    expect(t).toContain('Отчёт недели — «Магазин «Тепло»»');
    expect(t).toContain('28.09.2026–04.10.2026');
    expect(t).toContain('Диалоги: 120 (+20% к прошлому периоду)');
    expect(t).toContain('Решено без человека: 80 (67%)');
    expect(t).toContain('помощник довёл — 5');
    expect(t).toContain('с участием помощника (не обязательно благодаря) — 11');
    expect(t).toContain('пропущено: 2');
    expect(t).toContain('новых непокрытых тем: 4');
    expect(t).toContain('доставка в Польшу');
    expect(t).not.toMatch(/Админк/);
    expect(t).not.toMatch(/окупаем/i);
  });

  it('раздел «Админка» — только когда передан (решает digest.service по правам)', () => {
    const t = dailyDigestText(facts, { heldVersions: 2, quarantined: 5 });
    expect(t).toContain('Раздел «Админка»');
    expect(t).toContain('Удержанных версий базы «Админки»: 2');
    expect(dailyDigestText(facts, null)).not.toContain('Админк');
  });

  it('самый длинный вход — ≤ 4 096 символов (предел Telegram), без обрыва посреди строки', () => {
    const long: SiteDigestFacts = {
      ...facts,
      siteName: 'Я'.repeat(5000),
      dialogs: Number.MAX_SAFE_INTEGER,
      dialogsPrev: 1,
      resolved: Number.MAX_SAFE_INTEGER,
      operatorHours: Number.MAX_SAFE_INTEGER,
      handoffs: Number.MAX_SAFE_INTEGER,
      handoffsMissed: Number.MAX_SAFE_INTEGER,
      leads: Number.MAX_SAFE_INTEGER,
      conversionsDirect: Number.MAX_SAFE_INTEGER,
      conversionsAssisted: Number.MAX_SAFE_INTEGER,
      newTopics: Number.MAX_SAFE_INTEGER,
      heldVersions: Number.MAX_SAFE_INTEGER,
      goldenConflicts: Number.MAX_SAFE_INTEGER,
      alerts: ['unknown_spike', 'thumbs_down_spike', 'handoff_spike'],
      findings: Array(50).fill('Ж'.repeat(3000)),
    };
    const admin = {
      heldVersions: Number.MAX_SAFE_INTEGER,
      quarantined: Number.MAX_SAFE_INTEGER,
    };
    for (const t of [
      weeklyReportText(long, admin),
      dailyDigestText(long, admin),
    ]) {
      expect(t.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(
        t.split('\n').filter((l) => l.startsWith('• ')).length,
      ).toBeLessThanOrEqual(FINDINGS_MAX);
    }
    // Находка и название — не длиннее своих пределов (+ маркер «• »).
    for (const l of weeklyReportText(long, admin).split('\n')) {
      expect(l.length).toBeLessThanOrEqual(FINDING_MAX + 160);
    }
    // Даже 3 находки по 3000 символов не ломают предел — обрезаются по строкам.
    expect(weeklyReportText(long, admin)).toContain('Раздел «Админка»');
  });

  it('управляющие символы из названия сайта не попадают в текст', () => {
    const t = dailyDigestText({ ...facts, siteName: 'A\u0000B\u001bC' }, null);
    expect(t).toContain('«ABC»');
  });

  it('склейка с пределом Telegram: лишние строки отбрасываются целиком, в конце «…»', () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `${i}:${'ы'.repeat(98)}`,
    );
    const t = fitTelegram(lines);
    expect(t.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(t.endsWith('\n…')).toBe(true);
    for (const l of t.split('\n').slice(0, -1)) expect(lines).toContain(l);
    expect(fitTelegram(['a', 'b'])).toBe('a\nb');
  });
});
