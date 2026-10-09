import {
  issueVoiceTicket,
  readVoiceTicket,
  verifyVoiceTicket,
} from './voice-ticket';

const KEY = Buffer.from('k'.repeat(32));
const now = new Date('2026-10-05T10:00:00Z');
const base = {
  siteId: 's1',
  visitorId: 'v1',
  text: 'Скільки коштує доставка?',
  now,
};

describe('билет голоса (Э5, §7.1)', () => {
  const t = issueVoiceTicket(KEY, { ...base, ttlMs: 600_000 });

  it('свой билет на свой текст — да (пробелы по краям не важны)', () => {
    expect(verifyVoiceTicket(KEY, t, base)).toBe(true);
    expect(
      verifyVoiceTicket(KEY, t, { ...base, text: `  ${base.text} ` }),
    ).toBe(true);
  });

  it('другой текст, посетитель, сайт, ключ, просрочка, мусор — нет', () => {
    expect(verifyVoiceTicket(KEY, t, { ...base, text: 'Інше питання' })).toBe(
      false,
    );
    expect(verifyVoiceTicket(KEY, t, { ...base, visitorId: 'v2' })).toBe(false);
    expect(verifyVoiceTicket(KEY, t, { ...base, siteId: 's2' })).toBe(false);
    expect(verifyVoiceTicket(Buffer.from('x'.repeat(32)), t, base)).toBe(false);
    expect(verifyVoiceTicket(null, t, base)).toBe(false);
    expect(
      verifyVoiceTicket(KEY, t, {
        ...base,
        now: new Date(now.getTime() + 601_000),
      }),
    ).toBe(false);
    expect(
      verifyVoiceTicket(KEY, t.replace(/\.(\d+)\./, '.9999999999.'), base),
    ).toBe(false);
    for (const junk of [null, 42, '', 'v1..', `${t}x`, 'v2' + t.slice(2)]) {
      expect(verifyVoiceTicket(KEY, junk, base)).toBe(false);
    }
  });
  it('заход 11 (Р-З11-Б8): v2 — места неуверенных слов в подписи; слова — из ТЕКСТА; подмена спанов/текста — нет; без спанов — v1', () => {
    const text = 'Яка гарантія на Ксіомі';
    const t2 = issueVoiceTicket(KEY, {
      ...base,
      text,
      ttlMs: 600_000,
      spans: [
        { start: 16, len: 6 },
        { start: 40, len: 3 }, // за пределами текста — отброшен
      ],
    });
    expect(t2).toMatch(/^v2\.\d+\.16-6\.[A-Za-z0-9_-]{43}$/);
    expect(readVoiceTicket(KEY, t2, { ...base, text })).toEqual({
      spans: ['Ксіомі'],
    });
    expect(verifyVoiceTicket(KEY, t2, { ...base, text })).toBe(true);
    // Подменили места — подпись не сходится.
    expect(
      readVoiceTicket(KEY, t2.replace('.16-6.', '.4-8.'), { ...base, text }),
    ).toBeNull();
    // Другой текст той же длины — нет.
    expect(
      readVoiceTicket(KEY, t2, { ...base, text: 'Яка гарантія на Самсун' }),
    ).toBeNull();
    // v1 читается, спанов нет; пустые места — v1.
    expect(readVoiceTicket(KEY, t, base)).toEqual({ spans: [] });
    expect(
      issueVoiceTicket(KEY, { ...base, ttlMs: 600_000, spans: [] }),
    ).toMatch(/^v1\./);
    for (const junk of [
      t2.replace(/^v2/, 'v1'),
      t2.replace('.16-6.', '.16-6_1-1_2-2_3-3.'),
      t2.replace('.16-6.', '..'),
    ])
      expect(readVoiceTicket(KEY, junk, { ...base, text })).toBeNull();
  });
});
