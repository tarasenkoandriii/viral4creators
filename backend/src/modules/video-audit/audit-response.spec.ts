import {
  auditPrompt,
  manualFixPrompt,
  MAX_ISSUES,
  parseAuditResponse,
  parseIssues,
  parseManualFixResponse,
  parsePromptFix,
} from './audit-response';

describe('audit prompts', () => {
  it('embed the current prompt and ask for the JSON contract', () => {
    const p = auditPrompt('8 seconds; UGC realism…');
    expect(p).toContain('8 seconds; UGC realism…');
    expect(p).toContain('"verdict": "clean" | "issues"');
    expect(p).toContain('promptFix');
    const m = manualFixPrompt('the prompt', 'третья рука на 0:03');
    expect(m).toContain('третья рука на 0:03');
    expect(m).toContain('the prompt');
    expect(m).toContain('suggestedText');
  });
});

describe('parseIssues', () => {
  it('normalises severity/category/timecode, ids rows, caps the list', () => {
    const rows = parseIssues([
      {
        severity: 'HIGH',
        category: 'Anatomy',
        description: 'третья рука',
        timecode: '0:03',
      },
      { severity: 'weird', description: 'лицо плывёт' },
      { issue: 'товар удвоен', time: '0:06', category: 'product' },
      { category: 'x' },
      'nope',
    ]);
    expect(rows).toEqual([
      {
        id: 'a1',
        severity: 'high',
        category: 'anatomy',
        description: 'третья рука',
        timecode: '0:03',
      },
      {
        id: 'a2',
        severity: 'medium',
        category: 'other',
        description: 'лицо плывёт',
        timecode: null,
      },
      {
        id: 'a3',
        severity: 'medium',
        category: 'product',
        description: 'товар удвоен',
        timecode: '0:06',
      },
    ]);
    expect(
      parseIssues(Array.from({ length: 20 }, () => ({ description: 'x' }))),
    ).toHaveLength(MAX_ISSUES);
    expect(parseIssues('none')).toEqual([]);
  });
});

describe('parsePromptFix', () => {
  it('accepts suggestedText/prompt/text synonyms, requires text', () => {
    expect(parsePromptFix({ suggestedText: 'A', rationale: 'r' })).toEqual({
      suggestedText: 'A',
      rationale: 'r',
    });
    expect(parsePromptFix({ prompt: 'B' })).toEqual({
      suggestedText: 'B',
      rationale: '',
    });
    expect(parsePromptFix({ rationale: 'only' })).toBeNull();
    expect(parsePromptFix(null)).toBeNull();
    expect(parsePromptFix('str')).toBeNull();
  });
});

describe('parseAuditResponse', () => {
  it('clean verdict → no fix even if the model attached one', () => {
    const r = parseAuditResponse(
      JSON.stringify({
        verdict: 'clean',
        summary: 'Всё чисто',
        issues: [],
        promptFix: { suggestedText: 'x' },
      }),
    );
    expect(r).toEqual({
      verdict: 'clean',
      summary: 'Всё чисто',
      issues: [],
      promptFix: null,
    });
  });

  it('issues present override a contradicting "clean" verdict', () => {
    const r = parseAuditResponse(
      '```json\n' +
        JSON.stringify({
          verdict: 'clean',
          issues: [{ description: 'третья рука' }],
          promptFix: {
            suggestedText: 'fixed prompt',
            rationale: 'добавил ограничение',
          },
        }) +
        '\n```',
    );
    expect(r.verdict).toBe('issues');
    expect(r.summary).toBe('Найдено проблем: 1');
    expect(r.promptFix?.suggestedText).toBe('fixed prompt');
  });

  it('missing verdict and no issues → clean with a default summary', () => {
    const r = parseAuditResponse('{"issues": []}');
    expect(r.verdict).toBe('clean');
    expect(r.summary).toBe('Артефактов не обнаружено');
  });

  it('non-JSON → unknown with the raw text, never throws', () => {
    const r = parseAuditResponse('The model rambled.');
    expect(r).toEqual({
      verdict: 'unknown',
      summary: 'The model rambled.',
      issues: [],
      promptFix: null,
    });
    expect(parseAuditResponse('').summary).toBe('Пустой ответ модели');
  });
});

describe('parseManualFixResponse', () => {
  it('returns summary + fix without verdict logic; tolerates junk', () => {
    expect(
      parseManualFixResponse(
        JSON.stringify({
          summary: 'ok',
          promptFix: { suggestedText: 'fixed' },
        }),
      ),
    ).toEqual({
      summary: 'ok',
      promptFix: { suggestedText: 'fixed', rationale: '' },
    });
    expect(parseManualFixResponse('nope')).toEqual({
      summary: '',
      promptFix: null,
    });
  });
});
