/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
// Контроллер (ради его DTO) тянет сервисы с PrismaService — как в соседних спеках.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SetVoiceAssistantDto } from './admin-panel.controller';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import {
  AdminVoiceAssistantSettingsService,
  isStoredCap,
  isStoredVoice,
} from './admin-voice-assistant-settings.service';

function build(stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  const settings = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
  };
  const voiceover = {
    get: jest.fn().mockResolvedValue({
      options: [
        { key: 'elevenlabs', configured: false },
        { key: 'resemble', configured: true },
        { key: 'soniox', configured: true },
        { key: 'veo', configured: true },
      ],
    }),
  };
  return {
    svc: new AdminVoiceAssistantSettingsService(
      settings as any,
      voiceover as any,
    ),
    settings,
    store,
  };
}

describe('AdminVoiceAssistantSettingsService', () => {
  it('ничего не менялось — умолчания В-14 и голос по умолчанию', async () => {
    const { svc } = build();
    const v = await svc.view();
    expect(v.caps).toEqual({
      LITE: { usd: 0.5, defaultUsd: 0.5, source: 'default' },
      STANDARD: { usd: 2, defaultUsd: 2, source: 'default' },
      PREMIUM: { usd: 10, defaultUsd: 10, source: 'default' },
      // Сессии без владельца: голос по умолчанию выключен (аудит волны K).
      ANONYMOUS: { usd: 0, defaultUsd: 0, source: 'default' },
    });
    expect(v.voice).toEqual({
      provider: 'soniox',
      voiceId: null,
      source: 'default',
    });
    // `veo` — не голос: «не озвучивать» не может быть голосом помощника.
    expect(v.providers).toEqual([
      { key: 'elevenlabs', configured: false },
      { key: 'resemble', configured: true },
      { key: 'soniox', configured: true },
    ]);
  });

  it('запись — в ключи, которые читают потолок и озвучка советника', async () => {
    const { svc, settings } = build();
    const v = await svc.set(
      {
        caps: { LITE: 0.75, PREMIUM: 0 },
        voice: { provider: 'resemble', voiceId: ' v-1 ' },
      },
      'op-1',
    );
    expect(settings.set).toHaveBeenCalledWith(
      'voice_daily_cap_lite',
      '0.75',
      'op-1',
    );
    expect(settings.set).toHaveBeenCalledWith(
      'voice_daily_cap_premium',
      '0',
      'op-1',
    );
    expect(settings.set).toHaveBeenCalledWith(
      'voice_assistant_voice',
      '{"provider":"resemble","voiceId":"v-1"}',
      'op-1',
    );
    expect(v.caps.LITE).toMatchObject({ usd: 0.75, source: 'admin' });
    expect(v.caps.PREMIUM).toMatchObject({ usd: 0, source: 'admin' });
    expect(v.caps.STANDARD.source).toBe('default');
    expect(v.voice).toEqual({
      provider: 'resemble',
      voiceId: 'v-1',
      source: 'admin',
    });
  });

  it('потолок гостей — свой ключ, который читает потолок голоса', async () => {
    const { svc, settings } = build();
    const v = await svc.set({ caps: { ANONYMOUS: 0.2 } }, 'op');
    expect(settings.set).toHaveBeenCalledWith(
      'voice_daily_cap_anonymous',
      '0.2',
      'op',
    );
    expect(v.caps.ANONYMOUS).toMatchObject({ usd: 0.2, source: 'admin' });
  });

  it('не присланное не трогается; null у голоса — вернуть умолчание', async () => {
    const { svc, settings } = build({
      voice_assistant_voice: '{"provider":"resemble","voiceId":"x"}',
    });
    const v = await svc.set(
      { caps: { STANDARD: undefined }, voice: null },
      'op',
    );
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledWith(
      'voice_assistant_voice',
      '',
      'op',
    );
    expect(v.voice.source).toBe('default');
  });

  it('плохой ввод — отказ целиком, ничего не записано', async () => {
    const { svc, settings } = build();
    await expect(
      svc.set({ caps: { LITE: 1, STANDARD: -1 } }, 'op'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.set({ caps: { LITE: 1 }, voice: { provider: 'veo' } }, 'op'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.set({ caps: { GOLD: 1 } as any }, 'op'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('мусор в настройке показывается как умолчание — так его и читает потолок', () => {
    expect(isStoredCap('abc')).toBe(false);
    expect(isStoredCap('-1')).toBe(false);
    expect(isStoredCap('')).toBe(false);
    expect(isStoredCap('0')).toBe(true);
    expect(isStoredVoice('{oops')).toBe(false);
    expect(isStoredVoice('{"provider":"veo"}')).toBe(false);
    expect(isStoredVoice('{"provider":"soniox"}')).toBe(true);
  });
});

describe('SetVoiceAssistantDto под настоящими настройками ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const run = (value: unknown) =>
    pipe.transform(value, {
      type: 'body',
      metatype: SetVoiceAssistantDto,
      data: '',
    });

  it('принимает частичный ввод и null у голоса', async () => {
    await expect(run({ caps: { LITE: 0.5 } })).resolves.toBeDefined();
    await expect(run({ caps: { ANONYMOUS: 0 } })).resolves.toBeDefined();
    await expect(run({ voice: null })).resolves.toBeDefined();
    await expect(
      run({ voice: { provider: 'soniox', voiceId: null } }),
    ).resolves.toBeDefined();
  });

  it('отвергает отрицательное, строку вместо числа, veo и лишние поля', async () => {
    for (const bad of [
      { caps: { LITE: -1 } },
      { caps: { ANONYMOUS: -0.5 } },
      { caps: { LITE: 1001 } },
      { caps: { LITE: '1' } },
      { caps: { GOLD: 1 } },
      { voice: { provider: 'veo' } },
      { extra: 1 },
    ]) {
      await expect(run(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
