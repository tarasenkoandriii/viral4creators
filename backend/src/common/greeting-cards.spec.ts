import {
  CARD_SECONDS,
  MAX_CARD_TEXT_LENGTH,
  assColor,
  assTime,
  normalizeCardStyle,
  buildCardsAss,
  escapeAssText,
  hasCards,
} from './greeting-cards';

const opts = { totalDurationSeconds: 15, aspectRatio: '9:16' };

/** Строки Dialogue — то единственное, что реально рисуется. */
function events(ass: string): string[] {
  return ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
}

describe('escapeAssText', () => {
  it('фигурные скобки экранируются — иначе libass примет их за команду', () => {
    // Незакрытый или чужой блок `{...}` либо съест текст, либо
    // применит к нему что попало.
    expect(escapeAssText('С {днём} рождения')).toBe('С \\{днём\\} рождения');
  });

  it('обратный слэш становится косой чертой, а не удваивается', () => {
    // В тексте Dialogue у ASS нет способа записать литеральный
    // бэкслэш. Удвоение давало худший из исходов: `ААА\\NБББ` в файле
    // libass рисует как `ААА\\` + перенос строки + `БББ` — и лишний
    // слэш, и тот самый перенос. Проверено отрисовкой при этапе E.
    expect(escapeAssText('ААА\\NБББ')).toBe('ААА/NБББ');
    expect(escapeAssText('Путь C:\\Users')).toBe('Путь C:/Users');
  });

  it('перевод строки становится \\N — одна реплика это одна строка файла', () => {
    expect(escapeAssText('Марине\nот Андрея')).toBe('Марине\\Nот Андрея');
    expect(escapeAssText('a\r\nb')).toBe('a\\Nb');
  });

  it('обратная косая обрабатывается ПЕРВОЙ, а не после скобок', () => {
    // Порядок важен по-прежнему: замени скобки раньше — и косая
    // съела бы уже поставленное экранирование. Само правило для
    // косой изменилось (см. тест выше): не удвоение, а замена.
    expect(escapeAssText('a\\b')).toBe('a/b');
    expect(escapeAssText('a\\{b}')).toBe('a/\\{b\\}');
  });
});

describe('assTime', () => {
  it('формат libass — часы без ведущего нуля, сотые', () => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(1.5)).toBe('0:00:01.50');
    expect(assTime(75.25)).toBe('0:01:15.25');
    expect(assTime(3725)).toBe('1:02:05.00');
  });

  it('отрицательное время не уезжает в прошлое', () => {
    expect(assTime(-5)).toBe('0:00:00.00');
  });
});

describe('buildCardsAss', () => {
  it('нечего рисовать — пустая строка, а не пустой файл-заготовка', () => {
    // Вызывающий по этому признаку не создаёт лишний вход задачи.
    for (const cards of [null, undefined, {}, { title: '  ', closing: '' }]) {
      expect(buildCardsAss(cards, opts)).toBe('');
      expect(hasCards(cards)).toBe(false);
    }
  });

  it('титульная висит в начале, закрывающая — в конце', () => {
    const ass = buildCardsAss({ title: 'Марине', closing: 'От Андрея' }, opts);
    const [first, second] = events(ass);
    expect(first).toContain('0:00:00.00');
    expect(first).toContain('Марине');
    expect(second).toContain('0:00:15.00');
    expect(second).toContain('От Андрея');
  });

  it('только подпись — одна строка событий, титульной нет', () => {
    const ass = buildCardsAss({ closing: 'От Андрея' }, opts);
    expect(events(ass)).toHaveLength(1);
    expect(ass).toContain('От Андрея');
    expect(ass).not.toContain(',title,');
  });

  it('карточки не наезжают друг на друга даже на коротком ролике', () => {
    // Ролик в три секунды: обе карточки по две секунды не помещаются
    // подряд — титульная обязана ужаться, а не перекрыть подпись.
    const ass = buildCardsAss(
      { title: 'Марине', closing: 'От Андрея' },
      { ...opts, totalDurationSeconds: 3 },
    );
    const [first, second] = events(ass);
    const endOfFirst = first.split(',')[2];
    const startOfSecond = second.split(',')[1];
    expect(endOfFirst <= startOfSecond).toBe(true);
  });

  it('текст обрезается по длине — карточка не превращается в простыню', () => {
    const long = 'Я'.repeat(MAX_CARD_TEXT_LENGTH + 40);
    const ass = buildCardsAss({ title: long }, opts);
    // Строка Dialogue: всё после девятой запятой — это текст.
    const text = events(ass)[0].split(',').slice(9).join(',');
    expect(text.replace('{\\fad(250,250)}', '')).toHaveLength(
      MAX_CARD_TEXT_LENGTH,
    );
  });

  it('перенос и лишние пробелы схлопываются в одну строку', () => {
    const ass = buildCardsAss({ title: 'Марине\n  и   Ане' }, opts);
    expect(events(ass)[0]).toContain('Марине и Ане');
  });

  it('стили лежат внутри файла — force_style снаружи не нужен', () => {
    const ass = buildCardsAss({ title: 'Марине' }, opts);
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('Style: title,');
    expect(ass).toContain('Style: closing,');
  });

  it('плашка за текстом, а не обводка — и она РИСУЕТСЯ', () => {
    // `BorderStyle=3` самого по себе мало, и прежняя редакция этого
    // теста проверяла только его. Плашку libass строит по
    // `OutlineColour` с полем `Outline`, а ноль там значит «плашки
    // нет вовсе»; `BackColour` при этом стиле уходит на тень.
    // Карточка полтора этапа выходила белым текстом без подложки —
    // на светлом кадре почти невидимым. Отрисовано и сверено при
    // этапе E.
    const ass = buildCardsAss(
      { title: 'Марине', closing: 'С любовью' },
      { ...opts, credit: 'Автор — Имя' },
    );
    const styles = ass.split('\n').filter((l) => l.startsWith('Style:'));
    expect(styles).toHaveLength(3);
    for (const line of styles) {
      const f = line.split(',');
      // BorderStyle — 16-е поле формата; `Style: <имя>` это одно поле.
      expect(f[15]).toBe('3');
      // Outline — поле коробки. Ноль = коробки нет.
      expect(Number(f[16])).toBeGreaterThan(0);
      // Цвет плашки — в OutlineColour, и он непрозрачнее полного
      // «невидимо» (первый байт после &H — альфа, 0xFF это «совсем
      // прозрачно»).
      expect(f[5]).toMatch(/^&H[0-9A-F]{8}$/);
      expect(parseInt(f[5].slice(2, 4), 16)).toBeLessThan(0xff);
    }
  });

  it('PlayRes считается от формата кадра, короткая сторона всегда 1080', () => {
    // Иначе один и тот же кегль означал бы разный размер букв в 9:16 и
    // в 16:9.
    expect(buildCardsAss({ title: 'x' }, opts)).toContain('PlayResX: 1080');
    expect(buildCardsAss({ title: 'x' }, opts)).toContain('PlayResY: 1920');
    const wide = buildCardsAss(
      { title: 'x' },
      {
        ...opts,
        aspectRatio: '16:9',
      },
    );
    expect(wide).toContain('PlayResX: 1920');
    expect(wide).toContain('PlayResY: 1080');
  });

  it('мусор вместо формата не роняет файл', () => {
    for (const aspectRatio of ['', 'мусор', '0:0', null]) {
      const ass = buildCardsAss({ title: 'x' }, { ...opts, aspectRatio });
      expect(ass).toContain('PlayResX: 1080');
    }
  });

  it('карточки появляются и уходят плавно', () => {
    const ass = buildCardsAss({ title: 'Марине' }, opts);
    expect(events(ass)[0]).toContain('\\fad(');
  });

  it('титульная не длиннее своей мерки', () => {
    const ass = buildCardsAss({ title: 'Марине' }, opts);
    expect(events(ass)[0]).toContain(assTime(CARD_SECONDS));
  });
});

describe('упоминание автора музыки', () => {
  const credit = '«Тёплое утро» — Аноним (CC-BY-4.0), Freesound';

  it('рисуется, даже когда своих подписей нет вовсе', () => {
    // Это не подпись отправителя, а наше обязательство по лицензии:
    // отказаться от него он не может.
    const ass = buildCardsAss(null, { ...opts, credit });
    expect(ass).toContain(credit);
    expect(hasCards(null, credit)).toBe(true);
  });

  it('не мешает подписи отправителя, а живёт своей строкой', () => {
    const ass = buildCardsAss({ closing: 'От Андрея' }, { ...opts, credit });
    const lines = events(ass);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('От Андрея'))).toBe(true);
    expect(lines.some((l) => l.includes('Freesound'))).toBe(true);
  });

  it('у кредита свой стиль — мельче и ниже подписи', () => {
    const ass = buildCardsAss(null, { ...opts, credit });
    const style = ass.split('\n').find((l) => l.startsWith('Style: credit,'))!;
    const closing = ass
      .split('\n')
      .find((l) => l.startsWith('Style: closing,'))!;
    expect(Number(style.split(',')[2])).toBeLessThan(
      Number(closing.split(',')[2]),
    );
  });

  it('пустой кредит ничего не добавляет', () => {
    for (const c of [null, undefined, '   ']) {
      expect(buildCardsAss(null, { ...opts, credit: c })).toBe('');
      expect(hasCards(null, c)).toBe(false);
    }
  });

  it('кредит не режется под мерку своих подписей — это чужое имя', () => {
    const long = `«${'Т'.repeat(80)}» — ${'А'.repeat(40)} (CC-BY-4.0)`;
    const ass = buildCardsAss(null, { ...opts, credit: long });
    const text = events(ass)[0]
      .split(',')
      .slice(9)
      .join(',')
      .replace('{\\fad(250,250)}', '');
    expect(text.length).toBeGreaterThan(MAX_CARD_TEXT_LENGTH);
  });

  it('фигурные скобки в кредите экранируются так же, как везде', () => {
    const ass = buildCardsAss(null, { ...opts, credit: 'a {b} c' });
    expect(ass).toContain('a \\{b\\} c');
  });
});

describe('стиль карточек из бренд-бука (этап G, Г-6)', () => {
  const styleLine = (ass: string, name: string) =>
    ass.split('\n').find((l) => l.startsWith(`Style: ${name},`)) ?? '';

  it('без стиля — прежние Arial и белый', () => {
    const ass = buildCardsAss({ title: 'Марине' }, opts);
    expect(styleLine(ass, 'title')).toContain('title,Arial,64,&H00FFFFFF,');
    expect(styleLine(ass, 'closing')).toContain('closing,Arial,52,&H00FFFFFF,');
  });

  it('шрифт и цвет из белого списка; цвет — в порядке байт ASS (BGR)', () => {
    const ass = buildCardsAss(
      { title: 'Марине', style: { font: 'serif', color: 'gold' } },
      opts,
    );
    // gold = FFD54F (RGB) → &H004FD5FF (BGR).
    expect(styleLine(ass, 'title')).toContain(
      'title,DejaVu Serif,64,&H004FD5FF,',
    );
    expect(styleLine(ass, 'closing')).toContain(
      'closing,DejaVu Serif,52,&H004FD5FF,',
    );
    // Кредит автора музыки стиль не меняет.
    const withCredit = buildCardsAss(
      { title: 'x', style: { font: 'mono', color: 'pink' } },
      { ...opts, credit: 'Автор' },
    );
    expect(styleLine(withCredit, 'credit')).toContain('credit,Arial,28,');
  });

  it('чужой шрифт или цвет не протаскивается — умолчание по полю', () => {
    const ass = buildCardsAss(
      { title: 'x', style: { font: 'Comic Sans', color: 'mint' } },
      opts,
    );
    expect(styleLine(ass, 'title')).toContain('title,Arial,64,&H00C9E6C8,');
    expect(normalizeCardStyle({ font: 'x', color: 'y' })).toBeNull();
    expect(normalizeCardStyle(['serif'])).toBeNull();
    expect(normalizeCardStyle({ font: 'serif' })).toEqual({
      font: 'serif',
      color: 'white',
    });
  });

  it('стиль без текста — рисовать нечего', () => {
    expect(hasCards({ style: { font: 'serif', color: 'gold' } })).toBe(false);
    expect(
      buildCardsAss({ style: { font: 'serif', color: 'gold' } }, opts),
    ).toBe('');
  });

  it('assColor переставляет байты', () => {
    expect(assColor('112233')).toBe('&H00332211');
  });
});
