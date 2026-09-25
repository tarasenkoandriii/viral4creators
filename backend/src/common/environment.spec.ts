import { envKey, envKeyOf, normalizeEnvironment } from './environment';

describe('normalizeEnvironment', () => {
  const minimal = { surface: 'TMA', deviceKind: 'PHONE' };

  it('отказывает без поверхности и вида устройства', () => {
    // Без них запись не отвечает ни на один вопрос о воспроизводимости.
    expect(normalizeEnvironment(null)).toBeNull();
    expect(normalizeEnvironment('TMA')).toBeNull();
    expect(normalizeEnvironment({ surface: 'TMA' })).toBeNull();
    expect(normalizeEnvironment({ deviceKind: 'PHONE' })).toBeNull();
  });

  it('отказывает на значениях вне закрытого списка', () => {
    // Клиент подделывается тривиально, а по поверхности потом группируют.
    expect(
      normalizeEnvironment({ surface: 'DESKTOP', deviceKind: 'PHONE' }),
    ).toBeNull();
    expect(
      normalizeEnvironment({ surface: 'TMA', deviceKind: 'WATCH' }),
    ).toBeNull();
  });

  it('принимает голый минимум — остальные поля необязательны', () => {
    const env = normalizeEnvironment(minimal);
    expect(env).not.toBeNull();
    expect(env?.osFamily).toBe('unknown');
    expect(env?.appBuild).toBe('unknown');
    expect(env?.ua).toBeNull();
    expect(env?.screen).toBeNull();
    expect(env?.network).toBeNull();
  });

  it('обрезает длинные строки', () => {
    const env = normalizeEnvironment({ ...minimal, ua: 'x'.repeat(5000) });
    expect(env?.ua).toHaveLength(512);
  });

  it('обрезает короткие поля строже длинных', () => {
    // `osFamily` — это `ios`/`android`; строка на 512 там означала бы,
    // что в семейство ОС кто-то положил не семейство ОС.
    const env = normalizeEnvironment({
      ...minimal,
      osFamily: 'a'.repeat(200),
      ua: 'b'.repeat(200),
    });
    expect(env?.osFamily).toHaveLength(32);
    expect(env?.ua).toHaveLength(200);
  });

  it('пустые и небуквенные строки становятся null, а не пустой строкой', () => {
    const env = normalizeEnvironment({ ...minimal, ua: '   ', network: 42 });
    expect(env?.ua).toBeNull();
    expect(env?.network).toBeNull();
  });

  it('половина размера отбрасывается целиком', () => {
    // «не влезло» читается только по паре: одна сторона бесполезна.
    const env = normalizeEnvironment({ ...minimal, viewport: { w: 390 } });
    expect(env?.viewport).toBeNull();
  });

  it('отбрасывает заведомо невозможные размеры', () => {
    expect(
      normalizeEnvironment({ ...minimal, viewport: { w: 0, h: 800 } })
        ?.viewport,
    ).toBeNull();
    expect(
      normalizeEnvironment({ ...minimal, viewport: { w: 1e9, h: 800 } })
        ?.viewport,
    ).toBeNull();
    expect(
      normalizeEnvironment({ ...minimal, viewport: { w: -390, h: 800 } })
        ?.viewport,
    ).toBeNull();
  });

  it('округляет размеры и плотность', () => {
    const env = normalizeEnvironment({
      ...minimal,
      screen: { w: 390.5, h: 844.2, dpr: 2.6666 },
    });
    expect(env?.screen).toEqual({ w: 391, h: 844, dpr: 2.67 });
  });

  it('тему берёт только из закрытого списка', () => {
    // Значение приходит из класса на <html> и бывает ровно двух видов;
    // третье означало бы, что снимок собран не тем кодом.
    expect(normalizeEnvironment({ ...minimal, theme: 'dark' })?.theme).toBe(
      'dark',
    );
    expect(
      normalizeEnvironment({ ...minimal, theme: 'auto' })?.theme,
    ).toBeNull();
    expect(normalizeEnvironment(minimal)?.theme).toBeNull();
  });

  it('касания — небольшое неотрицательное целое', () => {
    // По ним отличают iPad от Mac; мусор в этом поле превращает планшет
    // в настольный компьютер, поэтому границы жёсткие.
    const touch = (v: unknown) =>
      normalizeEnvironment({ ...minimal, maxTouchPoints: v })?.maxTouchPoints;
    expect(touch(5)).toBe(5);
    expect(touch(0)).toBe(0);
    expect(touch(-1)).toBeNull();
    expect(touch(1e6)).toBeNull();
    expect(touch('5')).toBeNull();
    expect(touch(undefined)).toBeNull();
  });

  it('плотность без числа не роняет экран', () => {
    const env = normalizeEnvironment({
      ...minimal,
      screen: { w: 390, h: 844, dpr: 'two' },
    });
    expect(env?.screen).toEqual({ w: 390, h: 844, dpr: 1 });
  });
});

describe('envKey', () => {
  const base = {
    scenario: 'PRODUCT_VIDEO',
    stepId: 'prompt',
    surface: 'TMA' as const,
    tgPlatform: 'ios',
    osFamily: 'ios',
    uiLocale: 'ru',
  };

  it('строит ключ в нижнем регистре', () => {
    expect(envKey(base)).toBe('product_video:prompt:tma:ios:ru');
  });

  it('пустые части не схлопываются', () => {
    // Ключ из четырёх двоеточий читается и сравнивается; ключ из трёх —
    // уже другой ключ, и группы разойдутся молча.
    expect(
      envKey({ ...base, scenario: null, stepId: null, uiLocale: '' }),
    ).toBe('-:-:tma:ios:-');
  });

  it('без платформы Telegram берёт семейство ОС', () => {
    expect(envKey({ ...base, tgPlatform: null, osFamily: 'windows' })).toBe(
      'product_video:prompt:tma:windows:ru',
    );
  });

  it('локаль различает группы', () => {
    // У «поехала вёрстка» язык — такая же часть условия, что платформа:
    // длина слова в немецком и в русском разная.
    expect(envKey({ ...base, uiLocale: 'de' })).not.toBe(envKey(base));
  });

  it('envKeyOf берёт поля из окружения, а не из клиентского ключа', () => {
    const env = normalizeEnvironment({
      surface: 'BROWSER',
      deviceKind: 'DESKTOP',
      osFamily: 'windows',
      tgPlatform: null,
      uiLocale: 'de',
    });
    expect(envKeyOf(env!, { scenario: 'CLIENT_SITE', stepId: 'brief' })).toBe(
      'client_site:brief:browser:windows:de',
    );
  });
});
