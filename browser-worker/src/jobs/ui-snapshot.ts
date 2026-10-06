/**
 * `ui-snapshot` (Э6-тер (е) «Снимок», Ш4): публичная страница verified-хоста
 * в ЧИСТОМ контексте — без cookie, без кликов, без отправки форм. Результат:
 * снимок интерактивных элементов с рамками (координаты видимой области),
 * элементы в форме общей карты Ш4 и скриншот видимой области (артефакт 0).
 */
import { collectSnapshot } from '../page/collect';
import {
  WORKER_LIMITS,
  type UiSnapshotParams,
  type UiSnapshotResult,
} from '../shared/browser-job-protocol';
import { viewportJpeg } from './screenshot';
import type { JobContext } from './types';

export async function runUiSnapshot(
  ctx: JobContext,
): Promise<UiSnapshotResult> {
  const p = ctx.job.params as UiSnapshotParams;
  const page = await ctx.jb.newPage();
  await ctx.jb.goto(page, p.url);
  const c = await page.evaluate(collectSnapshot, {
    elements: WORKER_LIMITS.snapshotElements,
    mapElements: WORKER_LIMITS.mapElements,
    text: WORKER_LIMITS.textChars,
  });
  let screenshot: number | null = null;
  if (p.screenshot) {
    const data = await viewportJpeg(page);
    await ctx.uploadArtifact({
      idx: 0,
      data,
      contentType: 'image/jpeg',
      width: c.viewport.width,
      height: c.viewport.height,
    });
    screenshot = 0;
  }
  return {
    finalUrl: c.url,
    snapshot: { url: c.url, title: c.title, elements: c.elements },
    mapElements: p.mapElements ? c.mapElements : [],
    screenshot,
    viewport: c.viewport,
    blockedRequests: ctx.jb.blocked(),
  };
}
