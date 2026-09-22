import { buildGreetingFramePrompt } from './greeting-frame-prompt';
import { GREETING_OCCASION_SPECS } from '../../common/greeting-occasions';
import { GreetingOccasion } from '../../common/types/greeting.types';

/**
 * Промпт референс-кадра (фича №6). Проверяется не «строка собралась», а
 * четыре свойства, каждое из которых иначе ломается молча и дорого:
 * запреты на чувствительных поводах, отсутствие персональных данных,
 * обязательный запрет текста и то, что КАЖДЫЙ из 24 поводов даёт
 * осмысленную сцену, а не пустое место в промпте.
 */
describe('buildGreetingFramePrompt (№6)', () => {
  const base = {
    occasion: 'BIRTHDAY' as GreetingOccasion,
    customOccasionText: null,
    tone: 'WARM' as const,
    presenter: 'grok' as const,
  };

  it('на праздничном поводе описывает праздничную сцену', () => {
    const p = buildGreetingFramePrompt(base);
    expect(p).toContain('festive');
    expect(p).not.toContain('NOT a celebration');
  });

  it('на соболезновании ЗАПРЕЩАЕТ праздничную атрибутику явно', () => {
    // Самая важная проверка файла. `sceneMood` просит «no decorations»,
    // но модель, увидев слово greeting, дорисовывает шарики охотно —
    // поэтому запрет продублирован отдельным блоком.
    const p = buildGreetingFramePrompt({
      ...base,
      occasion: 'CONDOLENCE',
      tone: 'RESPECTFUL',
    });
    expect(p).toContain('NOT a celebration');
    expect(p).toMatch(/no balloons/);
    expect(p).toMatch(/no confetti/);
  });

  it('имя получателя и личное сообщение в промпт не попадают', () => {
    // Функция их и не принимает — проверка держит этот контракт: стоит
    // кому-то расширить вход «для полноты», и персональные данные
    // третьего лица уедут в чужую модель.
    const args = Object.keys(base);
    expect(args).not.toContain('recipientName');
    expect(args).not.toContain('personalMessage');
  });

  it('текст в кадре запрещён всегда — иначе имя на торте будет с опечаткой', () => {
    for (const occasion of Object.keys(
      GREETING_OCCASION_SPECS,
    ) as GreetingOccasion[]) {
      const spec = GREETING_OCCASION_SPECS[occasion];
      const p = buildGreetingFramePrompt({
        ...base,
        occasion,
        tone: spec.tones[0],
      });
      expect(p).toContain('Do not render any text');
    }
  });

  it('каждый из поводов даёт непустую сцену и повод в промпте', () => {
    for (const occasion of Object.keys(
      GREETING_OCCASION_SPECS,
    ) as GreetingOccasion[]) {
      const spec = GREETING_OCCASION_SPECS[occasion];
      const p = buildGreetingFramePrompt({
        ...base,
        occasion,
        tone: spec.tones[0],
      });
      expect(p).toContain(`Scene: ${spec.sceneMood}`);
      expect(p).toContain(spec.label);
    }
  });

  it('свой повод («другое») подставляется вместо родовой подписи', () => {
    const p = buildGreetingFramePrompt({
      ...base,
      occasion: 'OTHER',
      customOccasionText: 'защита диплома',
    });
    expect(p).toContain('защита диплома');
  });

  it('пустой свой повод откатывается на подпись каталога, а не в пустоту', () => {
    const p = buildGreetingFramePrompt({
      ...base,
      occasion: 'OTHER',
      customOccasionText: '   ',
    });
    expect(p).toContain(GREETING_OCCASION_SPECS.OTHER.label);
    expect(p).not.toContain('Occasion: .');
  });

  it('знаменитости запрещены — модерационный долг №35 начинается здесь', () => {
    expect(buildGreetingFramePrompt(base)).toContain('celebrity');
  });
});
