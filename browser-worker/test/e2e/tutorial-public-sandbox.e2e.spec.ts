/** Explicit opt-in: synthetic form only; no paid providers or production data. */
import { BrowserPool } from '../../src/browser/pool';
import { createApiClient } from '../../src/api-client';
import { createLogger } from '../../src/logger';
import { Runner } from '../../src/runner';
import { runTutorialExplore } from '../../src/jobs/tutorial-explore';
import { exploreFillAad } from '../../src/shared/browser-job-protocol';
import {
  generateWorkerSealKeys,
  sealForWorker,
} from '../../src/shared/worker-seal';
import { FakeSites } from '../helpers/fake-sites';

const live = process.env.RUN_PUBLIC_SANDBOX === '1' ? describe : describe.skip;
live('public sandbox: isolated worker form batch', () => {
  it('accepts exactly one synthetic request with its required checkbox', async () => {
    const secret = 's'.repeat(48);
    const keys = generateWorkerSealKeys();
    const reply = generateWorkerSealKeys();
    const sites = await new FakeSites(secret).start();
    sites.sealPublicKey = keys.publicKey;
    const logger = createLogger('error', () => undefined);
    const pool = new BrowserPool({
      executablePath: process.env.BROWSER_WORKER_CHROMIUM_PATH ?? null,
      sandbox: process.env.WORKER_LIVE_CHROMIUM_SANDBOX === '1',
      rotateJobs: 10,
      rotateMs: 3600000,
      logger,
    });
    let status = '';
    let count = '';
    const runner = new Runner({
      api: createApiClient({
        baseUrl: sites.url,
        secret,
        workerId: 'sandbox-batch-check',
      }),
      pool,
      logger,
      kinds: ['tutorial-explore'],
      concurrency: 1,
      pollMs: 200,
      idlePollMaxMs: 400,
      heartbeatMs: 1000,
      shutdownGraceMs: 2000,
      sealPrivateKey: keys.privateKey,
      egress: { denyCidrs: [], allowedPorts: [80, 443], upstream: null },
      executors: {
        'tutorial-explore': async (ctx) => {
          const result = await runTutorialExplore(ctx);
          const page = ctx.jb.context.pages()[0];
          status = await page.locator('#form-status').innerText();
          count = await page.locator('#form-count').innerText();
          return result;
        },
      },
    });
    try {
      runner.start();
      const host = 'sandbox.viral4creators.app';
      const p = {
        url: `https://${host}/`,
        allowedOrigin: `https://${host}`,
        allowedHosts: [host],
        viewport: 'desktop',
        clicks: ['#request-form [name=consent]', '#request-form button'],
        fills: [] as { selector: string; value: string }[],
        replay: null,
        login: null,
        session: null,
        replyKey: reply.publicKey,
        nonce: 'sandbox-batch-check-000001',
        videoFrame: false,
      };
      p.fills = [
        ['#request-form [name=name]', 'QA Sandbox'],
        ['#request-form [name=email]', 'qa@example.test'],
        ['#request-form [name=message]', 'Synthetic browser worker batch test'],
      ].map(([selector, value], i) => ({
        selector,
        value: sealForWorker(
          keys.publicKey,
          Buffer.from(value),
          exploreFillAad(p, i),
        ),
      }));
      const job = await sites.waitDone(sites.add('tutorial-explore', p));
      expect(job.error).toBeNull();
      expect(status).toContain('Тестовая заявка принята');
      expect(count).toBe('Принято заявок в этой вкладке: 1');
    } finally {
      await runner.shutdown();
      await pool.close();
      await sites.stop();
    }
  });
});
