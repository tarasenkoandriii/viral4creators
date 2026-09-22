import {
  celebrityLikenessMessage,
  findCelebrityLikeness,
} from './celebrity-likeness';

/**
 * Гейт №35. Две группы проверок, и вторая важнее первой: ложное
 * срабатывание на обычном поздравлении ломает продукт в момент, когда
 * человек меньше всего готов разбираться, а пропущенная экзотическая
 * формулировка остаётся управляемым риском (промпт кадра всё равно
 * запрещает узнаваемых людей, а ролик проходит через оператора).
 */
describe('findCelebrityLikeness (№35)', () => {
  describe('ловит просьбу воспроизвести конкретного человека', () => {
    const cases: Array<[string, string]> = [
      ['Сделай его похожим на Хабенского, будет смешно', 'likeness'],
      ['Хочу ведущего в образе Пугачёвой', 'likeness'],
      ['Пусть выглядит как Зеленский', 'likeness'],
      ['нужен двойник Меладзе', 'likeness'],
      ['Озвучь голосом Джигурды пожалуйста', 'voice'],
      ['make him look like Tom Cruise', 'likeness'],
      ['in the style of Beyonce', 'likeness'],
      ['use the voice of Morgan Freeman', 'voice'],
      ['deepfake Elon Musk', 'likeness'],
    ];
    for (const [text, kind] of cases) {
      it(text.slice(0, 44), () => {
        const m = findCelebrityLikeness(text);
        expect(m).not.toBeNull();
        expect(m?.kind).toBe(kind);
      });
    }
  });

  describe('НЕ трогает обычный текст поздравления', () => {
    const ok = [
      'Поздравь Марину с днём рождения, она любит море',
      'Поздравь как обычно, только потеплее',
      'Как в детстве, когда мы ездили к бабушке',
      'Скажи, что Андрей и Марина тебя поздравляют',
      'Пусть будет весело, как на нашей свадьбе',
      'Маша просила передать привет',
      'Happy birthday, make it warm and simple',
      'Поздравление от команды, голосом диктора',
      '',
      null,
    ];
    for (const text of ok) {
      it(JSON.stringify(text)?.slice(0, 44) ?? 'пусто', () => {
        expect(findCelebrityLikeness(text)).toBeNull();
      });
    }
  });

  it('сообщение называет найденный кусок, чтобы человек знал, что убрать', () => {
    const m = findCelebrityLikeness('Пусть выглядит как Зеленский');
    expect(m).not.toBeNull();
    const msg = celebrityLikenessMessage(m!);
    expect(msg).toContain('выглядит как Зеленский');
    // Не нотация: отказ объясняет причину и говорит, что делать.
    expect(msg).toContain('Уберите это из текста');
  });
});
