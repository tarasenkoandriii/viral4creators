/**
 * `frames-capture` (кадры обучалки/генератора): публичная страница
 * подтверждённого хоста, кадры видимой области сверху вниз (шаг — 80%
 * высоты окна), без кликов и форм. Кадры — артефакты задания (приватный
 * Blob со сроком жизни); генератор получает их подписанными ссылками.
 */
import {
  VIEWPORT_SIZE,
  type FramesCaptureParams,
  type FramesCaptureResult,
} from '../shared/browser-job-protocol';
import { viewportJpeg } from './screenshot';
import type { JobContext } from './types';

export async function runFramesCapture(
  ctx: JobContext,
): Promise<FramesCaptureResult> {
  const p = ctx.job.params as FramesCaptureParams;
  const page = await ctx.jb.newPage();
  await ctx.jb.goto(page, p.url);
  const size = VIEWPORT_SIZE[p.viewport];
  const frames: FramesCaptureResult['frames'] = [];
  let y = 0;
  for (let i = 0; i < p.frames; i++) {
    if (ctx.signal.aborted) break;
    const data = await viewportJpeg(page);
    await ctx.uploadArtifact({
      idx: i,
      data,
      contentType: 'image/jpeg',
      width: size.width,
      height: size.height,
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
  const u = new URL(page.url());
  return { finalUrl: `${u.origin}${u.pathname}`, frames };
}
