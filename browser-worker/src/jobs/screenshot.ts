/**
 * Скриншот видимой области под потолок артефакта: JPEG, качество 70 → 50
 * → 35; не влез — `too_large` (страница-«бомба» не раздувает очередь).
 */
import type { Page } from 'playwright-core';
import { WORKER_LIMITS } from '../shared/browser-job-protocol';
import { JobError } from '../errors';

export async function viewportJpeg(page: Page): Promise<Buffer> {
  for (const quality of [70, 50, 35]) {
    const buf = await page.screenshot({
      type: 'jpeg',
      quality,
      fullPage: false,
      timeout: 15_000,
    });
    if (buf.length <= WORKER_LIMITS.artifactBytes) return buf;
  }
  throw new JobError('too_large');
}
