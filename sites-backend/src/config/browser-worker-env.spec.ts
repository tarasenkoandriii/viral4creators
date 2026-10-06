import {
  browserWorkerEnabled,
  validateBrowserWorkerEnv,
  workerSealPublicKey,
  workerSecretCollision,
} from './browser-worker-env';
import { generateWorkerSealKeys } from '../modules/browser-jobs/worker-seal';

describe('env браузерного воркера Ш3 (sites-backend)', () => {
  it('по умолчанию выключен — проверять нечего', () => {
    expect(browserWorkerEnabled({})).toBe(false);
    expect(validateBrowserWorkerEnv({})).toEqual([]);
    expect(browserWorkerEnabled({ BROWSER_WORKER_ENABLED: 'true' })).toBe(true);
    expect(browserWorkerEnabled({ BROWSER_WORKER_ENABLED: 'yes' })).toBe(false);
  });

  it('включён: свой секрет ≥ 32, не равный секретам других направлений; ключ конверта', () => {
    const same = 'z'.repeat(40);
    const problems = validateBrowserWorkerEnv({
      BROWSER_WORKER_ENABLED: 'true',
      SITES_WORKER_HMAC_SECRET: same,
      SITES_TUTORIAL_HMAC_SECRET: same,
    });
    expect(problems.join('\n')).toMatch(
      /совпадает с SITES_TUTORIAL_HMAC_SECRET/,
    );
    expect(problems.join('\n')).toMatch(/SITES_WORKER_SEAL_PUBLIC_KEY/);
    const k = generateWorkerSealKeys();
    expect(
      validateBrowserWorkerEnv({
        BROWSER_WORKER_ENABLED: 'true',
        SITES_WORKER_HMAC_SECRET: 'a'.repeat(40),
        SITES_WORKER_SEAL_PUBLIC_KEY: k.publicKey,
      }),
    ).toEqual([]);
    expect(
      workerSealPublicKey({ SITES_WORKER_SEAL_PUBLIC_KEY: 'short' }),
    ).toBeNull();
  });

  it.each(['CRON_SECRET', 'ASSIST_SECRETS_KEY', 'BLOB_READ_WRITE_TOKEN'])(
    'аудит Ш3: совпадение с %s — тоже проблема (не только секреты каналов)',
    (other) => {
      const same = 'q'.repeat(44);
      expect(
        validateBrowserWorkerEnv({
          BROWSER_WORKER_ENABLED: 'true',
          SITES_WORKER_HMAC_SECRET: same,
          [other]: same,
        }).join('\n'),
      ).toMatch(new RegExp(`совпадает с ${other}`));
    },
  );

  it('аудит Ш3: совпадение с любым ключом SITE_CREDENTIALS_KEYS (KEK учёток Ш2)', () => {
    const key = 'k'.repeat(44);
    expect(
      workerSecretCollision(
        { SITE_CREDENTIALS_KEYS: `v1:${'o'.repeat(44)}, v2:${key}` },
        key,
      ),
    ).toBe('SITE_CREDENTIALS_KEYS');
    expect(
      workerSecretCollision(
        { SITE_CREDENTIALS_KEYS: `v1:${'o'.repeat(44)}` },
        key,
      ),
    ).toBeNull();
  });
});
