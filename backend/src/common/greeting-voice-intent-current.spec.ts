/**
 * Значения на экране в запросе разбора — изменение контракта 1
 * финального аудита ветки K (30.09.2026): `overlayCurrentBrief`.
 */
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  VOICE_CURRENT_FIELDS,
  VoiceBriefState,
  VoiceUnderstandContext,
  checkCommand,
  normalizeModelAnswer,
  overlayCurrentBrief,
  resolveIntent,
} from './greeting-voice-intent';
import { MAX_CUSTOM_OCCASION_LENGTH } from './types/greeting.types';
import { UpdateGreetingBriefDto } from '../modules/project/dto/update-greeting-brief.dto';

function brief(over: Partial<VoiceBriefState> = {}): VoiceBriefState {
  return {
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    occasionRegister: null,
    registerSource: null,
    userOccasionRegister: null,
    scriptLanguage: 'ru',
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'WARM',
    personalMessage: null,
    presenterProvider: 'grok',
    resolution: '720p',
    occasionDate: null,
    ...over,
  };
}

function ctx(b: VoiceBriefState): VoiceUnderstandContext {
  return {
    brief: b,
    presenters: ['grok'],
    maxResolution: '720p',
    scope: 'project',
    hasScript: false,
    screen: { step: 'brief' },
    pending: null,
    uiLocale: 'ru',
    replyLocale: 'ru',
  };
}

describe('overlayCurrentBrief — значения на экране поверх сохранённого', () => {
  it('нет current, не объект, массив — бриф как есть', () => {
    const b = brief();
    for (const c of [undefined, null, 'x', 5, [], ['occasion']]) {
      expect(overlayCurrentBrief(b, c)).toEqual(b);
    }
  });

  it('верные значения накладываются все', () => {
    const r = overlayCurrentBrief(brief(), {
      occasion: 'OTHER',
      customOccasionText: 'Выпускной внука',
      mood: 'SOLEMN',
      tone: 'RESPECTFUL',
      recipientName: 'Олег',
      senderName: 'Бабушка',
      personalMessage: 'Горжусь тобой',
      scriptLanguage: 'uk',
      presenterProvider: 'hedra',
      resolution: '1080p',
      occasionDate: '2026-10-05',
    });
    expect(r).toMatchObject({
      occasion: 'OTHER',
      customOccasionText: 'Выпускной внука',
      userOccasionRegister: 'SOLEMN',
      tone: 'RESPECTFUL',
      recipientName: 'Олег',
      senderName: 'Бабушка',
      personalMessage: 'Горжусь тобой',
      scriptLanguage: 'uk',
      presenterProvider: 'hedra',
      resolution: '1080p',
      occasionDate: '2026-10-05',
    });
  });

  it('неверное поле игнорируется, остальные применяются', () => {
    const b = brief();
    const r = overlayCurrentBrief(b, {
      occasion: 'birthday!!',
      tone: 'EVIL',
      mood: 'SAD',
      recipientName: 'я'.repeat(121),
      senderName: 42,
      personalMessage: 'я'.repeat(2001),
      scriptLanguage: 'fr',
      presenterProvider: 'veo',
      resolution: '4k',
      occasionDate: '2026-02-30',
      customOccasionText: 'я'.repeat(MAX_CUSTOM_OCCASION_LENGTH + 1),
      // Неизвестный ключ — не поле брифа.
      tone2: 'FUNNY',
    });
    expect(r).toEqual(b);
    expect(overlayCurrentBrief(b, { tone: 'FUNNY', occasion: 'NOPE' })).toEqual(
      { ...b, tone: 'FUNNY' },
    );
  });

  it('null: у необязательных — «на экране пусто», у обязательных — игнор', () => {
    const b = brief({
      personalMessage: 'текст',
      occasionDate: '2026-10-01',
      scriptLanguage: 'ru',
    });
    const r = overlayCurrentBrief(b, {
      senderName: null,
      personalMessage: '',
      occasionDate: null,
      scriptLanguage: null,
      occasion: null,
      tone: null,
      recipientName: null,
      presenterProvider: null,
      resolution: null,
    });
    expect(r).toEqual({
      ...b,
      senderName: null,
      personalMessage: null,
      occasionDate: null,
      scriptLanguage: null,
    });
  });

  it('строка из одних пробелов — не значение, игнорируется', () => {
    const b = brief({ personalMessage: 'текст', senderName: 'Андрей' });
    expect(
      overlayCurrentBrief(b, {
        recipientName: '   ',
        senderName: ' \t ',
        personalMessage: '  ',
        customOccasionText: '   ',
      }),
    ).toEqual(b);
    expect(
      overlayCurrentBrief(b, { recipientName: ' Олег ' }).recipientName,
    ).toBe(' Олег ');
  });

  it('дата с временем — берётся день, как у строки брифа', () => {
    expect(
      overlayCurrentBrief(brief(), { occasionDate: '2026-10-05T00:00:00.000Z' })
        .occasionDate,
    ).toBe('2026-10-05');
  });

  it('другой повод или описание — сохранённый подъём классификатором не переносится', () => {
    const b = brief({
      occasion: 'OTHER',
      customOccasionText: 'поминки',
      occasionRegister: 'MOURNING',
      registerSource: 'classifier',
    });
    expect(
      overlayCurrentBrief(b, { customOccasionText: 'выпускной' }),
    ).toMatchObject({ occasionRegister: null, registerSource: null });
    // То же описание — подъём остаётся.
    expect(
      overlayCurrentBrief(b, { customOccasionText: 'поминки', tone: 'WARM' }),
    ).toMatchObject({
      occasionRegister: 'MOURNING',
      registerSource: 'classifier',
    });
  });

  it('те же правила, что DTO брифа: что принял голос, примет и «Сохранить»', () => {
    // Поле `current` → поле DTO (`mood` там — `occasionRegister`).
    const dtoField: Record<string, string> = { mood: 'occasionRegister' };
    const candidates: Record<string, unknown[]> = {
      occasion: ['BIRTHDAY', 'OTHER', 'birthday', 'NOPE', ''],
      customOccasionText: [
        'a',
        'я'.repeat(MAX_CUSTOM_OCCASION_LENGTH),
        'я'.repeat(MAX_CUSTOM_OCCASION_LENGTH + 1),
      ],
      mood: ['SOLEMN', 'MOURNING', 'solemn', 'SAD'],
      tone: ['WARM', 'FUNNY', 'warm', 'EVIL'],
      recipientName: ['a', 'я'.repeat(120), 'я'.repeat(121), ''],
      senderName: ['a', 'я'.repeat(120), 'я'.repeat(121)],
      personalMessage: ['a', 'я'.repeat(2000), 'я'.repeat(2001)],
      scriptLanguage: ['ru', 'uk', 'en', 'de', 'es', 'fr', 'RU'],
      presenterProvider: ['grok', 'hedra', 'veo', 'GROK'],
      resolution: ['480p', '720p', '1080p', '4k'],
      occasionDate: ['2026-10-05', 'завтра', '05.10.2026'],
    };
    expect(Object.keys(candidates).sort()).toEqual(
      [...VOICE_CURRENT_FIELDS].sort(),
    );
    // Сторож вместо значений: принятое значение его заменит.
    const SENTINEL = '__';
    const base = Object.fromEntries(
      Object.keys(brief()).map((k) => [k, SENTINEL]),
    ) as unknown as VoiceBriefState;
    const stateKey: Record<string, keyof VoiceBriefState> = {
      mood: 'userOccasionRegister',
    };
    for (const [field, values] of Object.entries(candidates)) {
      for (const value of values) {
        // Пустая строка у необязательного — «на экране пусто», а не значение.
        if (value === '') continue;
        const dto = plainToInstance(UpdateGreetingBriefDto, {
          [dtoField[field] ?? field]: value,
        });
        const dtoOk = validateSync(dto).length === 0;
        const key = stateKey[field] ?? (field as keyof VoiceBriefState);
        const accepted =
          overlayCurrentBrief(base, { [field]: value })[key] !== SENTINEL;
        // Дата строже DTO (`@IsDateString`): только календарный день —
        // принятое голосом DTO примет, обратное не обязано.
        const expected = field === 'occasionDate' ? accepted && dtoOk : dtoOk;
        expect({ field, value, accepted }).toEqual({
          field,
          value,
          accepted: expected,
        });
      }
    }
  });
});

describe('разбор против экрана, а не сохранённого брифа', () => {
  it('на экране «Особый повод» (сохранён день рождения) — настроение принимается', () => {
    const saved = brief({ occasion: 'BIRTHDAY' });
    const answer = normalizeModelAnswer({
      kind: 'fill',
      confidence: 0.9,
      fields: [{ target: 'greeting-field-mood', value: 'SOLEMN' }],
    });
    const before = resolveIntent(
      answer,
      'настроение торжественное',
      ctx(saved),
    );
    expect(before.intent.kind).not.toBe('fill');

    const onScreen = overlayCurrentBrief(saved, {
      occasion: 'OTHER',
      customOccasionText: 'Выпускной',
    });
    const after = resolveIntent(
      answer,
      'настроение торжественное',
      ctx(onScreen),
    );
    expect(after.intent).toMatchObject({
      kind: 'fill',
      fields: [{ target: 'greeting-field-mood', value: 'SOLEMN' }],
    });
  });

  it('«серьёзнее» считается от тона на экране', () => {
    const saved = brief({ tone: 'WARM' });
    const onScreen = overlayCurrentBrief(saved, { tone: 'FUNNY' });
    const fromSaved = checkCommand('tone-serious', ctx(saved));
    const fromScreen = checkCommand('tone-serious', ctx(onScreen));
    expect(fromScreen).toEqual({ ok: true, args: { tone: 'WARM' } });
    expect(fromSaved).not.toEqual(fromScreen);
  });
});
