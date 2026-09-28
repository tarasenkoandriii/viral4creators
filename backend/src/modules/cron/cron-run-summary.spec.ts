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

/**
 * Причины отказа текстом — сквозной аудит обучалки 29.09.2026.
 * До него `summarizeCounters` брала только числа, и `failures[]`
 * генератора отбрасывался целиком: в журнале оставалось `failed=50`
 * без единого слова о том, что именно сломалось.
 */
describe('summarizeCounters — причины отказа', () => {
  it('failures[] генератора попадают в сводку поимённо', () => {
    const out = summarizeCounters({
      pairs: 2,
      failed: 2,
      failures: [
        { subjectKey: '3', locale: 'ru', reason: 'ответ не JSON-объект' },
        { subjectKey: '4', locale: 'uk', reason: 'селектор не из каталога' },
      ],
    });
    expect(out).toContain('failed=2');
    expect(out).toContain('3/ru: ответ не JSON-объект');
    expect(out).toContain('4/uk: селектор не из каталога');
  });

  it('outcomes[] исполнителя — только провалившиеся', () => {
    const out = summarizeCounters({
      total: 2,
      outcomes: [
        { subjectKey: '1', locale: 'ru', ok: true },
        { subjectKey: '2', locale: 'ru', ok: false, error: 'шаг 2: таймаут' },
      ],
    });
    expect(out).toContain('2/ru: шаг 2: таймаут');
    expect(out).not.toContain('1/ru');
  });

  it('длинный список урезается с честным хвостом', () => {
    // `summary` читают глазами в таблице; пятьдесят строк туда не лезут.
    const failures = Array.from({ length: 10 }, (_, i) => ({
      subjectKey: String(i),
      locale: 'ru',
      reason: 'причина',
    }));
    const out = summarizeCounters({ failed: 10, failures });
    expect(out).toContain('и ещё 7');
  });

  it('массивы ДАННЫХ в сводку не тащатся', () => {
    // `locales[]` — не причины, и в сводке только мешают.
    const out = summarizeCounters({ pairs: 1, locales: ['ru', 'uk'] });
    expect(out).toBe('pairs=1');
  });
});

describe('buildRunSummary — пропуск генерации сценариев', () => {
  it('отложенная генерация не выглядит как «делать было нечего»', () => {
    expect(
      buildRunSummary('tutorial-scenario-generate', {
        skipped: 'суточный потолок расхода обучалки выбран',
        pairs: 0,
        generated: 0,
        failed: 0,
      }),
    ).toContain('пропущен — суточный потолок');
  });
});
