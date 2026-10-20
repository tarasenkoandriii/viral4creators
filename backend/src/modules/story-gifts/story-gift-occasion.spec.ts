/* eslint-disable @typescript-eslint/no-explicit-any -- isolated in-memory mocks */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import {
  CreateStoryDto,
  PreviewStoryDto,
  StoryGiftsController,
  StoryPhotoDto,
} from './story-gifts.controller';
import { StoryGiftsService } from './story-gifts.service';
import { STORY_VOICE, storyText } from './story-catalog';
import {
  assertStoryPromiseFree,
  checkStoryPromises,
  foldStoryText,
} from './story-promise';
import {
  STORY_OCCASION_KINDS,
  storyOccasionLines,
  storyOccasionTheme,
} from './story-occasion';
import {
  composeStoryNarration,
  normalizeStorySpeechText,
  storyNarrationParts,
  toWellFormedStoryText,
} from './story-gift-note';
import {
  assertStoryAnimationAllowed,
  storyAnimationQuote,
  storyAudioReservation,
  storyEstimate,
  type StoryAnimationQuote,
} from './story-budget';
import { storyVideoReserve } from './story-video-plan';
import {
  prepareStoryDraft,
  previewStoryDraft,
  storedStoryEstimate,
} from './story-draft';
import { narratorLookPrice } from '../brand-manifest/narrator-looks.rules';
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_SKETCH_MODEL,
} from '../../common/gemini-image-model';

const LANTERN = 'little-lantern-ru-v1';
const TURNIP = 'turnip-ushinsky-ru-1949-v1';

function setup() {
  const row: Record<string, any> = {
    id: 'g1',
    userId: 'u1',
    locale: 'ru',
    status: 'DRAFT',
    budgetCents: 100,
    catalogId: LANTERN,
    title: 'x',
    chapters: [],
    giftNote: null,
    narrationLayout: null,
    occasionKind: null,
    occasionTheme: null,
    giftPhoto: null,
    hasGiftPhoto: false,
    giftPhotoDescription: null,
    updatedAt: new Date(), // ST3: retention in the card
  };
  const db = {
    findFirst: jest.fn(async ({ where }: any) =>
      where.userId === row.userId ? { ...row } : null,
    ),
    findFirstOrThrow: jest.fn(async () => ({ ...row })),
    findMany: jest.fn(),
    updateMany: jest.fn(async ({ where, data }: any) => {
      if (where.status && where.status !== row.status) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    count: jest.fn(async () => 0),
    create: jest.fn(async ({ data }: any) => ({ ...data, id: 'g2' })),
  };
  const tx = { storyGift: db, $queryRaw: jest.fn() };
  const prisma = {
    storyGift: db,
    storyVideoRender: {
      updateMany: jest.fn(),
      groupBy: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
  const tts = { configured: jest.fn(() => true), synthesize: jest.fn() };
  const stt = { configured: jest.fn(() => true), transcribe: jest.fn() };
  const plan = { assertCanSpendUser: jest.fn() };
  const usage = { record: jest.fn() };
  const service = new StoryGiftsService(
    prisma as any,
    tts as any,
    plan as any,
    usage as any,
    stt as any,
    {
      facts: jest.fn(async () => ({ mode: 'owner', isOwner: true })),
      quote: jest.fn(async () => ({
        credits: 0,
        usdEquivalent: 0,
        free: false,
      })),
      reserve: jest.fn(async () => ({
        credits: 0,
        usdEquivalent: 0,
        free: false,
      })),
      audioCharges: jest.fn(async () => new Map()),
      refund: jest.fn(async () => ({ refunded: false, credits: 0 })),
      refundQuietly: jest.fn(async () => undefined),
      refundAudio: jest.fn(async () => ({ refunded: false, credits: 0 })),
      autoRefundStale: jest.fn(async () => 0),
      capture: jest.fn(async () => 1),
      captureAudio: jest.fn(async () => 1),
      captureQuietly: jest.fn(async () => undefined),
      captureDelivered: jest.fn(async () => 0),
    } as any,
  );
  return { service, prisma, db, tx, tts, stt, plan, usage, row };
}
const errorsOf = (cls: any, body: object) =>
  validateSync(plainToInstance(cls, body)).map((e) => e.property);
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return ((e as BadRequestException).getResponse() as { code?: string }).code;
  }
  return undefined;
};

describe('WP3 DTO: occasion, gift note, preview', () => {
  it('accepts presets, skip and legacy free text; rejects unknown values and overlong fields', () => {
    for (const occasionKind of STORY_OCCASION_KINDS)
      expect(
        errorsOf(CreateStoryDto, { catalogId: TURNIP, occasionKind }),
      ).toEqual([]);
    expect(errorsOf(CreateStoryDto, { catalogId: TURNIP })).toEqual([]);
    expect(
      errorsOf(CreateStoryDto, { catalogId: TURNIP, occasion: 'Юбилей' }),
    ).toEqual([]);
    expect(
      errorsOf(CreateStoryDto, { catalogId: TURNIP, occasionKind: 'wedding' }),
    ).toEqual(['occasionKind']);
    expect(
      errorsOf(CreateStoryDto, { catalogId: TURNIP, theme: 'neon' }),
    ).toEqual(['theme']);
    expect(
      errorsOf(CreateStoryDto, { catalogId: TURNIP, occasion: 'x'.repeat(81) }),
    ).toEqual(['occasion']);
    expect(
      errorsOf(CreateStoryDto, {
        catalogId: TURNIP,
        giftPhotoDescription: 'x'.repeat(201),
      }),
    ).toEqual(['giftPhotoDescription']);
    expect(
      errorsOf(CreateStoryDto, { catalogId: TURNIP, giftNoteEnabled: 'yes' }),
    ).toEqual(['giftNoteEnabled']);
    expect(
      errorsOf(PreviewStoryDto, {
        catalogId: TURNIP,
        includeVideo: true,
        videoVoice: 'clone-x',
      }),
    ).toEqual(['videoVoice']);
    expect(errorsOf(StoryPhotoDto, { description: 'Плюшевый заяц' })).toEqual(
      [],
    );
  });
  it('requires explicit opt-in for a voiced gift note', () => {
    expect(
      codeOf(() =>
        prepareStoryDraft({
          catalogId: TURNIP,
          giftNote: 'Подарок под подушкой.',
        }),
      ),
    ).toBe('STORY_GIFT_NOTE_NOT_ENABLED');
    expect(
      codeOf(() =>
        prepareStoryDraft({
          catalogId: TURNIP,
          giftNote: 'Подарок под подушкой.',
          giftNoteEnabled: false,
        }),
      ),
    ).toBe('STORY_GIFT_NOTE_NOT_ENABLED');
    expect(
      codeOf(() =>
        prepareStoryDraft({
          catalogId: TURNIP,
          giftNoteEnabled: true,
          giftNote: ' \n ',
        }),
      ),
    ).toBe('STORY_GIFT_NOTE_EMPTY');
    const none = prepareStoryDraft({
      catalogId: TURNIP,
      giftNoteEnabled: false,
    });
    expect(none.giftNote).toBeNull();
    expect(none.text).toBe(storyText(TURNIP));
  });
});

describe('WP3 occasion: presets, theme, classic text untouched', () => {
  it('maps legacy free text to other, keeps the preset label empty and freezes a theme', () => {
    const legacy = prepareStoryDraft({
      catalogId: TURNIP,
      occasion: '  Юбилей  бабушки ',
    });
    expect(legacy.occasion).toEqual({
      kind: 'other',
      label: 'Юбилей бабушки',
      theme: 'calm',
    });
    const preset = prepareStoryDraft({
      catalogId: TURNIP,
      occasionKind: 'birthday',
      occasion: 'ignored for presets',
    });
    expect(preset.occasion).toEqual({
      kind: 'birthday',
      label: null,
      theme: 'celebration',
    });
    const skipped = prepareStoryDraft({ catalogId: TURNIP });
    expect(skipped.occasion).toEqual({
      kind: null,
      label: null,
      theme: 'calm',
    });
    expect(
      prepareStoryDraft({
        catalogId: TURNIP,
        occasionKind: 'bedtime',
        theme: 'warm',
      }).occasion.theme,
    ).toBe('warm');
    expect(storyOccasionTheme('separation')).toBe('warm');
    expect(storyOccasionTheme(null)).toBe('calm');
  });
  it('never changes the narrated classic text by occasion', () => {
    const texts = new Set(
      [...STORY_OCCASION_KINDS, undefined].map(
        (occasionKind) =>
          prepareStoryDraft({ catalogId: TURNIP, occasionKind }).text,
      ),
    );
    expect([...texts]).toEqual([storyText(TURNIP)]);
  });
  it('validates the free caption against forbidden promises', () => {
    expect(
      codeOf(() =>
        prepareStoryDraft({
          catalogId: TURNIP,
          occasionKind: 'other',
          occasion: 'Папа вернётся 5 мая',
        }),
      ),
    ).toBe('STORY_PROMISE_RETURN_DATE');
  });
  it('offers safe gender-neutral first lines in ru/uk/en that pass the validator', () => {
    for (const locale of ['ru', 'uk', 'en'])
      for (const kind of [...STORY_OCCASION_KINDS, null]) {
        const lines = storyOccasionLines(kind, locale);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        for (const line of lines) {
          expect(line.length).toBeLessThanOrEqual(180);
          expect(() => assertStoryPromiseFree(line, locale)).not.toThrow();
          expect(line).not.toMatch(/\{name\}|приготовил|приготовила/);
          expect(line[0]).toBe(line[0].toLocaleUpperCase());
        }
      }
    expect(storyOccasionLines('birthday', 'ru', 'Маша')[0]).toBe(
      'Маша, с днём рождения! У меня для тебя сказка.',
    );
    expect(storyOccasionLines('bedtime', 'uk')[0]).toBe(
      'Сонечко, час готуватися до сну. Послухаємо казку?',
    );
    // Not a name: falls back to the neutral address instead of injecting markup.
    expect(storyOccasionLines(null, 'en', '<b>Bob</b>')[0]).toBe(
      'Hi, sweetheart! I have a story for you.',
    );
    // ST3: proof-read UK/EN lines (FE review, 20.10.2026).
    expect(storyOccasionLines(null, 'uk', 'Оля')[0]).toBe(
      'Привіт, Оля! У мене є для тебе казка.',
    );
    expect(storyOccasionLines('bedtime', 'uk')[1]).toBe(
      'На добраніч, сонечко. Ось казка на ніч.',
    );
    expect(storyOccasionLines('separation', 'uk')[0]).toBe(
      'Привіт, сонечко! Ця казка — тобі від мене.',
    );
    expect(storyOccasionLines('other', 'en')[1]).toBe(
      'Sweetheart, get comfy — the story is about to begin.',
    );
    expect(storyOccasionLines('support', 'en')[1]).toBe(
      "Sweetheart, let's listen to a gentle story together.",
    );
  });
});

describe('WP3 promise validator', () => {
  const blocked: Array<[string, string, string]> = [
    ['ru', 'Я вернусь в пятницу и обниму тебя.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Скоро приеду!', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Через пару недель будем вместе.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Осталось 10 дней.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Увидимся к Новому году.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Папа вернётся 12.05.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Эта сказка тебя вылечит.', 'STORY_PROMISE_THERAPY'],
    [
      'ru',
      'Послушай, и ты перестанешь бояться темноты.',
      'STORY_PROMISE_THERAPY',
    ],
    ['ru', 'Это настоящая терапия.', 'STORY_PROMISE_THERAPY'],
    ['ru', 'Сказка поможет уснуть.', 'STORY_PROMISE_THERAPY'],
    ['ru', 'Подарок уже едет к тебе.', 'STORY_PROMISE_DELIVERY'],
    ['ru', 'Завтра курьер привезёт подарок.', 'STORY_PROMISE_DELIVERY'],
    ['ru', 'Его привезут вечером.', 'STORY_PROMISE_DELIVERY'],
    ['uk', 'Я повернуся в неділю.', 'STORY_PROMISE_RETURN_DATE'],
    ['uk', 'Незабаром приїду!', 'STORY_PROMISE_RETURN_DATE'],
    ['uk', 'Через три дні побачимося.', 'STORY_PROMISE_RETURN_DATE'],
    ['uk', 'Ти перестанеш боятися.', 'STORY_PROMISE_THERAPY'],
    ['uk', 'Подарунок вже в дорозі.', 'STORY_PROMISE_DELIVERY'],
    ['uk', "Кур'єр привезе його.", 'STORY_PROMISE_DELIVERY'],
    ['en', "I'll be back next week.", 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'See you soon!', 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'In three days we will be together.', 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'This story will heal you.', 'STORY_PROMISE_THERAPY'],
    ['en', "You won't be scared anymore.", 'STORY_PROMISE_THERAPY'],
    ['en', 'Your present is on its way.', 'STORY_PROMISE_DELIVERY'],
    ['en', 'The courier will bring it.', 'STORY_PROMISE_DELIVERY'],
  ];
  it.each(blocked)('%s blocks «%s»', (locale, text, code) => {
    expect(codeOf(() => assertStoryPromiseFree(text, locale))).toBe(code);
  });
  it('checks every language regardless of the story locale and resists invisible/homoglyph tricks', () => {
    expect(
      codeOf(() => assertStoryPromiseFree('Я повернуся завтра.', 'ru')),
    ).toBe('STORY_PROMISE_RETURN_DATE');
    // Latin "e"/"c" inside Cyrillic words and a zero-width space.
    expect(
      codeOf(() => assertStoryPromiseFree('Я вeрнусь ​завтра.', 'ru')),
    ).toBe('STORY_PROMISE_RETURN_DATE');
    expect(foldStoryText('ВЕРНУСЬ­Ё')).toBe('вернусье');
  });
  // B-S3-2: audit bypasses — stress marks/NFD, Cyrillic twins inside Latin
  // words, whole spoofed words, spaced numeric dates, dates in words.
  const bypasses: Array<[string, string, string]> = [
    ['ru', 'Я верну\u0301сь за\u0301втра.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я вернусь за\u0301втра.', 'STORY_PROMISE_RETURN_DATE'],
    ['uk', 'Я поверну\u0301ся за\u0301втра', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я вер\u0306нусь завтра', 'STORY_PROMISE_RETURN_DATE'],
    [
      'ru',
      'Я вернусь к Новому году'.normalize('NFD'),
      'STORY_PROMISE_RETURN_DATE',
    ],
    ['ru', 'Я вернусь\u200d завтра', 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'I will be b\u0430ck soon', 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'I will be back tom\u043Errow', 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'Your gift is on its w\u0430y', 'STORY_PROMISE_DELIVERY'],
    ['en', 'See you \uFF53\uFF4F\uFF4F\uFF4E', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Ckopo приеду', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Вeрнусь зaвтрa', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я вернусь 12 . 05', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я вернусь двенадцатого мая', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я вернусь восьмого марта.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я вернусь второго января.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я вернусь двенадцатого числа.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я вернусь в двенадцатом часу', 'STORY_PROMISE_RETURN_DATE'],
    ['uk', 'Я повернуся двадцять першого травня', 'STORY_PROMISE_RETURN_DATE'],
    ['uk', 'Я повернуся першого вересня.', 'STORY_PROMISE_RETURN_DATE'],
    ['en', "I'll be back on the twelfth of May.", 'STORY_PROMISE_RETURN_DATE'],
    ['en', "I'll be back on May the 12th.", 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'Daddy will be back May twelfth.', 'STORY_PROMISE_RETURN_DATE'],
    ['en', "I'll be back on the 12th.", 'STORY_PROMISE_RETURN_DATE'],
    // Still blocked after the B-S3-1 narrowing.
    ['ru', 'Я приеду через пару дней', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Через несколько недель увидимся', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Через полгода приеду', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Через два сна увидимся.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Осталось три сна!', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Через 5 лет ты будешь большой.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Мама скоро придёт.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Скоро придёт к тебе папа.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Я скоро приду к тебе.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Папа вернётся двенадцатого мая.', 'STORY_PROMISE_RETURN_DATE'],
    ['ru', 'Ты больше не будешь скучать.', 'STORY_PROMISE_THERAPY'],
    ['uk', 'Мама скоро прийде.', 'STORY_PROMISE_RETURN_DATE'],
    ['uk', 'Через пару днів приїду.', 'STORY_PROMISE_RETURN_DATE'],
    [
      'uk',
      'Лютий вовк пішов у ліс, а я прийду до тебе у лютому',
      'STORY_PROMISE_RETURN_DATE',
    ],
    ['en', 'Only three more sleeps to go!', 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'In a couple of days I will be home.', 'STORY_PROMISE_RETURN_DATE'],
    ['en', 'Your gift is on its way', 'STORY_PROMISE_DELIVERY'],
    ['en', 'It is on its way to you.', 'STORY_PROMISE_DELIVERY'],
    ['en', 'It’s on its way!', 'STORY_PROMISE_DELIVERY'],
    ['en', 'The package is on the way.', 'STORY_PROMISE_DELIVERY'],
  ];
  it.each(bypasses)('%s still blocks «%s»', (locale, text, code) => {
    expect(codeOf(() => assertStoryPromiseFree(text, locale))).toBe(code);
  });
  it('folds look-alikes both ways (B-S3-2)', () => {
    expect(foldStoryText('b\u0430ck')).toBe('back');
    expect(foldStoryText('Ckopo', 'cyrillic')).toBe('скоро');
    expect(foldStoryText('Ckopo', 'latin')).toBe('ckopo');
    expect(foldStoryText('в\u0435рнусь', 'latin')).toBe('вернусь');
    expect(foldStoryText('верну\u0301сь')).toBe('вернусь');
    // й/ї survive the NFKD → NFKC round trip.
    expect(foldStoryText('йде ї')).toBe('йде ї');
  });
  const allowed: Array<[string, string]> = [
    ['ru', 'Я тебя люблю.'],
    ['ru', 'Завтра почитаем ещё.'],
    ['ru', 'Спокойной ночи, солнышко. Я скучаю.'],
    [
      'ru',
      'Загляни под подушку — там небольшой подарок. Открой его после сказки.',
    ],
    ['ru', 'Не бойся темноты: рядом твой мишка.'],
    ['ru', 'Скоро будет утро.'],
    ['ru', 'Когда вернусь, мы почитаем вместе.'],
    ['uk', 'Я тебе люблю. На добраніч!'],
    ['uk', 'Завтра почитаємо ще.'],
    ['en', 'I love you. Sweet dreams!'],
    ['en', 'Tomorrow we can read another one.'],
    ['en', 'Look under your pillow after the story.'],
    // B-S3-1 false positives from the audit.
    ['en', 'We found this little bear on the way home.'],
    ['en', 'On the way to the forest, the fox sang.'],
    ['en', 'On its way home the fox found a box.'],
    ['en', 'The fox went on its way.'],
    ['en', 'May all your dreams be sweet.'],
    ['en', 'A day left behind us.'],
    ['ru', 'Шли через лес целый день и нашли рукавичку.'],
    ['ru', 'Мы ехали через поле два дня.'],
    ['ru', 'Скоро придут гости, и будет праздник.'],
    ['ru', 'Спи, я буду рядом, скоро наступит утро.'],
    ['ru', 'С этой книжкой ты не будешь скучать!'],
    ['ru', 'Подарок рядом с тобой, загляни под подушку.'],
    ['ru', 'Поздравляю с днём рождения! Тебе исполнилось 5 лет.'],
    ['ru', 'Марта, когда я вернусь, мы почитаем.'],
    ['ru', 'Мая, я вернусь и обниму тебя.'],
    ['uk', 'Ми йшли через ліс цілий день.'],
    ['uk', 'Скоро прийдуть гості.'],
    ['uk', 'Лютого вовка не буде, я повернуся.'],
  ];
  it.each(allowed)('%s allows «%s»', (locale, text) => {
    expect(() => assertStoryPromiseFree(text, locale)).not.toThrow();
  });
  it('turns borderline phrases into soft hints instead of errors', () => {
    expect(
      checkStoryPromises('Завтра почитаем ещё.', 'ru').hints.map((h) => h.code),
    ).toEqual(['STORY_HINT_RELATIVE_TIME']);
    expect(
      checkStoryPromises('Когда вернусь, мы почитаем вместе.', 'ru').hints.map(
        (h) => h.code,
      ),
    ).toEqual(['STORY_HINT_RETURN_WITHOUT_DATE']);
    expect(checkStoryPromises('Я тебя люблю.', 'ru')).toEqual({
      violation: null,
      hints: [],
    });
    // Decision B-S3-1: «не будешь скучать» is a hint, not a therapy block.
    expect(
      checkStoryPromises(
        'С этой книжкой ты не будешь скучать!',
        'ru',
      ).hints.map((h) => h.code),
    ).toEqual(['STORY_HINT_FEELING_PROMISE']);
    expect(
      checkStoryPromises(
        'Пусть мартышка из книжки придёт к тебе во сне.',
        'ru',
      ).hints.map((h) => h.code),
    ).toEqual(['STORY_HINT_RETURN_WITHOUT_DATE']);
    expect(checkStoryPromises('Скоро придут гости.', 'ru').hints).toEqual([]);
  });
  it('drops lone surrogates from spoken text, keeps pairs (B-S3-7)', () => {
    expect(toWellFormedStoryText('a\uD800b \uD83D\uDE00 c\uDC00')).toBe(
      'ab \uD83D\uDE00 c',
    );
    expect(normalizeStorySpeechText(' a\uD800b\n\nc ', 50)).toBe('ab c');
    expect(() =>
      encodeURIComponent(normalizeStorySpeechText('x\uDC00', 10)),
    ).not.toThrow();
  });
});

describe('WP3 gift note layout for video segments (WP4 contract)', () => {
  it('keeps the legacy audio text and records exact segment offsets', () => {
    const main = storyText(TURNIP);
    for (const position of ['beginning', 'end'] as const) {
      const { text, layout } = composeStoryNarration(
        main,
        'Подарок рядом.',
        position,
      );
      expect(text).toBe(
        position === 'beginning'
          ? `Подарок рядом.\n\n${main}`
          : `${main}\n\nПодарок рядом.`,
      );
      expect(text.slice(layout.main.start, layout.main.end)).toBe(main);
      expect(text.slice(layout.giftNote!.start, layout.giftNote!.end)).toBe(
        'Подарок рядом.',
      );
      const parts = storyNarrationParts({ text, narrationLayout: layout });
      expect(parts).toMatchObject({
        main,
        giftNote: { text: 'Подарок рядом.', position },
        legacy: false,
      });
    }
  });
  it('derives the same layout for pre-WP3 rows and refuses inconsistent data', () => {
    const main = storyText(TURNIP);
    const legacy = storyNarrationParts({
      text: `${main}\n\nПодарок рядом.`,
      giftNote: 'Подарок рядом.',
      giftNotePosition: 'end',
      narrationLayout: null,
    });
    expect(legacy.legacy).toBe(true);
    expect(legacy.main).toBe(main);
    expect(legacy.layout).toEqual(
      composeStoryNarration(main, 'Подарок рядом.', 'end').layout,
    );
    expect(storyNarrationParts({ text: main }).giftNote).toBeNull();
    const { layout } = composeStoryNarration(main, 'Подарок рядом.', 'end');
    expect(() =>
      storyNarrationParts({
        text: `${main}\n\nДругое.`,
        narrationLayout: layout,
      }),
    ).toThrow();
    expect(() =>
      storyNarrationParts({
        text: main,
        giftNote: 'Нет в тексте',
        giftNotePosition: 'end',
      }),
    ).toThrow();
  });
  it('normalizes the inserted note (whitespace, invisible characters) before validation', () => {
    const draft = prepareStoryDraft({
      catalogId: TURNIP,
      giftNoteEnabled: true,
      giftNote: '  Под​  подушкой\n\nнебольшой   подарок. ',
      giftNotePosition: 'beginning',
    });
    expect(draft.giftNote).toBe('Под подушкой небольшой подарок.');
    expect(draft.text.startsWith('Под подушкой небольшой подарок.\n\n')).toBe(
      true,
    );
  });
});

describe('WP3 preview has no side effects', () => {
  it('returns the exact voiced text with the highlighted insert, duration and estimate without DB, TTS or spend checks', () => {
    const s = setup();
    const preview = s.service.preview(
      {
        catalogId: TURNIP,
        occasionKind: 'bedtime',
        giftNoteEnabled: true,
        giftNote: 'Загляни под подушку после сказки.',
        giftNotePosition: 'end',
        budgetUsd: 3,
        giftPhotoDescription: 'Мягкий заяц в голубой коробке',
      },
      {
        includeVideo: true,
        preambleText: 'Привет, солнышко! У меня для тебя сказка.',
      },
    );
    expect(preview.sideEffects).toBe('none');
    expect(preview.parts.map((p) => p.kind)).toEqual(['main', 'giftNote']);
    expect(preview.parts.map((p) => p.text).join('\n\n')).toBe(preview.text);
    expect(preview.giftNote).toMatchObject({
      text: 'Загляни под подушку после сказки.',
      position: 'end',
    });
    expect(preview.occasion).toMatchObject({ kind: 'bedtime', theme: 'night' });
    expect(preview.occasion.lines[0]).toMatch(/сну/);
    expect(preview.durationSeconds.withinLimits).toBe(true);
    expect(preview.reserveMicroUsd).toBe(storyAudioReservation(preview.text));
    expect(
      preview.estimate.lines.find((l) => l.id === 'assembly')?.status,
    ).toBe('included');
    for (const fn of [
      s.db.findFirst,
      s.db.findFirstOrThrow,
      s.db.updateMany,
      s.db.count,
      s.db.create,
      s.prisma.$transaction,
      s.prisma.$queryRaw,
      s.prisma.$executeRaw,
      s.tts.synthesize,
      s.stt.transcribe,
      s.plan.assertCanSpendUser,
      s.usage.record,
    ])
      expect(fn).not.toHaveBeenCalled();
  });
  it('previews exactly what create stores', async () => {
    const s = setup();
    const input = {
      catalogId: TURNIP,
      giftNoteEnabled: true,
      giftNote: 'Рядом с тобой лежит подарок.',
      giftNotePosition: 'beginning' as const,
      budgetUsd: 2,
      occasionKind: 'separation' as const,
      giftPhotoDescription: ' Деревянная  машинка ',
    };
    const preview = s.service.preview(input);
    const created = await s.service.create('u1', input);
    const data = s.db.create.mock.calls[0][0].data;
    expect(data.text).toBe(preview.text);
    expect(data.textHash).toBe(preview.textHash);
    expect(data.narrationLayout).toEqual(preview.layout);
    expect(data).toMatchObject({
      giftNoteEnabled: true,
      giftNotePosition: 'beginning',
      occasionKind: 'separation',
      occasionTheme: 'warm',
      occasion: null,
      giftPhotoDescription: 'Деревянная машинка',
      voiceId: STORY_VOICE,
    });
    expect(created.estimate.audioReserveMicroUsd).toBe(data.reservedMicroUsd);
    expect(created.occasionTheme).toBe('warm');
  });
  it('rejects forbidden promises in the note, preamble and photo description before any write', async () => {
    const s = setup();
    expect(
      codeOf(() =>
        s.service.preview({
          catalogId: TURNIP,
          giftNoteEnabled: true,
          giftNote: 'Подарок уже в пути!',
        }),
      ),
    ).toBe('STORY_PROMISE_DELIVERY');
    expect(
      codeOf(() =>
        s.service.preview(
          { catalogId: TURNIP },
          { includeVideo: true, preambleText: 'Я вернусь через неделю.' },
        ),
      ),
    ).toBe('STORY_PROMISE_RETURN_DATE');
    await expect(
      s.service.create('u1', {
        catalogId: TURNIP,
        giftPhotoDescription: 'Курьер доставит завтра',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('routes preview options separately from the draft input', () => {
    const service = { previewFor: jest.fn(() => 'ok') };
    const controller = new StoryGiftsController(
      service as any,
      {} as any,
      {} as any,
    );
    void controller.preview(
      { telegramUserId: 'u1' } as any,
      {
        catalogId: TURNIP,
        includeVideo: true,
        preambleText: 'Привет!',
        videoVoice: 'nova',
      } as PreviewStoryDto,
    );
    expect(service.previewFor).toHaveBeenCalledWith(
      'u1',
      { catalogId: TURNIP },
      { includeVideo: true, preambleText: 'Привет!', videoVoice: 'nova' },
    );
  });
});

describe('WP3 estimate (9947)', () => {
  const main = storyText(TURNIP);
  it('keeps the audio reserve formula and splits it into voice + QA lines', () => {
    const { text } = composeStoryNarration(main, 'Подарок рядом.', 'end');
    const e = storyEstimate({
      mainChars: main.length,
      giftNoteChars: 'Подарок рядом.'.length,
      budgetMicroUsd: 1_000_000,
    });
    expect(e.audioReserveMicroUsd).toBe(storyAudioReservation(text));
    expect(e.totalReserveMicroUsd).toBe(storyAudioReservation(text));
    expect(e.lines.map((l) => [l.id, l.status])).toEqual([
      ['voice', 'included'],
      ['image', 'not-selected'],
      ['animation', 'unavailable'],
      ['assembly', 'not-included'],
      ['qa', 'included'],
    ]);
    expect(e.lines[0].items.map((i) => i.id)).toEqual([
      'voice.main',
      'voice.giftNote',
    ]);
    expect(e.reserveMultiplier).toBe(4);
    expect(e.withinBudget).toBe(true);
  });
  it('adds the video part with the existing storyVideoReserve formula (Nova and parent voice)', () => {
    const pre = 'Привет, солнышко! У меня для тебя сказка.';
    const nova = storyEstimate({
      mainChars: main.length,
      budgetMicroUsd: 5_000_000,
      video: { preambleChars: pre.length },
    });
    expect(nova.videoReserveMicroUsd).toBe(storyVideoReserve(pre));
    expect(nova.totalReserveMicroUsd).toBe(
      storyAudioReservation(main) + storyVideoReserve(pre),
    );
    const parent = storyEstimate({
      mainChars: main.length,
      budgetMicroUsd: 5_000_000,
      video: { preambleChars: pre.length, voice: 'parent' },
    });
    expect(parent.videoReserveMicroUsd).toBe(storyVideoReserve(pre, main));
    expect(parent.lines[0].items.map((i) => i.id)).toEqual([
      'voice.main',
      'voice.preamble',
      'voice.parentMain',
    ]);
  });
  it('B-S3-4: family voice re-synthesizes the gift note as its own segment; the outro is always synthesized', () => {
    const pre = 'Привет, солнышко! У меня для тебя сказка.';
    const note = 'Загляни под подушку — там небольшой подарок.';
    const outro = 'Спокойной ночи, солнышко.';
    const parent = storyEstimate({
      mainChars: main.length,
      giftNoteChars: note.length,
      budgetMicroUsd: 5_000_000,
      video: {
        preambleChars: pre.length,
        voice: 'parent',
        outroChars: outro.length,
      },
    });
    // Same call StoryVideoService makes: synth segments joined + parent main.
    expect(parent.videoReserveMicroUsd).toBe(
      storyVideoReserve(`${pre}${note}${outro}`, main),
    );
    expect(parent.lines[0].items.map((i) => i.id)).toEqual([
      'voice.main',
      'voice.giftNote',
      'voice.preamble',
      'voice.parentMain',
      'voice.parentGiftNote',
      'voice.outro',
    ]);
    // Nova: the note is inside the approved MP3 — only intro + outro.
    const nova = storyEstimate({
      mainChars: main.length,
      giftNoteChars: note.length,
      budgetMicroUsd: 5_000_000,
      video: { preambleChars: pre.length, outroChars: outro.length },
    });
    expect(nova.videoReserveMicroUsd).toBe(storyVideoReserve(`${pre}${outro}`));
    // Through the preview endpoint function, with normalization.
    const preview = previewStoryDraft(
      {
        catalogId: TURNIP,
        budgetUsd: 5,
        giftNoteEnabled: true,
        giftNote: note,
      },
      {
        includeVideo: true,
        preambleText: pre,
        videoVoice: 'parent',
        outroText: `  ${outro}\n`,
      },
    );
    expect(preview.estimate.videoReserveMicroUsd).toBe(
      storyVideoReserve(`${pre}${note}${outro}`, main),
    );
    expect(preview.estimate.speech.outroSeconds).toBeGreaterThan(0);
    expect(() =>
      previewStoryDraft(
        { catalogId: TURNIP },
        { includeVideo: true, outroText: 'Я вернусь завтра.' },
      ),
    ).toThrow(BadRequestException);
  });
  it('flags over-budget plans and never prices a long story as per-second animation', () => {
    const tight = storyEstimate({
      mainChars: main.length,
      budgetMicroUsd: 100_000,
      video: { preambleChars: 100 },
    });
    expect(tight.withinBudget).toBe(false);
    expect(tight.overByMicroUsd).toBe(tight.totalReserveMicroUsd - 100_000);
    expect(tight.remainingMicroUsd).toBe(0);
    const long = storyEstimate({
      mainChars: 50_000,
      budgetMicroUsd: 1_000_000_000,
      video: { preambleChars: 100 },
    });
    const anim = long.lines.find((l) => l.id === 'animation')!;
    expect(anim).toMatchObject({
      status: 'unavailable',
      costMicroUsd: 0,
      reserveMicroUsd: 0,
    });
    expect(long.animation).toMatchObject({ provider: null, available: false });
  });
  it('prices the narrator look with the WP5 price (story-narrator-look), 0 when unselected or reused', () => {
    const at = (look?: Parameters<typeof storyEstimate>[0]['look']) =>
      storyEstimate({
        mainChars: main.length,
        budgetMicroUsd: 5_000_000,
        ...(look ? { look } : {}),
      });
    const none = at();
    const noLook = none.lines.find((l) => l.id === 'image')!;
    expect(noLook).toMatchObject({
      status: 'not-selected',
      costMicroUsd: 0,
      reserveMicroUsd: 0,
      items: [],
    });
    const photo = narratorLookPrice([GEMINI_IMAGE_MODEL])!;
    expect(photo.estimateMicroUsd).toBeGreaterThan(0);
    // Outfit and makeup are one variant: one image pass, not two.
    for (const look of [{ outfit: true }, { outfit: true, makeup: true }]) {
      const e = at(look);
      const image = e.lines.find((l) => l.id === 'image')!;
      expect(image).toMatchObject({
        status: 'included',
        costMicroUsd: photo.estimateMicroUsd,
        reserveMicroUsd: photo.reserveMicroUsd,
      });
      expect(image.items.map((i) => i.id)).toEqual(['image.look']);
      expect(e.totalReserveMicroUsd).toBe(
        none.totalReserveMicroUsd + photo.reserveMicroUsd,
      );
      // Audio/video reserve formulas are untouched by the look line.
      expect(e.audioReserveMicroUsd).toBe(none.audioReserveMicroUsd);
    }
    const sketch = narratorLookPrice([
      GEMINI_IMAGE_MODEL,
      GEMINI_SKETCH_MODEL,
    ])!;
    const styled = at({ makeup: true, mode: 'cartoon' }).lines.find(
      (l) => l.id === 'image',
    )!;
    expect(styled.costMicroUsd).toBe(sketch.estimateMicroUsd);
    expect(styled.reserveMicroUsd).toBe(sketch.reserveMicroUsd);
    expect(styled.items.map((i) => i.id)).toEqual([
      'image.look',
      'image.style',
    ]);
    const reused = at({ outfit: true, existing: true });
    expect(reused.lines.find((l) => l.id === 'image')).toMatchObject({
      costMicroUsd: 0,
      reserveMicroUsd: 0,
      items: [],
    });
    expect(reused.totalReserveMicroUsd).toBe(none.totalReserveMicroUsd);
  });
  it('marks the look line unavailable when the image model has no rate', () => {
    const prev = process.env.GEMINI_IMAGE_MODEL;
    process.env.GEMINI_IMAGE_MODEL = 'no-such-image-model';
    try {
      jest.isolateModules(() => {
        const isolated =
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('./story-budget') as typeof import('./story-budget');
        const e = isolated.storyEstimate({
          mainChars: main.length,
          budgetMicroUsd: 5_000_000,
          look: { outfit: true },
        });
        expect(e.lines.find((l) => l.id === 'image')).toMatchObject({
          status: 'unavailable',
          costMicroUsd: 0,
          reserveMicroUsd: 0,
        });
      });
    } finally {
      if (prev === undefined) delete process.env.GEMINI_IMAGE_MODEL;
      else process.env.GEMINI_IMAGE_MODEL = prev;
    }
  });
  it('forbids enabling animation without a valid quote, within the preamble and budget', () => {
    const base = {
      preambleSeconds: 10,
      budgetMicroUsd: 3_000_000,
      reservedMicroUsd: 1_000_000,
    };
    expect(() =>
      assertStoryAnimationAllowed(storyAnimationQuote(), base),
    ).toThrow('нет котировки');
    expect(() => assertStoryAnimationAllowed(null, base)).toThrow();
    const now = new Date('2026-10-19T10:00:00Z');
    const quote: StoryAnimationQuote = {
      provider: 'test-provider',
      available: true,
      seconds: 8,
      costMicroUsd: 300_000,
      reserveMicroUsd: 600_000,
      quotedAt: '2026-10-19T09:59:00Z',
      expiresAt: '2026-10-19T10:10:00Z',
      reason: null,
    };
    expect(assertStoryAnimationAllowed(quote, { ...base, now })).toBe(600_000);
    expect(() =>
      assertStoryAnimationAllowed({ ...quote, seconds: 60 }, { ...base, now }),
    ).toThrow('преамбула');
    expect(() =>
      assertStoryAnimationAllowed(quote, {
        ...base,
        budgetMicroUsd: 1_500_000,
        now,
      }),
    ).toThrow('бюджет');
    expect(() =>
      assertStoryAnimationAllowed(quote, {
        ...base,
        now: new Date('2026-10-19T11:00:00Z'),
      }),
    ).toThrow('устарела');
    expect(() =>
      assertStoryAnimationAllowed(
        { ...quote, reserveMicroUsd: null },
        { ...base, now },
      ),
    ).toThrow();
  });
  it('restores the stored estimate for new and legacy gifts', () => {
    const draft = prepareStoryDraft({
      catalogId: TURNIP,
      giftNoteEnabled: true,
      giftNote: 'Подарок рядом.',
    });
    const fromLayout = storedStoryEstimate({
      catalogId: TURNIP,
      chapters: [],
      title: 'Репка',
      giftNote: draft.giftNote,
      narrationLayout: draft.layout,
      budgetCents: 100,
    });
    expect(fromLayout.audioReserveMicroUsd).toBe(draft.reserveMicroUsd);
    const legacy = storedStoryEstimate({
      catalogId: TURNIP,
      chapters: [],
      title: 'Репка',
      giftNote: 'Подарок рядом.',
      narrationLayout: null,
      budgetCents: 100,
    });
    expect(legacy.audioReserveMicroUsd).toBe(draft.reserveMicroUsd);
  });
});

describe('WP3 gift photo and description', () => {
  it('stores a description without a photo, clears it with an empty string, validates promises', async () => {
    const s = setup();
    const v = await s.service.photo('u1', 'g1', undefined, ' Плюшевый  заяц ');
    expect(s.row.giftPhotoDescription).toBe('Плюшевый заяц');
    expect(s.row.hasGiftPhoto).toBe(false);
    expect(v.estimate.version).toBe(1);
    await s.service.photo('u1', 'g1', undefined, '');
    expect(s.row.giftPhotoDescription).toBeNull();
    await expect(
      s.service.photo('u1', 'g1', undefined, 'Уже едет курьером'),
    ).rejects.toThrow(BadRequestException);
    await expect(s.service.photo('u1', 'g1')).rejects.toThrow(
      'Нужно фото или описание',
    );
  });
  it('removes photo and description only while the draft is editable', async () => {
    const s = setup();
    Object.assign(s.row, {
      giftPhoto: new Uint8Array([1]),
      hasGiftPhoto: true,
      giftPhotoDescription: 'Заяц',
    });
    await s.service.removePhoto('u1', 'g1');
    expect(s.row).toMatchObject({
      giftPhoto: null,
      hasGiftPhoto: false,
      giftPhotoDescription: null,
    });
    s.row.status = 'READY';
    await expect(s.service.removePhoto('u1', 'g1')).rejects.toThrow(
      'только до озвучки',
    );
    await expect(s.service.removePhoto('other', 'g1')).rejects.toThrow(
      'не найдена',
    );
  });
});
