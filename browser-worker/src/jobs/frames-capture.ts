/**
 * `frames-capture` (кадры обучалки/генератора): публичная страница
 * подтверждённого хоста, кадры видимой области сверху вниз (шаг — 80%
 * высоты окна), без кликов и форм. Кадры — артефакты задания (приватный
 * Blob со сроком жизни); генератор получает их подписанными ссылками.
 *
 * Формат (`image`, Ш3-хвост (3)): `jpeg` (по умолчанию) — JPEG видимой
 * области; `png2x` — съёмочный кадр обучалки: PNG плотности 2 (CDP; у
 * контекста Playwright плотность задана при создании), тот же формат, что
 * снимает функция генератора (`VIDEO_FRAME_CONTENT_TYPE`). Кадр сверх
 * потолка артефакта — `too_large`.
 */
import type { CDPSession, Page } from 'playwright-core';
import {
  VIEWPORT_SIZE,
  WORKER_LIMITS,
  type FramesCaptureParams,
  type FramesCaptureResult,
} from '../shared/browser-job-protocol';
import { JobError } from '../errors';
import { viewportJpeg } from './screenshot';
import type { JobContext } from './types';

async function png2x(cdp: CDPSession): Promise<Buffer> {
  const shot = (await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })) as { data?: string };
  const buf = Buffer.from(shot.data ?? '', 'base64');
  if (buf.length === 0) throw new JobError('internal');
  if (buf.length > WORKER_LIMITS.artifactBytes) throw new JobError('too_large');
  return buf;
}

export async function runFramesCapture(
  ctx: JobContext,
): Promise<FramesCaptureResult> {
  const p = ctx.job.params as FramesCaptureParams;
  const page: Page = await ctx.jb.newPage();
  await ctx.jb.goto(page, p.url);
  const size = VIEWPORT_SIZE[p.viewport];
  const hi = p.image === 'png2x';
  let cdp: CDPSession | null = null;
  if (hi) {
    cdp = await ctx.jb.context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    // `srcset` выбирает кандидатов под новую плотность.
    await page
      .waitForLoadState('networkidle', { timeout: 3_000 })
      .catch(() => undefined);
  }
  const frames: FramesCaptureResult['frames'] = [];
  let y = 0;
  try {
    for (let i = 0; i < p.frames; i++) {
      if (ctx.signal.aborted) break;
      const data = cdp ? await png2x(cdp) : await viewportJpeg(page);
      await ctx.uploadArtifact({
        idx: i,
        data,
        contentType: hi ? 'image/png' : 'image/jpeg',
        width: hi ? size.width * 2 : size.width,
        height: hi ? size.height * 2 : size.height,
      });
      frames.push({ artifact: i, scrollY: y });
      const next = await page.evaluate(
        (step: number) => {
          const max = Math.max(
            document.documentElement.scrollHeight - innerHeight,
            0,
          );
          const to = Math.min(scrollY + step, max);
          if (to <= scrollY) return -1;
          scrollTo(0, to);
          return to;
        },
        Math.round(size.height * 0.8),
      );
      if (next < 0) break;
      y = Math.round(next);
      await page.waitForTimeout(300);
    }
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
  const u = new URL(page.url());
  return { finalUrl: `${u.origin}${u.pathname}`, frames };
}
