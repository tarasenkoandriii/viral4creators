/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import {
  VOICE_BUDGET_EXHAUSTED_MESSAGE,
  VOICE_LOGIN_REQUIRED_MESSAGE,
  voiceAnonymousCapMicroUsd,
  VOICE_DAILY_CAP_SETTING_KEYS,
  VOICE_OPERATIONS,
  isValidVoiceCapUsd,
  voiceCapMicroUsd,
  voiceVerdict,
} from './voice-budget';
import {
  VoiceBudgetExhaustedException,
  VoiceBudgetService,
  VoiceLoginRequiredException,
} from './voice-budget.service';

describe('voiceCapMicroUsd — потолок из настройки админки', () => {
  it('умолчания В-14: Lite $0.50, Standard $2, Premium $10', () => {
    expect(voiceCapMicroUsd('LITE', null)).toBe(500_000);
    expect(voiceCapMicroUsd('STANDARD', undefined)).toBe(2_000_000);
    expect(voiceCapMicroUsd('PREMIUM', '')).toBe(10_000_000);
  });

  it('значение оператора — в долларах', () => {
    expect(voiceCapMicroUsd('LITE', '1.25')).toBe(1_250_000);
    expect(voiceCapMicroUsd('PREMIUM', ' 3 ')).toBe(3_000_000);
  });

  it('ноль — законно: голос выключен для тарифа', () => {
    expect(voiceCapMicroUsd('STANDARD', '0')).toBe(0);
  });

  it('мусор и отрицательное — умолчание, а не ноль для всех', () => {
    expect(voiceCapMicroUsd('LITE', 'abc')).toBe(500_000);
    expect(voiceCapMicroUsd('LITE', '-1')).toBe(500_000);
    expect(voiceCapMicroUsd('LITE', 'Infinity')).toBe(500_000);
  });

  it('ключи настроек — те, что в контракте волны', () => {
    expect(VOICE_DAILY_CAP_SETTING_KEYS).toEqual({
      LITE: 'voice_daily_cap_lite',
      STANDARD: 'voice_daily_cap_standard',
      PREMIUM: 'voice_daily_cap_premium',
    });
  });

  it('проверка значения из админки: 0..1000 долларов, только число', () => {
    expect(isValidVoiceCapUsd(0)).toBe(true);
    expect(isValidVoiceCapUsd(1000)).toBe(true);
    expect(isValidVoiceCapUsd(1000.01)).toBe(false);
    expect(isValidVoiceCapUsd(-0.01)).toBe(false);
    expect(isValidVoiceCapUsd('2')).toBe(false);
    expect(isValidVoiceCapUsd(Number.NaN)).toBe(false);
  });
});

describe('voiceAnonymousCapMicroUsd — голос без входа', () => {
  it('умолчание 0 — выключен; оператор может открыть; мусор — умолчание', () => {
    expect(voiceAnonymousCapMicroUsd(null)).toBe(0);
    expect(voiceAnonymousCapMicroUsd('0.25')).toBe(250_000);
    expect(voiceAnonymousCapMicroUsd('abc')).toBe(0);
  });
});

describe('voiceVerdict — граница', () => {
  it('пускает, пока потолок не выбран целиком; ровно потолок — стоп', () => {
    expect(voiceVerdict(499_999, 500_000).exhausted).toBe(false);
    expect(voiceVerdict(500_000, 500_000).exhausted).toBe(true);
    expect(voiceVerdict(700_000, 500_000).exhausted).toBe(true);
  });

  it('потолок 0 — голос выключен сразу', () => {
    expect(voiceVerdict(0, 0).exhausted).toBe(true);
  });
});

function build(
  opts: {
    spendPlan?: string;
    stored?: string | null;
    spent?: number | null;
    settingsThrow?: boolean;
  } = {},
) {
  const prisma = {
    aiUsage: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { costMicroUsd: opts.spent ?? null } }),
    },
  };
  const plans = {
    accessOf: jest.fn().mockResolvedValue({
      plan: 'PREMIUM',
      spendPlan: opts.spendPlan ?? 'LITE',
    }),
  };
  const settings = {
    get: opts.settingsThrow
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest.fn().mockResolvedValue(opts.stored ?? null),
  };
  const service = new VoiceBudgetService(
    prisma as any,
    plans as any,
    settings as any,
  );
  return { service, prisma, plans, settings };
}

describe('VoiceBudgetService', () => {
  it('считает сумму ТРЁХ операций голоса пользователя с начала суток UTC', async () => {
    const { service, prisma } = build({ spent: 120_000 });
    const now = new Date('2026-09-29T23:59:59.999Z');
    const state = await service.stateOf('u1', now);
    expect(state).toEqual({
      capUsd: 0.5,
      spentUsd: 0.12,
      exhausted: false,
      loginRequired: false,
    });
    const where = prisma.aiUsage.aggregate.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.anonymous).toBeUndefined();
    expect(where.operation.in).toEqual([
      'voice-assistant-stt',
      'voice-assistant-understand',
      'voice-assistant-tts',
    ]);
    expect(VOICE_OPERATIONS).toHaveLength(3);
    // Граница суток — полночь UTC ТОГО ЖЕ дня, не скользящие 24 часа.
    expect(where.createdAt.gte.toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });

  it('новые сутки — новое окно', async () => {
    const { service, prisma } = build();
    await service.stateOf('u1', new Date('2026-09-30T00:00:00.000Z'));
    expect(
      prisma.aiUsage.aggregate.mock.calls[0][0].where.createdAt.gte.toISOString(),
    ).toBe('2026-09-30T00:00:00.000Z');
  });

  it('тариф — денежный (spendPlan), а не выбранный самим человеком', async () => {
    const { service, settings } = build({ spendPlan: 'STANDARD' });
    const state = await service.stateOf('u1');
    expect(settings.get).toHaveBeenCalledWith('voice_daily_cap_standard');
    expect(state.capUsd).toBe(2);
  });

  it('настройка оператора меняет потолок', async () => {
    const { service } = build({ stored: '0.1', spent: 100_000 });
    expect((await service.stateOf('u1')).exhausted).toBe(true);
  });

  it('настройка не прочиталась — умолчание, голос не выключается всем', async () => {
    const { service } = build({ settingsThrow: true, spent: 10 });
    expect(await service.stateOf('u1')).toMatchObject({
      capUsd: 0.5,
      exhausted: false,
    });
  });

  it('анонимный путь — общий расход анонимных, по флагу и своему потолку', async () => {
    const { service, prisma, settings, plans } = build({ stored: '0.3' });
    const state = await service.stateOf(null);
    const where = prisma.aiUsage.aggregate.mock.calls[0][0].where;
    expect(where.anonymous).toBe(true);
    expect(where.userId).toBeUndefined();
    expect(settings.get).toHaveBeenCalledWith('voice_daily_cap_anonymous');
    // Тариф анонимного пути не спрашивается: у него свой потолок.
    expect(plans.accessOf).not.toHaveBeenCalled();
    expect(state).toMatchObject({ capUsd: 0.3, loginRequired: false });
  });

  it('анонимный путь по умолчанию — голос выключен, «войдите», а не «до завтра»', async () => {
    const { service } = build();
    expect(await service.stateOf(null)).toMatchObject({
      capUsd: 0,
      exhausted: true,
      loginRequired: true,
    });
    const err = await service.assertCanSpendVoice(null).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceLoginRequiredException);
    expect(err).not.toBeInstanceOf(VoiceBudgetExhaustedException);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe(VOICE_LOGIN_REQUIRED_MESSAGE);
  });

  it('анонимный потолок, открытый оператором и выбранный, — обычное «исчерпан»', async () => {
    const { service } = build({ stored: '0.1', spent: 100_000 });
    const err = await service.assertCanSpendVoice(null).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceBudgetExhaustedException);
  });

  it('вошедший с потолком 0 — «исчерпан», не «войдите»', async () => {
    const { service } = build({ stored: '0' });
    const err = await service.assertCanSpendVoice('u1').catch((e) => e);
    expect(err).toBeInstanceOf(VoiceBudgetExhaustedException);
  });

  it('assertCanSpendVoice: исчерпан — 403 отдельным классом и понятным текстом', async () => {
    const { service } = build({ spent: 500_000 });
    const err = await service.assertCanSpendVoice('u1').catch((e) => e);
    expect(err).toBeInstanceOf(VoiceBudgetExhaustedException);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe(VOICE_BUDGET_EXHAUSTED_MESSAGE);
    expect(err.message).toMatch(/руками/);
  });

  it('assertCanSpendVoice: не исчерпан — проходит', async () => {
    const { service } = build({ spent: 499_999 });
    await expect(service.assertCanSpendVoice('u1')).resolves.toBeUndefined();
  });
});
