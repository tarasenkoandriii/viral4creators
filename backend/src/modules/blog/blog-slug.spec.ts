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
