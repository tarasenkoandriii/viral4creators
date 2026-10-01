/**
 * Пути кадров и разбор data-URL (§5.2 `/finish`, §6.3 ТЗ, этап 113).
 *
 * Обе функции ошибочны ровно один раз и потом молча: путь, разошедшийся
 * между `/finish`, `DELETE` и админкой, оставляет файлы в Blob
 * навсегда, а кривой разбор кладёт в хранилище «файл», который
 * открывается как мусор — и видно это станет только на готовом ролике.
 */

import {
  FrameDecodeError,
  VIDEO_FRAME_CONTENT_TYPE,
  decodeFrameDataUrl,
  draftFramePathname,
  draftFramePrefix,
  draftRoundFramePathname,
  frameExtension,
  orderedFramePathnames,
  finalFrameIndex,
} from './draft-frames';

describe('путь в хранилище', () => {
  it('префикс заканчивается слэшем — иначе он захватит соседние черновики', () => {
    // `tutorial-video-frames/draft1` без слэша совпал бы и с
    // `draft10`, `draft11`… — а по этому префиксу идёт УДАЛЕНИЕ.
    expect(draftFramePrefix('draft1')).toBe('tutorial-video-frames/draft1/');
    expect(draftFramePrefix('draft1').endsWith('/')).toBe(true);
    expect(
      draftFramePathname('draft10', 0, 'image/jpeg').startsWith(
        draftFramePrefix('draft1'),
      ),
    ).toBe(false);
  });

  it('кадр лежит под своим номером внутри префикса', () => {
    expect(draftFramePathname('draft1', 0, 'image/jpeg')).toBe(
      'tutorial-video-frames/draft1/0.jpg',
    );
    expect(draftFramePathname('draft1', 12, 'image/jpeg')).toBe(
      'tutorial-video-frames/draft1/12.jpg',
    );
  });

  /**
   * Расширение описывает содержимое, а не привычку. `.jpg` с PNG внутри
   * открывается не везде, и разбирать такую находку пришлось бы по
   * байтам файла, а не по его имени.
   */
  it('расширение следует за типом кадра', () => {
    expect(draftFramePathname('d', 0, 'image/png')).toBe(
      'tutorial-video-frames/d/0.png',
    );
    expect(draftFramePathname('d', 0, 'image/jpeg')).toBe(
      'tutorial-video-frames/d/0.jpg',
    );
    expect(draftRoundFramePathname('d', 3)).toBe(
      'tutorial-video-frames/d/round-3.png',
    );
    expect(frameExtension('IMAGE/PNG')).toBe('png');
  });

  it('незнакомый тип отклоняется, а не превращается в файл наугад', () => {
    expect(() => frameExtension('image/svg+xml')).toThrow(FrameDecodeError);
    expect(() => draftFramePathname('d', 0, 'text/html')).toThrow(
      FrameDecodeError,
    );
  });

  /** Съёмочный кадр — PNG: его читает `computeDHash`, а тот знает только PNG. */
  it('съёмочный кадр объявлен PNG', () => {
    expect(VIDEO_FRAME_CONTENT_TYPE).toBe('image/png');
  });

  it('путь кадра всегда внутри своего же префикса', () => {
    // Формулировка «всегда» держится тестом, а не дисциплиной: `/finish`
    // пишет по одному пути, а `DELETE` стирает по другому — разойтись
    // им нельзя.
    for (let i = 0; i < 5; i++) {
      expect(
        draftFramePathname('d', i, 'image/png').startsWith(
          draftFramePrefix('d'),
        ),
      ).toBe(true);
      expect(
        draftRoundFramePathname('d', i).startsWith(draftFramePrefix('d')),
      ).toBe(true);
    }
  });
});

describe('разбор data-URL', () => {
  const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

  it('отдаёт байты и тип', () => {
    const { buffer, contentType } = decodeFrameDataUrl(JPEG);
    expect(contentType).toBe('image/jpeg');
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('png тоже законен — тип берётся из самой строки, не угадывается', () => {
    expect(
      decodeFrameDataUrl('data:image/png;base64,iVBORw0KGgo=').contentType,
    ).toBe('image/png');
  });

  it('переносы строк внутри base64 не мешают', () => {
    expect(() =>
      decodeFrameDataUrl('data:image/jpeg;base64,/9j/\n4AAQSkZJRg=='),
    ).not.toThrow();
  });

  describe('в хранилище не должно попасть неизвестно что', () => {
    const bad = [
      ['не data-URL вовсе', 'кадр-1'],
      ['пустая строка', ''],
      ['не изображение', 'data:text/html;base64,PHNjcmlwdD4='],
      ['не base64', 'data:image/jpeg,raw-bytes'],
      ['пустое содержимое', 'data:image/jpeg;base64,'],
    ];
    it.each(bad)('%s — ошибка, а не битый .jpg', (_name, value) => {
      expect(() => decodeFrameDataUrl(value)).toThrow(FrameDecodeError);
    });

    it('текст ошибки объясняет, что не так', () => {
      expect(() => decodeFrameDataUrl('кадр')).toThrow(/data:image/);
    });
  });
});

/**
 * Список кадров из хранилища. Проверяется именно ОТБОР и ПОРЯДОК:
 * первое отделяет кадры ролика от кадров раундов, лежащих под тем же
 * префиксом, второе — единственное место, где «десятый» может встать
 * перед «вторым».
 */
describe('итоговые кадры по листингу хранилища', () => {
  const P = 'tutorial-video-frames/d/';

  it('кадры раундов не попадают в ролик', () => {
    expect(
      orderedFramePathnames('d', [
        `${P}0.png`,
        `${P}round-0.png`,
        `${P}round-1.png`,
        `${P}1.jpg`,
      ]),
    ).toEqual([`${P}0.png`, `${P}1.jpg`]);
  });

  it('порядок числовой, а не строковый', () => {
    expect(
      orderedFramePathnames('d', [`${P}10.png`, `${P}2.png`, `${P}1.png`]),
    ).toEqual([`${P}1.png`, `${P}2.png`, `${P}10.png`]);
  });

  it('чужой префикс и посторонние имена отброшены', () => {
    expect(
      orderedFramePathnames('d', [
        'tutorial-video-frames/other/0.png',
        `${P}0.thumb.png`,
        `${P}cover.png`,
        `${P}0.png`,
      ]),
    ).toEqual([`${P}0.png`]);
  });

  it('пустой листинг — пустой список, а не ошибка', () => {
    expect(orderedFramePathnames('d', [])).toEqual([]);
  });
});

describe('finalFrameIndex — что /finish вправе стереть (блокер QA 01.10.2026)', () => {
  const P = 'tutorial-video-frames/d/';

  it('итоговый кадр — номер и расширение', () => {
    expect(finalFrameIndex('d', `${P}0.png`)).toBe(0);
    expect(finalFrameIndex('d', `${P}12.jpg`)).toBe(12);
  });

  it('съёмочный кадр раунда — НЕ итоговый: его ещё копировать', () => {
    expect(finalFrameIndex('d', `${P}round-0.png`)).toBeNull();
  });

  it('чужой черновик и посторонние имена — не итоговые', () => {
    expect(finalFrameIndex('d', 'tutorial-video-frames/dd/0.png')).toBeNull();
    expect(finalFrameIndex('d', `${P}0.thumb.png`)).toBeNull();
  });
});
