import {
  GENERATE_ROTATION_SETTING_KEY,
  orderByStaleness,
  parseGenerateStamps,
  rotationKey,
  serializeGenerateStamps,
} from './generate-rotation';

const pair = (locale: string, key: string) => ({ locale, key });

describe('parseGenerateStamps', () => {
  it('ключ настройки — свой, не чужой', () => {
    // Совпади он с `tutorial.scenarioLocales`, карта затёрла бы список
    // локалей в первую же ночь.
    expect(GENERATE_ROTATION_SETTING_KEY).toBe(
      'tutorial.scenarioGenerateStamps',
    );
  });

  it('пусто или мусор — пустая карта, а не исключение', () => {
    expect(parseGenerateStamps(null).size).toBe(0);
    expect(parseGenerateStamps('').size).toBe(0);
    expect(parseGenerateStamps('{не json').size).toBe(0);
    expect(parseGenerateStamps('["ru","en"]').size).toBe(0);
    expect(parseGenerateStamps('42').size).toBe(0);
  });

  it('битая запись выбрасывается, годные остаются', () => {
    const stamps = parseGenerateStamps(
      JSON.stringify({
        'ru:1': '2026-09-30T02:00:00.000Z',
        'ru:2': 'вчера',
        'en:1': 12345,
      }),
    );
    expect([...stamps.keys()]).toEqual(['ru:1']);
    expect(stamps.get('ru:1')).toBe(Date.parse('2026-09-30T02:00:00.000Z'));
  });

  it('сериализация и разбор — взаимно обратны на парах круга', () => {
    const stamps = new Map([
      [rotationKey('ru', '1'), Date.parse('2026-09-29T02:00:00.000Z')],
      [rotationKey('de', '3'), Date.parse('2026-09-28T02:00:00.000Z')],
    ]);
    const raw = serializeGenerateStamps(stamps, [pair('ru', '1')]);
    expect(JSON.parse(raw)).toEqual({ 'ru:1': '2026-09-29T02:00:00.000Z' });
    expect(parseGenerateStamps(raw).get('ru:1')).toBe(stamps.get('ru:1'));
  });
});

describe('orderByStaleness', () => {
  it('без отметок — исходный порядок (первая ночь после выката как раньше)', () => {
    const pairs = [pair('ru', '1'), pair('ru', '2'), pair('en', '1')];
    expect(orderByStaleness(pairs, new Map())).toEqual(pairs);
  });

  it('без отметки — впереди всех, дальше по давности', () => {
    const pairs = [pair('ru', '1'), pair('ru', '2'), pair('en', '1')];
    const stamps = new Map([
      ['ru:1', 300],
      ['ru:2', 100],
    ]);
    expect(orderByStaleness(pairs, stamps)).toEqual([
      pair('en', '1'),
      pair('ru', '2'),
      pair('ru', '1'),
    ]);
  });

  it('равная давность — исходный порядок (сортировка стабильна)', () => {
    const pairs = [pair('ru', '1'), pair('en', '1'), pair('uk', '1')];
    const stamps = new Map([
      ['ru:1', 5],
      ['en:1', 5],
      ['uk:1', 5],
    ]);
    expect(orderByStaleness(pairs, stamps)).toEqual(pairs);
  });

  it('не мутирует входной список', () => {
    const pairs = [pair('ru', '1'), pair('en', '1')];
    orderByStaleness(pairs, new Map([['ru:1', 1]]));
    expect(pairs).toEqual([pair('ru', '1'), pair('en', '1')]);
  });

  /*
   * Боевой размер из doc/TODO.md: пять локалей × (десять шагов мастера
   * + пять тем поздравления) = 75 пар, за ночь бюджет пропускает ≈28
   * (4 мин по ≈8.5 с). Без ротации последние 47 пар не доходили
   * никогда; с ней круг — ⌈75 / 28⌉ = 3 ночи, и дальше так же
   * по кругу.
   */
  it('75 пар по 28 за ночь — полный круг за 3 ночи, и без пропусков дальше', () => {
    const locales = ['ru', 'uk', 'en', 'es', 'de'];
    const keys = [
      ...Array.from({ length: 10 }, (_, i) => String(i + 1)),
      'greeting-brief',
      'greeting-voice',
      'greeting-music',
      'greeting-style',
      'greeting-final',
    ];
    const circle = locales.flatMap((l) => keys.map((k) => pair(l, k)));
    expect(circle).toHaveLength(75);

    const PER_NIGHT = 28;
    const stamps = new Map<string, number>();
    const lastNight = new Map<string, number>();
    const maxGap = new Map<string, number>();
    let coveredAfterThird = 0;
    for (let night = 1; night <= 12; night++) {
      // Через сериализацию — как в жизни, где карта переживает ночь в
      // настройке.
      const loaded = parseGenerateStamps(
        serializeGenerateStamps(stamps, circle),
      );
      const taken = orderByStaleness(circle, loaded).slice(0, PER_NIGHT);
      for (const p of taken) {
        const k = rotationKey(p.locale, p.key);
        const prev = lastNight.get(k) ?? 0;
        maxGap.set(k, Math.max(maxGap.get(k) ?? 0, night - prev));
        lastNight.set(k, night);
        stamps.set(k, night * 86_400_000);
      }
      if (night === 3) coveredAfterThird = lastNight.size;
    }
    expect(coveredAfterThird).toBe(75);
    // Ни одна пара не ждёт дольше трёх ночей — ни в первом круге, ни
    // в последующих.
    expect(Math.max(...maxGap.values())).toBeLessThanOrEqual(3);
  });
});
