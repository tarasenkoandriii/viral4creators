/**
 * `descriptor-resolve` (Т-3, `assist-voice-map-check`): ТОЛЬКО разрешение
 * дескрипторов карты на образцах страниц — без кликов, без cookie, без
 * отправки форм (ТЗ §5-кватер.10). На каждую страницу: число совпадений
 * CSS-кандидатов каждой цели + снимок (сервер ищет цели без CSS тем же
 * `findInSnapshot`, что в бою). Сбой одной страницы — строка с кодом, не
 * отказ всего задания.
 */
import { collectSnapshot, countSelectors } from '../page/collect';
import {
  WORKER_LIMITS,
  type DescriptorResolveParams,
  type DescriptorResolveResult,
} from '../shared/browser-job-protocol';
import { JobError } from '../errors';
import type { JobContext } from './types';

export async function runDescriptorResolve(
  ctx: JobContext,
): Promise<DescriptorResolveResult> {
  const p = ctx.job.params as DescriptorResolveParams;
  const page = await ctx.jb.newPage();
  const pages: DescriptorResolveResult['pages'] = [];
  for (const url of p.pages) {
    if (ctx.signal.aborted) break;
    try {
      await ctx.jb.goto(page, url);
      const counts: Record<string, number[]> = {};
      for (const t of p.targets) {
        counts[t.key] = t.selectors.length
          ? await page.evaluate(countSelectors, t.selectors)
          : [];
      }
      const c = await page.evaluate(collectSnapshot, {
        elements: WORKER_LIMITS.snapshotElements,
        mapElements: 0,
        text: WORKER_LIMITS.textChars,
      });
      pages.push({
        url: c.url,
        ok: true,
        error: null,
        counts,
        snapshot: { url: c.url, title: c.title, elements: c.elements },
      });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      const code = e instanceof JobError ? e.code : 'nav_failed';
      const u = new URL(url);
      pages.push({
        url: `${u.origin}${u.pathname}`,
        ok: false,
        error: code,
        counts: {},
        snapshot: null,
      });
    }
  }
  return { pages };
}
