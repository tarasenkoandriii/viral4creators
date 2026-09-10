import { creditPackById, creditPacks } from './billing-pricing';

/**
 * Г-5.2 (аудит 2026-09-08): названия пакетов кредитов уходили клиенту
 * по-русски независимо от локали интерфейса («5 роликов» в
 * `GET /billing/prices` для любого языка). Здесь — только перевод
 * `title`; числа/цены локаль не меняет (проверяются в
 * ai-pricing.spec.ts/billing.service.spec.ts).
 */
describe('creditPacks — локализация названий (Г-5.2)', () => {
  it('без локали — русский текст, как и раньше (нет регресса для старых клиентов)', () => {
    const packs = creditPacks();
    expect(packs.find((p) => p.id === 'small')?.title).toBe('5 роликов');
    expect(packs.find((p) => p.id === 'large')?.title).toBe('20 роликов');
  });

  it('английская локаль — переведённые названия, те же id/credits', () => {
    const ru = creditPacks('ru');
    const en = creditPacks('en');
    expect(en.find((p) => p.id === 'small')?.title).toBe('5 videos');
    expect(en.find((p) => p.id === 'large')?.title).toBe('20 videos');
    // Числа не зависят от локали — переводится только текст.
    expect(en.map((p) => p.credits)).toEqual(ru.map((p) => p.credits));
    expect(en.map((p) => p.stars)).toEqual(ru.map((p) => p.stars));
  });

  it('все пять локалей дают непустой перевод для каждого пакета', () => {
    for (const locale of ['ru', 'uk', 'en', 'de', 'es'] as const) {
      for (const pack of creditPacks(locale)) {
        expect(pack.title.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('creditPackById — локаль передаётся дальше', () => {
  it('находит пакет по id и переводит его title под запрошенную локаль', () => {
    expect(creditPackById('small', 'de')?.title).toBe('5 Videos');
    expect(creditPackById('large', 'es')?.title).toBe('20 vídeos');
  });

  it('неизвестный id — undefined, как и раньше', () => {
    expect(creditPackById('no-such-pack')).toBeUndefined();
  });
});
