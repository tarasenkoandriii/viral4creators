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

  // Заход 13 (Р-З13-В5): sanitize-html 2.17.1 → 2.18.0 (htmlparser2@12).
  // Политика та же; ниже — векторы advisory 2.17.x (схемы URI в атрибутах
  // action/formaction/data/poster/background) и обходы схемы в href.
  it('javascript: в href не проходит ни в каком написании', () => {
    for (const href of [
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java&#x09;script:alert(1)',
      '&#106;avascript:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:x',
      'mailto:a@b.c',
    ]) {
      expect(sanitizeBlogHtml(`<a href="${href}">x</a>`)).toBe('<a>x</a>');
    }
  });

  it('атрибуты-URI вне allow-list (action, formaction, data, poster, background) отбрасываются вместе с тегами', () => {
    expect(
      sanitizeBlogHtml(
        '<form action="javascript:alert(1)"><button formaction="javascript:1">b</button></form>' +
          '<object data="javascript:1"></object><video poster="javascript:1"></video>' +
          '<table background="javascript:1"><tr><td>t</td></tr></table>',
      ),
    ).toBe('bt');
  });

  it('лишние атрибуты ссылки и второй href не проходят', () => {
    expect(
      sanitizeBlogHtml(
        '<a href="https://ok.example" target="_blank" rel="x">t</a>',
      ),
    ).toBe('<a href="https://ok.example">t</a>');
    expect(
      sanitizeBlogHtml('<a href="https://x.example" href="javascript:1">d</a>'),
    ).toBe('<a href="https://x.example">d</a>');
  });

  it('svg/math/style/iframe и сырой текст (xmp, plaintext, textarea) не дают разметки', () => {
    for (const html of [
      '<svg><script>alert(1)</script></svg>',
      '<math><mi xlink:href="javascript:1">m</mi></math>',
      '<style>p{color:red}</style>',
      '<iframe src="https://x.example"></iframe>',
      '<xmp><p>x</p></xmp>',
      '<plaintext><p>x',
      '<textarea><p>x</p></textarea>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    ]) {
      expect(sanitizeBlogHtml(html)).not.toMatch(/<(?!\/?(p|a)\b)[a-z]/i);
      expect(sanitizeBlogHtml(html)).not.toMatch(
        /onerror|javascript:|<script/i,
      );
    }
  });
});
