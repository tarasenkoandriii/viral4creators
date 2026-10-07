// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/delimiter-buffer.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import {
  ACTIONS_DELIMITER,
  ACTIONS_DELIMITER_MAX_PREFIX,
  ACTIONS_DELIMITER_MIN_DANGLING,
  danglingDelimiterPrefix,
  DelimiterStreamBuffer,
  splitActionsBlock,
} from './delimiter-buffer';

/** Прогоняет куски через буфер и возвращает всё, что ушло бы посетителю. */
function streamed(pieces: string[], delimiter?: string): string[] {
  const buf = new DelimiterStreamBuffer(delimiter);
  const out = pieces.map((p) => buf.push(p)).filter(Boolean);
  const tail = buf.flush();
  if (tail) out.push(tail);
  return out;
}

describe('splitActionsBlock', () => {
  it('без разделителя — весь текст и null', () => {
    expect(splitActionsBlock('ответ')).toEqual({
      text: 'ответ',
      rawActionsJson: null,
    });
  });

  it('режет по первому разделителю', () => {
    expect(splitActionsBlock(`А.${ACTIONS_DELIMITER}{"items":[]}`)).toEqual({
      text: 'А.',
      rawActionsJson: '{"items":[]}',
    });
  });

  it('свой разделитель — параметром', () => {
    expect(splitActionsBlock('текст##json', '##')).toEqual({
      text: 'текст',
      rawActionsJson: 'json',
    });
  });

  it('MAX_PREFIX равен длине разделителя', () => {
    expect(ACTIONS_DELIMITER_MAX_PREFIX).toBe(ACTIONS_DELIMITER.length);
  });
});

describe('DelimiterStreamBuffer', () => {
  it('без разделителя весь текст в итоге уходит наружу, по порядку', () => {
    const pieces = ['Привет, ', 'это длинный ответ ', 'без кнопок.'];
    expect(streamed(pieces).join('')).toBe(pieces.join(''));
  });

  it('держит хвост длиной delimiter.length - 1, пока он может быть началом разделителя', () => {
    const buf = new DelimiterStreamBuffer();
    const text = 'x'.repeat(20);
    expect(buf.push(text)).toBe(
      text.slice(0, 20 - (ACTIONS_DELIMITER.length - 1)),
    );
    expect(buf.flush()).toBe('x'.repeat(ACTIONS_DELIMITER.length - 1));
  });

  it('разделитель по одному символу — в стрим не попадает ни символа его и JSON', () => {
    const pieces = [
      'Ответ.',
      ...ACTIONS_DELIMITER.split(''),
      '{"items":[{"kind":"open-app"}]}',
    ];
    const out = streamed(pieces).join('');
    expect(out).toBe('Ответ.');
  });

  it('разделитель посреди куска — отдаётся текст до него, остальное копится', () => {
    const buf = new DelimiterStreamBuffer();
    expect(buf.push(`Ответ.${ACTIONS_DELIMITER}{"items"`)).toBe('Ответ.');
    expect(buf.delimiterFound).toBe(true);
    expect(buf.push(':[]}')).toBe('');
    expect(buf.flush()).toBe('');
    expect(buf.fullText).toBe(`Ответ.${ACTIONS_DELIMITER}{"items":[]}`);
  });

  it('похожее на начало разделителя, но не он — в итоге отдаётся целиком', () => {
    const out = streamed(['Сравните <<', '<act', 'ually> это']).join('');
    expect(out).toBe('Сравните <<<actually> это');
  });

  it('пустой кусок ничего не меняет', () => {
    const buf = new DelimiterStreamBuffer();
    expect(buf.push('')).toBe('');
    expect(buf.fullText).toBe('');
  });

  it('свой разделитель — параметром', () => {
    expect(streamed(['abc#', '#json'], '##').join('')).toBe('abc');
  });

  it('пустой разделитель — ошибка вызывающего, а не тихая потеря ответа', () => {
    expect(() => new DelimiterStreamBuffer('')).toThrow();
  });
});

describe('обрыв посреди разделителя (MAX_TOKENS)', () => {
  it('хвост «<<<acti» посетителю не уходит — только текст до него', () => {
    expect(streamed(['Ответ готов.', ' <<<acti']).join('')).toBe(
      'Ответ готов. ',
    );
  });

  it('обрывок, разрезанный на куски, — тоже', () => {
    expect(streamed(['Да', '<<', '<ac', 'tions>']).join('')).toBe('Да');
  });

  it('«<<<» — уже обрывок; «<» и «<<» в конце обычного текста остаются', () => {
    expect(streamed(['a <<<']).join('')).toBe('a ');
    expect(streamed(['a <']).join('')).toBe('a <');
    expect(streamed(['a <<']).join('')).toBe('a <<');
  });

  it('«<<<» внутри текста, а не в конце, — обычный текст', () => {
    expect(streamed(['x <<< y']).join('')).toBe('x <<< y');
  });

  it('после flush буфер больше ничего не отдаёт', () => {
    const buf = new DelimiterStreamBuffer();
    buf.push('ok <<<act');
    expect(buf.flush()).toBe('ok ');
    expect(buf.flush()).toBe('');
  });

  it('danglingDelimiterPrefix: самое длинное собственное начало, не короче порога', () => {
    expect(ACTIONS_DELIMITER_MIN_DANGLING).toBe(3);
    expect(danglingDelimiterPrefix('текст<<<actions>>')).toBe(
      ACTIONS_DELIMITER.length - 1,
    );
    expect(danglingDelimiterPrefix('текст<<<a')).toBe(4);
    expect(danglingDelimiterPrefix('текст<<')).toBe(0);
    expect(danglingDelimiterPrefix('текст<<', ACTIONS_DELIMITER, 1)).toBe(2);
    expect(danglingDelimiterPrefix('текст')).toBe(0);
    expect(danglingDelimiterPrefix('')).toBe(0);
    // Короткий свой разделитель: собственное начало короче порога — не трогаем.
    expect(danglingDelimiterPrefix('ab|', '||')).toBe(0);
  });
});
