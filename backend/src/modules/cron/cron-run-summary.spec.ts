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

import {
  buildRunSummary,
  cronOutcomeOf,
  skipReasonOf,
  successLogFields,
  summarizeCounters,
  tutorialResultFailed,
  cronResultFailed,
  historicalTutorialFailed,
  historicalTutorialIdle,
} from './cron-run-summary';

describe('Tutorial batch failures are not successful runs', () => {
  it('interprets historical failures without confusing zero or another job', () => {
    expect(
      historicalTutorialFailed(
        'ui-snapshot-run',
        'total=5, changed=0, failed=5',
      ),
    ).toBe(true);
    expect(
      historicalTutorialFailed('ui-snapshot-run', 'total=5, failed=0'),
    ).toBe(false);
    expect(historicalTutorialFailed('publish', 'failed=5')).toBe(false);
  });
  it.each([
    'tutorial-scenario-generate',
    'tutorial-scenario-run',
    'tutorial-assembly-poll',
    'ui-snapshot-run',
  ])('%s detects partial and total failures', (key) => {
    expect(tutorialResultFailed(key, { failed: 5 })).toBe(true);
    expect(tutorialResultFailed(key, { failed: 0 })).toBe(false);
    expect(tutorialResultFailed(key, { failed: 5, skipped: 'locked' })).toBe(
      false,
    );
  });
  it('does not change unrelated job contracts or accept malformed counts', () => {
    expect(tutorialResultFailed('publish', { failed: 1 })).toBe(false);
    expect(tutorialResultFailed('ui-snapshot-run', { failed: '5' })).toBe(
      false,
    );
  });
  it('includes route failure reasons without requiring scenario ok flag', () => {
    expect(
      buildRunSummary('ui-snapshot-run', {
        total: 5,
        failed: 5,
        outcomes: [{ routeKey: 'generate', error: 'browser unavailable' }],
      }),
    ).toContain('generate: browser unavailable');
  });
});

describe('Tutorial quality outcomes reach cron monitoring', () => {
  it.each(['qualityErrors', 'qualityQueueErrors'])(
    '%s prevents a false green',
    (key) => {
      expect(
        tutorialResultFailed('tutorial-assembly-poll', { failed: 0, [key]: 1 }),
      ).toBe(true);
      expect(
        historicalTutorialFailed(
          'tutorial-assembly-poll',
          `failed=0, ${key}=1`,
        ),
      ).toBe(true);
      expect(tutorialResultFailed('tutorial-scenario-run', { [key]: 1 })).toBe(
        false,
      );
    },
  );
  it('budget deferral and retry are visible without becoming terminal failures', () => {
    const result = {
      failed: 0,
      qualityErrors: 0,
      qualityQueueErrors: 0,
      qualityDeferred: 2,
      qualityRetried: 1,
    };
    expect(tutorialResultFailed('tutorial-assembly-poll', result)).toBe(false);
    expect(buildRunSummary('tutorial-assembly-poll', result)).toContain(
      'qualityDeferred=2',
    );
    expect(
      tutorialResultFailed('tutorial-assembly-poll', { qualityErrors: '1' }),
    ).toBe(false);
  });
  it('disabled quality does not hide successful assembly work', () => {
    const result = { polled: 1, failed: 0, qualitySkipped: 'выключено' };
    expect(skipReasonOf(result)).toBeNull();
    expect(buildRunSummary('tutorial-assembly-poll', result)).toContain(
      'проверка качества пропущена — выключено',
    );
  });
});

describe('historical Tutorial idle rows', () => {
  it('recognizes only unambiguous zero scenario work', () => {
    expect(
      historicalTutorialIdle(
        'tutorial-scenario-run',
        'total=0, passed=0, failed=0',
      ),
    ).toBe(true);
    expect(
      historicalTutorialIdle(
        'tutorial-scenario-run',
        'total=0, passed=0, failed=0, executed=1',
      ),
    ).toBe(false);
    expect(
      historicalTutorialIdle(
        'tutorial-scenario-run',
        'total=1, passed=0, failed=1',
      ),
    ).toBe(false);
    expect(historicalTutorialIdle('tutorial-scenario-run', null)).toBe(false);
    expect(
      historicalTutorialIdle(
        'tutorial-assembly-poll',
        'total=0, passed=0, failed=0',
      ),
    ).toBe(false);
  });
});

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

describe('исход «пропущен» (аудит кронов 06.10.2026)', () => {
  it('три формы пропуска — строкой, `skipped: true`, `skipped-locked`', () => {
    expect(skipReasonOf({ skipped: 'потолок выбран' })).toBe('потолок выбран');
    expect(skipReasonOf({ skipped: true, deleted: 0 })).toBe(
      'предыдущий прогон ещё держал замок',
    );
    expect(skipReasonOf({ action: 'skipped-locked' })).toBe(
      'предыдущий прогон ещё держал замок',
    );
  });

  it('не пропуск: пустая строка, вложенный skipped у блога, счётчики skipped*', () => {
    expect(skipReasonOf({ skipped: '' })).toBeNull();
    expect(skipReasonOf({ generation: { skipped: true } })).toBeNull();
    expect(skipReasonOf({ skippedManual: 3, generated: 1 })).toBeNull();
    expect(skipReasonOf(null)).toBeNull();
  });

  it('любой джоб с пропуском получает сводку «пропущен — причина»', () => {
    expect(buildRunSummary('voice-uploads-sweep', { skipped: true })).toBe(
      'пропущен — предыдущий прогон ещё держал замок',
    );
    expect(
      buildRunSummary('portfolio-watermark', { action: 'skipped-locked' }),
    ).toBe('пропущен — предыдущий прогон ещё держал замок');
  });

  it('пропуск — отметка исхода в debugLog и без debug; обычный — как раньше', () => {
    const skipped = successLogFields(
      'tutorial-scenario-run',
      { skipped: 'нет фикстуры', total: 0 },
      false,
    );
    expect(skipped.debugLog).toEqual({
      cronOutcome: 'SKIPPED',
      reason: 'нет фикстуры',
      result: { skipped: 'нет фикстуры', total: 0 },
    });
    expect(cronOutcomeOf(skipped.debugLog)).toBe('SKIPPED');

    const plain = successLogFields('publish', { published: 2 }, false);
    expect(plain.debugLog).toBeUndefined();
    expect(cronOutcomeOf(plain.debugLog)).toBeNull();
    const debug = successLogFields('publish', { published: 2 }, true);
    expect(debug.debugLog).toEqual({ published: 2 });
    expect(cronOutcomeOf(debug.debugLog)).toBeNull();
  });
});

describe('assembly outcome reporting', () => {
  it('marks a passing regression with failed assembly as failed and names the cause', () => {
    const result = {
      passed: 1,
      failed: 0,
      assemblyFailures: 1,
      outcomes: [
        {
          ok: true,
          subjectKey: '3',
          locale: 'es',
          assemblyError: 'ffmpeg api 402: paymentRequired',
        },
      ],
    };
    expect(tutorialResultFailed('tutorial-scenario-run', result)).toBe(true);
    expect(buildRunSummary('tutorial-scenario-run', result)).toContain(
      '3/es: сборка: ffmpeg api 402',
    );
    expect(
      historicalTutorialFailed(
        'tutorial-scenario-run',
        'passed=1, failed=0, assemblyFailures=1',
      ),
    ).toBe(true);
  });
  it('shows budget deferral separately without inventing a failed regression', () => {
    expect(
      tutorialResultFailed('tutorial-scenario-run', {
        failed: 0,
        assemblyFailures: 0,
        assemblyDeferred: 3,
      }),
    ).toBe(false);
  });
});

describe('merchandise partial failures reach both cron entry points', () => {
  it.each([
    ['catalog-batch-run', 'failed'],
    ['catalog-batch-run', 'renderFailed'],
    ['catalog-batch-run', 'renderPollErrors'],
    ['catalog-batch-run', 'grokBatchItemsFailed'],
    ['ab-test-run', 'failed'],
    ['ab-test-run', 'renderFailed'],
    ['ab-test-run', 'renderPollErrors'],
    ['feed-import-run', 'failedRuns'],
    ['feed-import-run', 'failedItems'],
    ['api-video', 'failed'],
    ['api-video', 'gaveUp'],
    ['export-sync-run', 'failed'],
  ])('%s reports %s failure without a thrown exception', (job, counter) => {
    expect(cronResultFailed(job, { [counter]: 1 })).toBe(true);
    expect(cronResultFailed(job, { [counter]: 0 })).toBe(false);
    expect(cronResultFailed(job, { [counter]: '1' })).toBe(false);
    expect(cronResultFailed(job, { [counter]: 1, skipped: 'locked' })).toBe(
      false,
    );
  });
  it('keeps retries, idle ticks and unrelated counters separate from errors', () => {
    expect(cronResultFailed('api-video', { retried: 1, failed: 0 })).toBe(
      false,
    );
    expect(cronResultFailed('feed-import-run', { skippedItems: 2 })).toBe(
      false,
    );
    expect(cronResultFailed('publish', { failed: 1 })).toBe(false);
    expect(
      cronResultFailed('tutorial-scenario-run', { assemblyFailures: 1 }),
    ).toBe(true);
  });
});

it('reports unresolved Story-Tales recovery as failure rather than green', () => {
  for (const field of ['failed', 'blocked', 'unknown'])
    expect(cronResultFailed('story-finalize', { [field]: 1 })).toBe(true);
  expect(
    cronResultFailed('story-finalize', {
      scanned: 2,
      ready: 2,
      failed: 0,
      blocked: 0,
      unknown: 0,
    }),
  ).toBe(false);
});

it('Story-Tales retention: only item errors mark the run failed; dry-run counters stay green', () => {
  expect(cronResultFailed('story-retention', { errors: 1 })).toBe(true);
  expect(
    cronResultFailed('story-retention', {
      dryRun: true,
      staleGifts: 4,
      readyGifts: 2,
      raced: 1,
      purged: 0,
      errors: 0,
    }),
  ).toBe(false);
});
