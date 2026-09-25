import {
  buildTrackTranslationPrompt,
  parseTrackTranslation,
  syllableCount,
} from './track-translation';

/**
 * Перевод реплики под хронометраж (§5 ТЗ, этап 138).
 *
 * Проверяется то, из-за чего этот перевод отличается от обычного:
 * требование длины стоит первым и выражено в слогах, а повторная
 * попытка несёт явное число процентов — без него модель возвращает ту
 * же фразу другими словами.
 */
describe('syllableCount', () => {
  it('считает гласные кириллицы и латиницы одинаково', () => {
    expect(syllableCount('кружка')).toBe(2);
    expect(syllableCount('mug')).toBe(1);
    // Умляуты и диакритика — тоже гласные: немецкий и испанский в
    // локалях продукта, и без них счёт был бы систематически занижен.
    expect(syllableCount('Öl für Tür')).toBe(3);
    expect(syllableCount('')).toBe(0);
  });
});

describe('buildTrackTranslationPrompt', () => {
  it('требование длины стоит раньше всего остального', () => {
    const prompt = buildTrackTranslationPrompt({
      speech: 'Стальная кружка держит тепло шесть часов',
      source: 'ru',
      target: 'de',
    });
    const lengthAt = prompt.indexOf('same time to say out loud');
    const meaningAt = prompt.indexOf('Meaning and tone');
    expect(lengthAt).toBeGreaterThan(-1);
    expect(lengthAt).toBeLessThan(meaningAt);
    expect(prompt).toContain('German');
    expect(prompt).toContain('Russian');
  });

  it('бюджет слогов первой попытки — как у оригинала', () => {
    const speech = 'кружка';
    const prompt = buildTrackTranslationPrompt({
      speech,
      source: 'ru',
      target: 'en',
    });
    expect(prompt).toContain(`${syllableCount(speech)} syllables`);
  });

  it('повторная попытка несёт число процентов и прошлый вариант', () => {
    // Без явного числа модель возвращает ту же фразу другими словами —
    // это записано в ТЗ отдельным требованием.
    const prompt = buildTrackTranslationPrompt({
      speech: 'Стальная кружка держит тепло шесть часов',
      source: 'ru',
      target: 'de',
      shorterByPercent: 25,
      previous: 'Der Stahlbecher hält die Wärme sechs Stunden lang warm',
    });
    expect(prompt).toContain('25% shorter');
    expect(prompt).toContain('Der Stahlbecher');
    // И бюджет слогов ужат ровно на те же 25 %.
    const budget = Math.round(
      syllableCount('Стальная кружка держит тепло шесть часов') * 0.75,
    );
    expect(prompt).toContain(`${budget} syllables`);
  });

  it('прошлого варианта нет — не выдумываем его', () => {
    const prompt = buildTrackTranslationPrompt({
      speech: 'кружка',
      source: 'ru',
      target: 'en',
      shorterByPercent: 25,
    });
    expect(prompt).not.toContain('previous version');
  });
});

describe('buildTrackTranslationPrompt — построчно (этап 141)', () => {
  const TWO = 'Стальная кружка держит тепло\nШесть часов';

  it('реплика из двух битов уходит нумерованной и просит столько же строк', () => {
    const prompt = buildTrackTranslationPrompt({
      speech: TWO,
      source: 'ru',
      target: 'de',
    });
    expect(prompt).toContain('1. Стальная кружка держит тепло');
    expect(prompt).toContain('2. Шесть часов');
    expect(prompt).toContain('exactly 2 lines');
    // И бюджет слогов остаётся общим: длина меряется по всей реплике.
    expect(prompt).toContain(
      `${syllableCount(TWO)} syllables or fewer in total`,
    );
  });

  it('однострочную реплику не нумеруют', () => {
    // Нумерация одной строки — приглашение модели дописать вторую.
    const prompt = buildTrackTranslationPrompt({
      speech: 'кружка',
      source: 'ru',
      target: 'en',
    });
    expect(prompt).toContain('One line of plain speech');
    expect(prompt).not.toContain('1. кружка');
  });
});

describe('buildTrackTranslationPrompt — повторный заход построчно', () => {
  const TWO = 'Стальная кружка держит тепло\nШесть часов';

  it('на сокращении не просят «как оригинал» — это противоречие', () => {
    // Находка аудита этапа 141: «каждая строка примерно как своя
    // оригинальная» и «сделай на 25 % короче» отменяют друг друга.
    const prompt = buildTrackTranslationPrompt({
      speech: TWO,
      source: 'ru',
      target: 'de',
      shorterByPercent: 25,
      previous: 'Der Stahlbecher hält Wärme\nSechs Stunden',
    });
    expect(prompt).not.toContain('as long as its own original');
    expect(prompt).toContain('proportions must stay');
  });

  it('прошлый вариант показывается в той же форме, в какой ждут ответ', () => {
    // Неразмеченный образец рядом с «ответь нумерованными строками» —
    // приглашение ответить как образец.
    const prompt = buildTrackTranslationPrompt({
      speech: TWO,
      source: 'ru',
      target: 'de',
      shorterByPercent: 25,
      previous: 'Der Stahlbecher hält Wärme\nSechs Stunden',
    });
    expect(prompt).toContain('1. Der Stahlbecher hält Wärme');
    expect(prompt).toContain('2. Sechs Stunden');
  });
});

describe('parseTrackTranslation', () => {
  it('снимает кавычки и служебные префиксы', () => {
    expect(parseTrackTranslation('"Steel mug keeps heat"')).toBe(
      'Steel mug keeps heat',
    );
    expect(parseTrackTranslation('Перевод: Стальная кружка')).toBe(
      'Стальная кружка',
    );
    expect(parseTrackTranslation('«Стальная кружка»')).toBe('Стальная кружка');
  });

  it('берёт первую строку: пояснения модель дописывает снизу', () => {
    expect(
      parseTrackTranslation('Steel mug keeps heat\n\n(24 syllables)'),
    ).toBe('Steel mug keeps heat');
  });

  it('строки собираются по номерам, а не по порядку (этап 141)', () => {
    // Пояснения модель дописывает снизу, и без номеров «(24 syllables)»
    // встало бы на место второй реплики — и уехало бы в синтез.
    expect(
      parseTrackTranslation(
        'Here you go:\n1. Steel mug keeps the heat\n2. Six hours\n\n(24 syllables)',
        2,
      ),
    ).toBe('Steel mug keeps the heat\nSix hours');
  });

  it('перепутанный порядок строк восстанавливается по номерам', () => {
    expect(
      parseTrackTranslation('2. Six hours\n1. Steel mug keeps the heat', 2),
    ).toBe('Steel mug keeps the heat\nSix hours');
  });

  it('приписка снизу с чужим номером разбивку не ломает', () => {
    // «3.» при двух битах — это не реплика, а итог, который модель
    // дописала себе. Отбросить её лучше, чем потерять из-за неё всю
    // разбивку.
    expect(
      parseTrackTranslation(
        '1. Steel mug keeps the heat\n2. Six hours\n3. (24 syllables total)',
        2,
      ),
    ).toBe('Steel mug keeps the heat\nSix hours');
  });

  it('повторённый номер — откат к склейке, а не выбор монеткой', () => {
    // Модель переписала сама себя; какой из двух вариантов ответ —
    // знать неоткуда.
    expect(
      parseTrackTranslation(
        '1. Steel mug keeps heat\n1. Steel mug holds heat\n2. Six hours',
        2,
      ),
    ).toBe('Steel mug keeps heat');
  });

  it('неполный набор строк — откат к склейке, а не половина реплики', () => {
    // Половина битов хуже склейки: зритель услышал бы обрывок, а
    // субтитр показал бы его на весь ролик как полную мысль.
    expect(parseTrackTranslation('1. Steel mug keeps the heat', 2)).toBe(
      'Steel mug keeps the heat',
    );
  });

  it('ответ без нумерации вовсе — тоже откат, а не выдуманные номера', () => {
    expect(
      parseTrackTranslation('Steel mug keeps the heat\nSix hours', 2),
    ).toBe('Steel mug keeps the heat');
  });

  it('пустой ответ — null, а не пустая реплика', () => {
    // Пустая реплика уехала бы в синтез и дала бы немую дорожку.
    expect(parseTrackTranslation('')).toBeNull();
    expect(parseTrackTranslation('   \n  ')).toBeNull();
    expect(parseTrackTranslation('""')).toBeNull();
  });
});
