/**
 * `admin-crawl` — обход «Админки» за логином (Э7, ТЗ §5.3; Э-С Ш3).
 *
 *  1. Учётка — ТОЛЬКО здесь и только по запросу воркера: конверт под ключ
 *     воркера (sites-backend арендует учётку Ш2 `assist-admin-login` и
 *     сразу гасит аренду), открывается в памяти, лежит в `SecretBox`.
 *  2. Вход: готовая сессия (cookie регистрируемого домена хоста) или форма
 *     — логин и пароль в поля, отправка — Enter в поле пароля (никаких
 *     кликов по кнопкам). Один вход за задание, без повторов (QA §3.6).
 *     Секреты затираются СРАЗУ после входа, до обхода.
 *  3. Обход: ссылки своего хоста в ширину до `maxDepth`/`maxPages`; «выйти»,
 *     опасные слова в тексте или адресе, платёжные пути — пропуск.
 *     Раскрывашки (меню, вкладки) — клик только по стоп-листу
 *     (`safety/click-guard.ts`); «Видалити», «Оплатити», отправка формы —
 *     отказ (считается в `refusedClicks`).
 *  4. Результат — только «знания об интерфейсе» страниц (заголовки,
 *     подписи меню, кнопок и полей, шапки таблиц), без содержимого ячеек.
 *     ПД вне таблиц (Ш3-хвост (17), `admin-crawl-entity.ts`): на карточке
 *     сущности (заказ, покупатель, пользователь — по маршруту или номеру в
 *     заголовке) остаётся только структура, имена — маска; на прочих
 *     страницах — «Имя Фамилия» и имя после приветствия. Карточка каждого
 *     вида открывается ОДНА (структура у них общая).
 */
import type { Page } from 'playwright-core';
import { collectInterface } from '../page/collect';
import {
  clickRefusal,
  linkRefusal,
  toggleLinkRefusal,
} from '../safety/click-guard';
import {
  WORKER_LIMITS,
  lockHostOf,
  type AdminCrawlParams,
  type AdminCrawlResult,
} from '../shared/browser-job-protocol';
import { JobError } from '../errors';
import { entityRouteKey, sanitizeAdminPage } from './admin-crawl-entity';
import type { JobContext, JobCredentials } from './types';

/** Тот же селектор, что у `collectInterface` (page/collect.ts). */
const TOGGLE_SELECTOR =
  '[aria-expanded="false"],summary,[role="tab"][aria-selected="false"]';
const TOGGLES_PER_PAGE = 5;

interface CdpLikeCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** Cookie только регистрируемого домена хоста задания (П-Р3, Ш0.5). */
export function firstPartyCookies(
  raw: string,
  host: string,
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}> {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const bare = host.replace(/:\d+$/, '');
  const out = [];
  for (const c of list as CdpLikeCookie[]) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string')
      continue;
    const d = (c.domain ?? bare).replace(/^\./, '').toLowerCase();
    // Cookie для самого хоста или его родителя (не для чужого домена).
    if (!(bare === d || bare.endsWith(`.${d}`))) continue;
    if (!d.includes('.')) continue;
    const sameSite =
      c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax';
    out.push({
      name: c.name,
      value: c.value,
      domain: c.domain && c.domain.startsWith('.') ? c.domain : d,
      path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
      expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      sameSite: sameSite as 'Strict' | 'Lax' | 'None',
    });
  }
  return out.slice(0, 200);
}

async function passwordVisible(page: Page): Promise<boolean> {
  return page
    .locator('input[type="password"]:visible')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

/** Вход формой: логин и пароль в поля, Enter в поле пароля. */
async function loginWithForm(
  ctx: JobContext,
  page: Page,
  creds: JobCredentials,
): Promise<void> {
  const pass = page.locator('input[type="password"]:visible').first();
  if (!(await pass.count())) throw new JobError('login_form_missing');
  if (!creds.password) throw new JobError('credentials_unavailable');
  const form = pass.locator('xpath=ancestor::form[1]');
  const scope = (await form.count()) ? form : page.locator('body');
  const user = scope
    .locator(
      'input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])',
    )
    .first();
  if (creds.username && (await user.count())) {
    await user.fill(creds.username, { timeout: 10_000 });
  }
  await creds.password.reveal((plain) => pass.fill(plain, { timeout: 10_000 }));
  // Секрет больше не нужен — затереть ДО отправки и обхода.
  creds.wipe();
  await Promise.all([
    page
      .waitForLoadState('domcontentloaded', { timeout: 15_000 })
      .catch(() => undefined),
    pass.press('Enter', { timeout: 10_000 }),
  ]);
  await page
    .waitForLoadState('networkidle', { timeout: 8_000 })
    .catch(() => undefined);
  ctx.log.info('вход формой выполнен', { jobId: ctx.job.id });
}

export async function runAdminCrawl(
  ctx: JobContext,
): Promise<AdminCrawlResult> {
  const p = ctx.job.params as AdminCrawlParams;
  const host = p.allowedHosts[0];
  const creds = await ctx.credentials();
  let loggedIn = false;
  let page: Page;
  try {
    // Внутри try: упал браузер на `newPage` — секреты всё равно затираются
    // (аудит Ш3: раньше SecretBox оставался жить до перезапуска процесса).
    page = await ctx.jb.newPage();
    if (creds.cookies) {
      await creds.cookies.reveal(async (raw) => {
        const list = firstPartyCookies(raw, host);
        if (list.length) await ctx.jb.context.addCookies(list);
      });
    }
    await ctx.jb.goto(page, p.startUrl);
    if (await passwordVisible(page)) {
      if (p.loginMethod === 'session' && !creds.password) {
        throw new JobError('login_failed');
      }
      await loginWithForm(ctx, page, creds);
      if (await passwordVisible(page)) throw new JobError('login_failed');
      const now = new URL(page.url());
      if (!p.allowedHosts.includes(lockHostOf(now)))
        throw new JobError('offhost_redirect');
    } else if (!creds.cookies && p.loginMethod === 'password') {
      // Ни формы, ни сессии: открытая страница без входа — не «Админка».
      throw new JobError('login_form_missing');
    }
    loggedIn = true;
  } finally {
    creds.wipe();
  }

  const pages: AdminCrawlResult['pages'] = [];
  let refusedClicks = 0;
  let skippedLinks = 0;
  const seen = new Set<string>();
  const key = (u: string) => {
    const x = new URL(u);
    x.hash = '';
    return x.toString();
  };
  const queue: Array<{ url: string; depth: number }> = [];
  // Стартовая — та, где оказались после входа (сайт мог увести в /dashboard).
  queue.push({ url: page.url(), depth: 0 });
  seen.add(key(page.url()));
  // Виды карточек сущностей, уже поставленные в обход (одна на вид).
  const entityKinds = new Set<string>();
  const startKind = entityRouteKey(page.url());
  if (startKind) entityKinds.add(startKind);
  let first = true;
  while (queue.length && pages.length < p.maxPages) {
    if (ctx.signal.aborted) break;
    const { url, depth } = queue.shift()!;
    if (!first) {
      try {
        await ctx.jb.goto(page, url);
      } catch (e) {
        if (
          e instanceof JobError &&
          (e.code === 'offhost_redirect' || e.code === 'egress_blocked')
        ) {
          skippedLinks += 1;
          continue;
        }
        throw e;
      }
      // Сессия кончилась (увело на форму входа) — дальше не идём.
      if (await passwordVisible(page)) break;
    }
    first = false;
    // Раскрывашки — только по стоп-листу; после клика — без переходов.
    const tried = new Set<string>();
    for (let k = 0; k < TOGGLES_PER_PAGE; k++) {
      const info = await page.evaluate(
        collectInterface,
        WORKER_LIMITS.pageTextChars,
      );
      const next = info.toggles.find(
        (t) => !tried.has(`${t.text}|${t.hidden}`),
      );
      if (!next) break;
      tried.add(`${next.text}|${next.hidden}`);
      if (clickRefusal(next)) {
        refusedClicks += 1;
        ctx.log.info('клик отклонён стоп-листом', {
          jobId: ctx.job.id,
          reason: clickRefusal(next)!,
        });
        continue;
      }
      // Нажимается ровно тот элемент, который проверен: берётся тем же
      // querySelectorAll, что в сборе, и проверяется ЕЩЁ РАЗ по живому
      // тексту прямо перед кликом (страница могла подменить подпись).
      const handle = await page.evaluateHandle(
        (a: { sel: string; idx: number }) =>
          document.querySelectorAll(a.sel)[a.idx] ?? null,
        { sel: TOGGLE_SELECTOR, idx: next.idx },
      );
      const el = handle.asElement();
      if (!el) continue;
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
      if (
        clickRefusal(fresh) ||
        toggleLinkRefusal(fresh.href, page.url(), fresh.text, p.allowedHosts)
      ) {
        refusedClicks += 1;
        await el.dispose();
        continue;
      }
      const before = page.url();
      await el
        .click({ timeout: 3_000, noWaitAfter: true })
        .catch(() => undefined);
      await el.dispose();
      await page.waitForTimeout(250);
      // Раскрывашка, которая увела со страницы, — не раскрывашка: назад.
      // Смена одного якоря (`href="#"`) — не уход: страница та же.
      if (key(page.url()) !== key(before)) {
        await ctx.jb.goto(page, before).catch(() => undefined);
        break;
      }
    }
    const info = await page.evaluate(
      collectInterface,
      WORKER_LIMITS.pageTextChars,
    );
    const cur = new URL(page.url());
    const safe = sanitizeAdminPage(cur.toString(), info.title, info.text);
    pages.push({
      url: `${cur.origin}${cur.pathname}`,
      title: safe.title.slice(0, WORKER_LIMITS.titleChars),
      text: safe.text.slice(0, WORKER_LIMITS.pageTextChars),
    });
    if (depth >= p.maxDepth) continue;
    for (const l of info.links) {
      const k = key(l.href);
      if (seen.has(k)) continue;
      seen.add(k);
      if (linkRefusal(l.href, l.text, p.allowedHosts)) {
        skippedLinks += 1;
        continue;
      }
      // Вторая карточка того же вида (другой заказ/покупатель) — не нужна:
      // структура та же, а ПД — чужие.
      const kind = entityRouteKey(l.href);
      if (kind) {
        if (entityKinds.has(kind)) {
          skippedLinks += 1;
          continue;
        }
        entityKinds.add(kind);
      }
      queue.push({ url: l.href, depth: depth + 1 });
    }
  }
  // Один адрес — одна страница (разные query одного пути — первая).
  const uniq = new Map<string, AdminCrawlResult['pages'][number]>();
  for (const pg of pages) if (!uniq.has(pg.url)) uniq.set(pg.url, pg);
  return { loggedIn, pages: [...uniq.values()], refusedClicks, skippedLinks };
}
