/** Атрибуция (A, §5-тер.2, приёмка §5-тер.16 п.7): direct ≤ 30 мин после клика / assisted / unassisted. */
import { DIRECT_WINDOW_MS, decideAttribution } from './attribution';

const at = new Date('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(at.getTime() - ms);

describe('decideAttribution (A)', () => {
  it('клик по действию помощника ≤ 30 мин назад — direct; позже — assisted (если был ответ)', () => {
    const base = {
      source: 'iframe' as const,
      occurredAt: at,
      conversationHasAnswer: true,
      conversationId: 'c1',
    };
    expect(
      decideAttribution({ ...base, lastAssistClickAt: ago(5 * 60_000) }),
    ).toBe('direct');
    expect(
      decideAttribution({ ...base, lastAssistClickAt: ago(DIRECT_WINDOW_MS) }),
    ).toBe('direct');
    expect(
      decideAttribution({
        ...base,
        lastAssistClickAt: ago(DIRECT_WINDOW_MS + 1000),
      }),
    ).toBe('assisted');
    expect(decideAttribution({ ...base, lastAssistClickAt: null })).toBe(
      'assisted',
    );
    // Клик «из будущего» сверх расхождения часов — не прямой.
    expect(
      decideAttribution({
        ...base,
        lastAssistClickAt: new Date(at.getTime() + 5 * 60_000),
      }),
    ).toBe('assisted');
  });

  it('без диалога или без ответа модели — unassisted; загрузчик — unassisted; builtin — direct; s2s — unknown', () => {
    const b = { occurredAt: at, lastAssistClickAt: null };
    expect(
      decideAttribution({
        ...b,
        source: 'iframe',
        conversationHasAnswer: false,
        conversationId: 'c1',
      }),
    ).toBe('unassisted');
    expect(
      decideAttribution({
        ...b,
        source: 'iframe',
        conversationHasAnswer: false,
        conversationId: null,
      }),
    ).toBe('unassisted');
    expect(
      decideAttribution({
        source: 'loader',
        occurredAt: at,
        lastAssistClickAt: ago(1000),
        conversationHasAnswer: true,
        conversationId: 'c1',
      }),
    ).toBe('unassisted');
    expect(
      decideAttribution({
        ...b,
        source: 'builtin',
        conversationHasAnswer: false,
        conversationId: null,
      }),
    ).toBe('direct');
    expect(
      decideAttribution({
        ...b,
        source: 's2s',
        conversationHasAnswer: false,
        conversationId: null,
      }),
    ).toBe('unknown');
  });
});
