import {
  DEFAULT_MUSIC_VOLUME,
  userTrackUrl,
  MAX_MUSIC_THEMES,
  findThemeForOccasion,
  parseMusicCatalog,
  themesForOccasion,
} from './greeting-music';

const theme = (over: Record<string, unknown> = {}) => ({
  id: 'warm',
  title: 'Тёплая',
  url: 'https://blob.test/warm.mp3',
  ...over,
});

const json = (value: unknown) => JSON.stringify(value);

describe('parseMusicCatalog', () => {
  it('пустая настройка — пустой каталог, а не ошибка', () => {
    // Это рабочее состояние: код уезжает в прод тёмным и включается
    // загрузкой первой темы.
    for (const raw of [null, '', '   ']) {
      expect(parseMusicCatalog(raw)).toEqual([]);
    }
  });

  it('сломанный JSON не роняет разбор', () => {
    expect(parseMusicCatalog('{не json')).toEqual([]);
  });

  it('читает и голый массив, и { themes: [...] }', () => {
    expect(parseMusicCatalog(json([theme()]))).toHaveLength(1);
    expect(parseMusicCatalog(json({ themes: [theme()] }))).toHaveLength(1);
  });

  it('одна кривая запись не гасит остальные', () => {
    // Значение печатает человек в админке: опечатка в десятой теме не
    // должна отключать девять рабочих.
    const catalog = parseMusicCatalog(
      json([theme(), { id: 'плохой id' }, theme({ id: 'calm' })]),
    );
    expect(catalog.map((t) => t.id)).toEqual(['warm', 'calm']);
  });

  it('не-https ссылки отбрасываются', () => {
    // Ссылка уходит стороннему ffmpeg-сервису: http можно подменить по
    // дороге, file:// и data: — попросить сервис прочитать своё.
    for (const url of [
      'http://blob.test/x.mp3',
      'file:///etc/passwd',
      'data:audio/mp3;base64,AAA',
      'не ссылка',
      '',
    ]) {
      expect(parseMusicCatalog(json([theme({ url })]))).toEqual([]);
    }
  });

  it('дубль id отбрасывается — иначе выбор указывал бы на две темы', () => {
    const catalog = parseMusicCatalog(
      json([theme({ title: 'Первая' }), theme({ title: 'Вторая' })]),
    );
    expect(catalog).toHaveLength(1);
    expect(catalog[0].title).toBe('Первая');
  });

  it('без названия подставляется id, а не пустая строка', () => {
    expect(parseMusicCatalog(json([theme({ title: '  ' })]))[0].title).toBe(
      'warm',
    );
  });

  it('каталог ограничен по размеру', () => {
    const many = Array.from({ length: MAX_MUSIC_THEMES + 5 }, (_, i) =>
      theme({ id: `t${i}` }),
    );
    expect(parseMusicCatalog(json(many))).toHaveLength(MAX_MUSIC_THEMES);
  });

  it('неизвестные поводы отсеиваются, поле остаётся массивом', () => {
    // Пустой массив после фильтрации — это «перечислили мусор», а не
    // «подходит всем»: иначе фанфары уехали бы под соболезнование.
    const catalog = parseMusicCatalog(
      json([theme({ occasions: ['BIRTHDAY', 'НЕ_ПОВОД'] })]),
    );
    expect(catalog[0].occasions).toEqual(['BIRTHDAY']);
    const onlyGarbage = parseMusicCatalog(
      json([theme({ occasions: ['НЕ_ПОВОД'] })]),
    );
    expect(onlyGarbage[0].occasions).toEqual([]);
  });

  it('поле occasions отсутствует — тема общая', () => {
    expect(parseMusicCatalog(json([theme()]))[0].occasions).toBeNull();
  });
});

describe('themesForOccasion / findThemeForOccasion', () => {
  const catalog = parseMusicCatalog(
    json([
      theme({ id: 'common' }),
      theme({ id: 'party', occasions: ['BIRTHDAY'] }),
      theme({ id: 'quiet', occasions: ['CONDOLENCE'] }),
      theme({ id: 'garbage-only', occasions: ['НЕ_ПОВОД'] }),
    ]),
  );

  it('общая тема подходит любому поводу', () => {
    expect(themesForOccasion(catalog, 'BIRTHDAY').map((t) => t.id)).toContain(
      'common',
    );
    expect(themesForOccasion(catalog, 'CONDOLENCE').map((t) => t.id)).toContain(
      'common',
    );
  });

  it('праздничная тема не доезжает до соболезнования', () => {
    expect(
      themesForOccasion(catalog, 'CONDOLENCE').map((t) => t.id),
    ).not.toContain('party');
  });

  it('тема с пустым списком поводов не подходит никому', () => {
    for (const occasion of ['BIRTHDAY', 'CONDOLENCE'] as const) {
      expect(
        themesForOccasion(catalog, occasion).map((t) => t.id),
      ).not.toContain('garbage-only');
    }
  });

  it('поиск по id уважает повод — смена повода обнуляет чужую тему', () => {
    expect(findThemeForOccasion(catalog, 'BIRTHDAY', 'party')?.id).toBe(
      'party',
    );
    expect(findThemeForOccasion(catalog, 'CONDOLENCE', 'party')).toBeNull();
  });

  it('регистр id не важен', () => {
    expect(findThemeForOccasion(catalog, 'BIRTHDAY', '  PARTY ')?.id).toBe(
      'party',
    );
  });

  it('неизвестный id — null', () => {
    expect(findThemeForOccasion(catalog, 'BIRTHDAY', 'нет-такой')).toBeNull();
  });
});

describe('громкость подложки', () => {
  it('музыка тише голоса, но слышна', () => {
    expect(DEFAULT_MUSIC_VOLUME).toBeGreaterThan(0);
    expect(DEFAULT_MUSIC_VOLUME).toBeLessThan(0.5);
  });
});

describe('userTrackUrl — ссылка от пользователя строже каталожной', () => {
  it('обычная https-ссылка проходит', () => {
    expect(userTrackUrl('https://cdn.example.com/track.mp3')).toBe(
      'https://cdn.example.com/track.mp3',
    );
  });

  it('http, file и data отвергаются, как и в каталоге', () => {
    for (const url of [
      'http://cdn.example.com/track.mp3',
      'file:///etc/passwd',
      'data:audio/mp3;base64,AAA',
      'не ссылка',
      '',
      null,
    ]) {
      expect(userTrackUrl(url)).toBeNull();
    }
  });

  it('домашние и служебные адреса отвергаются с внятным отказом сразу', () => {
    // Сами мы ссылку не скачиваем — её открывает сторонний
    // ffmpeg-сервис, и такие адреса у него не разрешатся никогда.
    // Проверка нужна ради внятного отказа сейчас, а не падения задачи
    // через минуту.
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.10',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      'nas.local',
    ]) {
      expect(userTrackUrl(`https://${host}/track.mp3`)).toBeNull();
    }
  });

  it('публичные адреса из похожих диапазонов не задеты', () => {
    // 172.32 и 11.x в приватные диапазоны не входят — перестраховка
    // не должна отрезать рабочие адреса.
    for (const host of ['172.32.0.1', '11.0.0.1', 'local.example.com']) {
      expect(userTrackUrl(`https://${host}/track.mp3`)).not.toBeNull();
    }
  });

  it('логин с паролем в адресе отвергается', () => {
    // Иначе чужие учётные данные легли бы в снимок сессии и уехали
    // ffmpeg-сервису.
    expect(userTrackUrl('https://user:pass@cdn.example.com/t.mp3')).toBeNull();
    expect(userTrackUrl('https://user@cdn.example.com/t.mp3')).toBeNull();
  });
});
