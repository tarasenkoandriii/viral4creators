import { loadConfiguration, validateConfiguration } from './configuration';

describe('configuration', () => {
  it('CORS_ORIGIN — список через запятую, пустые элементы выброшены', () => {
    const c = loadConfiguration({
      CORS_ORIGIN: 'https://a.example, *.vercel.app,,',
    } as NodeJS.ProcessEnv);
    expect(c.corsOrigins).toEqual(['https://a.example', '*.vercel.app']);
  });

  it('адреса веб-кабинета (WEB_CABINET_ORIGINS) добавляются в CORS — иначе POST кабинета падал бы на CORS до гварда', () => {
    const c = loadConfiguration({
      CORS_ORIGIN: 'https://a.example',
      WEB_CABINET_ORIGINS: 'https://cab.example/, https://cab2.example',
    } as NodeJS.ProcessEnv);
    expect(c.corsOrigins).toEqual([
      'https://a.example',
      'https://cab.example',
      'https://cab2.example',
    ]);
  });

  it('умолчания для локального запуска', () => {
    const c = loadConfiguration({} as NodeJS.ProcessEnv);
    expect(c.port).toBe(3100);
    expect(c.nodeEnv).toBe('development');
    expect(c.databaseUrl).toBeUndefined();
  });

  it('в проде без SITES_DATABASE_URL — отказ на старте', () => {
    const c = loadConfiguration({
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect(() => validateConfiguration(c)).toThrow(/SITES_DATABASE_URL/);
  });

  it('в разработке без базы стартовать можно', () => {
    const c = loadConfiguration({} as NodeJS.ProcessEnv);
    expect(() => validateConfiguration(c)).not.toThrow();
  });

  it('нечисловой PORT — отказ', () => {
    const c = loadConfiguration({ PORT: 'abc' } as NodeJS.ProcessEnv);
    expect(() => validateConfiguration(c)).toThrow(/PORT/);
  });
});
