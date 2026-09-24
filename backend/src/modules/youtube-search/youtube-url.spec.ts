import { parseYoutubeVideoId } from './youtube-url';

/**
 * Разбор ссылки в id (этап 136). Проверяется ровно то, ради чего
 * функция заведена: из ссылки, какой её приносит человек — с хвостами,
 * в короткой форме, из мобильного приложения — получается тот самый id,
 * по которому `videos.list` отдаст теги. Ошибка здесь не заметна ничем:
 * теги просто молча не появятся.
 */
describe('parseYoutubeVideoId', () => {
  it('берёт id из всех форм ссылки, которые приносят люди', () => {
    const cases: Array<[string, string]> = [
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['http://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['  https://youtu.be/dQw4w9WgXcQ  ', 'dQw4w9WgXcQ'],
    ];
    for (const [url, id] of cases) {
      expect([url, parseYoutubeVideoId(url)]).toEqual([url, id]);
    }
  });

  it('не спотыкается о хвосты, ради которых и взят URL вместо регулярки', () => {
    // Плейлист, отметка времени, партнёрский `si` — всё это в ссылках из
    // жизни встречается чаще, чем чистая форма.
    expect(
      parseYoutubeVideoId(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2',
      ),
    ).toBe('dQw4w9WgXcQ');
    expect(
      parseYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=30&si=abc'),
    ).toBe('dQw4w9WgXcQ');
  });

  it('на чужой ссылке возвращает null, а не выдумывает id', () => {
    // null — штатный ответ: вызывающий просто останется без тегов.
    for (const url of [
      'https://vimeo.com/76979871',
      'https://www.youtube.com/channel/UC123',
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=',
      'not a url at all',
      '',
      'javascript:alert(1)//youtu.be/dQw4w9WgXcQ',
      // Схема проверяется отдельно от хоста: у `ftp://youtu.be/…`
      // хост как раз тот, и без проверки схемы ссылка прошла бы.
      'ftp://youtu.be/dQw4w9WgXcQ',
    ]) {
      expect([url, parseYoutubeVideoId(url)]).toEqual([url, null]);
    }
  });

  it('id с недопустимыми символами отбрасывается целиком', () => {
    // Иначе в параметр запроса к Google уехало бы что угодно из ссылки.
    expect(parseYoutubeVideoId('https://youtu.be/../../etc/passwd')).toBe(null);
    expect(parseYoutubeVideoId('https://www.youtube.com/watch?v=a b')).toBe(
      null,
    );
  });
});
