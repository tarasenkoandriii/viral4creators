import { evaluateGates, heldReasonText, type GateInput } from './gates';

const ok: GateInput = {
  coldStart: false,
  previouslyPublishedPages: 100,
  brokenPages: 0,
  changedPages: 5,
  largestIdenticalGroup: 0,
  parentLangs: { uk: 90, ru: 10 },
  newLangs: { uk: 90, ru: 10 },
  newQuarantined: 0,
  totalChunks: 500,
  invariantEval: { ran: true, failed: 0, total: 10, failures: [] },
};

const held = (i: Partial<GateInput>, check: string) => {
  const r = evaluateGates({ ...ok, ...i });
  expect(r.held).toBe(true);
  expect(r.checks.find((c) => c.check === check)?.held).toBe(true);
  return r;
};

describe('ворота публикации (§4-тер.2, Р-32)', () => {
  it('обычный переобход — публикуется', () => {
    const r = evaluateGates(ok);
    expect(r.held).toBe(false);
    expect(r.checks.map((c) => c.check)).toEqual([
      'gone_or_error_share',
      'identical_changed_share',
      'lang_shift',
      'quarantine_share',
      'invariant_eval',
    ]);
  });

  it('> 30% страниц сломались — держим; ровно 30% — нет', () => {
    held({ brokenPages: 31 }, 'gone_or_error_share');
    expect(evaluateGates({ ...ok, brokenPages: 30 }).held).toBe(false);
    // Мелкий сайт: одна удалённая страница из трёх — не повод держать.
    expect(
      evaluateGates({ ...ok, previouslyPublishedPages: 3, brokenPages: 1 })
        .held,
    ).toBe(false);
  });

  it('одинаковый текст у > 50% изменившихся (≥ 10) — заглушка', () => {
    held(
      { changedPages: 10, largestIdenticalGroup: 6 },
      'identical_changed_share',
    );
    expect(
      evaluateGates({ ...ok, changedPages: 9, largestIdenticalGroup: 9 }).held,
    ).toBe(false);
    expect(
      evaluateGates({ ...ok, changedPages: 10, largestIdenticalGroup: 5 }).held,
    ).toBe(false);
  });

  it('смена преобладающего языка > 40 п.п.', () => {
    held({ newLangs: { uk: 40, en: 60 } }, 'lang_shift');
    expect(evaluateGates({ ...ok, newLangs: { uk: 60, ru: 40 } }).held).toBe(
      false,
    );
  });

  it('карантин > 10% версии и ≥ 3 фрагментов — «похоже на взлом»', () => {
    held({ newQuarantined: 60, totalChunks: 500 }, 'quarantine_share');
    expect(
      evaluateGates({ ...ok, newQuarantined: 2, totalChunks: 10 }).held,
    ).toBe(false);
    expect(
      evaluateGates({ ...ok, newQuarantined: 50, totalChunks: 500 }).held,
    ).toBe(false);
  });

  it('инвариантный eval: любой провал держит; не запускался — не держит, с пометкой', () => {
    held(
      {
        invariantEval: {
          ran: true,
          failed: 1,
          total: 10,
          failures: ['x: нет отказа'],
        },
      },
      'invariant_eval',
    );
    const r = evaluateGates({
      ...ok,
      invariantEval: { ran: false, note: 'отложен: нет бюджета обучения' },
    });
    expect(r.held).toBe(false);
    expect(r.checks.find((c) => c.check === 'invariant_eval')?.note).toMatch(
      /бюджет/,
    );
  });

  it('холодный старт — ворота аномалий не применяются', () => {
    const r = evaluateGates({
      ...ok,
      coldStart: true,
      brokenPages: 100,
      newQuarantined: 400,
    });
    expect(r.held).toBe(false);
    expect(r.coldStart).toBe(true);
  });

  it('причина удержания — человеческим текстом', () => {
    const r = evaluateGates({ ...ok, brokenPages: 50 });
    expect(heldReasonText(r)).toMatch(/50% страниц сайта не открылись/);
    expect(heldReasonText(evaluateGates(ok))).toBeNull();
  });
});
