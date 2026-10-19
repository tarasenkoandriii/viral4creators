/**
 * Внутренний аудит IA-D2-02 (Р-IA-FXB-2): маска перед провайдером модели
 * закрывает обфусцированный email и ссылки на профили соцсетей (сценарий
 * Y-19 закрытого набора D2: «имя [at] домен [dot] зона», instagram.com/…),
 * не трогая обычный текст, деньги, даты, ссылки на сайт продукта и треды.
 */
import type { PubGeneratorSpec } from './generators/spec';
import { preparePrompt } from './gateway-core';
import { PII_MASK, maskContacts } from './pii-mask';

const masked = (s: string): number => maskContacts(s).masked;

describe('IA-D2-02: обфусцированный email (ru/uk/en)', () => {
  it.each([
    'olena.k [at] example [dot] com',
    'OLENA [AT] EXAMPLE [DOT] COM',
    'ivan(at)example(dot)org',
    'ivan {at} mail {dot} ua',
    'ivan <at> mail <dot> ua',
    'ivan [@] example.com',
    'ivan @ example . com',
    'ivan at gmail dot com',
    'ivan at gmail.com',
    'ivan.p at company.ua',
    'ivan_77 at company.ua',
    'ivan собака ukr крапка net',
    'іван собака приклад точка укр',
    'ivan равлик example крапка com.ua',
    'ivan [собака] example [точка] ru',
  ])('«%s» → маска целиком', (s) => {
    const r = maskContacts(`Пишіть: ${s}, дякуємо`);
    expect(r).toEqual({ text: `Пишіть: ${PII_MASK}, дякуємо`, masked: 1 });
  });

  it('обычный текст с « at », «собака», точками — не маскируется', () => {
    for (const s of [
      'Sign up at example.com today',
      'We meet at noon. Then we go',
      'available at amazon.com',
      'у нас є собака Рекс. Він гарний',
      'Ціна 2 000 грн, 16.10.2026, ID 12345678',
      'сайт demo.example.ua/pricing і https://demo.example.ua/contacts',
    ])
      expect({ s, masked: masked(s) }).toEqual({ s, masked: 0 });
  });
});

describe('IA-D2-02: ссылки на профили соцсетей и ники после метки', () => {
  it.each([
    'instagram.com/olena_k',
    'https://www.instagram.com/olena.k/?hl=uk',
    'instagr.am/olena',
    'facebook.com/olena.k',
    'https://m.facebook.com/profile.php?id=100000',
    'fb.com/olena',
    'm.me/olena',
    'linkedin.com/in/olena-k',
    'https://ua.linkedin.com/in/olena-k',
    'tiktok.com/@olena',
    'x.com/olena_k',
    'twitter.com/olena',
    'threads.net/@olena',
    'youtube.com/@olena',
    'vk.com/olena',
    'reddit.com/u/olena',
    'signal.me/#p/+0000',
  ])('«%s» → маска целиком', (s) => {
    const r = maskContacts(`профіль ${s} — пишіть`);
    expect(r.text).toBe(`профіль ${PII_MASK} — пишіть`);
    expect(r.masked).toBeGreaterThanOrEqual(1);
  });

  it('ник после метки мессенджера: маскируется ник, метка остаётся; фраза после метки — нет', () => {
    expect(maskContacts('Telegram: olena_k').text).toBe(
      `Telegram: ${PII_MASK}`,
    );
    expect(maskContacts('Інстаграм — olena.k').text).toBe(
      `Інстаграм — ${PII_MASK}`,
    );
    expect(maskContacts('вайбер: olena2026').text).toBe(`вайбер: ${PII_MASK}`);
    expect(maskContacts('Telegram: ivanpetrov').text).toBe(
      `Telegram: ${PII_MASK}`,
    );
    expect(masked('Instagram: stories and reels')).toBe(0);
    expect(masked('Telegram: 500 підписників')).toBe(0);
  });

  it('@-упоминание — контакт (P-A1, как и раньше); ссылки на треды и другие домены — нет', () => {
    expect(maskContacts('пишіть @olena_k').text).toBe(`пишіть ${PII_MASK}`);
    for (const s of [
      'reddit.com/r/marketing/comments/abc/title',
      'netflix.com/title/123',
      'box.com/s/abc',
      'instagram.com', // упоминание платформы без профиля
    ])
      expect({ s, masked: masked(s) }).toEqual({ s, masked: 0 });
  });
});

describe('IA-D2-02: исходный сценарий Y-19 — промпт провайдеру', () => {
  it('источник со всеми формами контакта: в user-промпте нет ни одной; id источника сохранён', () => {
    const spec = {
      buildPrompt: (
        _input: unknown,
        ctx: { sources: Array<{ id: string; fragment: string }> },
      ) => ({
        system: 'sys',
        user: ctx.sources.map((x) => `${x.id}: ${x.fragment}`).join('\n'),
      }),
    } as unknown as PubGeneratorSpec<unknown, unknown>;
    const id = 'cmvf5tbg9000bp97d9xp5cden';
    const fragment =
      'Контакти: тел. +00 67 000 11 22, olena@example.invalid, t.me/olena_k, ' +
      'olena.k [at] example [dot] invalid, ivan(at)mail(dot)invalid, ' +
      'instagram.com/olena_k, facebook.com/olena.k, linkedin.com/in/olena-k, ' +
      'tiktok.com/@olena, x.com/olena_k, Telegram: olena_k. Ціна 2 000 грн.';
    const { prompt, masked: n } = preparePrompt(spec, {}, {
      rulesVersion: 'ctx@1',
      audience: 'internal',
      sources: [
        {
          id,
          title: null,
          fragment,
          visibility: 'public',
          injectionFlag: null,
        },
      ],
      facts: [],
      offer: null,
    } as never);
    expect(prompt.user).not.toMatch(
      /olena|ivan|example|instagram|facebook|linkedin|tiktok|x\.com|\[at\]|\(at\)|000 11 22/,
    );
    expect(prompt.user).toContain(id);
    expect(prompt.user).toContain('Ціна 2 000 грн');
    expect(n).toBe(11);
  });
});

describe('IA-D1-04: email в кодировках, «по буквам», кириллические зоны и punycode', () => {
  it.each([
    'ivan%40gmail.com',
    'ivan%40gmail%2Ecom',
    'ivan&#64;gmail.com',
    'ivan&#064;gmail.com',
    'ivan&#x40;gmail.com',
    'ivan&commat;gmail&period;com',
    'i v a n @ g m a i l . c o m',
    'ivan @ g m a i l . c o m',
    'i v a n @ gmail.com',
    'ivan@почта.укр',
    'ivan@пошта.укр',
    'ivan [at] пошта [dot] укр',
    'ivan at mail dot рф',
    'ivan(at)example(dot)бел',
    'ivan@xn--80a1acny.xn--j1amh',
    'ivan [at] xn--d1acufc [dot] xn--p1ai',
  ])('«%s» → маска целиком', (s) => {
    expect(maskContacts(`Пишіть: ${s}, дякуємо`)).toEqual({
      text: `Пишіть: ${PII_MASK}, дякуємо`,
      masked: 1,
    });
  });

  it('без ложных срабатываний: проценты, HTML-сущности в тексте, одиночные буквы', () => {
    for (const s of [
      'знижка 40%, ще 40 % і 100%40',
      '&amp; &lt;b&gt;текст&lt;/b&gt; &nbsp; &#169; &#64; і &commat;',
      'варіанти a b c d e',
      'пункти: 1 2 3 . 4',
      'ціна 2 000 грн, 16.10.2026',
      'HTML: <a href="https://demo.example.ua/">сайт</a>',
    ])
      expect({ s, masked: masked(s) }).toEqual({ s, masked: 0 });
  });
});
