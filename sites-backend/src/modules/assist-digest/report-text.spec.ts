/**
 * Тексты сводки и отчёта недели (A, §5-тер.16 п.9): ≤ 4 096 символов на
 * самом длинном входе; раздел «Админка» — только если передан; слова
 * атрибуции — строго §5-тер.2; каждое число — из входа.
 */
import {
  appendAdminWeekly,
  DIGEST_LANGS,
  FINDINGS_MAX,
  digestTexts,
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

describe('report-text — «Админка»: мемо «требует проверки» и якорь журнала (заход 9)', () => {
  const head = {
    hash: 'a'.repeat(64),
    id: 'clog123',
    at: '2026-10-04T21:15:00.000Z',
  };
  const admin = {
    heldVersions: 0,
    quarantined: 0,
    memosNeedReview: [
      { number: 3, code: 'pin_mismatch', step: 2 },
      { number: 9, code: 'goal_low', step: null },
      { number: 12, code: 'failures', step: 1 },
      { number: 14, code: null, step: null },
    ],
    memosNeedReviewTotal: 6,
    chainHead: head,
  };

  it('§5-бис.17 п.8: строка «АМ-N требует проверки» с причиной — в сводке и в отчёте недели', () => {
    for (const t of [
      dailyDigestText(facts, admin),
      weeklyReportText(facts, admin),
    ]) {
      expect(t).toContain(
        'Мемо АМ-3 требует проверки: шаг 2 не находится на странице админки',
      );
      expect(t).toContain(
        'Мемо АМ-9 требует проверки: часто не доходит до цели',
      );
      expect(t).toContain(
        'Мемо АМ-12 требует проверки: сбои на шаге 1 у нескольких сотрудников',
      );
      expect(t).toContain('Мемо АМ-14 требует проверки: нужна проверка');
      expect(t).toContain('…и ещё мемо «требует проверки»: 2');
    }
    // Без раздела «Админка» (менеджер «Сайта») — ни мемо, ни якоря.
    expect(weeklyReportText(facts, null)).not.toMatch(
      /АМ-|chain|Журнал действий/,
    );
  });

  it('Р-З9-20: голова цепочки — только в отчёте недели, с хешем и id', () => {
    const w = weeklyReportText(facts, admin);
    expect(w).toContain(
      `Журнал действий — контрольная запись на 04.10.2026: ${head.hash} (id ${head.id})`,
    );
    expect(dailyDigestText(facts, admin)).not.toContain(head.hash);
    expect(
      weeklyReportText(facts, { ...admin, chainHead: null }),
    ).not.toContain('Журнал действий');
  });
});

describe('report-text — язык получателя (заход 10, Р-З10-14)', () => {
  const admin = {
    heldVersions: 2,
    quarantined: 5,
    memosNeedReview: [
      { number: 3, code: 'pin_mismatch', step: 2 },
      { number: 9, code: 'goal_low', step: null },
      { number: 12, code: 'failures', step: 1 },
      { number: 14, code: null, step: null },
    ],
    memosNeedReviewTotal: 6,
    chainHead: {
      hash: 'b'.repeat(64),
      id: 'clog9',
      at: '2026-10-04T21:15:00.000Z',
    },
  };
  const latin: SiteDigestFacts = {
    ...facts,
    siteName: 'Teplo Shop',
    alerts: ['unknown_spike', 'thumbs_down_spike', 'handoff_spike'],
    findings: ['Too expensive on /cart — Show installments'],
  };
  const numbers = (t: string) => (t.match(/\d+/g) ?? []).sort();

  it('рамка целиком на языке: uk — без русских букв и слов; en — без кириллицы; ru — по умолчанию (как раньше)', () => {
    for (const weekly of [true, false]) {
      const fn = weekly ? weeklyReportText : dailyDigestText;
      const uk = fn(latin, admin, 'uk');
      expect(uk).toContain(weekly ? 'Звіт тижня' : 'Ранкове зведення');
      expect(uk).toContain('Діалоги: 120 (+20% до минулого періоду)');
      expect(uk).toContain('Розділ «Адмінка»');
      expect(uk).toContain(
        'Мемо АМ-3 потребує перевірки: крок 2 не знаходиться на сторінці адмінки',
      );
      expect(uk).not.toMatch(/[ыэёъ]|Диалог|Решено|Раздел|Обучение|сводка/);
      const en = fn(latin, admin, 'en');
      expect(en).toContain(weekly ? 'Weekly report' : 'Morning summary');
      expect(en).toContain('Conversations: 120 (+20% vs previous period)');
      expect(en).toContain('Memo AM-12 needs review: failures at step 1');
      expect(en).toContain('≈ 4 h of operator work');
      expect(en).not.toMatch(/[А-Яа-яЁёІіЇїЄєҐґ]/);
      // По умолчанию — русский, как до захода 10.
      expect(fn(latin, admin)).toBe(fn(latin, admin, 'ru'));
      // Числа — одни и те же на всех языках.
      expect(numbers(uk)).toEqual(numbers(fn(latin, admin, 'ru')));
      expect(numbers(en)).toEqual(numbers(fn(latin, admin, 'ru')));
    }
    expect(weeklyReportText(latin, admin, 'en')).toContain(
      `Action log — checkpoint record as of 04.10.2026: ${'b'.repeat(64)} (id clog9)`,
    );
    expect(weeklyReportText(latin, admin, 'uk')).toContain(
      'Перевірити ланцюжок журналу',
    );
  });

  it('у каждого языка — все строки (тревоги, причины мемо, кнопка, строки находок digest.service)', () => {
    for (const l of DIGEST_LANGS) {
      const t = digestTexts(l);
      for (const a of [
        'unknown_spike',
        'thumbs_down_spike',
        'handoff_spike',
      ] as const) {
        expect(t.alerts[a]).toMatch(/^⚠️ /);
      }
      expect(t.button.length).toBeGreaterThan(3);
      expect(t.unanswered('X', 5)).toContain('5');
      expect(t.missedHandoffs(2)).toContain('2');
    }
    expect(digestTexts('en').unanswered('delivery', 5)).toBe(
      'Unanswered: “delivery” — asked by 5 different visitors',
    );
  });

  it('самый длинный вход на каждом языке — ≤ 4 096 символов', () => {
    const long: SiteDigestFacts = {
      ...latin,
      siteName: 'Я'.repeat(5000),
      findings: Array(50).fill('Ж'.repeat(3000)),
    };
    for (const l of DIGEST_LANGS) {
      for (const t of [
        weeklyReportText(long, admin, l),
        dailyDigestText(long, admin, l),
      ]) {
        expect(t.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      }
    }
  });
});

describe('report-text — отчёт недели «Админки» разделом сводки (заход 11, Р-З11-В3)', () => {
  it('раздел дописывается в конец через пустую строку; кнопка «Админки» — на каждом языке', () => {
    const base = weeklyReportText(facts, null, 'uk');
    const out = appendAdminWeekly(
      base,
      '  Тиждень «Адмінки» з 2026-09-28 · М\n\nДіалогів: 3 ',
    );
    expect(out).toBe(
      `${base}\n\nТиждень «Адмінки» з 2026-09-28 · М\n\nДіалогів: 3`,
    );
    expect(digestTexts('uk').admin.weeklyButton).toBe('Статистика «Адмінки»');
    expect(digestTexts('ru').admin.weeklyButton).toBe('Статистика «Админки»');
    expect(digestTexts('en').admin.weeklyButton).toBe('“Admin” statistics');
  });

  it('не влезает в 4 096 символов или пусто — null (отчёт уйдёт отдельно, не обрезанным)', () => {
    const base = 'x'.repeat(TELEGRAM_TEXT_LIMIT - 10);
    expect(appendAdminWeekly(base, 'y'.repeat(8))).toBe(
      `${base}\n\n${'y'.repeat(8)}`,
    );
    expect(appendAdminWeekly(base, 'y'.repeat(9))).toBeNull();
    expect(appendAdminWeekly('сводка', '   ')).toBeNull();
  });
});
