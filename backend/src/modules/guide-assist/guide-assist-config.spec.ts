import {
  GUIDE_JWT_DEFAULT_TTL_SEC,
  GUIDE_JWT_MAX_TTL_SEC,
  engineFor,
  normalizeAssistOrigin,
  readGuideAssistConfig,
  readGuideFactsConfig,
  resolveGuideEngine,
  type GuideAssistEnv,
} from './guide-assist-config';

const SECRET = 's'.repeat(40);
const FULL: GuideAssistEnv = {
  WIZARD_GUIDE_ENGINE: 'assist',
  WIZARD_GUIDE_ASSIST_SITE_ID: 'site_abc',
  WIZARD_GUIDE_ASSIST_PK: 'pk_live_abc123',
  WIZARD_GUIDE_ASSIST_ORIGIN: 'https://assist-wa.viral4creators.app',
  WIZARD_GUIDE_ASSIST_JWT_SECRET: SECRET,
};

describe('Ш6 — флаг гида (WIZARD_GUIDE_ENGINE)', () => {
  it('по умолчанию — старый гид, без жалоб', () => {
    const r = readGuideAssistConfig({});
    expect(r.config).toBeNull();
    expect(r.requested).toBe('legacy');
    expect(r.problems).toEqual([]);
  });

  it('legacy явно — старый гид даже при полной конфигурации', () => {
    const r = readGuideAssistConfig({ ...FULL, WIZARD_GUIDE_ENGINE: 'legacy' });
    expect(r.config).toBeNull();
  });

  it('неизвестное значение — старый гид с причиной', () => {
    const r = readGuideAssistConfig({ ...FULL, WIZARD_GUIDE_ENGINE: 'yes' });
    expect(r.config).toBeNull();
    expect(r.problems.join()).toMatch(/WIZARD_GUIDE_ENGINE/);
  });

  it('assist с полной конфигурацией — включён, ttl по умолчанию 10 мин', () => {
    const r = readGuideAssistConfig(FULL);
    expect(r.config).not.toBeNull();
    expect(r.config!.ttlSec).toBe(GUIDE_JWT_DEFAULT_TTL_SEC);
    expect(r.config!.role).toBe('creator');
    expect(r.config!.origin).toBe('https://assist-wa.viral4creators.app');
  });

  it.each([
    ['WIZARD_GUIDE_ASSIST_SITE_ID', ''],
    ['WIZARD_GUIDE_ASSIST_PK', 'sk_live_x'],
    ['WIZARD_GUIDE_ASSIST_ORIGIN', 'http://wa.example.com'],
    ['WIZARD_GUIDE_ASSIST_ORIGIN', 'https://wa.example.com/path'],
    ['WIZARD_GUIDE_ASSIST_JWT_SECRET', 'short'],
    ['WIZARD_GUIDE_ASSIST_ROLE', 'роль с пробелом'],
  ])('неполная конфигурация (%s=%s) — откат на старый гид', (k, v) => {
    const r = readGuideAssistConfig({ ...FULL, [k]: v });
    expect(r.config).toBeNull();
    expect(r.problems.join()).toContain(k);
  });

  it('pilot без списка — откат (иначе «Админка» не досталась бы никому молча)', () => {
    const r = readGuideAssistConfig({ ...FULL, WIZARD_GUIDE_ENGINE: 'pilot' });
    expect(r.config).toBeNull();
    expect(r.problems.join()).toMatch(/PILOT/);
  });

  it('срок JWT зажат в 60…900 с', () => {
    const ttl = (v: string) =>
      readGuideAssistConfig({ ...FULL, WIZARD_GUIDE_ASSIST_JWT_TTL_SEC: v })
        .config!.ttlSec;
    expect(ttl('3600')).toBe(GUIDE_JWT_MAX_TTL_SEC);
    expect(ttl('5')).toBe(60);
    expect(ttl('300')).toBe(300);
    expect(ttl('abc')).toBe(GUIDE_JWT_DEFAULT_TTL_SEC);
  });

  it('origin: localhost только с тестовым ключом', () => {
    expect(normalizeAssistOrigin('http://localhost:5199', 'pk_test_x')).toBe(
      'http://localhost:5199',
    );
    expect(normalizeAssistOrigin('http://localhost:5199', 'pk_live_x')).toBe(
      null,
    );
    expect(normalizeAssistOrigin('https://wa.x.app:8443', 'pk_live_x')).toBe(
      null,
    );
    expect(normalizeAssistOrigin('https://u:p@wa.x.app', 'pk_live_x')).toBe(
      null,
    );
  });
});

describe('Ш6 — чей гид (engineFor / resolveGuideEngine)', () => {
  const pilot = readGuideAssistConfig({
    ...FULL,
    WIZARD_GUIDE_ENGINE: 'pilot',
    WIZARD_GUIDE_ASSIST_PILOT: ' 777 , user_b ',
  }).config;

  it('аноним и выключенный флаг — старый гид', () => {
    expect(engineFor(null, { id: 'u', telegramId: '1' })).toBe('legacy');
    expect(engineFor(readGuideAssistConfig(FULL).config, null)).toBe('legacy');
  });

  it('pilot: по Telegram id и по id пользователя; остальные — старый', () => {
    expect(engineFor(pilot, { id: 'user_a', telegramId: '777' })).toBe(
      'assist',
    );
    expect(engineFor(pilot, { id: 'user_b', telegramId: '1' })).toBe('assist');
    expect(engineFor(pilot, { id: 'user_c', telegramId: '778' })).toBe(
      'legacy',
    );
  });

  it('assist: пользователя не читает (лишнего запроса нет)', async () => {
    const find = jest.fn();
    await expect(
      resolveGuideEngine(readGuideAssistConfig(FULL).config, 'u1', find),
    ).resolves.toBe('assist');
    expect(find).not.toHaveBeenCalled();
  });

  it('pilot: читает пользователя; нет такого — старый гид', async () => {
    await expect(
      resolveGuideEngine(pilot, 'ghost', async () => null),
    ).resolves.toBe('legacy');
    await expect(
      resolveGuideEngine(pilot, 'user_x', async () => ({
        id: 'user_x',
        telegramId: '777',
      })),
    ).resolves.toBe('assist');
  });
});

describe('Ш6 — ключи API фактов', () => {
  it('без ключа коннектора или секрета JWT — API выключен', () => {
    expect(readGuideFactsConfig({})).toBeNull();
    expect(
      readGuideFactsConfig({
        WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: 'k'.repeat(40),
      }),
    ).toBeNull();
  });

  it('один и тот же секрет на JWT и коннектор — отказ (разные назначения)', () => {
    expect(
      readGuideFactsConfig({
        WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: SECRET,
        WIZARD_GUIDE_ASSIST_JWT_SECRET: SECRET,
      }),
    ).toBeNull();
  });

  it('оба заданы и разные — включён (не зависит от флага гида)', () => {
    expect(
      readGuideFactsConfig({
        WIZARD_GUIDE_ENGINE: 'legacy',
        WIZARD_GUIDE_ASSIST_CONNECTOR_KEY: 'k'.repeat(40),
        WIZARD_GUIDE_ASSIST_JWT_SECRET: SECRET,
      }),
    ).not.toBeNull();
  });
});
