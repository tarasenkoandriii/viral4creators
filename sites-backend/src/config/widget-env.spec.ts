import { WIDGET_ORIGIN_DEFAULT } from '../brand';
import { MICRO_USD, WIDGET_DEFAULTS } from './assist-defaults';
import {
  TELEGRAM_WEB_ORIGINS,
  previewFrameAncestors,
  widgetEnvProblems,
  widgetIpSecret,
  widgetOrigin,
  widgetPlatformDailyCapMicroUsd,
  widgetPlatformEnabled,
  widgetTokenKey,
} from './widget-env';

describe('widget-env — переменные виджета Э2', () => {
  it('origin: только https-origin, иначе заглушка бренда', () => {
    expect(widgetOrigin({ ASSIST_WIDGET_ORIGIN: 'https://w.x.com/v1/' })).toBe(
      'https://w.x.com',
    );
    expect(widgetOrigin({ ASSIST_WIDGET_ORIGIN: 'http://w.x.com' })).toBe(
      WIDGET_ORIGIN_DEFAULT,
    );
    expect(widgetOrigin({})).toBe(WIDGET_ORIGIN_DEFAULT);
  });

  it('рубильник платформы: выключает только явное false', () => {
    expect(widgetPlatformEnabled({})).toBe(true);
    expect(widgetPlatformEnabled({ ASSIST_WIDGET_ENABLED: ' FALSE ' })).toBe(
      false,
    );
    expect(widgetPlatformEnabled({ ASSIST_WIDGET_ENABLED: 'no' })).toBe(true);
  });

  it('потолок платформы: мусор и минус — умолчание, не «без потолка»', () => {
    const d = WIDGET_DEFAULTS.platformDailyCapMicroUsdDefault;
    expect(widgetPlatformDailyCapMicroUsd({})).toBe(d);
    expect(
      widgetPlatformDailyCapMicroUsd({
        ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD: 'abc',
      }),
    ).toBe(d);
    expect(
      widgetPlatformDailyCapMicroUsd({
        ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD: '-1',
      }),
    ).toBe(d);
    expect(
      widgetPlatformDailyCapMicroUsd({
        ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD: '2.5',
      }),
    ).toBe(2.5 * MICRO_USD);
  });

  it('предпросмотр TMA: явный список важнее; иначе TMA, веб-кабинет и Telegram Web', () => {
    expect(
      previewFrameAncestors({
        ASSIST_PREVIEW_FRAME_ANCESTORS: 'https://a.com, javascript:alert(1)',
      }),
    ).toEqual(['https://a.com']);
    expect(
      previewFrameAncestors({
        ASSIST_TMA_URL: 'https://tma.x.com/#/sites',
        WEB_CABINET_ORIGINS: 'https://cab.x.com',
      }),
    ).toEqual([
      'https://tma.x.com',
      'https://cab.x.com',
      ...TELEGRAM_WEB_ORIGINS,
    ]);
  });

  it('ключи — производные от ASSIST_SECRETS_KEY, разные по назначению', () => {
    expect(widgetTokenKey({})).toBeNull();
    expect(widgetIpSecret({})).toBeNull();
    const env = { ASSIST_SECRETS_KEY: 'k' };
    const a = widgetTokenKey(env)!.toString('hex');
    expect(a).toHaveLength(64);
    expect(widgetIpSecret(env)).not.toBe(a);
  });

  it('проблемы конфигурации перечисляются', () => {
    expect(widgetEnvProblems({})).toHaveLength(2);
    expect(
      widgetEnvProblems({
        ASSIST_WIDGET_ORIGIN: 'https://w.x.com',
        ASSIST_SECRETS_KEY: 'k',
      }),
    ).toEqual([]);
  });
});
