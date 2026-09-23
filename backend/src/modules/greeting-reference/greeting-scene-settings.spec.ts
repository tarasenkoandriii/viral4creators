import {
  MAX_SETTING_LENGTH,
  buildSettingsPrompt,
  parseSettings,
} from './greeting-scene-settings';

/**
 * Фича №36. Проверяется в первую очередь ПАРСЕР: модель отвечает
 * свободным текстом, и всё, что она добавит от себя — нумерацию,
 * вступление, кавычки, — увидит не разработчик, а пользователь, в виде
 * варианта «1. Вот три варианта:».
 */
describe('buildSettingsPrompt (№36)', () => {
  it('у праздничного повода не просит убирать праздник', () => {
    const p = buildSettingsPrompt('BIRTHDAY', null, 'WARM');
    expect(p).toContain('праздничное');
    expect(p).not.toContain('никаких шаров');
  });

  it('у соболезнования ЗАПРЕЩАЕТ праздничную атрибутику отдельной строкой', () => {
    const p = buildSettingsPrompt('CONDOLENCE', null, 'RESPECTFUL');
    expect(p).toContain('никаких шаров');
    expect(p).toContain('сдержанное');
  });

  it('свой повод подставляется вместо родовой подписи', () => {
    const p = buildSettingsPrompt('OTHER', 'защита диплома', 'WARM');
    expect(p).toContain('защита диплома');
  });
});

describe('parseSettings (№36)', () => {
  it('чистый ответ из трёх строк разбирается как есть', () => {
    const out = parseSettings(
      'Sunlit kitchen with fresh flowers on the table\n' +
        'Cosy living room, warm lamps, soft blanket on the sofa\n' +
        'Summer terrace at golden hour, greenery in the background',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('Sunlit kitchen with fresh flowers on the table');
  });

  it('нумерация, маркеры и кавычки снимаются', () => {
    const out = parseSettings(
      '1. Sunlit kitchen with fresh flowers\n' +
        '- Cosy living room with warm lamps\n' +
        '• "Summer terrace at golden hour"',
    );
    expect(out).toEqual([
      'Sunlit kitchen with fresh flowers',
      'Cosy living room with warm lamps',
      'Summer terrace at golden hour',
    ]);
  });

  it('вступление «Вот три варианта:» не становится вариантом', () => {
    const out = parseSettings(
      'Вот три варианта:\n' +
        'Sunlit kitchen with fresh flowers\n' +
        'Cosy living room with warm lamps',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('Sunlit kitchen with fresh flowers');
  });

  it('четвёртый вариант отбрасывается — просили три', () => {
    const out = parseSettings(
      [
        'Sunlit kitchen with flowers',
        'Cosy living room lamps',
        'Summer terrace evening',
        'Snowy balcony at night',
      ].join('\n'),
    );
    expect(out).toHaveLength(3);
  });

  it('длинный вариант режется по потолку — он уходит в промпт картинки', () => {
    const long = 'A '.repeat(200);
    const out = parseSettings(long);
    expect(out[0].length).toBeLessThanOrEqual(MAX_SETTING_LENGTH);
  });

  it('мусор и пустота дают пустой список, а не выдуманные варианты', () => {
    expect(parseSettings('')).toEqual([]);
    expect(parseSettings(null)).toEqual([]);
    // Короткие обрывки — не описание обстановки.
    expect(parseSettings('ок\nда\n...')).toEqual([]);
  });
});
