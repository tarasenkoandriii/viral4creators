/**
 * `ui-snapshot` (Э6-тер (е) «Снимок», Ш4): публичная страница verified-хоста
 * в ЧИСТОМ контексте — без cookie, без отправки форм. Результат: снимок
 * интерактивных элементов с рамками (координаты видимой области),
 * элементы в форме общей карты Ш4 и скриншот видимой области (артефакт 0).
 *
 * Ш3 (5), Р-З10-21: «раскрытия сразу» — до `params.toggles` (≤ 5)
 * раскрывашек (меню, вкладки, аккордеоны) ТОЛЬКО по стоп-листу
 * (`page/toggles.ts`, тот же, что у обхода «Админки»): опасная кнопка,
 * отправка формы, ссылка-действие — не нажимаются. Каждое раскрытие —
 * отдельное состояние: подпись раскрывашки, элементы, которых не было в
 * основном снимке, и скриншот (артефакты 1…). Раскрывашка увела со
 * страницы — назад, состояние не пишется. Элементы раскрытий дополняют
 * карту Ш4 (меню, которых обход без браузера не видит).
 */
import type { Page } from 'playwright-core';
import { collectSnapshot, collectToggles } from '../page/collect';
import { toggleKey, tryToggle } from '../page/toggles';
import {
  WORKER_LIMITS,
  type UiSnapshotParams,
  type UiSnapshotResult,
  type WorkerMapElement,
  type WorkerSnapElement,
  type WorkerSnapshotState,
} from '../shared/browser-job-protocol';
import { viewportJpeg } from './screenshot';
import type { JobContext } from './types';

const elementKey = (e: WorkerSnapElement) =>
  `${e.role}|${e.tag}|${e.text}|${e.hiddenLabel ?? ''}|${e.href ?? ''}|${e.assistId ?? ''}`;
const mapKey = (e: WorkerMapElement) =>
  `${e.tag}|${e.label}|${e.role ?? ''}|${e.assistId ?? ''}|${e.selector ?? ''}`;

type Limits = { elements: number; mapElements: number; text: number };

/** Раскрытия по стоп-листу; `takeArtifact` — номер скриншота или null. */
async function expand(
  ctx: JobContext,
  page: Page,
  p: UiSnapshotParams,
  limits: Limits,
  c: { elements: WorkerSnapElement[] },
  want: number,
  states: WorkerSnapshotState[],
  mapElements: WorkerMapElement[],
  takeArtifact: () => number | null,
): Promise<void> {
  const known = new Set(c.elements.map(elementKey));
  const knownMap = new Set(mapElements.map(mapKey));
  const tried = new Set<string>();
  // Попыток — с запасом на отказы стоп-листа, но конечно.
  for (let k = 0; k < want * 3 && states.length < want; k++) {
    if (ctx.signal.aborted) return;
    const next = (await page.evaluate(collectToggles, 20)).find(
      (t) => !tried.has(toggleKey(t)),
    );
    if (!next) return;
    tried.add(toggleKey(next));
    const out = await tryToggle(ctx.jb, page, next, p.allowedHosts, {
      noLinks: true,
    });
    if (out.kind === 'refused') {
      ctx.log.info('клик отклонён стоп-листом', {
        jobId: ctx.job.id,
        reason: out.reason,
      });
      continue;
    }
    // Не вернулись на страницу — с чужой ничего не собираем.
    if (out.kind === 'lost') return;
    if (out.kind !== 'clicked') continue;
    const s = await page.evaluate(collectSnapshot, limits);
    const fresh = s.elements
      .filter((e) => !known.has(elementKey(e)))
      .slice(0, WORKER_LIMITS.stateElements);
    for (const e of fresh) known.add(elementKey(e));
    if (p.mapElements) {
      for (const m of s.mapElements) {
        if (mapElements.length >= WORKER_LIMITS.mapElements) break;
        if (knownMap.has(mapKey(m))) continue;
        knownMap.add(mapKey(m));
        mapElements.push(m);
      }
    }
    let shot: number | null = null;
    const idx = takeArtifact();
    if (idx !== null) {
      const data = await viewportJpeg(page);
      await ctx.uploadArtifact({
        idx,
        data,
        contentType: 'image/jpeg',
        width: s.viewport.width,
        height: s.viewport.height,
      });
      shot = idx;
    }
    states.push({
      label: (next.text || next.hidden || '').slice(0, WORKER_LIMITS.textChars),
      elements: fresh,
      screenshot: shot,
    });
  }
}

export async function runUiSnapshot(
  ctx: JobContext,
): Promise<UiSnapshotResult> {
  const p = ctx.job.params as UiSnapshotParams;
  const page = await ctx.jb.newPage();
  await ctx.jb.goto(page, p.url);
  const limits = {
    elements: WORKER_LIMITS.snapshotElements,
    mapElements: WORKER_LIMITS.mapElements,
    text: WORKER_LIMITS.textChars,
  };
  const c = await page.evaluate(collectSnapshot, limits);
  let screenshot: number | null = null;
  let nextArtifact = 0;
  if (p.screenshot) {
    const data = await viewportJpeg(page);
    await ctx.uploadArtifact({
      idx: nextArtifact,
      data,
      contentType: 'image/jpeg',
      width: c.viewport.width,
      height: c.viewport.height,
    });
    screenshot = nextArtifact++;
  }
  const want = Math.min(p.toggles ?? 0, WORKER_LIMITS.snapshotToggles);
  const states: WorkerSnapshotState[] = [];
  const mapElements = p.mapElements ? [...c.mapElements] : [];
  if (want > 0) {
    // Аудит P3 (4): на время раскрытий — только чтение (кнопка-
    // «раскрывашка», которая на деле шлёт POST, ничего не изменит). Тот же
    // страж, что у обхода «Админки» (`safety/write-guard.ts`, Р-З11-Г2):
    // доказанное чтение GraphQL (меню на POST-запросе `query`) проходит,
    // мутации и прочая запись — обрыв.
    ctx.jb.setReadOnly(true);
    try {
      await expand(ctx, page, p, limits, c, want, states, mapElements, () =>
        p.screenshot && nextArtifact < WORKER_LIMITS.artifactsPerJob
          ? nextArtifact++
          : null,
      );
    } catch (e) {
      // Сбой шага раскрытий (страница ушла, контекст разрушен) не губит
      // снимок: отдаются основной снимок и уже собранные состояния.
      ctx.log.info('раскрытия прерваны', {
        jobId: ctx.job.id,
        code: e instanceof Error ? e.name : 'error',
      });
    } finally {
      ctx.jb.setReadOnly(false);
    }
  }
  return {
    finalUrl: c.url,
    snapshot: { url: c.url, title: c.title, elements: c.elements },
    mapElements,
    screenshot,
    viewport: c.viewport,
    blockedRequests: ctx.jb.blocked(),
    ...('toggles' in p ? { states } : {}),
  };
}
