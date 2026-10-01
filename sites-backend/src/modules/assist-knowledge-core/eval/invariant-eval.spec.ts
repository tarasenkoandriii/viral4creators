import { INVARIANT_CASES } from './invariant-cases';
import { judgeInvariant, runInvariantEval } from './invariant-eval';

describe('инвариантный eval (§4-тер.2)', () => {
  it('10 кейсов, уникальные id, все — отказ; подстроки в нижнем регистре', () => {
    expect(INVARIANT_CASES).toHaveLength(10);
    expect(new Set(INVARIANT_CASES.map((c) => c.id)).size).toBe(10);
    for (const c of INVARIANT_CASES) {
      expect(c.expectRefusal).toBe(true);
      for (const s of c.mustNotSay) expect(s).toBe(s.toLowerCase());
    }
    // Есть и «вне знаний», и инъекции; uk/ru/en.
    expect(INVARIANT_CASES.some((c) => c.id.startsWith('oos-'))).toBe(true);
    expect(INVARIANT_CASES.some((c) => c.id.startsWith('inj-'))).toBe(true);
  });

  it('судья: нет отказа или запрещённая подстрока — провал', () => {
    const c = INVARIANT_CASES.find((x) => x.id === 'inj-role-ru')!;
    expect(judgeInvariant(c, { refused: true, text: 'Не знаю.' })).toBeNull();
    expect(judgeInvariant(c, { refused: false, text: 'Не знаю.' })).toMatch(
      /отказа/,
    );
    expect(judgeInvariant(c, { refused: true, text: 'АРР!' })).toMatch(/арр/);
  });

  it('прогон: поиск каждого вопроса, сумма токенов, список провалов', async () => {
    const searched: string[] = [];
    const r = await runInvariantEval({
      search: async (q) => {
        searched.push(q);
        return [];
      },
      answer: async (req) => ({
        text: req.question.includes('пират') ? 'Арр!' : 'Не знаю',
        sources: [],
        refused: !req.question.includes('пират'),
        model: 'm',
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: 1,
      }),
    });
    expect(searched).toHaveLength(10);
    expect(r.passed).toBe(9);
    expect(r.failed).toBe(1);
    expect(r.failures[0].id).toBe('inj-role-ru');
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(20);
    expect(r.cachedInputTokens).toBe(10);
  });
});
