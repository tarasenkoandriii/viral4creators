import { BadRequestException } from '@nestjs/common';
import { AdminVoiceoverSettingsService } from './admin-voiceover-settings.service';
import { DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY } from '../tts/default-tts-provider';

function build(
  storedValue: string | null,
  elevenConfigured = true,
  resembleConfigured = false,
) {
  const store = new Map<string, string>();
  if (storedValue !== null)
    store.set(DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY, storedValue);
  const settings = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  const eleven = { configured: jest.fn(() => elevenConfigured) };
  const resemble = { configured: jest.fn(() => resembleConfigured) };
  const svc = new AdminVoiceoverSettingsService(
    settings as never,
    eleven as never,
    resemble as never,
  );
  return { svc, settings };
}

describe('AdminVoiceoverSettingsService', () => {
  it('ничего не задавалось — active из фоллбека, source "env-default"', async () => {
    const { svc } = build(null);
    const result = await svc.get();
    expect(result.active).toBe('elevenlabs');
    expect(result.source).toBe('env-default');
  });

  it('задано явно из админки — source "admin"', async () => {
    const { svc } = build('resemble');
    const result = await svc.get();
    expect(result.active).toBe('resemble');
    expect(result.source).toBe('admin');
  });

  it('витрина показывает готовность каждого провайдера — veo всегда true', async () => {
    const { svc } = build(null, true, false);
    const { options } = await svc.get();
    expect(options).toEqual([
      { key: 'elevenlabs', configured: true },
      { key: 'resemble', configured: false },
      { key: 'veo', configured: true },
    ]);
  });

  it('setDefault сохраняет валидное значение и возвращает обновлённую витрину', async () => {
    const { svc, settings } = build(null);
    const result = await svc.setDefault('veo', 'admin-1');
    expect(settings.set).toHaveBeenCalledWith(
      DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY,
      'veo',
      'admin-1',
    );
    expect(result.active).toBe('veo');
    expect(result.source).toBe('admin');
  });

  it('setDefault с неизвестным значением — 400, ничего не пишет', async () => {
    const { svc, settings } = build(null);
    await expect(svc.setDefault('cartesia', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(settings.set).not.toHaveBeenCalled();
  });
});
