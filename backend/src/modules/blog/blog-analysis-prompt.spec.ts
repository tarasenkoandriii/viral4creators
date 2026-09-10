import {
  buildBlogAnalysisPrompt,
  parseBlogAnalysisResponse,
} from './blog-analysis-prompt';

describe('buildBlogAnalysisPrompt', () => {
  it('содержит заголовок, канал, нишу и требование строгого JSON-ответа', () => {
    const prompt = buildBlogAnalysisPrompt({
      title: 'Крутая реклама кроссовок',
      channelTitle: 'RunChannel',
      category: 'обувь',
    });
    expect(prompt).toContain('Крутая реклама кроссовок');
    expect(prompt).toContain('RunChannel');
    expect(prompt).toContain('обувь');
    expect(prompt).toContain(
      '{"score": number, "scoreReasoning": string, "title": string, "bodyHtml": string}',
    );
  });
});

describe('parseBlogAnalysisResponse', () => {
  it('разбирает чистый JSON без ограждений', () => {
    const raw = JSON.stringify({
      score: 82,
      scoreReasoning: 'Сильный крючок, ясный оффер.',
      title: 'Почему это работает',
      bodyHtml: '<p>Текст</p>',
    });
    expect(parseBlogAnalysisResponse(raw)).toEqual({
      score: 82,
      scoreReasoning: 'Сильный крючок, ясный оффер.',
      title: 'Почему это работает',
      bodyHtml: '<p>Текст</p>',
    });
  });

  it('снимает ```json ограждения и берёт внешние {...} среди преамбулы', () => {
    const raw =
      'Конечно, вот разбор:\n```json\n{"score": 50, "scoreReasoning": "ok", "title": "T", "bodyHtml": "<p>b</p>"}\n```\nНадеюсь, помогло!';
    expect(parseBlogAnalysisResponse(raw)).toEqual({
      score: 50,
      scoreReasoning: 'ok',
      title: 'T',
      bodyHtml: '<p>b</p>',
    });
  });

  it('зажимает оценку в диапазон 0–100', () => {
    const over = JSON.stringify({
      score: 150,
      title: 'T',
      bodyHtml: '<p>b</p>',
    });
    expect(parseBlogAnalysisResponse(over)?.score).toBe(100);
    const under = JSON.stringify({
      score: -20,
      title: 'T',
      bodyHtml: '<p>b</p>',
    });
    expect(parseBlogAnalysisResponse(under)?.score).toBe(0);
  });

  it('score отсутствует или не число — считается нулём, не бросает', () => {
    const raw = JSON.stringify({ title: 'T', bodyHtml: '<p>b</p>' });
    expect(parseBlogAnalysisResponse(raw)?.score).toBe(0);
  });

  it('нет title или bodyHtml — null, черновик заводить нечего', () => {
    expect(
      parseBlogAnalysisResponse(JSON.stringify({ score: 90, title: 'T' })),
    ).toBeNull();
    expect(
      parseBlogAnalysisResponse(
        JSON.stringify({ score: 90, bodyHtml: '<p>b</p>' }),
      ),
    ).toBeNull();
  });

  it('невалидный JSON — null, не бросает', () => {
    expect(parseBlogAnalysisResponse('вообще не JSON')).toBeNull();
    expect(parseBlogAnalysisResponse('')).toBeNull();
  });
});
