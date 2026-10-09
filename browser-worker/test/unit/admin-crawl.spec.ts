import { runAdminCrawl } from '../../src/jobs/admin-crawl';
import type { JobContext, JobCredentials } from '../../src/jobs/types';
import { createLogger, liveSecretCount } from '../../src/logger';
import { SecretBox } from '../../src/secret-box';

/**
 * Аудит Ш3: секреты учётки затираются, даже если браузер упал раньше входа
 * (на `newPage`) — раньше SecretBox оставался жить до перезапуска процесса.
 */
describe('admin-crawl: затирание секретов при сбое браузера', () => {
  it('newPage упал — пароль и cookie затёрты, живых секретов нет', async () => {
    const password = new SecretBox(['Pw', 'unit', 'marker'].join('-'));
    const cookies = new SecretBox('[{"name":"sid","value":"x"}]');
    const creds: JobCredentials = {
      username: 'manager',
      password,
      cookies,
      wipe() {
        password.wipe();
        cookies.wipe();
      },
    };
    const order: string[] = [];
    const ctx = {
      job: {
        id: 'job-1',
        kind: 'admin-crawl',
        attempt: 1,
        leaseToken: 't'.repeat(43),
        leaseUntil: new Date().toISOString(),
        wallMs: 1000,
        needsCredentials: true,
        params: {
          startUrl: 'https://admin.shop.test/admin',
          allowedHosts: ['admin.shop.test'],
          viewport: 'desktop',
          maxPages: 1,
          maxDepth: 0,
          loginMethod: 'password',
        },
      },
      jb: {
        sessionReadOnly: () => {
          order.push('read-only');
          return Promise.resolve();
        },
        newPage: () => {
          order.push('newPage');
          return Promise.reject(
            new Error('Target page, context or browser closed'),
          );
        },
      },
      signal: new AbortController().signal,
      log: createLogger('error', () => undefined),
      uploadArtifact: () => Promise.resolve(),
      credentials: () => Promise.resolve(creds),
    } as unknown as JobContext;
    expect(liveSecretCount()).toBe(2);
    await expect(runAdminCrawl(ctx)).rejects.toThrow(/closed/);
    expect(password.wiped).toBe(true);
    expect(cookies.wiped).toBe(true);
    expect(liveSecretCount()).toBe(0);
    // Р-З11-Г1: «только чтение» включается ДО первой страницы.
    expect(order).toEqual(['read-only', 'newPage']);
  });
});
