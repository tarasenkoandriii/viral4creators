/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * Приёмка §8.1 ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md,
 * пункт «Перебор комбинаций»: 24 повода × 5 тонов × наклейка {нет, есть}
 * × музыка {тема повода, тема `occasions: null`, свой файл} × сцены 1–4
 * = 2880 комбинаций, плюс OTHER × 5 регистров (× те же оси — ещё 600).
 * Для каждой ожидаемый вердикт совпадает с ответом (а) `PATCH` брифа
 * проекта и сессии, (б) проверки в `startVideo`.
 *
 * `common/greeting-policy.spec.ts` перебирает то же против ЧИСТОЙ
 * функции. Здесь — через сервисы, то есть ровно то, что видит клиент
 * API: функцию могли бы звать с не теми полями (забыть музыку, взять
 * повод из брифа вместо снимка), и чистый перебор этого не заметит.
 *
 * Ожидания — своя таблица ниже (ORACLE_*), переписанная из §3.2–§3.3
 * ТЗ руками, а не `REGISTER_POLICY`: иначе тест сверял бы код с ним же.
 *
 * Наклейка, сцены и музыка правятся своими маршрутами — они проверены
 * отдельными `describe` в конце, и только по ИСХОДУ (отказ политики или
 * нет): как сервис пишет снимок (целиком, по полю, с повтором при гонке)
 * — не дело этого теста, и смена способа записи его не ломает.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../prompt/prompt.service', () => ({ PromptService: class {} }));
jest.mock('../storage/blob.service', () => ({ BlobService: class {} }));
jest.mock('../../common/platform-settings.service', () => ({
  PlatformSettingsService: class {},
}));
jest.mock('../audio/audio.service', () => ({ AudioService: class {} }));
// Наклейки: ключа Pixabay нет, сеть закрыта — разрешённый политикой выбор
// упирается в «не настроено», а не уходит наружу.
jest.mock('axios');
jest.mock('../../config/configuration', () => ({
  loadConfiguration: jest.fn(() => ({ pixabay: { apiKey: '' } })),
}));

import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { GreetingBriefService } from './greeting-brief.service';
import { GreetingSessionEditService } from '../greeting-session-edit/greeting-session-edit.service';
import { GreetingVideoService } from '../greeting-video/greeting-video.service';
import { GreetingStickerService } from '../greeting-sticker/greeting-sticker.service';
import { GreetingScenesService } from '../greeting-scenes/greeting-scenes.service';
import { GreetingMusicService } from '../greeting-music/greeting-music.service';
import { RenderAccessService } from '../render-access/render-access.service';
import { GreetingReferenceService } from '../greeting-reference/greeting-reference.service';
import { OTHER_MOOD_REQUIRED } from '../../common/greeting-policy';
import { GREETING_MUSIC_SETTING_KEY } from '../../common/greeting-music';
import { ModerationStatus } from '../../common/types/prompt.types';
import { fakeSnapshotDb } from '../../../test/fake-greeting-snapshot-db';
import {
  GREETING_OCCASIONS,
  GREETING_REGISTERS,
  GREETING_TONES,
  GreetingOccasion,
  GreetingRegister,
  GreetingTone,
} from '../../common/types/greeting.types';

// ── Ожидания: §3.2–§3.3 ТЗ, переписаны руками ────────────────────────────

type Catalog = Exclude<GreetingOccasion, 'OTHER'>;

const CELEBRATORY_TONES: GreetingTone[] = ['WARM', 'FUNNY', 'FORMAL'];

/** §3.2: регистр и тоны каталожных поводов. */
const ORACLE: Record<
  Catalog,
  { register: GreetingRegister; tones: GreetingTone[] }
> = {
  BIRTHDAY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  WEDDING: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  ANNIVERSARY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  NEW_YEAR: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  CHRISTMAS: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  GRADUATION: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  VALENTINES_DAY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  WOMENS_DAY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  MOTHERS_DAY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  FATHERS_DAY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  TEACHERS_DAY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  FIRST_SCHOOL_DAY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  NEW_BABY: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  HOUSEWARMING: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  PROMOTION: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  RETIREMENT: { register: 'CELEBRATORY', tones: CELEBRATORY_TONES },
  CORPORATE: { register: 'CELEBRATORY', tones: ['FORMAL', 'WARM', 'FUNNY'] },
  FAREWELL_COLLEAGUE: { register: 'WARM_NEUTRAL', tones: CELEBRATORY_TONES },
  DEFENDERS_DAY: {
    register: 'SOLEMN',
    tones: ['WARM', 'FORMAL', 'RESPECTFUL'],
  },
  BAPTISM: { register: 'SOLEMN', tones: ['WARM', 'FORMAL', 'RESPECTFUL'] },
  APOLOGY: { register: 'SENSITIVE', tones: ['RESPECTFUL', 'WARM'] },
  GET_WELL: { register: 'SENSITIVE', tones: ['SUPPORTIVE', 'WARM'] },
  CONDOLENCE: { register: 'MOURNING', tones: ['RESPECTFUL', 'SUPPORTIVE'] },
};

/** §3.2, строка OTHER: тоны «Особого повода» по регистру. */
const ORACLE_OTHER_TONES: Record<GreetingRegister, GreetingTone[]> = {
  CELEBRATORY: ['WARM', 'FUNNY', 'FORMAL'],
  WARM_NEUTRAL: ['WARM', 'FUNNY', 'FORMAL'],
  SOLEMN: ['WARM', 'FORMAL', 'RESPECTFUL'],
  SENSITIVE: ['WARM', 'SUPPORTIVE', 'RESPECTFUL'],
  MOURNING: ['RESPECTFUL', 'SUPPORTIVE'],
};

/** §3.3: наклейки, общая тема каталога, потолок сцен. */
const ORACLE_RULES: Record<
  GreetingRegister,
  { stickers: boolean; universalTheme: boolean; maxScenes: number }
> = {
  CELEBRATORY: { stickers: true, universalTheme: true, maxScenes: 4 },
  WARM_NEUTRAL: { stickers: true, universalTheme: true, maxScenes: 4 },
  SOLEMN: { stickers: false, universalTheme: false, maxScenes: 3 },
  SENSITIVE: { stickers: false, universalTheme: false, maxScenes: 2 },
  MOURNING: { stickers: false, universalTheme: false, maxScenes: 2 },
};

/**
 * Повод для перебора: каталожный, «Особый» с ответом о настроении или
 * «Особый» без ответа (снимок до этапа D — читается тёплым нейтральным,
 * а сохранить такой бриф заново уже нельзя).
 */
interface Case {
  occasion: GreetingOccasion;
  /** Только у OTHER: ответ человека; `null` — снимок без ответа. */
  register: GreetingRegister | null;
}

const CASES: Case[] = [
  ...GREETING_OCCASIONS.map((occasion) => ({ occasion, register: null })),
  ...GREETING_REGISTERS.map((register) => ({
    occasion: 'OTHER' as const,
    register,
  })),
];

function oracleRegister(c: Case): GreetingRegister {
  if (c.occasion !== 'OTHER') return ORACLE[c.occasion].register;
  return c.register ?? 'WARM_NEUTRAL';
}

function oracleTones(c: Case): GreetingTone[] {
  return c.occasion === 'OTHER'
    ? ORACLE_OTHER_TONES[oracleRegister(c)]
    : ORACLE[c.occasion].tones;
}

const caseName = (c: Case) =>
  c.occasion === 'OTHER'
    ? `OTHER/${c.register ?? 'без ответа'}`
    : String(c.occasion);

type MusicKind = 'own' | 'universal' | 'upload';
const MUSIC_KINDS: MusicKind[] = ['own', 'universal', 'upload'];

interface Combo {
  c: Case;
  tone: GreetingTone;
  sticker: boolean;
  music: MusicKind;
  scenes: number;
}

type Field = 'tone' | 'sticker' | 'music' | 'sceneCount';

function expectedViolations(x: Combo): Field[] {
  const reg = oracleRegister(x.c);
  const rules = ORACLE_RULES[reg];
  const out: Field[] = [];
  if (!oracleTones(x.c).includes(x.tone)) out.push('tone');
  if (x.sticker && !rules.stickers) out.push('sticker');
  if (x.music === 'universal' && !rules.universalTheme) out.push('music');
  if (x.scenes > rules.maxScenes) out.push('sceneCount');
  return out;
}

function* combos(c: Case): Generator<Combo> {
  for (const tone of GREETING_TONES)
    for (const sticker of [false, true])
      for (const music of MUSIC_KINDS)
        for (let scenes = 1; scenes <= 4; scenes++)
          yield { c, tone, sticker, music, scenes };
}

const comboName = (x: Combo) =>
  `${caseName(x.c)}/${x.tone}/${x.sticker ? 'наклейка' : '—'}/${x.music}/${x.scenes}`;

/** Фрагмент отказа политики по каждому правилу — то, что прочтёт человек. */
const FIELD_TEXT: Record<Field, RegExp> = {
  tone: /Тон «[^»]+» недоступен/,
  sticker: /Наклейки недоступны/,
  music: /музыкальная тема не подходит/,
  sceneCount: /не больше \d сцен/,
};

// ── Снимок и бриф для комбинации ─────────────────────────────────────────

const STICKER = {
  id: 'st1',
  url: 'https://blob.test/sessions/s1/stickers/st1.png',
  pathname: 'sessions/s1/stickers/st1.png',
  sourceUrl: 'https://pixabay.com/x',
  source: 'pixabay' as const,
  placement: 'top-right',
};

function musicOf(kind: MusicKind, occasion: GreetingOccasion) {
  switch (kind) {
    case 'own':
      return {
        id: 'theme-own',
        title: 'Тема повода',
        url: 'https://blob.test/music/own.mp3',
        source: 'catalog' as const,
        occasions: [occasion],
      };
    case 'universal':
      return {
        id: 'theme-any',
        title: 'Общая тема',
        url: 'https://blob.test/music/any.mp3',
        source: 'catalog' as const,
        occasions: null,
      };
    case 'upload':
      return {
        id: 'own-file',
        title: 'Своя песня',
        url: 'https://blob.test/sessions/s1/music/own.mp3',
        pathname: 'sessions/s1/music/own.mp3',
        source: 'upload' as const,
      };
  }
}

/** Нейтральное описание: ни ключевых слов траура, ни праздника. */
const OTHER_TEXT = 'семейный ужин в субботу';

function occasionFields(c: Case) {
  if (c.occasion !== 'OTHER') {
    return { occasion: c.occasion, customOccasionText: null };
  }
  return {
    occasion: 'OTHER' as const,
    customOccasionText: OTHER_TEXT,
    ...(c.register
      ? {
          occasionRegister: c.register,
          registerSource: 'user' as const,
          userOccasionRegister: c.register,
        }
      : {}),
  };
}

function snapshotOf(x: Combo, tone: GreetingTone = x.tone) {
  return {
    sourceGreetingBriefId: 'gb1',
    ...occasionFields(x.c),
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone,
    personalMessage: null,
    requestedPresenterProvider: 'grok',
    resolvedPresenterProvider: 'grok',
    requestedResolution: '720p',
    resolvedResolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    addedAt: '2026-09-22T10:00:00.000Z',
    sticker: x.sticker ? { ...STICKER } : null,
    musicTheme: musicOf(x.music, x.c.occasion),
    sceneCount: x.scenes,
  };
}

function projectBriefRow(over: Record<string, unknown> = {}) {
  return {
    id: 'gb1',
    projectId: 'p1',
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    occasionRegister: null,
    registerSource: null,
    userOccasionRegister: null,
    scriptLanguage: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'WARM',
    personalMessage: null,
    presenterProvider: 'grok',
    resolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    presenterLookId: null,
    presenterVariant: null,
    createdAt: new Date('2026-09-22T10:00:00Z'),
    updatedAt: new Date('2026-09-22T10:00:00Z'),
    ...over,
  };
}

function briefService(current: Record<string, unknown>) {
  const prisma = {
    greetingBrief: {
      findFirst: jest.fn().mockResolvedValue(current),
      update: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) => ({
            ...current,
            ...data,
          }),
        ),
    },
    brandManifest: { findFirst: jest.fn() },
    personaLook: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const plans = { planOfUser: jest.fn().mockResolvedValue('PREMIUM') };
  return {
    service: new GreetingBriefService(prisma as any, plans as any),
    prisma,
  };
}

async function outcome<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

function messageOf(e: unknown): string {
  if (e instanceof HttpException) {
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    const m = (r as { message?: unknown }).message;
    return Array.isArray(m) ? m.join(' ') : String(m ?? e.message);
  }
  return e instanceof Error ? e.message : String(e);
}

// ── (а) PATCH брифа проекта: тон против повода ───────────────────────────

describe('§8.1 перебор: PATCH /projects/:id/greeting-brief', () => {
  /**
   * У брифа проекта из правил ролика есть только тон: наклейка, музыка и
   * сцены живут в сессии. Тон ломается с двух сторон — поставить тон при
   * уже выбранном поводе и сменить повод при уже стоящем тоне; оба пути.
   */
  let checked = 0;

  it.each(CASES.map((c) => [caseName(c), c] as const))(
    '%s × 5 тонов',
    async (_name, c) => {
      for (const tone of GREETING_TONES) {
        const allowed = oracleTones(c).includes(tone);
        const missingMood = c.occasion === 'OTHER' && !c.register;
        const occasionDto =
          c.occasion === 'OTHER'
            ? {
                occasion: 'OTHER' as const,
                customOccasionText: OTHER_TEXT,
                ...(c.register ? { occasionRegister: c.register } : {}),
              }
            : { occasion: c.occasion };

        // Путь 1: повод уже стоит, меняется тон.
        const first = briefService(
          projectBriefRow({
            ...occasionFields(c),
            tone: oracleTones(c)[0],
          }),
        );
        const r1 = await outcome(
          first.service.updateBrief('u1', 'p1', { tone }),
        );
        // Путь 2: тон уже стоит (с прошлой правки), меняется повод.
        const second = briefService(
          projectBriefRow({ occasion: 'BIRTHDAY', tone }),
        );
        const r2 = await outcome(
          second.service.updateBrief('u1', 'p1', occasionDto as any),
        );

        const where = `${caseName(c)}/${tone}`;
        const expected = missingMood
          ? // §8.1: без ответа о настроении бриф не сохраняется.
            {
              ok: false,
              badRequest: true,
              moodRequired: true,
              toneExplained: false,
              listed: [],
              saved: null,
            }
          : allowed
            ? {
                ok: true,
                badRequest: false,
                moodRequired: false,
                toneExplained: false,
                listed: [],
                saved: { tone, occasion: c.occasion },
              }
            : {
                ok: false,
                badRequest: true,
                moodRequired: false,
                toneExplained: true,
                // Отказ называет ровно допустимые тоны — кодами (§3.5).
                listed: GREETING_TONES.filter((t) =>
                  oracleTones(c).includes(t),
                ),
                saved: null,
              };
        for (const [path, r, svc] of [
          ['тон', r1, first],
          ['повод', r2, second],
        ] as const) {
          checked++;
          const msg = r.ok ? '' : messageOf(r.error);
          const saved = svc.prisma.greetingBrief.update.mock.calls[0]?.[0]
            .data as Record<string, unknown> | undefined;
          expect({
            where,
            path,
            ok: r.ok,
            badRequest: !r.ok && r.error instanceof BadRequestException,
            moodRequired: msg === OTHER_MOOD_REQUIRED,
            toneExplained: FIELD_TEXT.tone.test(msg),
            listed: GREETING_TONES.filter((t) => msg.includes(`(${t})`)),
            saved: saved
              ? { tone: saved.tone, occasion: saved.occasion }
              : null,
          }).toEqual({ where, path, ...expected });
        }
      }
    },
  );

  it('перебрано: 29 поводов (24 + OTHER × 5) × 5 тонов × 2 пути', () => {
    expect(checked).toBe(CASES.length * GREETING_TONES.length * 2);
  });
});

// ── (а) PATCH брифа сессии: тон — отказ, остальное — сброс с перечнем ────

/**
 * Хранилище сессии для маршрутов, пишущих снимок. Запись снимка идёт
 * мимо `updateSession` — точечным SQL (`common/greeting-snapshot-write.ts`,
 * C2 захода 8); его исполняет общий фейк `test/fake-greeting-snapshot-db.ts`
 * поверх этого же хранилища. Неизвестные методы `SessionService` —
 * успешные пустышки: тест смотрит на ответ сервиса, а не на то, какими
 * вызовами он записан.
 */
function sessionDoubles(snapshot: Record<string, unknown>) {
  const store: Record<string, any> = {
    s1: {
      sessionId: 's1',
      userId: 'u1',
      projectId: 'p1',
      locale: 'ru',
      greetingBriefSnapshot: snapshot,
    },
  };
  const known: Record<string, unknown> = {
    getSession: jest.fn(async (id: string) =>
      store[id] ? { ...store[id] } : null,
    ),
    updateSession: jest.fn(async (id: string, patch: Record<string, any>) => {
      const next = { ...store[id] };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      store[id] = next;
      return next;
    }),
    createSession: jest.fn(async (_u: string, seed: Record<string, any>) => {
      store.s2 = { sessionId: 's2', userId: 'u1', projectId: 'p1', ...seed };
      return { ...store.s2 };
    }),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const sessions = new Proxy(known, {
    get: (t, k: string) => (k in t ? t[k] : jest.fn().mockResolvedValue(true)),
  });
  return { sessions, db: fakeSnapshotDb(sessions as any) };
}

function sessionEditService(snapshot: Record<string, unknown>) {
  const { sessions, db } = sessionDoubles(snapshot);
  const { service: briefs } = briefService(projectBriefRow());
  const Ctor = GreetingSessionEditService as any;
  return new Ctor(
    sessions,
    briefs,
    { moderateText: () => ({ status: 'APPROVED', flags: [] }) },
    { copyBlob: jest.fn(async (_f: string, to: string) => to) },
    db,
  ) as GreetingSessionEditService;
}

describe('§8.1 перебор: PATCH /sessions/:id/greeting-brief', () => {
  const RESET_NAME: Record<Exclude<Field, 'tone'>, string> = {
    sticker: 'sticker',
    music: 'musicTheme',
    sceneCount: 'sceneCount',
  };
  let checked = 0;

  it.each(CASES.map((c) => [caseName(c), c] as const))(
    '%s × тон × наклейка × музыка × сцены',
    async (_name, c) => {
      const failures: string[] = [];
      for (const x of combos(c)) {
        checked++;
        const expected = expectedViolations(x);
        // Тон в снимке до правки — допустимый: проверяется сама правка.
        const service = sessionEditService(
          snapshotOf(x, oracleTones(c)[0]) as any,
        );
        const r = await outcome(service.updateBrief('s1', { tone: x.tone }));
        const where = comboName(x);
        if (c.occasion === 'OTHER' && !c.register) {
          if (r.ok || messageOf(r.error) !== OTHER_MOOD_REQUIRED) {
            failures.push(`${where}: ждали отказ «нет ответа о настроении»`);
          }
          continue;
        }
        if (expected.includes('tone')) {
          // Тон — единственное, что правкой не сбрасывается, а отклоняется
          // (§3.6 п.1: «прогоняет политику»).
          if (r.ok || !(r.error instanceof BadRequestException)) {
            failures.push(`${where}: ждали 400 по тону`);
          } else if (!FIELD_TEXT.tone.test(messageOf(r.error))) {
            failures.push(`${where}: отказ без объяснения тона`);
          }
          continue;
        }
        if (!r.ok) {
          failures.push(`${where}: отказ ${messageOf(r.error)}`);
          continue;
        }
        const wantReset = expected
          .map((f) => RESET_NAME[f as Exclude<Field, 'tone'>])
          .sort();
        const gotReset = [...r.value.resetFields].sort();
        if (JSON.stringify(gotReset) !== JSON.stringify(wantReset)) {
          failures.push(
            `${where}: resetFields ${JSON.stringify(gotReset)} ≠ ${JSON.stringify(wantReset)}`,
          );
        }
        const brief = r.value.brief as any;
        const reg = oracleRegister(c);
        const wantSticker = x.sticker && ORACLE_RULES[reg].stickers;
        const wantMusic = !expected.includes('music');
        const wantScenes = Math.min(x.scenes, ORACLE_RULES[reg].maxScenes);
        if (
          !!brief.sticker !== wantSticker ||
          !!brief.musicTheme !== wantMusic ||
          brief.sceneCount !== wantScenes ||
          brief.tone !== x.tone
        ) {
          failures.push(
            `${where}: снимок наклейка=${!!brief.sticker} музыка=${!!brief.musicTheme} сцены=${brief.sceneCount} тон=${brief.tone}`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it('перебрано 2880 + OTHER × 5 регистров × 120 = 3480 комбинаций', () => {
    expect(checked).toBe(2880 + 5 * 120);
  });
});

// ── (б) startVideo: проверка у денег ─────────────────────────────────────

function videoService(
  snapshot: Record<string, unknown>,
  images: unknown[] = [],
) {
  const startGeneration = jest.fn().mockResolvedValue({ requestId: 'r1' });
  const credits = {
    reserveForGeneration: jest.fn().mockResolvedValue(true),
    refundIfReserved: jest.fn().mockResolvedValue(undefined),
    grantWelcomeIfFirst: jest.fn().mockResolvedValue(false),
  };
  const plans = {
    assertCanSpendSession: jest.fn().mockResolvedValue(undefined),
    assertCanSpendUser: jest.fn().mockResolvedValue(undefined),
    assertSession: jest.fn().mockResolvedValue(undefined),
    planOfSession: jest.fn().mockResolvedValue('PREMIUM'),
  };
  const session = {
    sessionId: 's1',
    userId: 'u1',
    greetingBriefSnapshot: snapshot,
    generationPrompt: {
      finalText: 'сцена',
      moderationStatus: ModerationStatus.APPROVED,
    },
    greetingReferenceImages: images,
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(session),
    updateSession: jest
      .fn()
      .mockImplementation((_id: string, patch: unknown) =>
        Promise.resolve(patch),
      ),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const tts = {
    providerKey: 'resemble',
    configured: () => true,
    voices: jest.fn().mockResolvedValue({ voices: [] }),
    synthesize: jest.fn().mockResolvedValue({
      ok: true,
      audio: Buffer.from('mp3'),
      mimeType: 'audio/mpeg',
      characters: 1,
    }),
  };
  const svc = new GreetingVideoService(
    sessions as any,
    plans as any,
    {
      record: jest.fn().mockResolvedValue(undefined),
      countToday: jest.fn().mockResolvedValue(0),
    } as any,
    { start: jest.fn((_id: string, v: unknown) => Promise.resolve(v)) } as any,
    {
      isConfigured: () => true,
      modelName: 'grok-imagine-video-1.5',
      startGeneration,
      getStatus: jest.fn().mockResolvedValue({ done: false }),
    } as any,
    {
      uploadBuffer: jest.fn((p: string) =>
        Promise.resolve({ url: `https://blob.test/${p}` }),
      ),
    } as any,
    { configured: () => true, submit: jest.fn(), status: jest.fn() } as any,
    {
      resolve: jest.fn().mockResolvedValue(tts),
      resolveByKey: jest.fn().mockReturnValue(tts),
    } as any,
    new RenderAccessService(
      { user: { findUnique: jest.fn().mockResolvedValue(null) } } as any,
      plans as any,
      credits as any,
    ),
    { onRenderCompleted: jest.fn().mockResolvedValue(undefined) } as any,
    credits as any,
    {
      persona: { findFirst: jest.fn().mockResolvedValue(null) },
      personaLook: { findFirst: jest.fn().mockResolvedValue(null) },
      userVoice: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any,
  );
  return { svc, startGeneration, credits };
}

describe('§8.1 перебор: проверка в startVideo', () => {
  let checked = 0;

  it.each(CASES.map((c) => [caseName(c), c] as const))(
    '%s × тон × наклейка × музыка × сцены',
    async (_name, c) => {
      const failures: string[] = [];
      for (const x of combos(c)) {
        checked++;
        const expected = expectedViolations(x);
        const { svc, startGeneration, credits } = videoService(
          snapshotOf(x) as any,
        );
        const r = await outcome(svc.startVideo('s1'));
        const where = comboName(x);
        if (expected.length === 0) {
          if (!r.ok) failures.push(`${where}: отказ ${messageOf(r.error)}`);
          else if (startGeneration.mock.calls.length !== 1) {
            failures.push(`${where}: провайдер не позван`);
          }
          continue;
        }
        if (r.ok || !(r.error instanceof BadRequestException)) {
          failures.push(`${where}: ждали 400 (${expected.join(', ')})`);
          continue;
        }
        const msg = messageOf(r.error);
        for (const f of Object.keys(FIELD_TEXT) as Field[]) {
          if (FIELD_TEXT[f].test(msg) !== expected.includes(f)) {
            failures.push(`${where}: правило ${f} в отказе «${msg}»`);
          }
        }
        // §8.1: отказ политики не стоит кредита и не зовёт провайдера.
        if (
          credits.reserveForGeneration.mock.calls.length ||
          credits.refundIfReserved.mock.calls.length ||
          startGeneration.mock.calls.length
        ) {
          failures.push(`${where}: отказ тронул кредит или провайдера`);
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it('перебрано 2880 + OTHER × 5 регистров × 120 = 3480 комбинаций', () => {
    expect(checked).toBe(2880 + 5 * 120);
  });
});

// ── Свои маршруты наклейки, сцен и музыки — только исход ─────────────────

function choiceSnapshot(c: Case) {
  return snapshotOf(
    { c, tone: oracleTones(c)[0], sticker: false, music: 'upload', scenes: 1 },
    oracleTones(c)[0],
  );
}

describe('§8.1 перебор: выбор наклейки (PUT /sessions/:id/greeting-sticker)', () => {
  it.each(CASES.map((c) => [caseName(c), c] as const))(
    '%s',
    async (_name, c) => {
      const { sessions, db } = sessionDoubles(choiceSnapshot(c));
      const Ctor = GreetingStickerService as any;
      const service = new Ctor(
        sessions,
        { uploadBuffer: jest.fn() },
        db,
      ) as GreetingStickerService;
      const r = await outcome(service.select('s1', 'цветы', '101', null));
      // Разрешённый выбор дальше упирается в «Pixabay не настроен» —
      // это не отказ политики; отказ политики — 400 с её текстом.
      const refusedByPolicy =
        !r.ok &&
        r.error instanceof BadRequestException &&
        FIELD_TEXT.sticker.test(messageOf(r.error));
      expect(refusedByPolicy).toBe(!ORACLE_RULES[oracleRegister(c)].stickers);
    },
  );
});

describe('§8.1 перебор: число сцен (PUT /sessions/:id/greeting-scenes)', () => {
  it.each(CASES.map((c) => [caseName(c), c] as const))(
    '%s × 1–4 сцены',
    async (_name, c) => {
      const max = ORACLE_RULES[oracleRegister(c)].maxScenes;
      for (let n = 1; n <= 4; n++) {
        const { sessions, db } = sessionDoubles(choiceSnapshot(c));
        const Ctor = GreetingScenesService as any;
        const service = new Ctor(sessions, db) as GreetingScenesService;
        const r = await outcome(service.setCount('s1', n));
        const kind = r.ok
          ? 'ok'
          : r.error instanceof BadRequestException &&
              FIELD_TEXT.sceneCount.test(messageOf(r.error))
            ? 'policy'
            : `other: ${messageOf(r.error)}`;
        expect({ n, kind }).toEqual({ n, kind: n > max ? 'policy' : 'ok' });
      }
    },
  );
});

describe('§8.1 перебор: тема каталога (PUT /sessions/:id/greeting-music)', () => {
  const catalogFor = (occasion: GreetingOccasion) =>
    JSON.stringify([
      {
        id: 'theme-own',
        title: 'Тема повода',
        url: 'https://blob.test/music/own.mp3',
        occasions: [occasion],
      },
      {
        id: 'theme-any',
        title: 'Общая тема',
        url: 'https://blob.test/music/any.mp3',
        occasions: null,
      },
    ]);

  it.each(CASES.map((c) => [caseName(c), c] as const))(
    '%s × {тема повода, общая тема}',
    async (_name, c) => {
      for (const [themeId, allowed] of [
        ['theme-own', true],
        ['theme-any', ORACLE_RULES[oracleRegister(c)].universalTheme],
      ] as const) {
        const { sessions, db } = sessionDoubles(choiceSnapshot(c));
        const Ctor = GreetingMusicService as any;
        const service = new Ctor(
          {
            get: jest.fn(async (k: string) =>
              k === GREETING_MUSIC_SETTING_KEY ? catalogFor(c.occasion) : null,
            ),
          },
          sessions,
          {},
          { enabled: false },
          db,
        ) as GreetingMusicService;
        const r = await outcome(service.select('s1', themeId));
        // Каталог отфильтрован по поводу и регистру: неподходящая тема
        // для маршрута просто не существует — 404, а не тихий выбор.
        const kind = r.ok
          ? 'ok'
          : r.error instanceof NotFoundException
            ? 'not-found'
            : `other: ${messageOf(r.error)}`;
        expect({ themeId, kind }).toEqual({
          themeId,
          kind: allowed ? 'ok' : 'not-found',
        });
      }
    },
  );
});

// ── §3.9: обстановка ролика (sceneSetting) — выбор, правка брифа, старт ──

/**
 * §3.9 ТЗ (фича №36): выбранная обстановка — правило ролика наравне с
 * наклейкой. Вне праздника праздничная обстановка не принимается ни
 * маршрутом выбора, ни у денег (`startVideo`), а правка брифа,
 * переводящая повод из праздника, сбрасывает её с перечнем.
 */
const ORACLE_FESTIVE: Record<GreetingRegister, boolean> = {
  CELEBRATORY: true,
  WARM_NEUTRAL: false,
  SOLEMN: false,
  SENSITIVE: false,
  MOURNING: false,
};
const SETTINGS = {
  festive: 'sunny garden party with balloons and a birthday cake',
  calm: 'quiet sunlit living room with a bookshelf and soft daylight',
} as const;
const SETTING_TEXT = /праздничной атрибутикой/;

function settingSnapshot(c: Case, setting: string | null) {
  // Белый список (аудит захода 8): выбрать можно только выданное сервером.
  const issuedAt = new Date().toISOString();
  return {
    ...choiceSnapshot(c),
    sceneSetting: setting,
    sceneSettingOptions: Object.values(SETTINGS).map((text) => ({
      text,
      issuedAt,
    })),
  };
}

/**
 * Вторая линия — словарь (аудит захода 8): обходы, которые раньше
 * проходили, и наши же спокойные варианты, которые раньше ложно
 * блокировались. Проверяется у денег (`startVideo`) — там, где обстановка
 * могла попасть в снимок мимо белого списка (старый снимок).
 */
const FESTIVE_TRICKS = [
  'a room with bаlloons',
  'bal\u200Bloons and con\u200Bfetti',
  'ｂａｌｌｏｏｎｓ everywhere',
  'birthday decorations and candles',
  'colorful garlands and bunting',
  'Christmas tree and ornaments',
  'New Year decor',
  'Geburtstagstorte und Sekt',
  'festlich geschmückter Raum',
  'decoración festiva',
  'cumpleaños con piñata',
  'день рождения, гирлянды и серпантин',
  'вечірка, свято',
  'хлопушки и гирлянды',
  'Торт со свечами',
  'no smoking, balloons everywhere',
];
const CALM_VARIANTS = [
  'Quiet sunlit garden at dusk, no balloons or confetti, soft warm light',
  'Calm, non-festive living room with soft daylight',
  'Memorial hall for a celebration of life, candles and white lilies',
  'Тихая непраздничная комната, мягкий свет',
  'Cozy room with a pastel color palette',
  'church interior, soft candlelight',
];

describe('§3.9 перебор: обстановка ролика (sceneSetting)', () => {
  const each = CASES.flatMap((c) =>
    (Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>).map(
      (kind) => [`${caseName(c)}/${kind}`, c, kind] as const,
    ),
  );

  it.each(each)(
    'выбор (PUT …/greeting-references/setting): %s',
    async (_n, c, kind) => {
      const { sessions, db } = sessionDoubles(settingSnapshot(c, null));
      const Ctor = GreetingReferenceService as any;
      const service = new Ctor(
        sessions,
        {},
        { generate: jest.fn() },
        {},
        { assertCanSpendSession: jest.fn() },
        db,
      ) as GreetingReferenceService;
      const r = await outcome(service.setSceneSetting('s1', SETTINGS[kind]));
      const refused = kind === 'festive' && !ORACLE_FESTIVE[oracleRegister(c)];
      const got = r.ok
        ? 'ok'
        : r.error instanceof BadRequestException &&
            SETTING_TEXT.test(messageOf(r.error))
          ? 'policy'
          : `other: ${messageOf(r.error)}`;
      expect({
        got,
        saved: r.ok ? r.value.sceneSetting : null,
      }).toEqual({
        got: refused ? 'policy' : 'ok',
        saved: refused ? null : SETTINGS[kind],
      });
    },
  );

  it.each(each)('у денег (startVideo): %s', async (_n, c, kind) => {
    const { svc, startGeneration, credits } = videoService(
      settingSnapshot(c, SETTINGS[kind]) as any,
    );
    const r = await outcome(svc.startVideo('s1'));
    const refused = kind === 'festive' && !ORACLE_FESTIVE[oracleRegister(c)];
    const message = r.ok ? null : messageOf((r as any).error);
    // Отказ политики не трогает кредит и провайдера; иначе обстановка
    // доходит до провайдера (§3.9).
    expect({
      refusedBySetting: message !== null && SETTING_TEXT.test(message),
      otherError: message !== null && !SETTING_TEXT.test(message),
      reserved: credits.reserveForGeneration.mock.calls.length > 0,
      providerCalls: startGeneration.mock.calls.length,
    }).toEqual({
      refusedBySetting: refused,
      otherError: false,
      reserved: !refused,
      providerCalls: refused ? 0 : 1,
    });
  });

  it.each(
    CASES.filter((c) => c.occasion !== 'OTHER' || c.register).map(
      (c) => [caseName(c), c] as const,
    ),
  )(
    'правка брифа сессии сбрасывает праздничную обстановку вне праздника: %s',
    async (_n, c) => {
      const service = sessionEditService(
        settingSnapshot(c, SETTINGS.festive) as any,
      );
      const r = await outcome(
        service.updateBrief('s1', { tone: oracleTones(c)[0] }),
      );
      expect(r.ok).toBe(true);
      const festive = ORACLE_FESTIVE[oracleRegister(c)];
      const value = (r as any).value;
      expect(value.resetFields.includes('sceneSetting')).toBe(!festive);
      expect(value.brief.sceneSetting).toBe(festive ? SETTINGS.festive : null);
    },
  );
});

describe('§3.9 перебор: словарь обстановки — обходы и ложные срабатывания (startVideo)', () => {
  const each = CASES.map((c) => [caseName(c), c] as const);

  it.each(each)('%s', async (_n, c) => {
    const festive = ORACLE_FESTIVE[oracleRegister(c)];
    const got: Record<string, boolean> = {};
    const want: Record<string, boolean> = {};
    for (const text of [...FESTIVE_TRICKS, ...CALM_VARIANTS]) {
      const { svc } = videoService({
        ...choiceSnapshot(c),
        sceneSetting: text,
      } as any);
      const r = await outcome(svc.startVideo('s1'));
      got[text] = !r.ok && SETTING_TEXT.test(messageOf((r as any).error));
      want[text] = !festive && FESTIVE_TRICKS.includes(text);
    }
    expect(got).toEqual(want);
  });
});

describe('аудит захода 8 перебор: подписи фото у денег (startVideo)', () => {
  const photo = (label: string, description: string | null = null) => ({
    id: 'gr_1',
    label,
    description,
    photoUrl: 'https://blob.test/sessions/s1/greeting-refs/gr_1/p.jpg',
    photoPathname: 'sessions/s1/greeting-refs/gr_1/p.jpg',
    hasFace: false,
  });

  it.each(CASES.map((c) => [caseName(c), c] as const))('%s', async (_n, c) => {
    const festive = ORACLE_FESTIVE[oracleRegister(c)];
    const run = async (img: unknown) => {
      const { svc, credits } = videoService(choiceSnapshot(c) as any, [img]);
      const r = await outcome(svc.startVideo('s1'));
      return {
        refused: !r.ok,
        reserved: credits.reserveForGeneration.mock.calls.length > 0,
      };
    };
    expect({
      festiveCaption: await run(photo('Фото', 'стол с тортом и шарами')),
      calmCaption: await run(photo('папа', 'у окна')),
      moderated: await run(photo('порнография')),
    }).toEqual({
      festiveCaption: { refused: !festive, reserved: festive },
      calmCaption: { refused: false, reserved: true },
      moderated: { refused: true, reserved: false },
    });
  });
});
