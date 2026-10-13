/**
 * P-B1 unit: чистые правила контента (`rules.ts`, `source-import.ts`) —
 * meta и тело версии, оценки F01, значение факта F02, критичность
 * изменения, hash оффера, готовность брифа, блокеры QA, требования
 * адаптаций, diff версий, CSV без формул, причины отказа импорта.
 */
import {
  briefMissing,
  checkBlockers,
  checkFactValue,
  checkScores,
  checkVersionMeta,
  csvCell,
  formatIssues,
  hasRawHtml,
  isCriticalFact,
  isCriticalOfferChange,
  lineDiff,
  metaChangedKeys,
  offerHash,
  sameValue,
  scoreSummary,
  selectionMissing,
  setDiff,
  toCsv,
} from './rules';
import { importReasonOf } from './source-import';

describe('P-B1 rules: тело и meta версии', () => {
  it('markdown без сырого HTML', () => {
    expect(hasRawHtml('**жирний** текст\n\n- пункт')).toBe(false);
    expect(hasRawHtml('a < b and c > d')).toBe(false);
    expect(hasRawHtml('<script>alert(1)</script>')).toBe(true);
    expect(hasRawHtml('text <img src=x onerror=1>')).toBe(true);
    expect(hasRawHtml('<!-- comment -->')).toBe(true);
    expect(hasRawHtml('</div>')).toBe(true);
  });

  it('meta: белый список ключей, длины, карточки и сцены, подпись без контакта', () => {
    expect(
      checkVersionMeta({
        description: 'Опис',
        cta: 'Обговорити',
        limitations: ['a'],
      }),
    ).toEqual({
      meta: { description: 'Опис', cta: 'Обговорити', limitations: ['a'] },
      issues: [],
    });
    expect(checkVersionMeta({ hidden: 1 }).issues).toEqual([
      { field: 'meta.hidden', code: 'unknown_key' },
    ]);
    expect(checkVersionMeta({ description: 'x'.repeat(301) }).issues).toEqual([
      { field: 'meta.description', code: 'type' },
    ]);
    expect(
      checkVersionMeta({ cards: [{ title: 'a', text: 'b', extra: 1 }] }).issues,
    ).toEqual([{ field: 'meta.cards', code: 'type' }]);
    expect(
      checkVersionMeta({ scenes: [{ visual: 'v', voice: 'v', caption: 'c' }] })
        .issues,
    ).toEqual([]);
    expect(
      checkVersionMeta({ editor: 'Олена, +380 67 123 45 67' }).issues,
    ).toEqual([{ field: 'meta.editor', code: 'pii' }]);
    expect(checkVersionMeta([]).issues).toEqual([
      { field: 'meta', code: 'type' },
    ]);
    expect(
      checkVersionMeta({ substantiallyUpdatedAt: '2026-10-20' }).meta
        .substantiallyUpdatedAt,
    ).toBe('2026-10-20T00:00:00.000Z');
  });

  it('требования формата при отправке (F06): CTA, свой заголовок, карточки, сцены', () => {
    expect(
      formatIssues('article', { title: 'T', body: '', meta: {} }, null),
    ).toEqual([{ field: 'body', code: 'required' }]);
    expect(
      formatIssues('post', { title: 'T', body: 'b', meta: {} }, 'P'),
    ).toEqual([{ field: 'meta.cta', code: 'required' }]);
    expect(
      formatIssues('post', { title: 'P', body: 'b', meta: { cta: 'c' } }, 'P'),
    ).toEqual([{ field: 'title', code: 'same_as_parent' }]);
    expect(
      formatIssues('cards', { title: 'C', body: '', meta: { cta: 'c' } }, 'P'),
    ).toEqual([{ field: 'meta.cards', code: 'required' }]);
    expect(
      formatIssues(
        'video_script',
        { title: 'S', body: '', meta: { cta: 'c' } },
        'P',
      ),
    ).toEqual([{ field: 'meta.scenes', code: 'required' }]);
  });
});

describe('P-B1 rules: вопросы F01', () => {
  it('оценки 0–2 или null с пояснением; неизвестный критерий и 3 — ошибка', () => {
    expect(checkScores({ cost: { score: 2, why: ' дешево ' } })).toEqual({
      scores: { cost: { score: 2, why: 'дешево' } },
      issues: [],
    });
    expect(checkScores({ cost: { score: 3, why: 'x' } }).issues).toEqual([
      { field: 'scores.cost.score', code: 'range' },
    ]);
    expect(checkScores({ traffic: { score: 1, why: 'x' } }).issues).toEqual([
      { field: 'scores.traffic', code: 'unknown_key' },
    ]);
    expect(
      checkScores({ cost: { score: 1, why: 'тел. 067 123 45 67' } }).issues,
    ).toEqual([{ field: 'scores.cost.why', code: 'pii' }]);
  });

  it('выбор темы требует 4 пояснения и разрешённый источник; неизвестная оценка не 0', () => {
    const s = {
      offer_fit: { score: 2 as const, why: 'a' },
      confirmed_task: { score: null, why: 'b' },
    };
    expect(selectionMissing(s, 0)).toEqual([
      'scores.own_answer.why',
      'scores.cost.why',
      'sources.allowed',
    ]);
    expect(scoreSummary(s)).toEqual({ total: 2, unknown: 3 });
  });
});

describe('P-B1 rules: бренд F02', () => {
  it('значение факта по виду, без ключей ПД и контактов (кроме вида contact)', () => {
    expect(
      checkFactValue('price', {
        amountMinor: 1_000_000,
        currency: 'UAH',
        note: 'пілот',
      }),
    ).toEqual([]);
    expect(
      checkFactValue('price', { amountMinor: -1, currency: 'uah' }),
    ).toEqual([
      { field: 'value.amountMinor', code: 'range' },
      { field: 'value.currency', code: 'format' },
    ]);
    expect(checkFactValue('faq', { question: 'Q', answer: 'A' })).toEqual([]);
    expect(checkFactValue('fact', { text: 'x', name: 'Іван' })).toEqual(
      expect.arrayContaining([
        { field: 'value.name', code: 'unknown_key' },
        { field: 'value', code: 'pii_key' },
      ]),
    );
    expect(checkFactValue('fact', { text: 'пишіть на a@b.ua' })).toEqual([
      { field: 'value.text', code: 'pii' },
    ]);
    expect(checkFactValue('contact', { text: 'hello@agency.ua' })).toEqual([]);
    expect(checkFactValue('fact', 'текст')).toEqual([
      { field: 'value', code: 'type' },
    ]);
  });

  it('критичность: цена и гарантия; одинаковые значения; hash оффера чувствителен к цене и фактам', () => {
    expect(isCriticalFact({ kind: 'price', factKey: 'price.x' })).toBe(true);
    expect(
      isCriticalFact({ kind: 'condition', factKey: 'guarantee.refund' }),
    ).toBe(true);
    // Аудит P-B1 S2-5: условия (kind condition), warranty, terms — критичны.
    expect(
      isCriticalFact({ kind: 'condition', factKey: 'payment.terms' }),
    ).toBe(true);
    expect(isCriticalFact({ kind: 'fact', factKey: 'warranty.months' })).toBe(
      true,
    );
    expect(isCriticalFact({ kind: 'fact', factKey: 'service.terms' })).toBe(
      true,
    );
    expect(isCriticalFact({ kind: 'fact', factKey: 'team.size' })).toBe(false);
    const offer = {
      title: 'T',
      text: 'Повний цикл',
      priceNote: '10 000',
      facts: [{ factKey: 'team.size', kind: 'fact', value: { n: 3 } }],
    };
    expect(isCriticalOfferChange(offer, { ...offer })).toBe(false);
    const renamed = { ...offer, title: 'Інша назва' };
    expect(isCriticalOfferChange(offer, renamed)).toBe(false);
    expect(
      isCriticalOfferChange(offer, { ...offer, text: 'Лише тексти' }),
    ).toBe(true);
    expect(
      isCriticalOfferChange(offer, { ...offer, priceNote: '12 000' }),
    ).toBe(true);
    expect(
      isCriticalOfferChange(offer, {
        ...offer,
        facts: [
          ...offer.facts,
          { factKey: 'warranty', kind: 'fact', value: { m: 6 } },
        ],
      }),
    ).toBe(true);
    expect(sameValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    const base = {
      title: 'T',
      text: 'X',
      priceNote: '10 000',
      facts: [{ id: 'f1', version: 1, value: { a: 1 } }],
    };
    const h = offerHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(offerHash({ ...base, priceNote: '12 000' })).not.toBe(h);
    expect(
      offerHash({
        ...base,
        facts: [{ id: 'f1', version: 2, value: { a: 1 } }],
      }),
    ).not.toBe(h);
  });
});

describe('P-B1 rules: бриф F03 и QA F04', () => {
  it('готовность брифа: вклад, CTA, пояснение уместности, разрешённый источник, активный оффер', () => {
    expect(
      briefMissing({
        ownContribution: ' ',
        cta: null,
        ctaIntentNote: 'x',
        allowedSources: 0,
        offerActive: false,
      }),
    ).toEqual(['own_contribution', 'cta', 'allowed_source', 'offer_active']);
    expect(
      briefMissing({
        ownContribution: 'a',
        cta: 'b',
        ctaIntentNote: 'c',
        allowedSources: 1,
        offerActive: true,
      }),
    ).toEqual([]);
  });

  it('блокеры QA: код, текст, claimId; контакт в тексте — pii', () => {
    expect(
      checkBlockers([
        { code: 'claim_unsupported', claimId: 'c1', text: 'Немає джерела' },
      ]),
    ).toEqual({
      blockers: [
        { code: 'claim_unsupported', claimId: 'c1', text: 'Немає джерела' },
      ],
      issues: [],
    });
    expect(checkBlockers([{ code: 'Bad Code', text: 'x' }]).issues).toEqual([
      { field: 'blockers[0]', code: 'type' },
    ]);
    expect(
      checkBlockers([{ code: 'x', text: 'дзвоніть 067-123-45-67' }]).issues,
    ).toEqual([{ field: 'blockers[0].text', code: 'pii' }]);
  });
});

describe('P-B1 rules: diff и CSV', () => {
  it('line diff: общий префикс/суффикс, вставка и удаление', () => {
    const r = lineDiff('a\nb\nc', 'a\nx\nc');
    expect(r).toEqual({
      lines: [
        { op: 'eq', text: 'a' },
        { op: 'del', text: 'b' },
        { op: 'add', text: 'x' },
        { op: 'eq', text: 'c' },
      ],
      coarse: false,
    });
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
    const big2 = Array.from({ length: 3000 }, (_, i) => `m${i}`).join('\n');
    expect(lineDiff(big, big2).coarse).toBe(true);
    expect(setDiff(['a', 'b'], ['b', 'c'])).toEqual({
      added: ['c'],
      removed: ['a'],
    });
    expect(metaChangedKeys({ a: 1, b: [1] }, { a: 1, b: [2], c: 'x' })).toEqual(
      ['b', 'c'],
    );
  });

  it('CSV: формулы экранированы, кавычки и переводы строк', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+380')).toBe("'+380");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['h1', 'h2'], [['x', 1]])).toBe('h1,h2\r\nx,1\r\n');
  });

  it('причины отказа импорта — закрытый список §11.2', () => {
    expect(importReasonOf('ssrf')).toBe('ssrf');
    expect(importReasonOf('redirect_offsite')).toBe('redirect_offsite');
    expect(importReasonOf('excluded')).toBe('empty');
    expect(importReasonOf(undefined)).toBe('empty');
  });
});
