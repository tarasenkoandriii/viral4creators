import { ACTIONS_DELIMITER, parseActions, splitActionsBlock } from './actions';

describe('splitActionsBlock (ТЗ §5.4)', () => {
  it('без разделителя — весь текст, rawActionsJson: null', () => {
    expect(splitActionsBlock('просто ответ')).toEqual({
      text: 'просто ответ',
      rawActionsJson: null,
    });
  });

  it('режет ровно по разделителю', () => {
    const full = `Ответ.${ACTIONS_DELIMITER}{"items":[]}`;
    expect(splitActionsBlock(full)).toEqual({
      text: 'Ответ.',
      rawActionsJson: '{"items":[]}',
    });
  });
});

describe('parseActions (ТЗ §5.4)', () => {
  it('null → []', () => {
    expect(parseActions(null)).toEqual([]);
  });

  it('битый JSON → [] молча', () => {
    expect(parseActions('{not json')).toEqual([]);
  });

  it('не массив items → []', () => {
    expect(parseActions('{"items":"nope"}')).toEqual([]);
  });

  it('валидные действия каждого kind проходят', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'step', stepId: 7 },
        { kind: 'open-app' },
        { kind: 'plan', planId: 'STANDARD' },
        { kind: 'faq', faqIndex: 3 },
        { kind: 'legal', slug: 'offer' },
      ],
    });
    // Ограничение — максимум 3, поэтому валидны все пять, но останутся
    // первые три (проверяется отдельным тестом ниже).
    const result = parseActions(raw);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[0]).toEqual({ kind: 'step', stepId: 7 });
  });

  it('kind:video с непустым subjectKey проходит (этап 99, §4.8)', () => {
    const raw = JSON.stringify({
      items: [{ kind: 'video', subjectKey: 'plan-upgrade' }],
    });
    expect(parseActions(raw)).toEqual([
      { kind: 'video', subjectKey: 'plan-upgrade' },
    ]);
  });

  it('kind:video с пустым subjectKey отбрасывает элемент', () => {
    const raw = JSON.stringify({
      items: [{ kind: 'video', subjectKey: '  ' }],
    });
    expect(parseActions(raw)).toEqual([]);
  });

  it('kind:video без subjectKey отбрасывает элемент', () => {
    const raw = JSON.stringify({ items: [{ kind: 'video' }] });
    expect(parseActions(raw)).toEqual([]);
  });

  it('не больше одного video-действия — второе отбрасывается структурно (аудит §10, п.8)', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'video', subjectKey: 'first' },
        { kind: 'step', stepId: 2 },
        { kind: 'video', subjectKey: 'second' },
      ],
    });
    const result = parseActions(raw);
    expect(result).toEqual([
      { kind: 'video', subjectKey: 'first' },
      { kind: 'step', stepId: 2 },
    ]);
  });

  it('обрезает до 3 элементов', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'step', stepId: 1 },
        { kind: 'step', stepId: 2 },
        { kind: 'step', stepId: 3 },
        { kind: 'step', stepId: 4 },
      ],
    });
    expect(parseActions(raw)).toHaveLength(3);
  });

  it('невалидный stepId (вне 1..10) отбрасывает элемент', () => {
    const raw = JSON.stringify({ items: [{ kind: 'step', stepId: 99 }] });
    expect(parseActions(raw)).toEqual([]);
  });

  it('planId не из PLAN_IDS отбрасывает элемент', () => {
    const raw = JSON.stringify({
      items: [{ kind: 'plan', planId: 'ENTERPRISE' }],
    });
    expect(parseActions(raw)).toEqual([]);
  });

  it('faqIndex вне диапазона отбрасывает элемент', () => {
    const raw = JSON.stringify({ items: [{ kind: 'faq', faqIndex: 999 }] });
    expect(parseActions(raw)).toEqual([]);
  });

  it('legal slug не из allow-list отбрасывает элемент', () => {
    const raw = JSON.stringify({ items: [{ kind: 'legal', slug: 'privacy' }] });
    expect(parseActions(raw)).toEqual([]);
  });

  it('неизвестный kind отбрасывает элемент', () => {
    const raw = JSON.stringify({ items: [{ kind: 'delete-account' }] });
    expect(parseActions(raw)).toEqual([]);
  });
});
