/**
 * Разделение сессии на две колонки (В-4.2 третьего аудита, этап 122).
 *
 * Ошибка здесь тихая: ключ, попавший не в ту колонку, всё равно
 * прочитается (при чтении колонки сливаются) — потеряется только смысл
 * разделения, то есть экономия, ради которой всё и делалось. А ключ,
 * попавший в ОБЕ, однажды разойдётся сам с собой, и понять, какая из
 * копий правдивее, будет уже нечем.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@prisma/client', () => ({
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
  WorkflowKind: { SESSION: 'SESSION' },
}));

import {
  DATA_KEYS,
  LIVE_KEYS,
  isLiveKey,
  sessionData,
  splitSessionPatch,
} from './session.service';

describe('какой ключ в какой колонке', () => {
  it('горячие ключи уходят в liveData, остальные — в data', () => {
    const { data, live } = splitSessionPatch({
      generatedVideo: { status: 'processing' },
      videoAnalysis: { status: 'complete' },
      relevance: { verdict: 'ok' },
      generationPrompt: { finalText: 'p' },
    });
    expect(Object.keys(live).sort()).toEqual(['generatedVideo', 'relevance']);
    expect(Object.keys(data).sort()).toEqual([
      'generationPrompt',
      'videoAnalysis',
    ]);
  });

  it('ключ не попадает в обе колонки разом', () => {
    // Две копии одного статуса рано или поздно разойдутся, и выяснять,
    // какая правдивее, будет нечем.
    for (const key of DATA_KEYS) {
      const { data, live } = splitSessionPatch({ [key]: 1 });
      expect(key in data && key in live).toBe(false);
      expect(key in data || key in live).toBe(true);
    }
  });

  it('все горячие ключи перечислены среди ключей сессии', () => {
    // Иначе `updateSession` молча выбрасывал бы правку: он идёт по
    // `DATA_KEYS`, а не по тому, что прислали.
    for (const key of LIVE_KEYS) {
      expect(DATA_KEYS as readonly string[]).toContain(key);
      expect(isLiveKey(key)).toBe(true);
    }
  });

  it('`undefined` превращается в null — это стирание, а не пропуск', () => {
    // `JSON.stringify` выбросил бы ключ со значением `undefined`, и
    // стирание не состоялось бы: в колонке осталось бы прежнее значение.
    const { data, live } = splitSessionPatch({
      relevance: undefined,
      videoAnalysis: undefined,
    });
    expect(live).toEqual({ relevance: null });
    expect(data).toEqual({ videoAnalysis: null });
  });

  it('чужие ключи в правку не проходят', () => {
    const { data, live } = splitSessionPatch({
      workLocks: { generate: 1 },
      nonsense: 1,
    });
    // `workLocks` ведут `claimWork`/`releaseWork` своими запросами — их
    // нельзя переписывать целиком из общей правки, иначе конкурентный
    // захват платного вызова потеряется.
    expect(data).toEqual({});
    expect(live).toEqual({});
  });

  it('пустая правка даёт две пустые половины', () => {
    // Вызовы, меняющие только `status`, — таких около двадцати: обе
    // колонки в этом случае не должны переписываться вовсе.
    expect(splitSessionPatch({ status: 'created' })).toEqual({
      data: {},
      live: {},
    });
  });
});

describe('чтение обеих колонок как одной сессии', () => {
  it('колонки сливаются', () => {
    expect(
      sessionData({
        data: { videoAnalysis: 'a' },
        liveData: { generatedVideo: 'v' },
      }),
    ).toEqual({ videoAnalysis: 'a', generatedVideo: 'v' });
  });

  it('старая копия в `data` сильнее — её писал старый код', () => {
    // Порядок не косметический (этап 122). Миграция КОПИРУЕТ горячие
    // ключи, не переносит: пока новый код не переписал сессию, в `data`
    // лежит последнее значение — его писал старый код, который про
    // вторую колонку не знал. Возьми мы `liveData`, сессия, тронутая во
    // время выкатки, показала бы состояние на момент миграции: готовый
    // ролик снова «рендерится».
    expect(
      sessionData({
        data: { generatedVideo: 'написано старым кодом' },
        liveData: { generatedVideo: 'копия с момента миграции' },
      }).generatedVideo,
    ).toBe('написано старым кодом');
  });

  it('после переписывания копии в `data` нет — читается liveData', () => {
    // `updateSession` убирает копию в том же запросе, которым пишет
    // горячий ключ, поэтому обе колонки одновременно его не держат.
    expect(
      sessionData({
        data: { videoAnalysis: 'a' },
        liveData: { generatedVideo: 'свежее' },
      }).generatedVideo,
    ).toBe('свежее');
  });

  it('пустые и отсутствующие колонки не роняют чтение', () => {
    // Строка из старой выборки без обеих колонок — типом не пропускается,
    // но в рантайме такое встречалось; чтение не должно падать.
    expect(sessionData({} as Parameters<typeof sessionData>[0])).toEqual({});
    expect(sessionData({ data: null, liveData: null })).toEqual({});
  });
});
