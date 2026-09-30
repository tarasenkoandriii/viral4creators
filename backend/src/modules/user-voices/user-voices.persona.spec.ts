/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));

import { head } from '@vercel/blob';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserVoicesService } from './user-voices.service';
import {
  PERSONA_VOICE_CONSENT_VERSION,
  personaVoiceConsentPhrase,
} from './persona-voice-consent';
import { SUPPORTED_LOCALES } from '../../common/locale';

/**
 * Голос персоны «Я в кадре» (ТЗ TZ-Greeting-2.0 §4.2, §4.6, В-1): один на
 * персону, вне лимита трёх клонов, фраза согласия — действующей редакции.
 */

const mockedHead = head as jest.MockedFunction<typeof head>;
const USER = 'u1';
const PERSONA = {
  id: 'p1',
  userId: USER,
  consentGivenAt: new Date('2026-09-01'),
  revokedAt: null,
  livenessCheckedAt: new Date('2026-09-01'),
  verifyResult: { status: 'ok' },
  ageMin: 30,
};

function build(
  over: {
    persona?: Record<string, unknown> | null;
    /** Сколько не-FAILED голосов уже у персоны / вне персоны. */
    personaVoices?: number;
    plainVoices?: number;
  } = {},
) {
  const persona =
    over.persona === null ? null : { ...PERSONA, ...(over.persona ?? {}) };
  const prisma: any = {
    persona: { findFirst: jest.fn().mockResolvedValue(persona) },
    userVoice: {
      create: jest.fn(),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => ({
        id: where.id,
        userId: USER,
        personaId: 'p1',
        label: 'Мой голос',
        status: 'TRAINING',
        resembleVoiceId: null,
        sampleUrl: 'https://blob.test/x.webm',
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      })),
      count: jest
        .fn()
        .mockImplementation(async ({ where }: any) =>
          where.personaId === null
            ? (over.plainVoices ?? 0)
            : where.personaId
              ? (over.personaVoices ?? 0)
              : (over.plainVoices ?? 0) + (over.personaVoices ?? 0),
        ),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: any) => unknown) =>
    fn(prisma),
  );
  const blob = {
    createUploadUrl: jest
      .fn()
      .mockResolvedValue({ uploadUrl: 'https://blob.test/put' }),
  };
  const plans = {
    assertUser: jest.fn().mockResolvedValue(undefined),
    assertCanSpendUser: jest.fn().mockResolvedValue(undefined),
  };
  const aiUsage = { record: jest.fn() };
  const resemble = {
    cloneVoice: jest
      .fn()
      .mockResolvedValue({ ok: true, resembleVoiceId: 'r-1' }),
  };
  const svc = new UserVoicesService(
    prisma,
    blob as never,
    plans as never,
    aiUsage as never,
    resemble as never,
  );
  return { svc, prisma, blob, plans, resemble };
}

const UPLOAD = {
  fileName: 'voice.webm',
  fileSize: 1000,
  mimeType: 'audio/webm',
  forPersona: true,
};
const CLONE = {
  pathname: `users/${USER}/voices/v1/sample.webm`,
  label: 'Мой голос',
  consent: true,
  forPersona: true,
  consentPhraseVersion: PERSONA_VOICE_CONSENT_VERSION,
};

describe('голос персоны: загрузка и клон', () => {
  const saved = process.env.PERSONA_ENABLED;
  beforeEach(() => {
    process.env.PERSONA_ENABLED = 'true';
    mockedHead.mockResolvedValue({ url: 'https://blob.test/x.webm' } as never);
  });
  afterAll(() => {
    process.env.PERSONA_ENABLED = saved;
  });

  it('вне лимита трёх клонов: три обычных голоса не мешают голосу персоны', async () => {
    const { svc, prisma, resemble } = build({ plainVoices: 3 });
    await expect(
      svc.createUploadUrl(USER, UPLOAD as never),
    ).resolves.toBeTruthy();
    const view = await svc.confirmClone(USER, CLONE as never);
    expect(prisma.userVoice.create.mock.calls[0][0].data).toMatchObject({
      personaId: 'p1',
      userId: USER,
      status: 'TRAINING',
    });
    expect(resemble.cloneVoice).toHaveBeenCalled();
    expect(view.personaId).toBe('p1');
  });

  it('обычный клон не видит голос персоны в своём лимите', async () => {
    const { svc, prisma } = build({ plainVoices: 2, personaVoices: 1 });
    await expect(
      svc.createUploadUrl(USER, { ...UPLOAD, forPersona: false } as never),
    ).resolves.toBeTruthy();
    expect(prisma.userVoice.count).toHaveBeenCalledWith({
      where: { userId: USER, personaId: null, status: { not: 'FAILED' } },
    });
    const { svc: full } = build({ plainVoices: 3, personaVoices: 0 });
    await expect(
      full.createUploadUrl(USER, { ...UPLOAD, forPersona: false } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('один голос на персону: второй — 409 и на загрузке, и на клоне', async () => {
    const { svc, blob, prisma, resemble } = build({ personaVoices: 1 });
    await expect(
      svc.createUploadUrl(USER, UPLOAD as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
    await expect(svc.confirmClone(USER, CLONE as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.userVoice.create).not.toHaveBeenCalled();
    expect(resemble.cloneVoice).not.toHaveBeenCalled();
    expect(prisma.userVoice.count).toHaveBeenCalledWith({
      where: { personaId: 'p1', status: { not: 'FAILED' } },
    });
  });

  it('фраза согласия не той редакции или без неё — 400 до Resemble', async () => {
    for (const consentPhraseVersion of [undefined, '2020-01-01', '']) {
      const { svc, resemble } = build();
      await expect(
        svc.confirmClone(USER, { ...CLONE, consentPhraseVersion } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(resemble.cloneVoice).not.toHaveBeenCalled();
    }
  });

  it('тарифный гейт В-1: тот же voiceCloning (Standard+)', async () => {
    const { svc, plans } = build();
    plans.assertUser.mockRejectedValue(new ForbiddenException('тариф'));
    await expect(
      svc.createUploadUrl(USER, UPLOAD as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.confirmClone(USER, CLONE as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(plans.assertUser).toHaveBeenCalledWith(USER, 'voiceCloning');
  });

  it('персоны нет / не проверена / режим выключен — отказ', async () => {
    await expect(
      build({ persona: null }).svc.createUploadUrl(USER, UPLOAD as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build({ persona: { livenessCheckedAt: null } }).svc.confirmClone(
        USER,
        CLONE as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    process.env.PERSONA_ENABLED = 'false';
    await expect(
      build().svc.createUploadUrl(USER, UPLOAD as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('фраза согласия голоса (§4.6)', () => {
  it('пять языков, у каждой есть {name}, версия общая', () => {
    const texts = new Set<string>();
    for (const locale of SUPPORTED_LOCALES) {
      const r = personaVoiceConsentPhrase(locale);
      expect(r.locale).toBe(locale);
      expect(r.version).toBe(PERSONA_VOICE_CONSENT_VERSION);
      expect(r.template).toContain('{name}');
      expect(r.text).toBeNull();
      texts.add(r.template);
    }
    expect(texts.size).toBe(SUPPORTED_LOCALES.length);
  });

  it('имя подставляется очищенным; неизвестная локаль — русский', () => {
    const r = personaVoiceConsentPhrase('fr', ' Анна {name}\n ');
    expect(r.locale).toBe('ru');
    expect(r.text).toBe(
      'Я, Анна name, разрешаю создать синтетическую копию моего голоса и использовать её только в моих роликах в этом сервисе.',
    );
    expect(personaVoiceConsentPhrase('en', 'x'.repeat(200)).text).toContain(
      `I, ${'x'.repeat(60)}, allow`,
    );
  });
});
