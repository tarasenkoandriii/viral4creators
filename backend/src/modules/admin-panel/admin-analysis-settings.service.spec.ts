import { BadRequestException } from '@nestjs/common';
import { AdminAnalysisSettingsService } from './admin-analysis-settings.service';
import { DEFAULT_ANALYSIS_PROVIDER_SETTING_KEY } from '../analysis/default-analysis-provider';

const loadConfigurationMock = jest.fn(() => ({ grok: { apiKey: '' } }));
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => loadConfigurationMock(),
}));

function build(storedValue: string | null) {
  const store = new Map<string, string>();
  if (storedValue !== null)
    store.set(DEFAULT_ANALYSIS_PROVIDER_SETTING_KEY, storedValue);
  const settings = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  const svc = new AdminAnalysisSettingsService(settings as never);
  return { svc, settings };
}

describe('AdminAnalysisSettingsService', () => {
  beforeEach(() => {
    loadConfigurationMock.mockReturnValue({ grok: { apiKey: '' } });
  });

  it('ничего не задавалось — active из фоллбека (gemini), source "env-default"', async () => {
    const { svc } = build(null);
    const result = await svc.get();
    expect(result.active).toBe('gemini');
    expect(result.source).toBe('env-default');
  });

  // Доп. запрос владельца продукта: сам разбор через Grok ещё не
  // реализован (§17.3 ТЗ) — пункт показывается, но недоступен для
  // выбора, независимо от того, задан ли GROK_API_KEY.
  it('grok — недоступен для выбора, даже если ключ настроен', async () => {
    loadConfigurationMock.mockReturnValue({ grok: { apiKey: 'sk-test' } });
    const { svc } = build(null);
    const { options } = await svc.get();
    const grok = options.find((o) => o.key === 'grok');
    expect(grok?.configured).toBe(true);
    expect(grok?.available).toBe(false);
    expect(grok?.unavailableReason).toBeTruthy();
  });

  it('gemini — всегда настроен и доступен', async () => {
    const { svc } = build(null);
    const { options } = await svc.get();
    const gemini = options.find((o) => o.key === 'gemini');
    expect(gemini).toEqual({
      key: 'gemini',
      configured: true,
      available: true,
    });
  });

  it('setDefault("gemini") — сохраняет и возвращает обновлённую витрину', async () => {
    const { svc, settings } = build(null);
    const result = await svc.setDefault('gemini', 'admin-1');
    expect(settings.set).toHaveBeenCalledWith(
      DEFAULT_ANALYSIS_PROVIDER_SETTING_KEY,
      'gemini',
      'admin-1',
    );
    expect(result.active).toBe('gemini');
    expect(result.source).toBe('admin');
  });

  it('setDefault("grok") — 400, ничего не пишет, даже если ключ настроен', async () => {
    loadConfigurationMock.mockReturnValue({ grok: { apiKey: 'sk-test' } });
    const { svc, settings } = build(null);
    await expect(svc.setDefault('grok', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('setDefault с неизвестным значением — 400, ничего не пишет', async () => {
    const { svc, settings } = build(null);
    await expect(svc.setDefault('claude', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(settings.set).not.toHaveBeenCalled();
  });
});
