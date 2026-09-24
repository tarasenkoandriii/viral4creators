/**
 * Сводка прогона крона — та строка, которую оператор видит на экране
 * `/cron` без раскрытия debug.
 *
 * Тесты здесь про одно: **ноль обязан отличаться от «не запускалось»**.
 * Прогон, который ничего не сделал, потому что не настроен или
 * заблокирован чужим замком, выглядит в счётчиках ровно как прогон,
 * который честно поискал и ничего не нашёл. Разницу видно только в этой
 * строке, а в бессерверном деплое логи оператор не читает.
 */

import { buildRunSummary, summarizeCounters } from './cron-run-summary';

describe('summarizeCounters', () => {
  it('собирает числовые поля, нечисловые не выдумывает', () => {
    expect(summarizeCounters({ a: 1, b: 'x', c: 2 })).toBe('a=1, c=2');
  });

  it('без чисел отдаёт объект как есть, а не пустую строку', () => {
    expect(summarizeCounters({ ok: true })).toBe('{"ok":true}');
  });
});

describe('buildRunSummary — пропуск отличается от нуля', () => {
  it('report показывает сам текст отчёта — ради него кнопку и жмут', () => {
    expect(buildRunSummary('report', { text: 'за сутки: 3 ролика' })).toBe(
      'за сутки: 3 ролика',
    );
  });

  it('cleanup-sessions: замок другого прогона назван словами', () => {
    expect(buildRunSummary('cleanup-sessions', { skipped: true })).toContain(
      'замок',
    );
  });

  it('blog: ненастроенный генератор говорит, чего не хватает', () => {
    // Найдено на живом проде: экран показывал три нуля, и это читалось
    // как «поискали и ничего не нашли», хотя ключей не было.
    const summary = buildRunSummary('blog', {
      generation: {
        notConfigured: 'не задано: YOUTUBE_API_KEY, GEMINI_API_KEY',
        categoriesTried: 0,
        candidatesConsidered: 0,
        draftsCreated: 0,
      },
      translation: { polledJobs: 0 },
    });
    expect(summary).toContain('YOUTUBE_API_KEY');
    expect(summary).toContain('GEMINI_API_KEY');
    // Нули в такой строке только мешают: читать надо причину.
    expect(summary).not.toContain('categoriesTried=0');
  });

  it('blog: выключенный человеком не выдаётся за поломку', () => {
    // Приставку «не задано» сводка не дописывает: текст приходит
    // готовым, потому что у выключенного и у ненастроенного разный
    // смысл, и второй заставил бы искать несуществующую проблему.
    const summary = buildRunSummary('blog', {
      generation: {
        notConfigured: 'выключен намеренно: BLOG_CATEGORIES задан пустым',
      },
      translation: {},
    });
    expect(summary).toContain('выключен намеренно');
    expect(summary).not.toContain('не задано');
  });

  it('blog настроенный: обе половины счётчиками, как раньше', () => {
    const summary = buildRunSummary('blog', {
      generation: { notConfigured: null, categoriesTried: 3, draftsCreated: 1 },
      translation: { polledJobs: 2, completedJobs: 1 },
    });
    expect(summary).toBe(
      'генерация: categoriesTried=3, draftsCreated=1; перевод: polledJobs=2, completedJobs=1',
    );
  });

  it('обычный джоб — плоские счётчики', () => {
    expect(buildRunSummary('publish', { processed: 0, published: 0 })).toBe(
      'processed=0, published=0',
    );
  });
});
