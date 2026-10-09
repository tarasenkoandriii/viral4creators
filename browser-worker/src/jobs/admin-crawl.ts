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
 *  3а. Только чтение (заход 11, Р-З11-Г1): с начала задания до конца —
 *     кроме окна отправки входа — сеть пропускает лишь чтение
 *     (`safety/write-guard.ts`): POST/PUT/PATCH/DELETE, beacon, отправка
 *     формы скриптом, GraphQL-мутация, GET «выхода» и разрушительного
 *     адреса из скрипта (и редиректом на него), WebSocket, Worker и
 *     SharedWorker, попапы — обрыв; доказанное чтение GraphQL проходит.
 *     Окно записи входа — от Enter до признака входа (смена адреса или
 *     исчезновение поля пароля, ≤ 15 с), только хостам замка. Счётчик — в
 *     журнале задания (`writes`).
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
import { toggleKey, tryToggle } from '../page/toggles';
import { linkRefusal } from '../safety/click-guard';
import {
  WORKER_LIMITS,
  lockHostOf,
  type AdminCrawlParams,
  type AdminCrawlResult,
} from '../shared/browser-job-protocol';
import { JobError } from '../errors';
import { entityRouteKey, sanitizeAdminPage } from './admin-crawl-entity';
import type { JobContext, JobCredentials } from './types';

const TOGGLES_PER_PAGE = 5;
/** Потолок окна записи шага входа: ждём признак входа не дольше. */
const LOGIN_SIGNAL_MS = 15_000;

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
  // Единственное окно записи задания (Р-З11-Г1): от Enter до ПРИЗНАКА
  // входа — смены адреса или исчезновения поля пароля (≤ 15 с; аудит
  // P2-1: SPA-вход шлёт `fetch` из обработчика `submit` с задержкой, и
  // окно «до загрузки» закрывалось раньше запроса). В окне запись — только
  // хостам замка; загрузка дашборда после признака — уже только чтение
  // («последний вход», «прочитано» не пишутся).
  const before = page.url();
  await ctx.jb.loginStep(async () => {
    let timer: NodeJS.Timeout | undefined;
    // Ожидание, которое упало (таймаут, страница ушла), признаком не
    // считается: окно держит другое ожидание или потолок.
    const settle = (w: Promise<unknown>) =>
      w.then(
        () => undefined,
        () => new Promise<void>(() => undefined),
      );
    const signal = Promise.race([
      settle(
        page.waitForURL((u) => u.toString() !== before, {
          waitUntil: 'commit',
          timeout: LOGIN_SIGNAL_MS,
        }),
      ),
      // Поле пароля пропало или скрыто — проверка на каждом кадре (`raf`):
      // опрос локатора (до 500 мс) пропускал запись дашборда SPA.
      settle(
        page.waitForFunction(
          () =>
            !Array.from(
              document.querySelectorAll('input[type="password"]'),
            ).some(
              (e) =>
                e.getClientRects().length > 0 &&
                getComputedStyle(e).visibility !== 'hidden',
            ),
          undefined,
          { polling: 'raf', timeout: LOGIN_SIGNAL_MS },
        ),
      ),
      new Promise<void>((r) => {
        timer = setTimeout(r, LOGIN_SIGNAL_MS);
      }),
    ]);
    try {
      await pass.press('Enter', { timeout: 10_000 });
      await signal;
    } finally {
      clearTimeout(timer);
    }
  });
  await page
    .waitForLoadState('domcontentloaded', { timeout: 15_000 })
    .catch(() => undefined);
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
    // Только чтение — ДО первой страницы и до cookie учётки: под сессией
    // ни загрузка, ни раскрывашки не меняют данные заказчика (Р-З11-Г1).
    await ctx.jb.sessionReadOnly();
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
    // Раскрывашки — только по стоп-листу (`page/toggles.ts`); после клика —
    // без переходов: увела со страницы — назад и следующая. Сбой шага
    // (страница ушла позже окна клика, контекст разрушен — аудит P1-1) или
    // не вернулись — раскрытия этой страницы прекращаются; не на своей
    // странице — она пропускается (с чужой ничего не собираем).
    const here = key(page.url());
    let lost = false;
    try {
      const tried = new Set<string>();
      for (let k = 0; k < TOGGLES_PER_PAGE; k++) {
        const info = await page.evaluate(
          collectInterface,
          WORKER_LIMITS.pageTextChars,
        );
        const next = info.toggles.find((t) => !tried.has(toggleKey(t)));
        if (!next) break;
        tried.add(toggleKey(next));
        const out = await tryToggle(ctx.jb, page, next, p.allowedHosts);
        if (out.kind === 'refused') {
          refusedClicks += 1;
          ctx.log.info('клик отклонён стоп-листом', {
            jobId: ctx.job.id,
            reason: out.reason,
          });
          continue;
        }
        if (out.kind === 'lost') {
          lost = true;
          break;
        }
      }
    } catch {
      lost = true;
    }
    if (lost || key(page.url()) !== here) {
      await page
        .waitForLoadState('domcontentloaded', { timeout: 10_000 })
        .catch(() => undefined);
      const back = await ctx.jb
        .goto(page, here)
        .then(() => key(page.url()) === here)
        .catch(() => false);
      if (!back || (await passwordVisible(page))) {
        skippedLinks += 1;
        continue;
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
