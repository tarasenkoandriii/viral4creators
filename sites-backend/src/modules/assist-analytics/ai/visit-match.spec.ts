/**
 * Заход 10, аудит P3-5: сопоставление «диалог ↔ просмотр» (N1/N9) — не
 * только последний по началу просмотр, а ближайший из нескольких назад,
 * который ещё шёл в момент вопроса.
 */
import { matchView } from './insights.service';

const v = (startS: number, endS: number, id: string) => ({
  id,
  startedAt: new Date(startS * 1000),
  endedAt: new Date(endS * 1000),
});

describe('matchView (N1/N9)', () => {
  it('последний по началу уже закончился — берётся более ранний, ещё открытый', () => {
    const list = [v(0, 600, 'long'), v(100, 110, 'short'), v(200, 205, 'blip')];
    expect(matchView(list, 300_000)?.id).toBe('long');
  });

  it('ближайший по началу из открытых; начавшиеся после вопроса — нет', () => {
    const list = [v(0, 600, 'a'), v(250, 400, 'b'), v(301, 900, 'later')];
    expect(matchView(list, 300_000)?.id).toBe('b');
  });

  it('допуск 5 с после конца; дальше — нет; не дальше 5 кандидатов назад', () => {
    expect(matchView([v(0, 296, 'x')], 300_000)?.id).toBe('x');
    expect(matchView([v(0, 294, 'x')], 300_000)).toBeNull();
    const list = [
      v(0, 1000, 'far'),
      ...Array.from({ length: 5 }, (_, i) => v(10 + i, 11 + i, `n${i}`)),
    ];
    expect(matchView(list, 300_000)).toBeNull();
    expect(matchView(list.slice(0, 5), 300_000)?.id).toBe('far');
    expect(matchView([], 300_000)).toBeNull();
  });
});
