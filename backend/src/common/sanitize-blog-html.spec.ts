/**
 * sanitizeBlogHtml (Г-3.1, аудит round4, этап 64) — чистая функция без
 * Prisma, реально прогоняется в песочнице (в отличие от спеков сервисов
 * blog/*, которые ts-jest не может даже скомпилировать без
 * сгенерированного Prisma-клиента — см. заметку в PrismaService).
 */
import { sanitizeBlogHtml } from './sanitize-blog-html';

describe('sanitizeBlogHtml', () => {
  it('пропускает разрешённые теги форматирования как есть', () => {
    const html = '<p>Текст <strong>жирный</strong> и <em>курсив</em>.</p>';
    expect(sanitizeBlogHtml(html)).toBe(html);
  });

  it('пропускает списки', () => {
    const html = '<ul><li>раз</li><li>два</li></ul><ol><li>три</li></ol>';
    expect(sanitizeBlogHtml(html)).toBe(html);
  });

  it('пропускает https-ссылку, вырезает нехарактерные протоколы', () => {
    expect(sanitizeBlogHtml('<a href="https://example.com">ссылка</a>')).toBe(
      '<a href="https://example.com">ссылка</a>',
    );
    // http (не https), javascript:, протокол-независимая — везде href
    // вырезается целиком, текст ссылки остаётся.
    expect(sanitizeBlogHtml('<a href="http://example.com">x</a>')).toBe(
      '<a>x</a>',
    );
    expect(sanitizeBlogHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a>x</a>',
    );
    expect(sanitizeBlogHtml('<a href="//evil.example">x</a>')).toBe('<a>x</a>');
  });

  it('вырезает img целиком (prompt-injection → <img onerror>)', () => {
    expect(sanitizeBlogHtml('до<img src=x onerror="alert(1)">после')).toBe(
      'допосле',
    );
  });

  it('вырезает script целиком вместе с содержимым', () => {
    expect(
      sanitizeBlogHtml('<p>текст</p><script>alert(document.cookie)</script>'),
    ).toBe('<p>текст</p>');
  });

  it('вырезает атрибуты обработчиков событий на разрешённых тегах', () => {
    expect(sanitizeBlogHtml('<p onclick="alert(1)">текст</p>')).toBe(
      '<p>текст</p>',
    );
  });

  it('br без содержимого проходит как есть', () => {
    expect(sanitizeBlogHtml('строка1<br>строка2')).toBe('строка1<br />строка2');
  });
});
