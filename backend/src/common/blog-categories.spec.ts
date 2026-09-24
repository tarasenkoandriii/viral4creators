/**
 * Категории блога — умолчание и выключатель (§36 SPEC, правка владельца
 * 24.09.2026).
 *
 * Проверяется одно различие, и оно стоит денег: «переменной нет» — это
 * умолчание, «переменная пустая» — выключено человеком. Спутать их
 * значит либо не включить блог там, где просили, либо включить его
 * там, где выключили осознанно, — а он тратит квоту YouTube, вызовы
 * Gemini на каждый кандидат и перевод Grok на пять локалей.
 */

import {
  DEFAULT_BLOG_CATEGORIES,
  blogCategories,
  blogDisabledExplicitly,
} from './blog-categories';

const env = (value?: string): NodeJS.ProcessEnv =>
  (value === undefined ? {} : { BLOG_CATEGORIES: value }) as NodeJS.ProcessEnv;

describe('blogCategories', () => {
  it('переменной нет — умолчание владельца', () => {
    expect(blogCategories(env())).toEqual(['viral', 'ai', 'voice']);
    expect(blogCategories(env())).toEqual([...DEFAULT_BLOG_CATEGORIES]);
  });

  it('умолчание отдаётся копией — общий массив мог бы уехать', () => {
    const first = blogCategories(env());
    first.push('лишнее');
    expect(blogCategories(env())).toEqual(['viral', 'ai', 'voice']);
  });

  it('заданные категории умолчание не дополняют, а заменяют', () => {
    // Иначе оператор, сузивший тему до одной, получил бы к ней ещё три
    // чужих — и удивился бы счёту за YouTube.
    expect(blogCategories(env('фитнес'))).toEqual(['фитнес']);
  });

  it('запятые, пробелы и пустые элементы прощаем', () => {
    expect(blogCategories(env(' фитнес , , кулинария '))).toEqual([
      'фитнес',
      'кулинария',
    ]);
  });

  it('пустая переменная — пустой список, а не умолчание', () => {
    expect(blogCategories(env(''))).toEqual([]);
  });
});

describe('blogDisabledExplicitly', () => {
  it('пустая переменная — выключено человеком', () => {
    expect(blogDisabledExplicitly(env(''))).toBe(true);
    // Из одних запятых и пробелов список тоже пуст — и это то же самое
    // решение, записанное неаккуратно.
    expect(blogDisabledExplicitly(env(' , '))).toBe(true);
  });

  it('переменной нет — это НЕ выключено, это умолчание', () => {
    expect(blogDisabledExplicitly(env())).toBe(false);
  });

  it('категории заданы — не выключено', () => {
    expect(blogDisabledExplicitly(env('фитнес'))).toBe(false);
  });
});
