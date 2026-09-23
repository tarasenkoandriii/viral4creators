import {
  AudioRequest,
  NormalizedAudioTrack,
  bpmCenter,
  buildAttribution,
  normalizeCcLicense,
  scoreTrack,
  trackPassesFilter,
} from './audio.types';

const track = (
  over: Partial<NormalizedAudioTrack> = {},
): NormalizedAudioTrack => ({
  provider: 'freesound',
  providerTrackId: '1',
  kind: 'music',
  title: 'Тема',
  artist: 'Автор',
  durationSec: 30,
  mood: [],
  genre: [],
  tags: [],
  audioUrl: 'https://cdn.test/a.mp3',
  license: { type: 'CC0-1.0', commercialUse: true, attributionRequired: false },
  ...over,
});

const req = (over: Partial<AudioRequest> = {}): AudioRequest => ({
  kind: 'music',
  ...over,
});

describe('normalizeCcLicense', () => {
  it('CC0 — можно всё и упоминать никого не нужно', () => {
    const l = normalizeCcLicense(
      'http://creativecommons.org/publicdomain/zero/1.0/',
    );
    expect(l.type).toBe('CC0-1.0');
    expect(l.commercialUse).toBe(true);
    expect(l.attributionRequired).toBe(false);
  });

  it('CC-BY — можно, но автора назвать обязаны', () => {
    const l = normalizeCcLicense('http://creativecommons.org/licenses/by/4.0/');
    expect(l.type).toBe('CC-BY-4.0');
    expect(l.commercialUse).toBe(true);
    expect(l.attributionRequired).toBe(true);
  });

  it('NC — коммерческое использование запрещено', () => {
    // Поздравление делается в платном продукте: NC сюда не подходит.
    const l = normalizeCcLicense(
      'http://creativecommons.org/licenses/by-nc/4.0/',
    );
    expect(l.commercialUse).toBe(false);
  });

  it('неизвестная лицензия НЕ считается разрешительной', () => {
    // «Мы не знаем» — это не «наверное можно»: рисковать чужим
    // поздравлением на таком основании нельзя.
    for (const url of ['', 'https://example.com/whatever', 'мусор']) {
      const l = normalizeCcLicense(url);
      expect(l.type).toBe('unknown');
      expect(l.commercialUse).toBe(false);
    }
  });
});

describe('trackPassesFilter', () => {
  it('по умолчанию отсекает некоммерческие лицензии', () => {
    const nc = track({
      license: {
        type: 'CC-BY-NC',
        commercialUse: false,
        attributionRequired: true,
      },
    });
    expect(trackPassesFilter(nc, req())).toBe(false);
  });

  it('трек, требующий покупки лицензии, отсекается по запросу', () => {
    // Таков бесплатный тариф Jamendo: показывать его в выдаче значит
    // предлагать нарушение.
    // Именно «коммерческое можно, но за деньги»: иначе проверку
    // сделала бы предыдущая ветка, и эта осталась бы непроверенной.
    const paid = track({
      license: {
        type: 'jamendo-commercial-unpaid',
        commercialUse: true,
        attributionRequired: false,
        requiresPaidLicense: true,
      },
    });
    expect(trackPassesFilter(paid, req({ allowPaidLicense: false }))).toBe(
      false,
    );
  });

  it('купленная коммерческая лицензия проходит', () => {
    const owned = track({
      license: {
        type: 'jamendo-commercial',
        commercialUse: true,
        attributionRequired: false,
        requiresPaidLicense: false,
      },
    });
    expect(trackPassesFilter(owned, req({ allowPaidLicense: false }))).toBe(
      true,
    );
  });

  it('атрибуцию можно запретить отдельно от коммерческого использования', () => {
    const by = track({
      license: {
        type: 'CC-BY-4.0',
        commercialUse: true,
        attributionRequired: true,
      },
    });
    expect(trackPassesFilter(by, req({ allowAttribution: false }))).toBe(false);
    expect(trackPassesFilter(by, req({ allowAttribution: true }))).toBe(true);
  });

  it('темп вне окна отсекается, неизвестный темп — нет', () => {
    expect(
      trackPassesFilter(track({ bpm: 200 }), req({ bpmRange: [80, 120] })),
    ).toBe(false);
    expect(
      trackPassesFilter(track({ bpm: 100 }), req({ bpmRange: [80, 120] })),
    ).toBe(true);
    // Отсутствие BPM — не повод отсеивать: Jamendo его вовсе не отдаёт.
    expect(trackPassesFilter(track(), req({ bpmRange: [80, 120] }))).toBe(true);
  });
});

describe('scoreTrack', () => {
  it('совпадение настроения поднимает трек', () => {
    const warm = track({ tags: ['warm', 'piano'] });
    const other = track({ tags: ['metal'] });
    const r = req({ mood: ['warm'] });
    expect(scoreTrack(warm, r)).toBeGreaterThan(scoreTrack(other, r));
  });

  it('близкая длительность лучше далёкой', () => {
    const r = req({ durationSec: 30 });
    expect(scoreTrack(track({ durationSec: 32 }), r)).toBeGreaterThan(
      scoreTrack(track({ durationSec: 300 }), r),
    );
  });

  it('регистр тегов не мешает совпадению', () => {
    const r = req({ genre: ['Piano'] });
    expect(scoreTrack(track({ genre: ['piano'] }), r)).toBeGreaterThan(0);
  });
});

describe('buildAttribution', () => {
  it('без обязательства — пусто', () => {
    expect(buildAttribution(track())).toBeUndefined();
  });

  it('готовая строка провайдера побеждает собранную', () => {
    const t = track({
      license: {
        type: 'CC-BY-4.0',
        commercialUse: true,
        attributionRequired: true,
        attributionText: 'точная строка',
      },
    });
    expect(buildAttribution(t)).toBe('точная строка');
  });

  it('без готовой строки собирается из названия и автора', () => {
    const t = track({
      license: {
        type: 'CC-BY-4.0',
        commercialUse: true,
        attributionRequired: true,
      },
    });
    expect(buildAttribution(t)).toContain('Тема');
    expect(buildAttribution(t)).toContain('Автор');
    expect(buildAttribution(t)).toContain('CC-BY-4.0');
  });
});

describe('bpmCenter', () => {
  it('середина окна, или ничего', () => {
    expect(bpmCenter([80, 120])).toBe(100);
    expect(bpmCenter(undefined)).toBeUndefined();
  });
});
