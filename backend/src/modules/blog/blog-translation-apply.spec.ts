import {
  applyTranslationBatchResults,
  buildTranslationBatchItems,
  PendingTranslationRow,
} from './blog-translation-apply';

const rows: PendingTranslationRow[] = [
  { id: 't-uk', locale: 'uk', title: 'Заголовок', bodyHtml: '<p>Тело</p>' },
  { id: 't-de', locale: 'de', title: 'Заголовок', bodyHtml: '<p>Тело</p>' },
];

describe('buildTranslationBatchItems', () => {
  it('строит по одному элементу пачки на перевод с явным именем языка и strict JSON', () => {
    const items = buildTranslationBatchItems(rows, 'grok-4-fast');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      batchRequestId: 't-uk',
      model: 'grok-4-fast',
      messages: [
        { role: 'user', content: expect.stringContaining('into Ukrainian') },
      ],
      responseFormat: { type: 'json_object' },
    });
    expect(items[1].messages[0].content).toContain('into German');
  });

  it('пустой список строк — пустой список элементов', () => {
    expect(buildTranslationBatchItems([], 'grok-4-fast')).toEqual([]);
  });
});

describe('applyTranslationBatchResults', () => {
  it('успешный результат — ready с заголовком и телом', () => {
    const applied = applyTranslationBatchResults(rows, {
      't-uk': JSON.stringify({ title: 'Заголовок UK', bodyHtml: '<p>UK</p>' }),
      't-de': JSON.stringify({ title: 'Titel DE', bodyHtml: '<p>DE</p>' }),
    });
    expect(applied).toEqual([
      {
        translationId: 't-uk',
        outcome: 'ready',
        title: 'Заголовок UK',
        bodyHtml: '<p>UK</p>',
      },
      {
        translationId: 't-de',
        outcome: 'ready',
        title: 'Titel DE',
        bodyHtml: '<p>DE</p>',
      },
    ]);
  });

  it('перевод без результата в пачке (num_error у xAI) — failed, не "ещё не готов"', () => {
    const applied = applyTranslationBatchResults(rows, {
      't-uk': JSON.stringify({ title: 'T', bodyHtml: '<p>b</p>' }),
      // t-de отсутствует вовсе
    });
    const de = applied.find((a) => a.translationId === 't-de');
    expect(de?.outcome).toBe('failed');
    expect(de?.errorMessage).toMatch(/не вернул результат/);
  });

  it('результат есть, но не разбирается как {title, bodyHtml} — failed с диагностикой', () => {
    const applied = applyTranslationBatchResults([rows[0]], {
      't-uk': 'извините, не могу это перевести',
    });
    expect(applied[0].outcome).toBe('failed');
    expect(applied[0].errorMessage).toContain('не разобрался');
  });

  it('снимает ```json ограждения так же, как разбор анализа блога', () => {
    const applied = applyTranslationBatchResults([rows[0]], {
      't-uk': '```json\n{"title": "T", "bodyHtml": "<p>b</p>"}\n```',
    });
    expect(applied[0]).toEqual({
      translationId: 't-uk',
      outcome: 'ready',
      title: 'T',
      bodyHtml: '<p>b</p>',
    });
  });

  it('пустой список ожидающих — пустой результат', () => {
    expect(applyTranslationBatchResults([], {})).toEqual([]);
  });
});
