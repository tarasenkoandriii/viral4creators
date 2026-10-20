/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../storage/blob.service', () => ({ BlobService: class {} }));
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../image-sketch/sketch-generator.service', () => ({
  SketchGeneratorService: class {},
}));

import {
  BadRequestException,
  HttpException,
  ValidationPipe,
} from '@nestjs/common';
import {
  CreateNarratorLookDto,
  NarratorImageConsentDto,
  RestyleNarratorLookDto,
} from './dto/narrator-looks.dto';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { createHash } from 'node:crypto';
import { NarratorLooksService } from './narrator-looks.service';
import { NarratorLooksController } from './narrator-looks.controller';
import { StoryDevelopmentGuard } from '../story-gifts/story-development.guard';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import {
  NARRATOR_IDENTITY_LINE,
  NARRATOR_LOOK_STALE_MS,
  STORY_PARENT_IMAGE_CONSENT_VERSION,
} from './narrator-looks.rules';

const png = (tag: string) =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(tag)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const ORIGINAL = png('original-photo');
const SKETCH_FILE = png('original-cartoon');
const PHOTO_URL = 'https://store.public.blob.vercel-storage.com/brand/c1.png';
const CONSENT_AT = new Date('2026-01-01T09:00:00Z');

function ok(tag: string) {
  return {
    status: 'ok' as const,
    bytes: png(tag),
    mimeType: 'image/png',
    model: 'gemini-3.1-flash-image',
    raw: { usageMetadata: { candidatesTokenCount: 1290 } },
  };
}

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const c = v as any;
      if ('in' in c) return c.in.includes(row[k]);
      if ('lt' in c) return row[k] < c.lt;
      if ('gte' in c) return row[k] >= c.gte;
      if ('not' in c) return row[k] !== c.not;
    }
    return (row[k] ?? null) === (v ?? null);
  });
}

interface Opts {
  consent?: boolean;
  revoked?: boolean;
  sketch?: null | { style: string; options?: any };
  photoUrl?: string | null;
  looks?: any[];
  outcomes?: any[];
  narratorCharacterId?: string | null;
}

function build(o: Opts = {}) {
  const manifests: Record<string, any> = {
    m1: {
      id: 'm1',
      userId: 'u1',
      narratorCharacterId:
        o.narratorCharacterId === undefined ? 'c1' : o.narratorCharacterId,
      narratorImageConsentAt: o.consent === false ? null : CONSENT_AT,
      narratorImageConsentVersion:
        o.consent === false ? null : STORY_PARENT_IMAGE_CONSENT_VERSION,
      narratorImageConsentRevokedAt: o.revoked ? new Date() : null,
      narratorLookId: null,
      narratorLookAsset: null,
    },
    m2: {
      id: 'm2',
      userId: 'u2',
      narratorCharacterId: 'c2',
      narratorImageConsentAt: CONSENT_AT,
      narratorImageConsentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
      narratorImageConsentRevokedAt: null,
      narratorLookId: null,
      narratorLookAsset: null,
    },
  };
  const character: any = {
    id: 'c1',
    brandManifestId: 'm1',
    label: 'Мама',
    photoUrl: o.photoUrl === undefined ? PHOTO_URL : o.photoUrl,
    originalDeletedAt: null,
    activeSketch: o.sketch
      ? {
          id: 's1',
          url: 'https://store.public.blob.vercel-storage.com/sketches/u1/s1.png',
          pathname: 'sketches/u1/s1.png',
          mimeType: 'image/png',
          style: o.sketch.style,
          options: o.sketch.options ?? {},
          appliedAt: new Date('2026-10-18'),
        }
      : null,
  };
  const characterBefore = JSON.stringify(character);
  const looks: any[] = (o.looks ?? []).map((l) => ({ ...l }));
  const calls: any[] = looks.map((l) => ({
    userId: l.userId,
    lookId: l.id,
    imageCalls: l.imageCalls,
    createdAt: l.createdAt,
  }));
  let seq = 0;
  const delegate = {
    findMany: jest.fn(async ({ where }: any) =>
      looks.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    ),
    findFirst: jest.fn(async ({ where, orderBy }: any) => {
      const found = looks.filter((r) => matches(r, where));
      if (orderBy?.createdAt === 'desc') found.reverse();
      return found[0] ? { ...found[0] } : null;
    }),
    create: jest.fn(async ({ data }: any) => {
      seq += 1;
      const row = {
        id: `look${seq}`,
        parentLookId: null,
        photo: null,
        photoMime: null,
        photoHash: null,
        styled: null,
        styledMime: null,
        styledHash: null,
        style: null,
        styleOptions: null,
        error: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      looks.push(row);
      return { id: row.id };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of looks) {
        if (matches(r, where)) {
          Object.assign(r, data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return { count };
    }),
  };
  const prisma: any = {
    brandManifest: {
      findFirst: jest.fn(async ({ where }: any) => {
        const m = manifests[where.id];
        return m && m.userId === where.userId ? { ...m } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const m = manifests[where.id];
        if (!m || !matches(m, where)) return { count: 0 };
        Object.assign(m, data);
        return { count: 1 };
      }),
    },
    brandCharacter: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === character.id &&
        where.brandManifestId === character.brandManifestId
          ? { ...character }
          : null,
      ),
    },
    storyNarratorLook: delegate,
    // ST2-S-02: quota ledger (seeded looks = migration backfill).
    storyNarratorLookCall: {
      findMany: jest.fn(async ({ where }: any) =>
        calls.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      create: jest.fn(async ({ data }: any) => {
        calls.push({ createdAt: new Date(), ...data });
        return { ...data };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = calls.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    $queryRaw: jest.fn(async () => [{ pg_advisory_xact_lock: '' }]),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const plans = { assertCanSpendUser: jest.fn(async () => undefined) };
  const aiUsage = { recordGemini: jest.fn(async () => undefined) };
  const blob = {
    downloadBuffer: jest.fn(async (p: string) =>
      p === 'sketches/u1/s1.png' ? SKETCH_FILE : ORIGINAL,
    ),
  };
  const outcomes = [...(o.outcomes ?? [])];
  const generator = {
    generate: jest.fn(
      async () => outcomes.shift() ?? ok(`gen${Math.random()}`),
    ),
  };
  const service = new NarratorLooksService(
    prisma,
    plans as any,
    aiUsage as any,
    blob as any,
    generator as any,
  );
  return {
    service,
    prisma,
    manifests,
    character,
    characterBefore,
    looks,
    calls,
    generator,
    aiUsage,
    plans,
    blob,
  };
}

const RESERVE_ONE = 156_000;
const RESERVE_TWO = 312_000;
const createDto = (over: any = {}) => ({
  outfit: 'cozy-home' as const,
  makeup: 'light' as const,
  maxReserveMicroUsd: RESERVE_TWO,
  ...over,
});

async function rejects(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    return e as HttpException;
  }
  throw new Error('expected rejection');
}
const bodyOf = (e: HttpException) => e.getResponse() as any;

describe('NarratorLooksService (WP5)', () => {
  it('маршруты закрыты: личность Telegram + только владелец Story', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      NarratorLooksController,
    );
    expect(guards).toEqual([TelegramIdentityGuard, StoryDevelopmentGuard]);
  });

  describe('создание варианта', () => {
    it('фото-режим: один вызов модели, защитный промпт, оригинал не тронут, вариант не активен', async () => {
      const t = build();
      const res = await t.service.create('u1', 'm1', createDto());
      expect(res.reused).toBe(false);
      expect(t.generator.generate).toHaveBeenCalledTimes(1);
      const call = (t.generator.generate.mock.calls[0] as any[])[0];
      expect(call.prompt).toContain(NARRATOR_IDENTITY_LINE);
      expect(call.prompt).toMatch(/cosy home clothes/);
      expect(call.source.bytes).toEqual(ORIGINAL);
      expect(call.model).toBe('gemini-3.1-flash-image');
      const row = t.looks[0];
      expect(row).toMatchObject({
        status: 'READY',
        styleStatus: 'NONE',
        style: null,
        sourceUrl: PHOTO_URL,
        sourceHash: sha(ORIGINAL),
        outfit: 'cozy-home',
        makeup: 'light',
        consentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
        consentAt: CONSENT_AT,
        imageCalls: 1,
        reservedMicroUsd: RESERVE_ONE,
      });
      expect(row.photoHash).toBe(sha(row.photo));
      expect(res.look).toMatchObject({ active: false, problem: null });
      expect(t.aiUsage.recordGemini).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'story-narrator-look',
          userId: 'u1',
        }),
      );
      expect(t.plans.assertCanSpendUser).toHaveBeenCalledWith('u1');
      // Оригинал и его скетч неизменны, активный образ — всё ещё оригинал.
      expect(JSON.stringify(t.character)).toBe(t.characterBefore);
      expect(t.manifests.m1.narratorLookId).toBeNull();
      const view = await t.service.view('u1', 'm1');
      expect(view.active).toMatchObject({ kind: 'original', mode: 'photo' });
      expect(view.items).toHaveLength(1);
      expect((view.items[0] as any).photo).toBeUndefined();
    });

    it('без согласия на синтетический образ — 409, модель не вызывается', async () => {
      for (const o of [{ consent: false }, { revoked: true }]) {
        const t = build(o);
        const e = await rejects(t.service.create('u1', 'm1', createDto()));
        expect(e.getStatus()).toBe(409);
        expect(bodyOf(e).code).toBe('NARRATOR_IMAGE_CONSENT_REQUIRED');
        expect(t.generator.generate).not.toHaveBeenCalled();
        expect(t.looks).toHaveLength(0);
      }
    });

    it('нет фото рассказчика или персонажа — 400 без вызова', async () => {
      const a = build({ photoUrl: null });
      expect(
        (await rejects(a.service.create('u1', 'm1', createDto()))).getStatus(),
      ).toBe(400);
      const b = build({ narratorCharacterId: null });
      expect(
        bodyOf(await rejects(b.service.create('u1', 'm1', createDto()))).code,
      ).toBe('NARRATOR_CHARACTER_REQUIRED');
      expect(a.generator.generate).not.toHaveBeenCalled();
    });

    it('цена выше показанной — 409, модель не вызывается', async () => {
      const t = build({ sketch: { style: 'cartoon' } });
      const e = await rejects(
        t.service.create(
          'u1',
          'm1',
          createDto({ maxReserveMicroUsd: RESERVE_ONE }),
        ),
      );
      expect(bodyOf(e)).toMatchObject({
        code: 'NARRATOR_LOOK_PRICE_CHANGED',
        price: { reserveMicroUsd: RESERVE_TWO },
      });
      expect(t.generator.generate).not.toHaveBeenCalled();
    });

    it('повтор того же запроса возвращает готовый вариант без оплаты; repeat — новый вызов', async () => {
      const t = build();
      const first = await t.service.create('u1', 'm1', createDto());
      const again = await t.service.create('u1', 'm1', createDto());
      expect(again).toMatchObject({
        reused: true,
        look: { id: first.look.id },
      });
      expect(t.generator.generate).toHaveBeenCalledTimes(1);
      const repeated = await t.service.create(
        'u1',
        'm1',
        createDto({ repeat: true }),
      );
      expect(repeated.reused).toBe(false);
      expect(t.generator.generate).toHaveBeenCalledTimes(2);
    });

    it('генерация уже в полёте — 409', async () => {
      const t = build({
        looks: [
          {
            id: 'busy',
            userId: 'u1',
            manifestId: 'm1',
            status: 'PENDING',
            styleStatus: 'NONE',
            imageCalls: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        ],
      });
      const e = await rejects(t.service.create('u1', 'm1', createDto()));
      expect(bodyOf(e).code).toBe('NARRATOR_LOOK_IN_PROGRESS');
      expect(t.generator.generate).not.toHaveBeenCalled();
    });
  });

  describe('сохранение режима скетча', () => {
    it('cartoon → смена одежды → активный образ всё ещё cartoon того же стиля', async () => {
      const t = build({
        sketch: { style: 'cartoon', options: { keepColors: false } },
        outcomes: [ok('outfit-photo'), ok('outfit-cartoon')],
      });
      const before = await t.service.view('u1', 'm1');
      expect(before.character).toMatchObject({
        mode: 'cartoon',
        sketchRendering: 'stylized',
      });
      expect(before.price.create?.reserveMicroUsd).toBe(RESERVE_TWO);

      const { look } = await t.service.create('u1', 'm1', createDto());
      expect(t.generator.generate).toHaveBeenCalledTimes(2);
      const stylize = (t.generator.generate.mock.calls[1] as any[])[0];
      // Тот же стиль применяется к НОВОМУ фото, а не к оригиналу.
      expect(stylize.source.bytes).toEqual(png('outfit-photo'));
      expect(stylize.prompt).toContain('storybook cartoon');
      expect(look).toMatchObject({
        status: 'READY',
        styleStatus: 'READY',
        style: 'cartoon',
        problem: null,
      });
      expect(t.looks[0].styleOptions).toEqual({
        anonymizeFace: true,
        keepColors: true,
        sketchRendering: 'stylized',
      });

      const applied = await t.service.apply('u1', 'm1', look.id);
      expect(applied.active).toMatchObject({
        kind: 'variant',
        lookId: look.id,
        asset: 'styled',
        mode: 'cartoon',
        problem: null,
        modeChanged: false,
      });
      const image = await t.service.resolveNarratorImage('m1', 'u1');
      expect(image).toMatchObject({
        kind: 'variant',
        asset: 'styled',
        style: 'cartoon',
        sketchRendering: 'stylized',
        consentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
        assetHash: sha(png('outfit-cartoon')),
        mimeType: 'image/png',
      });
      expect(image.bytes).toEqual(png('outfit-cartoon'));
      expect(JSON.stringify(t.character)).toBe(t.characterBefore);
    });

    it('стилизация не удалась — UNKNOWN без повтора, фото сохранено, перестилизация одним вызовом', async () => {
      const t = build({
        sketch: { style: 'watercolor' },
        outcomes: [
          ok('p'),
          { status: 'failed', reason: 'timeout', model: 'm' },
        ],
      });
      const e = await rejects(t.service.create('u1', 'm1', createDto()));
      expect(bodyOf(e).code).toBe('NARRATOR_LOOK_UNKNOWN');
      expect(t.generator.generate).toHaveBeenCalledTimes(2);
      expect(t.looks[0]).toMatchObject({
        status: 'UNKNOWN',
        styleStatus: 'UNKNOWN',
        imageCalls: 2,
      });
      expect(t.looks[0].photoHash).toBe(sha(png('p')));
      // A-S3-1: a non-READY variant is never applied or rendered, even when
      // its photo exists and the character is (back) in photo mode.
      const failedId = t.looks[0].id;
      expect(
        bodyOf(await rejects(t.service.apply('u1', 'm1', failedId))),
      ).toMatchObject({
        code: 'NARRATOR_LOOK_NOT_READY',
        problem: 'not-ready',
      });
      const sketch = t.character.activeSketch;
      t.character.activeSketch = null;
      expect(
        bodyOf(await rejects(t.service.apply('u1', 'm1', failedId))).code,
      ).toBe('NARRATOR_LOOK_NOT_READY');
      expect((await t.service.view('u1', 'm1')).items[0].problem).toBe(
        'not-ready',
      );
      // Pinned before the fix (legacy row): rendering refuses, no fallback.
      t.manifests.m1.narratorLookId = failedId;
      t.manifests.m1.narratorLookAsset = 'photo';
      expect(
        bodyOf(await rejects(t.service.resolveNarratorImage('m1', 'u1'))).code,
      ).toBe('NARRATOR_LOOK_NOT_READY');
      t.manifests.m1.narratorLookId = null;
      t.manifests.m1.narratorLookAsset = null;
      t.character.activeSketch = sketch;
      const restyled = await t.service.restyle('u1', 'm1', t.looks[0].id, {
        maxReserveMicroUsd: RESERVE_ONE,
      });
      expect(t.generator.generate).toHaveBeenCalledTimes(3);
      expect(restyled.look).toMatchObject({
        parentLookId: t.looks[0].id,
        style: 'watercolor',
        status: 'READY',
        imageCalls: 1,
        photoHash: sha(png('p')),
      });
    });

    it('режим сменился после генерации — применить нельзя (409), restyle делает нужный стиль', async () => {
      const t = build();
      const { look } = await t.service.create('u1', 'm1', createDto());
      t.character.activeSketch = {
        id: 's9',
        url: 'https://x/s9.png',
        pathname: 'sketches/u1/s9.png',
        mimeType: 'image/png',
        style: 'pencil',
        options: {},
        appliedAt: new Date(),
      };
      const e = await rejects(t.service.apply('u1', 'm1', look.id));
      expect(bodyOf(e)).toMatchObject({
        code: 'NARRATOR_LOOK_MODE_MISMATCH',
        problem: 'mode-mismatch',
      });
      const r = await t.service.restyle('u1', 'm1', look.id, {
        maxReserveMicroUsd: RESERVE_ONE,
      });
      const applied = await t.service.apply('u1', 'm1', r.look.id);
      expect(applied.active).toMatchObject({ asset: 'styled', mode: 'pencil' });
      // Одобренный ассет закреплён: персонаж ушёл в фото — образ остаётся pencil.
      t.character.activeSketch = null;
      const view = await t.service.view('u1', 'm1');
      expect(view.active).toMatchObject({ mode: 'pencil', modeChanged: true });
      expect((await t.service.resolveNarratorImage('m1', 'u1')).style).toBe(
        'pencil',
      );
    });
  });

  describe('откат, удаление, превью', () => {
    it('A-S3-10: превью — private, no-store, noindex; JSON ≤3 МиБ, крупное — 413 и бинарный /image/raw', async () => {
      const t = build();
      const { look } = await t.service.create('u1', 'm1', createDto());
      const controller = new NarratorLooksController(t.service);
      const req = { telegramUserId: 'u1' } as any;
      const headers: Record<string, string> = {};
      let sent: Buffer | null = null;
      const res: any = {
        set(k: string | Record<string, string>, v?: string) {
          Object.assign(headers, typeof k === 'string' ? { [k]: v } : k);
          return res;
        },
        send(b: Buffer) {
          sent = b;
          return res;
        },
      };
      const json = await controller.image(req, 'm1', look.id, 'photo', res);
      expect(headers).toMatchObject({
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      });
      expect(json).toEqual({
        base64: t.looks[0].photo.toString('base64'),
        mime: 'image/png',
        hash: look.photoHash,
      });
      // 3.5 MiB variant: JSON would be ≈4.7 MB (> Vercel 4.5 MB) → 413.
      const big = Buffer.concat([png('big'), Buffer.alloc(3.5 * 1024 * 1024)]);
      t.looks[0].photo = big;
      t.looks[0].photoHash = sha(big);
      const e = await rejects(
        controller.image(req, 'm1', look.id, 'photo', res),
      );
      expect(e.getStatus()).toBe(413);
      expect(bodyOf(e).code).toBe('NARRATOR_LOOK_IMAGE_TOO_LARGE');
      for (const k of Object.keys(headers)) delete headers[k];
      await controller.imageRaw(req, 'm1', look.id, 'photo', res);
      expect(sent).toEqual(big);
      expect(headers).toMatchObject({
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Content-Type': 'image/png',
        'X-Narrator-Look-Hash': sha(big),
      });
      // Foreign owner: 404 before any byte is sent.
      sent = null;
      const foreign = await rejects(
        controller.imageRaw(
          { telegramUserId: 'u2' } as any,
          'm1',
          look.id,
          'photo',
          res,
        ),
      );
      expect(foreign.getStatus()).toBe(404);
      expect(sent).toBeNull();
    });

    it('откат к оригиналу одним действием; варианты остаются', async () => {
      const t = build({ sketch: { style: 'cartoon' } });
      const { look } = await t.service.create('u1', 'm1', createDto());
      await t.service.apply('u1', 'm1', look.id);
      const view = await t.service.revert('u1', 'm1');
      expect(view.active).toMatchObject({ kind: 'original', lookId: null });
      expect(view.items).toHaveLength(1);
      const image = await t.service.resolveNarratorImage('m1', 'u1');
      expect(image).toMatchObject({
        kind: 'original',
        asset: 'sketch',
        style: 'cartoon',
        sketchRendering: 'stylized',
        assetHash: sha(SKETCH_FILE),
      });
      const photo = build();
      expect(
        await photo.service.resolveNarratorImage('m1', 'u1'),
      ).toMatchObject({
        kind: 'original',
        asset: 'original',
        style: 'photo',
        assetHash: sha(ORIGINAL),
      });
    });

    it('удаление активного варианта стирает байты и возвращает оригинал', async () => {
      const t = build();
      const { look } = await t.service.create('u1', 'm1', createDto());
      const preview = await t.service.image('u1', 'm1', look.id, 'photo');
      expect(Buffer.from(preview.base64, 'base64')).toEqual(t.looks[0].photo);
      expect(preview.hash).toBe(look.photoHash);
      await t.service.apply('u1', 'm1', look.id);
      const view = await t.service.remove('u1', 'm1', look.id);
      expect(view.active.kind).toBe('original');
      expect(view.items).toHaveLength(0);
      expect(t.looks[0]).toMatchObject({
        status: 'DELETED',
        photo: null,
        styled: null,
      });
      expect(
        (
          await rejects(t.service.image('u1', 'm1', look.id, 'photo'))
        ).getStatus(),
      ).toBe(404);
      expect(
        (
          await rejects(t.service.image('u1', 'm1', look.id, 'raw'))
        ).getStatus(),
      ).toBe(400);
    });
  });

  describe('согласие', () => {
    it('отзыв: варианты недоступны для новых рендеров, без молчаливой подмены', async () => {
      const t = build();
      const { look } = await t.service.create('u1', 'm1', createDto());
      await t.service.apply('u1', 'm1', look.id);
      const revoked = await t.service.revokeConsent('u1', 'm1');
      expect(revoked.consent.active).toBe(false);
      expect(revoked.active).toMatchObject({
        kind: 'variant',
        problem: 'consent',
      });
      const e = await rejects(t.service.resolveNarratorImage('m1', 'u1'));
      expect(bodyOf(e)).toMatchObject({
        code: 'NARRATOR_LOOK_CONSENT',
        problem: 'consent',
      });
      expect(
        bodyOf(
          await rejects(
            t.service.create('u1', 'm1', createDto({ repeat: true })),
          ),
        ).code,
      ).toBe('NARRATOR_IMAGE_CONSENT_REQUIRED');
      // Согласие заново — старые варианты всё равно закрыты.
      const again = await t.service.acceptConsent('u1', 'm1', {
        version: STORY_PARENT_IMAGE_CONSENT_VERSION,
        accepted: true,
      });
      expect(again.consent.active).toBe(true);
      expect(again.items[0].problem).toBe('consent');
      expect(
        bodyOf(await rejects(t.service.apply('u1', 'm1', look.id))).problem,
      ).toBe('consent');
    });

    it('принять согласие: только текущая версия; повтор не перевыпускает', async () => {
      const t = build({ consent: false });
      const e = await rejects(
        t.service.acceptConsent('u1', 'm1', {
          version: 'story-parent-voice-v1',
          accepted: true,
        }),
      );
      expect(e.getStatus()).toBe(400);
      await t.service.acceptConsent('u1', 'm1', {
        version: STORY_PARENT_IMAGE_CONSENT_VERSION,
        accepted: true,
      });
      const at = t.manifests.m1.narratorImageConsentAt;
      expect(at).toBeInstanceOf(Date);
      await t.service.acceptConsent('u1', 'm1', {
        version: STORY_PARENT_IMAGE_CONSENT_VERSION,
        accepted: true,
      });
      expect(t.manifests.m1.narratorImageConsentAt).toBe(at);
    });
  });

  describe('квота, резерв, неизвестный исход', () => {
    it('квота считает все начатые вызовы; не хватает на два — 429 до вызова и без брони', async () => {
      const t = build({
        sketch: { style: 'cartoon' },
        looks: [
          {
            id: 'old',
            userId: 'u1',
            manifestId: 'm1',
            status: 'UNKNOWN',
            styleStatus: 'NONE',
            configHash: 'x',
            imageCalls: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
          ...[1, 2, 3].map((i) => ({
            id: `del${i}`,
            userId: 'u1',
            manifestId: 'm1',
            status: 'DELETED',
            styleStatus: 'NONE',
            configHash: 'y',
            imageCalls: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: new Date(),
          })),
        ],
      });
      const e = await rejects(t.service.create('u1', 'm1', createDto()));
      expect(e.getStatus()).toBe(429);
      expect(bodyOf(e)).toMatchObject({
        code: 'NARRATOR_LOOK_QUOTA',
        quota: { dayUsed: 5, dayLimit: 6 },
      });
      expect(t.generator.generate).not.toHaveBeenCalled();
      expect(t.looks).toHaveLength(4);
    });

    it('нет ответа модели — UNKNOWN, без автоповтора и без записи расхода; повтор только явно', async () => {
      const t = build({
        outcomes: [{ status: 'failed', reason: 'socket hang up', model: 'm' }],
      });
      const e = await rejects(t.service.create('u1', 'm1', createDto()));
      expect(e.getStatus()).toBe(502);
      expect(bodyOf(e).code).toBe('NARRATOR_LOOK_UNKNOWN');
      expect(t.generator.generate).toHaveBeenCalledTimes(1);
      expect(t.aiUsage.recordGemini).not.toHaveBeenCalled();
      expect(t.looks[0]).toMatchObject({ status: 'UNKNOWN', imageCalls: 1 });
      const again = await rejects(t.service.create('u1', 'm1', createDto()));
      expect(bodyOf(again)).toMatchObject({
        code: 'NARRATOR_LOOK_REPEAT_REQUIRED',
        status: 'UNKNOWN',
      });
      expect(t.generator.generate).toHaveBeenCalledTimes(1);
      const view = await t.service.view('u1', 'm1');
      expect(view.quota.dayUsed).toBe(1);
    });

    it('отказ модели — FAILED, расход записан (вызов оплачен), 422', async () => {
      const t = build({
        sketch: { style: 'flat' },
        outcomes: [
          { status: 'refused', reason: 'SAFETY', model: 'm', raw: {} },
        ],
      });
      const e = await rejects(t.service.create('u1', 'm1', createDto()));
      expect(e.getStatus()).toBe(422);
      expect(t.aiUsage.recordGemini).toHaveBeenCalledTimes(1);
      expect(t.looks[0]).toMatchObject({
        status: 'FAILED',
        styleStatus: 'FAILED',
        imageCalls: 1,
      });
    });

    it('непригодный ответ модели — FAILED', async () => {
      const t = build({
        outcomes: [{ ...ok('x'), bytes: Buffer.from('GIF89a') }],
      });
      const e = await rejects(t.service.create('u1', 'm1', createDto()));
      expect(bodyOf(e).code).toBe('NARRATOR_LOOK_INVALID_IMAGE');
      expect(t.looks[0].status).toBe('FAILED');
    });

    it('сбой после брони (не модель) — UNKNOWN, а не вечный PENDING', async () => {
      const t = build();
      t.generator.generate.mockRejectedValueOnce(new Error('boom'));
      await expect(t.service.create('u1', 'm1', createDto())).rejects.toThrow(
        'boom',
      );
      expect(t.looks[0]).toMatchObject({ status: 'UNKNOWN', error: 'boom' });
    });

    it('зависшая бронь старше 10 минут становится UNKNOWN', async () => {
      const old = new Date(Date.now() - NARRATOR_LOOK_STALE_MS - 1000);
      const t = build({
        looks: [
          {
            id: 'stuck',
            userId: 'u1',
            manifestId: 'm1',
            characterId: 'c1',
            sourceUrl: PHOTO_URL,
            consentAt: CONSENT_AT,
            consentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
            outfit: 'casual',
            makeup: 'none',
            status: 'PENDING',
            styleStatus: 'PENDING',
            style: 'cartoon',
            imageCalls: 2,
            createdAt: old,
            updatedAt: old,
            deletedAt: null,
          },
        ],
      });
      const view = await t.service.view('u1', 'm1');
      expect(view.items[0]).toMatchObject({
        status: 'UNKNOWN',
        styleStatus: 'UNKNOWN',
      });
      expect(t.generator.generate).not.toHaveBeenCalled();
    });
  });

  describe('изоляция по владельцу', () => {
    it('чужой брендбук и чужой вариант — 404', async () => {
      const t = build();
      const { look } = await t.service.create('u1', 'm1', createDto());
      for (const p of [
        t.service.view('u2', 'm1'),
        t.service.create('u2', 'm1', createDto()),
        t.service.apply('u2', 'm1', look.id),
        t.service.image('u2', 'm1', look.id, 'photo'),
        t.service.remove('u2', 'm1', look.id),
        t.service.resolveNarratorImage('m1', 'u2'),
        t.service.acceptConsent('u2', 'm1', {
          version: STORY_PARENT_IMAGE_CONSENT_VERSION,
          accepted: true,
        }),
      ]) {
        expect((await rejects(p)).getStatus()).toBe(404);
      }
      // Вариант u1 под брендбуком u2 не находится.
      expect(
        (await rejects(t.service.apply('u2', 'm2', look.id))).getStatus(),
      ).toBe(404);
      expect(t.generator.generate).toHaveBeenCalledTimes(1);
    });

    it('фото рассказчика заменено — вариант устарел и не идёт в рендер', async () => {
      const t = build();
      const { look } = await t.service.create('u1', 'm1', createDto());
      await t.service.apply('u1', 'm1', look.id);
      t.character.photoUrl =
        'https://store.public.blob.vercel-storage.com/brand/new.png';
      const e = await rejects(t.service.resolveNarratorImage('m1', 'u1'));
      expect(bodyOf(e).problem).toBe('source-changed');
    });
  });

  describe('DTO под настройками глобального ValidationPipe', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const run = (m: any, v: unknown) =>
      pipe.transform(v, { type: 'body', metatype: m, data: '' });
    const bad = (m: any, v: unknown) =>
      expect(run(m, v)).rejects.toBeInstanceOf(BadRequestException);

    it('только коды пресетов и показанный резерв; путей и текста нет', async () => {
      await expect(
        run(CreateNarratorLookDto, createDto()),
      ).resolves.toBeDefined();
      await bad(CreateNarratorLookDto, createDto({ outfit: 'evening' }));
      await bad(CreateNarratorLookDto, createDto({ makeup: 'heavy' }));
      await bad(
        CreateNarratorLookDto,
        createDto({ prompt: 'make me younger' }),
      );
      await bad(CreateNarratorLookDto, createDto({ photoUrl: 'https://x' }));
      await bad(CreateNarratorLookDto, { outfit: 'casual', makeup: 'none' });
      await bad(RestyleNarratorLookDto, { maxReserveMicroUsd: -1 });
      // C-S2-2: the explicit repeat flag survives the global pipe.
      await expect(
        run(RestyleNarratorLookDto, { maxReserveMicroUsd: 1, repeat: true }),
      ).resolves.toMatchObject({ repeat: true });
      await bad(RestyleNarratorLookDto, {
        maxReserveMicroUsd: 1,
        repeat: 'yes',
      });
    });

    it('согласие — только текущая версия и явное true', async () => {
      await expect(
        run(NarratorImageConsentDto, {
          version: STORY_PARENT_IMAGE_CONSENT_VERSION,
          accepted: true,
        }),
      ).resolves.toBeDefined();
      await bad(NarratorImageConsentDto, {
        version: 'story-parent-voice-v1',
        accepted: true,
      });
      await bad(NarratorImageConsentDto, {
        version: STORY_PARENT_IMAGE_CONSENT_VERSION,
        accepted: 'yes',
      });
    });
  });
});

describe('Story-Tales pass 2 (ST2-S-02/04/07, ST2-R-01)', () => {
  it('ST2-S-02: удаление брендбука/вариантов не обнуляет квоту — журнал вызовов остаётся', async () => {
    const t = build();
    const presets: Array<[string, string]> = [
      ['casual', 'none'],
      ['cozy-home', 'none'],
      ['festive', 'none'],
      ['business', 'none'],
      ['winter', 'none'],
      ['casual', 'light'],
    ];
    for (const [outfit, makeup] of presets)
      await t.service.create('u1', 'm1', createDto({ outfit, makeup }));
    expect(t.generator.generate).toHaveBeenCalledTimes(6);
    // = BrandManifestService.remove(): the looks cascade away with the manifest.
    t.looks.splice(0, t.looks.length);
    const e = await rejects(
      t.service.create(
        'u1',
        'm1',
        createDto({ outfit: 'winter', makeup: 'light' }),
      ),
    );
    expect(e.getStatus()).toBe(429);
    expect(bodyOf(e)).toMatchObject({
      code: 'NARRATOR_LOOK_QUOTA',
      quota: { dayUsed: 6, dayLimit: 6 },
    });
    expect(t.generator.generate).toHaveBeenCalledTimes(6);
    expect(t.calls).toHaveLength(6);
    expect(t.calls.every((c: any) => c.userId === 'u1')).toBe(true);
  });

  it('ST2-S-04: отзыв согласия во время чтения фото — бронь его видит, модель не вызывается', async () => {
    const t = build();
    t.blob.downloadBuffer.mockImplementationOnce(async () => {
      await t.service.revokeConsent('u1', 'm1'); // concurrent DELETE …/consent
      return ORIGINAL;
    });
    const e = await rejects(t.service.create('u1', 'm1', createDto()));
    expect(e.getStatus()).toBe(409);
    expect(bodyOf(e).code).toBe('NARRATOR_IMAGE_CONSENT_REQUIRED');
    expect(t.generator.generate).not.toHaveBeenCalled();
    expect(t.looks).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
    // revokeConsent takes the same advisory lock as reserve().
    expect(
      t.prisma.$queryRaw.mock.calls.some((c: any[]) =>
        String(c[1]).startsWith('story-narrator-look:u1'),
      ),
    ).toBe(true);
  });

  it('ST2-S-04: отзыв между фото и стилизацией — второй вызов не начинается, квота держит один', async () => {
    const t = build({ sketch: { style: 'cartoon' } });
    t.generator.generate.mockImplementationOnce(async () => {
      await t.service.revokeConsent('u1', 'm1');
      return ok('photo-before-revoke');
    });
    const e = await rejects(t.service.create('u1', 'm1', createDto()));
    expect(e.getStatus()).toBe(409);
    expect(bodyOf(e).code).toBe('NARRATOR_IMAGE_CONSENT_REQUIRED');
    expect(t.generator.generate).toHaveBeenCalledTimes(1);
    expect(t.looks[0]).toMatchObject({
      status: 'FAILED',
      styleStatus: 'FAILED',
      imageCalls: 1,
    });
    expect(t.calls[0]).toMatchObject({ lookId: t.looks[0].id, imageCalls: 1 });
  });

  it('ST2-S-04: согласие проверяется прямо перед вызовом модели (после брони)', async () => {
    const t = build();
    const real = t.prisma.storyNarratorLook.create;
    t.prisma.storyNarratorLook.create = jest.fn(async (a: any) => {
      const r = await real(a);
      // Revoked right after the reservation, before the call (lock released).
      t.manifests.m1.narratorImageConsentRevokedAt = new Date();
      return r;
    });
    const e = await rejects(t.service.create('u1', 'm1', createDto()));
    expect(bodyOf(e).code).toBe('NARRATOR_IMAGE_CONSENT_REQUIRED');
    expect(t.generator.generate).not.toHaveBeenCalled();
    expect(t.looks[0]).toMatchObject({ status: 'FAILED', imageCalls: 0 });
    expect(t.calls[0]).toMatchObject({ imageCalls: 0 });
  });

  it('ST2-S-07: ответ модели больше 4 000 000 байт — FAILED (видео его не примет)', async () => {
    const big = Buffer.concat([png('big'), Buffer.alloc(4_000_001)]);
    const t = build({ outcomes: [{ ...ok('x'), bytes: big }] });
    const e = await rejects(t.service.create('u1', 'm1', createDto()));
    expect(bodyOf(e).code).toBe('NARRATOR_LOOK_INVALID_IMAGE');
    expect(t.looks[0]).toMatchObject({ status: 'FAILED', photo: null });
    expect(t.looks[0].error).toContain('4 000 000');
  });

  it('ST2-S-07: старый вариант > 4 000 000 байт не применяется (409 до любого рендера)', async () => {
    const t = build();
    await t.service.create('u1', 'm1', createDto());
    t.prisma.$queryRaw.mockResolvedValueOnce([
      { photo: 4_100_000, styled: null },
    ]);
    const e = await rejects(t.service.apply('u1', 'm1', t.looks[0].id));
    expect(e.getStatus()).toBe(409);
    expect(bodyOf(e).code).toBe('NARRATOR_LOOK_TOO_LARGE');
    expect(t.manifests.m1.narratorLookId).toBeNull();
    // Within the limit — applied.
    t.prisma.$queryRaw.mockResolvedValueOnce([
      { photo: 4_000_000, styled: null },
    ]);
    await t.service.apply('u1', 'm1', t.looks[0].id);
    expect(t.manifests.m1.narratorLookId).toBe(t.looks[0].id);
  });

  it('ST2-R-01: GET состояния образов — private, no-store и X-Robots-Tag', () => {
    const headers = Reflect.getMetadata(
      '__headers__',
      NarratorLooksController.prototype.view,
    );
    expect(headers).toEqual(
      expect.arrayContaining([
        { name: 'Cache-Control', value: 'private, no-store' },
        { name: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      ]),
    );
  });
});
