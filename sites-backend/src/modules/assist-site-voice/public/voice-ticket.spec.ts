import { issueVoiceTicket, verifyVoiceTicket } from './voice-ticket';

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
});
