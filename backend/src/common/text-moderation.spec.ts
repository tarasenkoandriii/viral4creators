import { findModerationFlags, normalizeForModeration } from './text-moderation';

describe('normalizeForModeration', () => {
  it('складывает гомоглифы — латинская «а» выглядит как кириллическая', () => {
    // Простейший обход списка слов: подменить одну букву.
    expect(normalizeForModeration('пopно')).toBe(
      normalizeForModeration('порно'),
    );
  });

  it('вычищает невидимые разделители', () => {
    expect(normalizeForModeration('по​рно')).toBe('порно');
  });

  it('схлопывает растянутые буквы', () => {
    expect(normalizeForModeration('пооооорно')).toContain('порно');
  });

  it('две одинаковые буквы подряд — это слово, а не растягивание', () => {
    // Иначе «аллея» и «ссора» ломались бы на ровном месте.
    expect(normalizeForModeration('аллея')).toBe('аллея');
  });
});

describe('findModerationFlags — соболезнование НЕ блокируется', () => {
  // Повод СОБОЛЕЗНОВАНИЕ есть в продукте. Наивный список слов про
  // смерть заблокировал бы именно его, и человек получил бы отказ в
  // самый неподходящий момент своей жизни.
  const condolences = [
    'Светлая память. Скорблю вместе с вами о вашей утрате.',
    'Примите мои соболезнования в связи со смертью вашего отца.',
    'Мені дуже шкода. Співчуваю вашій втраті.',
    'Похороны в субботу, я буду рядом.',
    'Он умер тихо, во сне. Помню его добрым.',
    'I am so sorry for your loss. Your mother was a wonderful person.',
    'Деда не стало вчера. Держитесь.',
  ];

  it.each(condolences)('не флагует: %s', (text) => {
    expect(findModerationFlags(text)).toEqual([]);
  });
});

describe('findModerationFlags — обычные поздравления не блокируются', () => {
  const harmless = [
    'Марина, с днём рождения! Пусть всё получается.',
    'Убью вечер за работой, но поздравить успею.',
    'Ты меня убила этой новостью — в хорошем смысле!',
    'До смерти рад тебя видеть.',
    'Аллея в парке, где мы гуляли, всё так же красива.',
    'Вітаю з річницею! Щасливі роки попереду.',
    'Happy birthday! You are killing it this year.',
  ];

  it.each(harmless)('не флагует: %s', (text) => {
    expect(findModerationFlags(text)).toEqual([]);
  });
});

describe('findModerationFlags — адресованные угрозы ловятся', () => {
  // Угроза отличается от соболезнования связкой «действие + адресат»,
  // а не отдельными словами.
  const threats = [
    'Я убью тебя, когда встречу',
    'чтоб ты сдох',
    'щоб ти здох',
    'Сдохни уже',
    "I'll kill you",
    'взорву твой дом',
    "Я вб'ю тебе",
  ];

  it.each(threats)('флагует угрозу: %s', (text) => {
    expect(findModerationFlags(text)).toContain('threat');
  });

  it('угроза через гомоглифы всё равно ловится', () => {
    expect(findModerationFlags('чтоб ты cдox')).toContain('threat');
  });
});

describe('findModerationFlags — остальные категории', () => {
  it('сексуальный контент', () => {
    expect(findModerationFlags('порнография в кадре')).toContain(
      'sexual-content',
    );
    expect(findModerationFlags('explicit sexual content')).toContain(
      'sexual-content',
    );
  });

  it('язык вражды', () => {
    expect(findModerationFlags('этническая чистка')).toContain('hate-speech');
    expect(findModerationFlags('sieg heil')).toContain('hate-speech');
  });

  it('запрещённое', () => {
    expect(findModerationFlags('где купить оружие без документов')).toContain(
      'illegal-content',
    );
    expect(findModerationFlags('кокаин')).toContain('illegal-content');
  });

  it('категория в ответе одна, даже если сработало несколько выражений', () => {
    const flags = findModerationFlags('героин и кокаин');
    expect(flags.filter((f) => f === 'illegal-content')).toHaveLength(1);
  });

  it('склонения ловятся основой — русский язык не словарь форм', () => {
    for (const form of ['кокаина', 'кокаином', 'кокаину']) {
      expect(findModerationFlags(form)).toContain('illegal-content');
    }
  });

  it('основа не срабатывает внутри другого слова', () => {
    // Граница слева обязательна, иначе ловилось бы в середине.
    expect(findModerationFlags('барракуда')).toEqual([]);
    expect(findModerationFlags('спорно')).toEqual([]);
  });

  it('пустой текст — пусто, а не падение', () => {
    for (const text of ['', '   ', null as unknown as string]) {
      expect(findModerationFlags(text)).toEqual([]);
    }
  });
});
