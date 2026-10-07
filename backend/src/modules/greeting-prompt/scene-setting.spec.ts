/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * §3.9 ТЗ Greeting 2.0 (фича №36): выбранная обстановка `sceneSetting`
 * идёт и в кадр, и в видео-промпт; вне праздника праздничная обстановка
 * не принимается и сбрасывается при смене регистра.
 */
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../prompt/prompt.service', () => ({ PromptService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  buildSceneDescription,
  greetingSceneLine,
} from './greeting-prompt.service';
import { greetingScriptInputs } from './script-inputs';
import { buildGreetingFramePrompt } from '../greeting-reference/greeting-frame-prompt';
import {
  evaluateGreetingPolicy,
  festiveSettingMarker,
  sceneMoodFor,
} from '../../common/greeting-policy';
import { reconcileSelections } from '../../common/greeting-session-edit';
import type { GreetingBriefSnapshot } from '../../common/types/greeting.types';

const SNOW = 'snowy wooden balcony at dusk, warm string lights';

const brief = (over: Record<string, unknown> = {}) =>
  ({
    sourceGreetingBriefId: 'gb1',
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'WARM',
    personalMessage: null,
    requestedPresenterProvider: 'grok',
    resolvedPresenterProvider: 'grok',
    requestedResolution: '720p',
    resolvedResolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    addedAt: '2026-10-07T00:00:00.000Z',
    ...over,
  }) as unknown as GreetingBriefSnapshot;

const scene = (b: GreetingBriefSnapshot) =>
  buildSceneDescription(b, 'birthday', 'С днём рождения!', [], 'voiceover');

describe('видео-промпт и выбранная обстановка', () => {
  it('без обстановки — сцена повода байт в байт как раньше', () => {
    const b = brief();
    expect(scene(b)).toContain(
      `${sceneMoodFor('BIRTHDAY', 'CELEBRATORY')}; no on-screen text.`,
    );
    expect(scene(brief({ sceneSetting: null }))).toBe(scene(b));
    expect(scene(brief({ sceneSetting: '   ' }))).toBe(scene(b));
  });

  it('выбранная обстановка ЗАМЕЩАЕТ сцену повода в видео-промпте', () => {
    const text = scene(brief({ sceneSetting: SNOW }));
    expect(text).toContain(`Setting: ${SNOW}; no on-screen text.`);
    expect(text).not.toContain(sceneMoodFor('BIRTHDAY', 'CELEBRATORY'));
  });

  it('вне праздника к обстановке добавляется запрет праздничной атрибутики', () => {
    expect(greetingSceneLine('CONDOLENCE', 'MOURNING', 'quiet garden')).toBe(
      'Setting: quiet garden; no balloons, no confetti, no cake, no gifts, no party decorations',
    );
    expect(greetingSceneLine('BIRTHDAY', 'CELEBRATORY', 'quiet garden')).toBe(
      'Setting: quiet garden',
    );
  });

  it('кавычки и переносы обстановки не ломают промпт', () => {
    expect(
      greetingSceneLine('BIRTHDAY', 'CELEBRATORY', 'a "loft"\nwith plants'),
    ).toBe('Setting: a loft with plants');
  });

  it('та же обстановка — в кадре (одна строка на кадр и видео)', () => {
    const frame = buildGreetingFramePrompt({
      occasion: 'BIRTHDAY',
      customOccasionText: null,
      tone: 'WARM',
      presenter: 'grok',
      setting: SNOW,
    });
    expect(frame).toContain(`Scene: ${SNOW}.`);
  });
});

describe('отпечаток сценария', () => {
  it('обстановка входит в отпечаток, только когда выбрана', () => {
    const none = greetingScriptInputs({ greetingBriefSnapshot: brief() });
    expect(
      greetingScriptInputs({
        greetingBriefSnapshot: brief({ sceneSetting: null }),
      }),
    ).toBe(none);
    expect(none).not.toContain('sceneSetting');
    const a = greetingScriptInputs({
      greetingBriefSnapshot: brief({ sceneSetting: SNOW }),
    });
    const b = greetingScriptInputs({
      greetingBriefSnapshot: brief({ sceneSetting: 'quiet garden' }),
    });
    expect(a).not.toBe(none);
    expect(a).not.toBe(b);
  });
});

describe('политика обстановки', () => {
  it.each([
    ['room full of balloons', 'balloons'],
    ['confetti everywhere', 'confetti'],
    ['table with a birthday cake', 'cake'],
    ['rooftop party at night', 'party'],
    ['комната с воздушными шарами', 'воздушными шар'],
    ['стол с тортом', 'торт'],
    ['Garten mit Luftballons', 'luftballon'],
    ['salón con globos', 'globos'],
  ])('праздничный предмет найден: %s', (text, word) => {
    expect(festiveSettingMarker(text)).toBe(word);
  });

  it.each([
    'quiet sunlit living room with a bookshelf',
    'calm garden with white flowers, soft light',
    'портрет у окна, мягкий свет',
    'participants gather by the window',
  ])('спокойная обстановка — не праздник: %s', (text) => {
    expect(festiveSettingMarker(text)).toBeNull();
  });

  it('праздник принимает любую обстановку, остальные регистры — без праздничной', () => {
    const festive = 'garden party with balloons';
    const ok = (occasion: any, occasionRegister: any = null) =>
      evaluateGreetingPolicy({
        occasion,
        occasionRegister,
        tone: 'RESPECTFUL',
        sceneSetting: festive,
      }).violations.some((v) => v.field === 'sceneSetting');
    expect(ok('BIRTHDAY')).toBe(false);
    expect(ok('OTHER', 'CELEBRATORY')).toBe(false);
    expect(ok('FAREWELL_COLLEAGUE')).toBe(true);
    expect(ok('BAPTISM')).toBe(true);
    expect(ok('APOLOGY')).toBe(true);
    expect(ok('CONDOLENCE')).toBe(true);
    expect(ok('OTHER', 'MOURNING')).toBe(true);
  });

  it('отказ называет предмет и регистр', () => {
    const v = evaluateGreetingPolicy({
      occasion: 'CONDOLENCE',
      tone: 'RESPECTFUL',
      sceneSetting: 'hall with balloons',
    });
    expect(v.violations).toEqual([
      expect.objectContaining({
        field: 'sceneSetting',
        code: 'setting-not-allowed',
        message: expect.stringContaining('«balloons»'),
      }),
    ]);
    expect(v.violations[0].message).toContain('траурного повода');
  });

  it('смена регистра на траурный сбрасывает праздничную обстановку с перечнем, спокойную — нет', () => {
    const festive = reconcileSelections(
      brief({
        occasion: 'CONDOLENCE',
        tone: 'RESPECTFUL',
        sceneSetting: 'party with confetti',
      }),
    );
    expect(festive.snapshot.sceneSetting).toBeNull();
    expect(festive.resetFields).toEqual(['sceneSetting']);
    const calm = reconcileSelections(
      brief({
        occasion: 'CONDOLENCE',
        tone: 'RESPECTFUL',
        sceneSetting: 'quiet garden',
      }),
    );
    expect(calm.snapshot.sceneSetting).toBe('quiet garden');
    expect(calm.resetFields).toEqual([]);
  });
});

describe('словарь обстановки — вторая линия после белого списка (аудит захода 8)', () => {
  it.each([
    'a room with bаlloons',
    'bal\u200Bloons and con\u200Bfetti',
    'ｂａｌｌｏｏｎｓ fullwidth',
    'birthday decorations and candles',
    'colorful garlands and bunting, layered frosted dessert with candles',
    'Christmas tree and ornaments',
    'New Year decor',
    'Geburtstagstorte und Sekt',
    'cumpleaños con piñata',
    'celebración con globos',
    'день рождения, гирлянды и серпантин',
    'вечірка, свято',
    'вечеринка с колпаками',
    'disco ball and glitter',
    'Party-Deko',
    'festlich geschmückter Raum',
    'decoración festiva',
    'a jubilant gala ballroom',
    'Торт со свечами',
    'тортик',
    'хлопушки и гирлянды',
    'no smoking, balloons everywhere',
  ])('обход пойман: %s', (text) => {
    expect(festiveSettingMarker(text)).not.toBeNull();
  });

  it.each([
    'Quiet sunlit garden at dusk, no balloons or confetti, soft warm light',
    'Calm, non-festive living room with soft daylight',
    'Memorial hall for a celebration of life, candles and white lilies',
    'Тихая непраздничная комната, мягкий свет',
    'Cozy room with a pastel color palette',
    'a garden without any party decorations',
    'кімната без кульок і без торта',
  ])('наш спокойный вариант не блокируется: %s', (text) => {
    expect(festiveSettingMarker(text)).toBeNull();
  });
});

describe('видео-промпт: запрет добавленных узнаваемых людей (аудит захода 8)', () => {
  const LINE =
    'Do not add any recognisable real person or celebrity beyond the people shown in the reference images.';
  it('есть обстановка или подписи фото — строка есть; нет ни того ни другого — промпт прежний', () => {
    expect(scene(brief())).not.toContain(LINE);
    expect(scene(brief({ sceneSetting: SNOW }))).toContain(LINE);
    const withPhoto = buildSceneDescription(
      brief(),
      'birthday',
      'С днём рождения!',
      [
        {
          id: 'gr_1',
          label: 'папа',
          description: 'у окна',
          photoUrl: 'https://blob/p.jpg',
          photoPathname: 'sessions/s1/greeting-refs/gr_1/p.jpg',
          hasFace: false,
        } as any,
      ],
      'voiceover',
    );
    expect(withPhoto).toContain(LINE);
  });
});
