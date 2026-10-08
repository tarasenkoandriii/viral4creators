/**
 * `knowledge-render` (Ш3 (20), Р-З10-20): страницы verified-хоста «Сайта»,
 * которые обычный обход нашёл пустой оболочкой SPA, — в ЧИСТОМ контексте
 * (без cookie, без кликов, без отправки форм), через тот же фильтр
 * исходящего трафика и потолки, что у остальных заданий. На страницу:
 * переход (замок хоста), ожидание текста (SPA дорисовывает данные после
 * `domcontentloaded`), «очищенный» HTML и ссылки своего хоста
 * (`page/render.ts`). Сбой одной страницы — её отказ кодом из закрытого
 * списка, остальные идут дальше; потолок трафика и остановка — задание
 * целиком (как у прочих).
 */
import type { Page } from 'playwright-core';
import { JobError } from '../errors';
import { collectRenderedHtml } from '../page/render';
import {
  WORKER_LIMITS,
  lockHostOf,
  type KnowledgeRenderParams,
  type KnowledgeRenderResult,
} from '../shared/browser-job-protocol';
import type { JobContext } from './types';

/** Сколько ждать, пока SPA нарисует текст (после затишья сети в `goto`). */
const TEXT_WAIT_MS = 8_000;
/** «Есть текст» — столько видимых символов в body. */
const TEXT_MIN_CHARS = 200;

/**
 * Запас стены времени на одну страницу: переход (≤ 25 с) + ожидание
 * текста + прокрутка. Меньше осталось — частичный результат (аудит P3 (3)):
 * не дошедшие страницы обход доведёт как раньше (`spa`).
 */
export const RENDER_PAGE_RESERVE_MS = 40_000;

/**
 * Потолок результата в БАЙТАХ UTF-8 (аудит P3 (1)): `renderHtmlChars` —
 * символы, а кириллица — 2 байта, U+2028 и U+FFFD — 3; сервер меряет байты
 * (`resultBytes`). Не влезает — сначала срезаются ссылки, потом HTML самых
 * длинных страниц.
 */
export const RENDER_RESULT_BUDGET = WORKER_LIMITS.resultBytes - 16 * 1024;

const bytesOf = (r: KnowledgeRenderResult) =>
  Buffer.byteLength(JSON.stringify(r), 'utf8');

/** Обрезать результат под байтовый потолок (на месте). */
export function fitRenderBudget(
  r: KnowledgeRenderResult,
  budget = RENDER_RESULT_BUDGET,
): KnowledgeRenderResult {
  for (let guard = 0; guard < 200 && bytesOf(r) > budget; guard++) {
    const withLinks = [...r.pages].reverse().find((p) => p.links.length);
    if (withLinks) {
      withLinks.links = withLinks.links.slice(
        0,
        Math.floor(withLinks.links.length / 2),
      );
      continue;
    }
    const big = [...r.pages]
      .filter((p) => p.html)
      .sort((a, b) => b.html!.length - a.html!.length)[0];
    if (!big) break;
    const over = bytesOf(r) - budget;
    // Байт на символ ≤ 3: срезаем с запасом.
    let cut = big.html!.slice(
      0,
      Math.max(0, big.html!.length - Math.ceil(over / 1.5) - 64),
    );
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    big.html = cut;
  }
  return r;
}

/** Коды отказа страницы, после которых остальные страницы не имеют смысла. */
const FATAL = new Set([
  'traffic_limit',
  'shutdown',
  'cancelled',
  'job_timeout',
]);

/**
 * Прокрутка до низа и обратно (аудит P2-3): анимации «появления при
 * прокрутке» и ленивые блоки дорисовываются; не дольше ~3 с.
 */
async function scrollThrough(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const step = Math.max(200, window.innerHeight);
      const end = Date.now() + 2_500;
      for (
        let y = 0;
        y < document.documentElement.scrollHeight && Date.now() < end;
        y += step
      ) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 400));
    })
    .catch(() => undefined);
}

async function waitForText(page: Page): Promise<void> {
  await page
    .waitForFunction(
      (min: number) =>
        ((document.body && document.body.innerText) || '').replace(/\s+/g, '')
          .length >= min,
      TEXT_MIN_CHARS,
      { timeout: TEXT_WAIT_MS, polling: 250 },
    )
    .catch(() => undefined);
}

export async function runKnowledgeRender(
  ctx: JobContext,
): Promise<KnowledgeRenderResult> {
  const p = ctx.job.params as KnowledgeRenderParams;
  const page = await ctx.jb.newPage();
  const pages: KnowledgeRenderResult['pages'] = [];
  const deadline = Date.now() + ctx.job.wallMs;
  for (let i = 0; i < p.urls.length; i++) {
    if (ctx.signal.aborted) throw new JobError('cancelled');
    // Стена близко — отдать готовое (частичный результат), а не потерять всё.
    if (pages.length && deadline - Date.now() < RENDER_PAGE_RESERVE_MS) break;
    try {
      await ctx.jb.goto(page, p.urls[i]);
      await waitForText(page);
      await scrollThrough(page);
      const r = await page.evaluate(collectRenderedHtml, {
        htmlChars: WORKER_LIMITS.renderHtmlChars,
        links: WORKER_LIMITS.renderLinks,
      });
      // Ссылки — только хост замка (самопроверка до разбора протоколом).
      const links = r.links.filter((l) => {
        try {
          const u = new URL(l);
          return (
            (u.protocol === 'https:' || u.protocol === 'http:') &&
            p.allowedHosts.includes(lockHostOf(u))
          );
        } catch {
          return false;
        }
      });
      pages.push({ i, ok: true, error: null, html: r.html, links });
    } catch (e) {
      if (!(e instanceof JobError)) throw e;
      if (FATAL.has(e.code)) throw e;
      pages.push({ i, ok: false, error: e.code, html: null, links: [] });
      ctx.log.info('страница рендера не открылась', {
        jobId: ctx.job.id,
        code: e.code,
      });
    }
  }
  return fitRenderBudget({ pages });
}
