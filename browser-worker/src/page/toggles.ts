/**
 * Раскрывашки (меню, вкладки, аккордеоны) — общий шаг обхода «Админки» и
 * «Снимка» (Ш3 (5), Р-З10-21). Клик — ТОЛЬКО по стоп-листу
 * (`safety/click-guard.ts`): не в форме и не отправка, с видимым именем, ни
 * одной категории словаря действий; раскрывашка-ссылка — по правилам
 * ссылок обхода. Нажимается ровно тот элемент, который проверен: берётся
 * тем же `querySelectorAll`, что в сборе, и проверяется ЕЩЁ РАЗ по живому
 * тексту прямо перед кликом (страница могла подменить подпись). Увела со
 * страницы — не раскрывашка: назад.
 */
import type { Page } from 'playwright-core';
import type { JobBrowser } from '../browser/context';
import {
  clickRefusal,
  toggleLinkRefusal,
  type ClickRefusal,
  type LinkRefusal,
} from '../safety/click-guard';

/** Тот же селектор, что у `collectInterface`/`collectToggles` (page/collect.ts). */
export const TOGGLE_SELECTOR =
  '[aria-expanded="false"],summary,[role="tab"][aria-selected="false"]';

export interface ToggleCandidate {
  idx: number;
  text: string;
  hidden: string | null;
  submit: boolean;
  inForm: boolean;
}

export type ToggleOutcome =
  | { kind: 'refused'; reason: ClickRefusal | LinkRefusal | 'navigation' }
  | { kind: 'missing' }
  | { kind: 'clicked' }
  | { kind: 'navigated' }
  /**
   * Клик увёл со страницы, и вернуться не удалось (`goto` назад упал):
   * раскрытия прекратить, с этой (чужой) страницы ничего не собирать.
   */
  | { kind: 'lost' };

export interface ToggleOptions {
  /**
   * «Снимок» (аудит пакета Д, P1-1): раскрывашка-ССЫЛКА на другую страницу
   * (href без одного якоря, не равный текущему адресу) — не нажимается
   * вовсе: это переход, а не раскрытие.
   */
  noLinks?: boolean;
}

/** Сколько ждать загрузки чужой страницы, на которую увёл клик. */
const NAV_SETTLE_MS = 10_000;

const urlKey = (u: string) => {
  const x = new URL(u);
  x.hash = '';
  return x.toString();
};

/** Ключ кандидата: одну и ту же раскрывашку дважды не пробуем. */
export const toggleKey = (t: ToggleCandidate) => `${t.text}|${t.hidden}`;

export async function tryToggle(
  jb: Pick<JobBrowser, 'goto'>,
  page: Page,
  t: ToggleCandidate,
  allowedHosts: readonly string[],
  opts: ToggleOptions = {},
): Promise<ToggleOutcome> {
  const first = clickRefusal(t);
  if (first) return { kind: 'refused', reason: first };
  const handle = await page.evaluateHandle(
    (a: { sel: string; idx: number }) =>
      document.querySelectorAll(a.sel)[a.idx] ?? null,
    { sel: TOGGLE_SELECTOR, idx: t.idx },
  );
  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return { kind: 'missing' };
  }
  const fresh = await el.evaluate((e) => {
    const form = (e as HTMLButtonElement).form || e.closest('form');
    const a = e.closest('a[href]') as HTMLAnchorElement | null;
    return {
      text: ((e as HTMLElement).innerText || '').trim(),
      hidden: e.getAttribute('aria-label') || e.getAttribute('title'),
      href: a ? a.href : null,
      inForm: !!form,
      submit:
        !!form &&
        e.tagName === 'BUTTON' &&
        ((e as HTMLButtonElement).type || 'submit') === 'submit',
    };
  });
  const again =
    clickRefusal(fresh) ??
    toggleLinkRefusal(fresh.href, page.url(), fresh.text, allowedHosts);
  if (again) {
    await el.dispose();
    return { kind: 'refused', reason: again };
  }
  const before = page.url();
  if (opts.noLinks && fresh.href && leavesPage(fresh.href, before)) {
    await el.dispose();
    return { kind: 'refused', reason: 'navigation' };
  }
  // Переход главного фрейма в окне клика (ссылка, `location.href=` в
  // обработчике) ловится по запросу, а не только по адресу: медленная
  // страница (> окна ожидания) ещё не сменила `page.url()`, а следующий
  // `evaluate` упал бы «Execution context was destroyed» (аудит P1-1).
  let navigating = false;
  const onRequest = (r: import('playwright-core').Request) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame())
      navigating = true;
  };
  page.on('request', onRequest);
  try {
    await el
      .click({ timeout: 3_000, noWaitAfter: true })
      .catch(() => undefined);
    await el.dispose().catch(() => undefined);
    await page.waitForTimeout(250);
  } finally {
    page.off('request', onRequest);
  }
  let moved = navigating;
  try {
    moved = moved || urlKey(page.url()) !== urlKey(before);
  } catch {
    moved = true;
  }
  if (!moved) return { kind: 'clicked' };
  // Увела: дождаться чужого документа (иначе он придёт поверх нашего
  // `goto`), затем назад; не вернулись — раскрытия прекращаются.
  await page
    .waitForLoadState('domcontentloaded', { timeout: NAV_SETTLE_MS })
    .catch(() => undefined);
  try {
    await jb.goto(page, before);
  } catch {
    return { kind: 'lost' };
  }
  return urlKey(page.url()) === urlKey(before)
    ? { kind: 'navigated' }
    : { kind: 'lost' };
}

/** Ссылка ведёт на другой документ (не один якорь текущей страницы). */
function leavesPage(href: string, current: string): boolean {
  try {
    const u = new URL(href, current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return urlKey(u.toString()) !== urlKey(current);
  } catch {
    return true;
  }
}
