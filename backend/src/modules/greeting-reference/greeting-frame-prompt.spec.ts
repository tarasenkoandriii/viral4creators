import { buildGreetingFramePrompt } from './greeting-frame-prompt';
import { GREETING_OCCASION_SPECS } from '../../common/greeting-occasions';
import {
  GREETING_REGISTERS,
  GreetingOccasion,
  GreetingRegister,
  GreetingTone,
} from '../../common/types/greeting.types';

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

/**
 * Приёмка §8.1 ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md:
 * снимок кадр-промпта по каждому из пяти регистров — явным текстом (почему
 * не `__snapshots__` — см. тот же блок в `greeting-prompt.spec.ts`), и
 * запрет «smil», «festive», «confetti», «farewell» в УТВЕРДИТЕЛЬНОЙ части
 * промпта деликатного и траурного регистров: «no confetti» и «NOT a
 * celebration» — сам запрет (§3.3, `CALM_SCENE`), его не ищем.
 */
const GOLDEN_FRAME: Record<GreetingRegister, string[]> = {
  CELEBRATORY: [
    'Generate a single photorealistic still frame that will be used as the',
    'opening reference frame of a short greeting video.',
    'Occasion: день рождения.',
    'Scene: bright, cheerful setting with soft festive decor; warm light; celebratory but tasteful.',
    'Mood of the person on camera: warm, genuine smile; relaxed and friendly.',
    'A single friendly person facing the camera, upper body in frame.',
    'Vertical or horizontal framing is acceptable; keep the subject centred',
    'with room around the head so the frame works as a video start.',
    'Do not render any text, letters, numbers, captions or watermarks.',
    'Do not include any recognisable real person or celebrity.',
  ],
  WARM_NEUTRAL: [
    'Generate a single photorealistic still frame that will be used as the',
    'opening reference frame of a short greeting video.',
    'Occasion: прощание с коллегой.',
    'Scene: friendly office-like setting; warm but composed mood.',
    'Mood of the person on camera: warm, genuine smile; relaxed and friendly.',
    'A single friendly person facing the camera, upper body in frame.',
    'Vertical or horizontal framing is acceptable; keep the subject centred',
    'with room around the head so the frame works as a video start.',
    'Do not render any text, letters, numbers, captions or watermarks.',
    'Do not include any recognisable real person or celebrity.',
    'This is NOT a celebration: no balloons, no confetti, no cake, no gifts,',
    'no party decorations of any kind.',
  ],
  SOLEMN: [
    'Generate a single photorealistic still frame that will be used as the',
    'opening reference frame of a short greeting video.',
    'Occasion: День защитников и защитниц.',
    'Scene: restrained, dignified setting; calm, respectful mood.',
    'Mood of the person on camera: serious, respectful, quiet expression; no smile.',
    'A single friendly person facing the camera, upper body in frame.',
    'Vertical or horizontal framing is acceptable; keep the subject centred',
    'with room around the head so the frame works as a video start.',
    'Do not render any text, letters, numbers, captions or watermarks.',
    'Do not include any recognisable real person or celebrity.',
    'This is NOT a celebration: no balloons, no confetti, no cake, no gifts,',
    'no party decorations of any kind.',
  ],
  SENSITIVE: [
    'Generate a single photorealistic still frame that will be used as the',
    'opening reference frame of a short greeting video.',
    'Occasion: извинение.',
    'Scene: quiet, restrained setting; soft muted colours; no decorations, no confetti, no balloons.',
    'Mood of the person on camera: sincere, serious, regretful expression; no smile.',
    'A single friendly person facing the camera, upper body in frame.',
    'Vertical or horizontal framing is acceptable; keep the subject centred',
    'with room around the head so the frame works as a video start.',
    'Do not render any text, letters, numbers, captions or watermarks.',
    'Do not include any recognisable real person or celebrity.',
    'This is NOT a celebration: no balloons, no confetti, no cake, no gifts,',
    'no party decorations of any kind.',
  ],
  MOURNING: [
    'Generate a single photorealistic still frame that will be used as the',
    'opening reference frame of a short greeting video.',
    'Occasion: соболезнование.',
    'Scene: quiet, restrained setting; soft muted colours; no decorations, no confetti, no balloons.',
    'Mood of the person on camera: serious, quiet, compassionate expression; no smile.',
    'A single friendly person facing the camera, upper body in frame.',
    'Vertical or horizontal framing is acceptable; keep the subject centred',
    'with room around the head so the frame works as a video start.',
    'Do not render any text, letters, numbers, captions or watermarks.',
    'Do not include any recognisable real person or celebrity.',
    'This is NOT a celebration: no balloons, no confetti, no cake, no gifts,',
    'no party decorations of any kind.',
  ],
};

const GOLDEN_FRAME_INPUT: Record<
  GreetingRegister,
  { occasion: GreetingOccasion; tone: GreetingTone }
> = {
  CELEBRATORY: { occasion: 'BIRTHDAY', tone: 'WARM' },
  WARM_NEUTRAL: { occasion: 'FAREWELL_COLLEAGUE', tone: 'WARM' },
  SOLEMN: { occasion: 'DEFENDERS_DAY', tone: 'RESPECTFUL' },
  SENSITIVE: { occasion: 'APOLOGY', tone: 'RESPECTFUL' },
  MOURNING: { occasion: 'CONDOLENCE', tone: 'RESPECTFUL' },
};

/** Утвердительная часть: без отрицаний («no …», «NOT a celebration …»). */
function affirmative(prompt: string): string {
  return prompt
    .replace(/\bNOT a celebration\b[^.]*\.[^.]*\./gi, ' ')
    .replace(/\b(no|not|never|without)\b[^;:.,()\n—]*/gi, ' ');
}

describe('§8.1: снимки кадр-промпта по пяти регистрам', () => {
  it.each(GREETING_REGISTERS)('%s — промпт целиком', (register) => {
    const p = buildGreetingFramePrompt({
      ...GOLDEN_FRAME_INPUT[register],
      customOccasionText: null,
      presenter: 'grok',
    });
    expect(p.split('\n')).toEqual(GOLDEN_FRAME[register]);
  });

  it('«Особый повод» в каждом регистре: сцена и лицо — от регистра, праздник запрещён вне праздника', () => {
    for (const register of GREETING_REGISTERS) {
      const p = buildGreetingFramePrompt({
        occasion: 'OTHER',
        customOccasionText: 'встреча семьи',
        occasionRegister: register,
        tone: 'RESPECTFUL',
        presenter: 'grok',
      });
      expect(p).toContain('Occasion: встреча семьи.');
      expect(p.includes('NOT a celebration')).toBe(register !== 'CELEBRATORY');
    }
  });

  const SERIOUS: Array<{
    name: string;
    input: {
      occasion: GreetingOccasion;
      customOccasionText: string | null;
      occasionRegister?: GreetingRegister;
    };
    register: GreetingRegister;
    tones: GreetingTone[];
  }> = [
    {
      name: 'APOLOGY',
      input: { occasion: 'APOLOGY', customOccasionText: null },
      register: 'SENSITIVE',
      tones: ['RESPECTFUL', 'WARM'],
    },
    {
      name: 'GET_WELL',
      input: { occasion: 'GET_WELL', customOccasionText: null },
      register: 'SENSITIVE',
      tones: ['SUPPORTIVE', 'WARM'],
    },
    {
      name: 'CONDOLENCE',
      input: { occasion: 'CONDOLENCE', customOccasionText: null },
      register: 'MOURNING',
      tones: ['RESPECTFUL', 'SUPPORTIVE'],
    },
    {
      name: 'OTHER/SENSITIVE',
      input: {
        occasion: 'OTHER',
        customOccasionText: 'трудный период у друга',
        occasionRegister: 'SENSITIVE',
      },
      register: 'SENSITIVE',
      tones: ['WARM', 'SUPPORTIVE', 'RESPECTFUL'],
    },
    {
      name: 'OTHER/MOURNING',
      input: {
        occasion: 'OTHER',
        customOccasionText: 'прощание с дедушкой',
        occasionRegister: 'MOURNING',
      },
      register: 'MOURNING',
      tones: ['RESPECTFUL', 'SUPPORTIVE'],
    },
  ];

  it.each(SERIOUS.map((s) => [s.name, s] as const))(
    '%s: ни улыбки, ни праздника — при любом тоне и ведущем',
    (_name, s) => {
      const found: string[] = [];
      for (const tone of s.tones)
        for (const presenter of ['grok', 'hedra'] as const) {
          const full = buildGreetingFramePrompt({
            ...s.input,
            tone,
            presenter,
          });
          const where = `${tone}/${presenter}`;
          if (!full.includes('NOT a celebration')) {
            found.push(`${where}: нет явного запрета праздника`);
          }
          const p = affirmative(full);
          for (const re of [
            /festive/i,
            /confetti/i,
            /farewell/i,
            /celebrat/i,
            /party/i,
            /balloon/i,
            /cheerful/i,
          ]) {
            if (re.test(p)) found.push(`${where}: ${re}`);
          }
          // Деликатный регистр при тёплом тоне (кроме извинения) — «мягкое»
          // лицо по §3.3: «at most a gentle, reassuring smile» и только она.
          const gentle =
            s.register === 'SENSITIVE' &&
            tone === 'WARM' &&
            s.input.occasion !== 'APOLOGY';
          const rest = gentle
            ? p.replace('at most a gentle, reassuring smile', ' ')
            : p;
          const smile = /[^;,()]*smil[^;,()]*/i.exec(rest);
          if (smile) found.push(`${where}: «${smile[0].trim()}»`);
        }
      expect(found).toEqual([]);
    },
  );
});
