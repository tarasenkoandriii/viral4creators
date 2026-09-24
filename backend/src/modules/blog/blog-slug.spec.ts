import { blogSlugFor, slugify } from './blog-slug';

describe('slugify', () => {
  it('транслитерирует русский заголовок, а не вырезает его в пустоту', () => {
    expect(slugify('Как снять вирусное видео за 5 минут')).toBe(
      'kak-snyat-virusnoe-video-za-5-minut',
    );
  });

  it('покрывает украинские буквы (і, ї, є, ґ)', () => {
    expect(slugify('Її ґудзик і мій рюкзак')).toBe('yiyi-gudzik-i-miy-ryukzak');
  });

  it('латиница и цифры проходят как есть, регистр — в нижний', () => {
    expect(slugify('Top 10 Ad Hooks in 2026')).toBe('top-10-ad-hooks-in-2026');
  });

  it('схлопывает несколько разделителей подряд и обрезает края', () => {
    expect(slugify('  Заголовок — с тире! И... точками.  ')).toBe(
      'zagolovok-s-tire-i-tochkami',
    );
  });

  it('пустой/полностью нелатинский после транслитерации — пустая строка (обрабатывает вызывающий)', () => {
    expect(slugify('   ')).toBe('');
  });

  it('обрезает длинные заголовки и не оставляет висящий дефис на срезе', () => {
    const long = 'слово '.repeat(30).trim();
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('blogSlugFor', () => {
  it('добавляет дизамбигуатор всегда, не только при коллизии', () => {
    expect(blogSlugFor('Реклама кроссовок', 'abc123XYZ')).toBe(
      'reklama-krossovok-abc123xyz',
    );
  });

  it('пустой заголовок — базовая часть "post", не пусто', () => {
    expect(blogSlugFor('   ', 'vid1')).toBe('post-vid1');
  });

  it('нелатинский дизамбигуатор тоже транслитерируется', () => {
    expect(blogSlugFor('Title', 'ролик')).toBe('title-rolik');
  });
});

describe('blogSlugFor — суффикс не теряется (аудит 24.09.2026)', () => {
  it('длинный заголовок режется под суффикс, а не вместе с ним', () => {
    // Прежняя редакция резала склейку целиком, и у заголовка, который
    // сам добирал предел, суффикс отбрасывался НАЦЕЛО: слаг становился
    // чистой функцией заголовка. Два похожих заголовка → один слаг →
    // P2002 на `@@unique` → HTTP 500 у оператора.
    const long = 'Щучье Юбилейное '.repeat(20);
    const a = blogSlugFor(long, 'video-aaa');
    const b = blogSlugFor(long, 'video-bbb');
    expect(a).toContain('video-aaa');
    expect(b).toContain('video-bbb');
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(80);
  });

  it('короткий заголовок по-прежнему читаем', () => {
    expect(blogSlugFor('Как снять UGC-ролик', 'abc123')).toBe(
      'kak-snyat-ugc-rolik-abc123',
    );
  });

  it('слаг не заканчивается дефисом даже при обрезке', () => {
    const s = blogSlugFor('Привет '.repeat(30), 'x1');
    expect(s.endsWith('-')).toBe(false);
  });
});
