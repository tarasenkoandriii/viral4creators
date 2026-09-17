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
  decodeFrameDataUrl,
  draftFramePathname,
  draftFramePrefix,
} from './draft-frames';

describe('путь в хранилище', () => {
  it('префикс заканчивается слэшем — иначе он захватит соседние черновики', () => {
    // `tutorial-video-frames/draft1` без слэша совпал бы и с
    // `draft10`, `draft11`… — а по этому префиксу идёт УДАЛЕНИЕ.
    expect(draftFramePrefix('draft1')).toBe('tutorial-video-frames/draft1/');
    expect(draftFramePrefix('draft1').endsWith('/')).toBe(true);
    expect(
      draftFramePathname('draft10', 0).startsWith(draftFramePrefix('draft1')),
    ).toBe(false);
  });

  it('кадр лежит под своим номером внутри префикса', () => {
    expect(draftFramePathname('draft1', 0)).toBe(
      'tutorial-video-frames/draft1/0.jpg',
    );
    expect(draftFramePathname('draft1', 12)).toBe(
      'tutorial-video-frames/draft1/12.jpg',
    );
  });

  it('путь кадра всегда внутри своего же префикса', () => {
    // Формулировка «всегда» держится тестом, а не дисциплиной: `/finish`
    // пишет по одному пути, а `DELETE` стирает по другому — разойтись
    // им нельзя.
    for (let i = 0; i < 5; i++) {
      expect(draftFramePathname('d', i).startsWith(draftFramePrefix('d'))).toBe(
        true,
      );
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
