/**
 * `tutorial-explore` — раунд исследователя обучалки по сайту заказчика
 * (Ш3-хвост (3)) вместо Chromium в функции генератора
 * (`backend/.../chromium-page-explorer.ts`): тот же порядок раунда, та же
 * разведка страницы и тот же поиск полей входа (копии
 * `scripts/sync-worker-shared.mjs`), но в изолированном воркере — с его
 * прокси, замком главного фрейма, стоп-листом и потолками трафика.
 *
 *  1. Сессия черновика — конвертом под ключ воркера (AAD — одноразовый
 *     `nonce` раунда); в контекст кладутся только cookie хостов замка и их
 *     родителей (П-Р3).
 *  2. Переход (`JobBrowser.goto`: замок, egress, потолки) и пол возраста
 *     кадра — как в функции.
 *  3. Вход учёткой РЕЕСТРА (`login`): секреты — запросом `credentials`
 *     (аренда Ш2 `tutorial-login` на сервере), поля — `findLoginFields` по
 *     разведке ЭТОЙ страницы, пароль — только в настоящее поле пароля;
 *     секрет затирается сразу после ввода. Ввода руками в протоколе нет —
 *     такие раунды остаются в функции генератора.
 *  4. Клик (≤ 1): цель стоп-листа (оплата, удаление, оформление…;
 *     `action-words`) — отказ `click_refused` ДО клика (раунд уйдёт в
 *     функцию, где человек подтверждает опасную кнопку); нет цели —
 *     `target_missing`; увод на чужой хост — `offhost_redirect`.
 *  5. Кадр: доворот к цели (если экран тот же), мягкое оседание, заморозка,
 *     предпросмотр JPEG (артефакт 0) и съёмочный PNG ×2 (артефакт 1,
 *     необязательный — не влез или не снялся, раунд не валится).
 *  6. Элементы — разведкой страницы; подписи и тексты кнопок — с маской ПД
 *     (e-mail, телефон, длинные номера, ключи), как у «Снимка»; селекторы и
 *     значения опций — как есть (по ним идёт следующий раунд).
 *  7. Новая сессия — конвертом под одноразовый ключ генератора `replyKey`
 *     (sites-backend и очередь видят только шифротекст); не снялась или не
 *     влезла — `null` (как в функции: потеря jar'а раунд не валит).
 */
import type { Page } from 'playwright-core';
import { linkRefusal } from '../safety/click-guard';
import { NEVER_KINDS, actionKindsFor } from '../shared/action-words';
import {
  EXPLORE_CANDIDATE_KINDS,
  VIEWPORT_SIZE,
  WORKER_LIMITS,
  isExploreSelector,
  exploreFillAad,
  exploreReplyAad,
  exploreSessionAad,
  lockHostOf,
  type ExploreElement,
  type TutorialExploreParams,
  type TutorialExploreResult,
} from '../shared/browser-job-protocol';
import { dangerWarningFor } from '../shared/danger-words';
import {
  DSF_REPAINT_CAP_MS,
  DSF_REPAINT_QUIET_SOURCE,
  FOREIGN_SETTLE_CEILING_MS,
  FRAME_FREEZE_SOURCE,
  FRAME_RELEASE_SOURCE,
  scrollTargetIntoCenterSource,
  settleForeignFrame,
} from '../shared/foreign-frame-settle';
import {
  findLoginFields,
  passwordFieldSource,
} from '../shared/login-form-detect';
import {
  collectPageExploration,
  type CollectedPage,
} from '../shared/page-exploration';
import type { PageElement } from '../shared/page-exploration.types';
import { sealForWorker } from '../shared/worker-seal';
import { JobError } from '../errors';
import { SecretBox } from '../secret-box';
import { firstPartyCookies } from './admin-crawl';
import type { JobContext, JobCredentials } from './types';

/** Те же числа, что у раунда в функции (`chromium-page-explorer.ts`). */
export const SETTLE_FLOOR_MS = 1_500;
const SETTLE_TIMEOUT_MS = 6_000;
const ACTION_TIMEOUT_MS = 10_000;
const PREVIEW_QUALITY = [60, 45] as const;
/** Остаток стены под снимки, куки и сдачу результата. */
const SNAPSHOT_RESERVE_MS = 8_000;
/** Запас тела `complete` под обёртку и прочие поля. */
const RESULT_MARGIN = 8 * 1024;

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE = /(?:\+?\d[\s().-]?){7,}\d/g;
const TOKEN = /\b(sk-[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,})\b/g;
const LONG_DIGITS = /\d(?:[\s-]?\d){8,}/g;

/** Маска ПД подписи (та же, что у «Снимка», `page/collect.ts`). */
export function maskPd(s: string): string {
  return s
    .replace(EMAIL, '[e-mail]')
    .replace(TOKEN, '[ключ]')
    .replace(PHONE, '[тел.]')
    .replace(LONG_DIGITS, '[№]');
}

/** В строке есть ПД (то, что маска заменила бы). */
export function hasPd(s: string): boolean {
  return maskPd(s) !== s;
}

const clip = (s: string | undefined, max: number): string | undefined =>
  s === undefined ? undefined : s.length > max ? s.slice(0, max) : s;

/** Элемент разведки → элемент протокола (маска ПД, длины, без `danger`). */
export function toExploreElement(e: PageElement): ExploreElement | null {
  const L = WORKER_LIMITS.exploreTextChars;
  if (
    typeof e.selector !== 'string' ||
    !e.selector.trim() ||
    e.selector.length > WORKER_LIMITS.exploreSelectorChars
  ) {
    return null;
  }
  const out: ExploreElement = { selector: e.selector, tag: e.tag };
  if (e.type) out.type = clip(e.type, 40);
  if (e.label) out.label = clip(maskPd(e.label), L);
  if (e.visibleText) out.visibleText = clip(maskPd(e.visibleText), L);
  if (e.name) out.name = clip(e.name, L);
  if (e.autocomplete) out.autocomplete = clip(e.autocomplete, 80);
  if (e.options?.length) {
    const opts = e.options
      .filter((o) => typeof o.value === 'string' && o.value.length <= L)
      .slice(0, WORKER_LIMITS.exploreOptions)
      .map((o) => ({ value: o.value, label: clip(maskPd(o.label), L) ?? '' }));
    if (opts.length) out.options = opts;
  }
  // Ш4(5)-хвост: кандидаты карты интерфейса. Аудит захода 7: кандидат с ПД
  // в селекторе или подписи (`[aria-label="Иван, +380…"]`, id/name с
  // e-mail) ОТБРАСЫВАЕТСЯ, а не маскируется — маска сломала бы селектор.
  if (e.candidates?.length) {
    const cs = e.candidates
      .filter(
        (c) =>
          (EXPLORE_CANDIDATE_KINDS as readonly string[]).includes(c.kind) &&
          isExploreSelector(c.selector) &&
          c.selector.length <= WORKER_LIMITS.exploreCandidateChars &&
          (c.kind !== 'aria' || !!c.name) &&
          !hasPd(c.selector) &&
          !hasPd(c.name ?? ''),
      )
      .slice(0, WORKER_LIMITS.exploreCandidates)
      .map((c) =>
        c.kind === 'aria'
          ? {
              kind: c.kind,
              selector: c.selector,
              name: clip(c.name ?? '', L) ?? '',
            }
          : { kind: c.kind, selector: c.selector },
      );
    if (cs.length) out.candidates = cs;
  }
  return out;
}

/**
 * Уложить элементы в бюджет результата: сначала урезаются списки опций,
 * затем — хвост элементов (порядок документа: верх страницы важнее).
 */
export function fitElements(
  elements: ExploreElement[],
  budgetBytes: number,
): ExploreElement[] {
  const size = (els: ExploreElement[]) =>
    Buffer.byteLength(JSON.stringify(els), 'utf8');
  let out = elements.slice(0, WORKER_LIMITS.exploreElements);
  if (size(out) <= budgetBytes) return out;
  out = out.map((e) =>
    e.options && e.options.length > 20
      ? { ...e, options: e.options.slice(0, 20) }
      : e,
  );
  while (out.length && size(out) > budgetBytes) {
    out = out.slice(0, Math.floor(out.length * 0.8));
  }
  return out;
}

function withDanger(e: PageElement): PageElement {
  const danger = dangerWarningFor(e.visibleText ?? e.label);
  return danger ? { ...e, danger } : e;
}

/** Источник для `evaluate`: что за цель клика (текст, скрытая подпись, ссылка). */
export function clickTargetSource(selector: string): string {
  return `(() => {
  try {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    // Аудит захода 7: цель клика — не только сам элемент, но и его
    // интерактивный предок (svg-иконка внутри <button aria-label="Оплатить">)
    // и поле, которое включает <label for>.
    const owner = el.closest('button,a,[role=button],[role=link],input[type=submit],input[type=button],label') || el;
    const nodes = [el, owner];
    if (owner.tagName === 'LABEL' && owner.getAttribute('for')) {
      const ctl = document.getElementById(owner.getAttribute('for'));
      if (ctl) nodes.push(ctl);
    }
    const uniq = nodes.filter((n, i) => nodes.indexOf(n) === i);
    const textOf = (n) => String(n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
    const hiddenOf = (n) => [n.getAttribute('aria-label'), n.getAttribute('title'),
      n.tagName === 'INPUT' ? n.value : null].filter(Boolean).join(' ');
    const text = uniq.map(textOf).filter(Boolean).join(' ').slice(0, 300);
    const hidden = uniq.map(hiddenOf).filter(Boolean).join(' ').slice(0, 300);
    const a = el.closest('a[href]');
    return { text, hidden, href: a ? a.href : null };
  } catch (e) {
    return null;
  }
})()`;
}

/** Источник: поле — пароль или код (как `sensitiveFieldSource` функции). */
export function sensitiveFieldSource(selector: string): string {
  return `(() => {
  try {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return type === 'password' || /(current|new)-password|one-time-code/.test(ac);
  } catch (e) {
    return false;
  }
})()`;
}

export type ClickVerdict = 'ok' | 'refused' | 'missing';

/**
 * Решение стоп-листа по цели клика: категории «никогда» (оплата, удаление,
 * оформление заказа, отмена, возврат, списание, массовое действие) по тексту
 * и скрытой подписи; ссылка — тем же разбором, что у обхода (GET-удаление
 * «/orders/5/delete» — тоже действие). Отправка формы и вход — разрешены:
 * это обычные шаги обучалки.
 */
export function clickVerdict(
  target: { text: string; hidden: string; href: string | null } | null,
  allowedHosts: readonly string[],
): ClickVerdict {
  if (!target) return 'missing';
  const kinds = [
    ...actionKindsFor(target.text),
    ...actionKindsFor(target.hidden),
  ];
  if (kinds.some((k) => NEVER_KINDS.has(k))) return 'refused';
  if (target.href) {
    const r = linkRefusal(target.href, target.text, allowedHosts);
    if (r === 'danger') return 'refused';
  }
  return 'ok';
}

interface PwCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/** Cookie хостов замка (и их родителей) — без дублей. */
export function lockCookies(raw: string, hosts: readonly string[]): PwCookie[] {
  const seen = new Set<string>();
  const out: PwCookie[] = [];
  for (const h of hosts) {
    for (const c of firstPartyCookies(raw, h)) {
      const key = `${c.name}\u0000${c.domain}\u0000${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/** Cookie контекста → формат jar генератора (`CdpCookie`), только хосты замка. */
export function harvestJar(
  cookies: PwCookie[],
  hosts: readonly string[],
): string {
  const bare = hosts.map((h) => h.replace(/:\d+$/, ''));
  const jar = cookies
    .filter((c) => {
      const d = c.domain.replace(/^\./, '').toLowerCase();
      return (
        d.includes('.') && bare.some((b) => b === d || b.endsWith(`.${d}`))
      );
    })
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expires: c.expires,
    }));
  return JSON.stringify(jar);
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

async function floor(startedAt: number): Promise<void> {
  await sleep(startedAt + SETTLE_FLOOR_MS - Date.now());
}

async function collect(page: Page, origin: string): Promise<CollectedPage> {
  const src = `(${collectPageExploration.toString()})(${JSON.stringify(origin)})`;
  const raw = (await page
    .evaluate(src)
    .catch(() => null)) as CollectedPage | null;
  if (!raw || !Array.isArray(raw.elements)) {
    return { currentUrl: page.url(), elements: [], looksLikeLogin: false };
  }
  return raw;
}

function assertInside(ctx: JobContext, page: Page): void {
  if (ctx.jb.offhost) throw new JobError('offhost_redirect');
  let u: URL;
  try {
    u = new URL(page.url());
  } catch {
    throw new JobError('nav_failed');
  }
  if (!ctx.jb.allowedHosts.includes(lockHostOf(u))) {
    throw new JobError('offhost_redirect');
  }
}

/** Клик с ожиданием навигации ИЛИ затишья сети, затем пол кадра и замок. */
async function clickAndSettle(
  ctx: JobContext,
  page: Page,
  selector: string,
): Promise<void> {
  const navigated = page
    .waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: SETTLE_TIMEOUT_MS,
    })
    .catch(() => null);
  const startedAt = Date.now();
  try {
    await page
      .locator(`css=${selector}`)
      .first()
      .click({ timeout: ACTION_TIMEOUT_MS });
  } catch (e) {
    if (ctx.jb.offhost) throw new JobError('offhost_redirect');
    if (ctx.signal.aborted) throw e;
    throw new JobError('target_missing');
  }
  await Promise.race([
    navigated,
    page
      .waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS })
      .catch(() => null),
  ]);
  await floor(startedAt);
  assertInside(ctx, page);
}

async function isPasswordField(page: Page, selector: string): Promise<boolean> {
  return page
    .evaluate(passwordFieldSource(selector))
    .then((r) => r === true)
    .catch(() => false);
}

async function loginWithRegistry(
  ctx: JobContext,
  page: Page,
  p: TutorialExploreParams,
): Promise<NonNullable<TutorialExploreResult['autoLogin']>> {
  const login = p.login!;
  let creds: JobCredentials | null = null;
  try {
    creds = await ctx.credentials();
    if (!creds.password) throw new JobError('credentials_unavailable');
    const collected = await collect(page, p.allowedOrigin);
    // Стоп-лист — и здесь: кнопка «Оплатить» кнопкой входа не станет.
    const pick = login.pick;
    const found = findLoginFields(collected.elements.map(withDanger), {
      needUsername: login.needUsername && !!creds.username,
      pick: pick
        ? {
            ...(pick.usernameSelector
              ? { usernameSelector: pick.usernameSelector }
              : {}),
            ...(pick.passwordSelector
              ? { passwordSelector: pick.passwordSelector }
              : {}),
            ...(pick.submitSelector
              ? { submitSelector: pick.submitSelector }
              : {}),
          }
        : undefined,
    });
    if (!found.ok) throw new JobError('login_form_missing');
    if (!(await isPasswordField(page, found.passwordSelector))) {
      throw new JobError('login_form_missing');
    }
    const fill = async (selector: string, value: string) => {
      try {
        await page
          .locator(`css=${selector}`)
          .first()
          .fill(value, { timeout: ACTION_TIMEOUT_MS });
      } catch {
        throw new JobError('login_form_missing');
      }
    };
    if (found.usernameSelector && creds.username) {
      await fill(found.usernameSelector, creds.username);
    }
    await creds.password.reveal((plain) => fill(found.passwordSelector, plain));
    // Секрет больше не нужен — затереть ДО отправки формы.
    creds.wipe();
    await clickAndSettle(ctx, page, found.submitSelector);
    return {
      usernameSelector: found.usernameSelector,
      passwordSelector: found.passwordSelector,
      submitSelector: found.submitSelector,
    };
  } finally {
    creds?.wipe();
  }
}

async function previewJpeg(page: Page): Promise<Buffer> {
  for (const quality of PREVIEW_QUALITY) {
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

/**
 * Съёмочный кадр: PNG плотности 2 (CDP — у контекста Playwright плотность
 * задана при создании). Сбой или кадр сверх потолка артефакта — `null`.
 */
export async function videoFramePng(
  ctx: JobContext,
  page: Page,
  leftMs: () => number,
): Promise<Buffer | null> {
  const size =
    VIEWPORT_SIZE[(ctx.job.params as TutorialExploreParams).viewport];
  let cdp: Awaited<ReturnType<typeof ctx.jb.context.newCDPSession>> | null =
    null;
  try {
    cdp = await ctx.jb.context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    if (leftMs() >= DSF_REPAINT_CAP_MS + 500) {
      await Promise.race([
        page.evaluate(DSF_REPAINT_QUIET_SOURCE).catch(() => undefined),
        sleep(DSF_REPAINT_CAP_MS + 500),
      ]);
    }
    await page.evaluate(FRAME_FREEZE_SOURCE).catch(() => undefined);
    const shot = (await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })) as { data?: string };
    const buf = Buffer.from(shot.data ?? '', 'base64');
    if (buf.length === 0 || buf.length > WORKER_LIMITS.artifactBytes) {
      ctx.log.debug('съёмочный кадр пропущен', { bytes: buf.length });
      return null;
    }
    return buf;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log.debug('съёмочный кадр не снялся');
    return null;
  } finally {
    await cdp
      ?.send('Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      .catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
  }
}

/** Клик со стоп-листом: цель «никогда» — `click_refused` ДО клика. */
async function guardedClick(
  ctx: JobContext,
  page: Page,
  p: TutorialExploreParams,
  selector: string,
): Promise<void> {
  const target = (await page
    .evaluate(clickTargetSource(selector))
    .catch(() => null)) as {
    text: string;
    hidden: string;
    href: string | null;
  } | null;
  const verdict = clickVerdict(target, p.allowedHosts);
  if (verdict === 'missing') throw new JobError('target_missing');
  if (verdict === 'refused') throw new JobError('click_refused');
  await clickAndSettle(ctx, page, selector);
}

/**
 * Ввод значения из конверта (AAD — поле `index` раунда): значение — в
 * `SecretBox` (журнал его вырезает), затирается сразу после ввода.
 * `<select>` — выбором варианта по значению (как `fill` puppeteer).
 * Возвращает «это поле пароля/кода» (вход: липкий `loginUsedAt`).
 */
async function sealedFill(
  ctx: JobContext,
  page: Page,
  p: TutorialExploreParams,
  selector: string,
  sealed: string,
  index: number,
  passwordOnly = false,
): Promise<boolean> {
  const box = new SecretBox(ctx.unseal(sealed, exploreFillAad(p, index)));
  try {
    if (passwordOnly && !(await isPasswordField(page, selector))) {
      throw new JobError('login_form_missing');
    }
    const sensitive = await page
      .evaluate(sensitiveFieldSource(selector))
      .then((r) => r === true)
      .catch(() => true);
    const tag = await page
      .evaluate(
        `(() => { try { const e = document.querySelector(${JSON.stringify(selector)}); return e ? e.tagName : null; } catch (e) { return null; } })()`,
      )
      .catch(() => null);
    if (tag === null) throw new JobError('target_missing');
    const loc = page.locator(`css=${selector}`).first();
    try {
      await box.reveal((v) =>
        tag === 'SELECT'
          ? loc
              .selectOption(v, { timeout: ACTION_TIMEOUT_MS })
              .then(() => undefined)
          : loc.fill(v, { timeout: ACTION_TIMEOUT_MS }),
      );
    } catch (e) {
      if (ctx.signal.aborted || e instanceof JobError) throw e;
      throw new JobError('target_missing');
    }
    return sensitive;
  } finally {
    box.wipe();
  }
}

export async function runTutorialExplore(
  ctx: JobContext,
): Promise<TutorialExploreResult> {
  const p = ctx.job.params as TutorialExploreParams;
  const deadline = Date.now() + ctx.job.wallMs - SNAPSHOT_RESERVE_MS;
  const leftMs = () => deadline - Date.now();
  if (p.session) {
    const plain = ctx.unseal(p.session, exploreSessionAad(p));
    try {
      const cookies = lockCookies(plain.toString('utf8'), p.allowedHosts);
      if (cookies.length) await ctx.jb.context.addCookies(cookies);
    } finally {
      plain.fill(0);
    }
  }
  const page = await ctx.jb.newPage();
  let sensitiveFill = false;
  let autoLogin: TutorialExploreResult['autoLogin'] = null;
  let target: string | undefined;
  let urlBefore: string;
  if (p.replay) {
    // Переигровка (`/undo`): шаги с нуля, как `replayInBrowser` функции.
    urlBefore = '';
    for (let i = 0; i < p.replay.length; i++) {
      if (ctx.signal.aborted) throw new JobError('cancelled');
      const st = p.replay[i];
      if (st.kind === 'goto') {
        const t0 = Date.now();
        await ctx.jb.goto(page, st.url);
        await floor(t0);
        target = undefined;
        urlBefore = page.url();
        continue;
      }
      target = st.selector;
      urlBefore = page.url();
      if (st.kind === 'fill') {
        if (
          await sealedFill(
            ctx,
            page,
            p,
            st.selector,
            st.value,
            i,
            st.passwordOnly,
          )
        )
          sensitiveFill = true;
      } else {
        await guardedClick(ctx, page, p, st.selector);
      }
    }
  } else {
    const startedAt = Date.now();
    await ctx.jb.goto(page, p.url);
    await floor(startedAt);
    urlBefore = page.url();
    if (p.login) {
      autoLogin = await loginWithRegistry(ctx, page, p);
      sensitiveFill = true;
    }
    for (let i = 0; i < p.fills.length; i++) {
      const f = p.fills[i];
      if (await sealedFill(ctx, page, p, f.selector, f.value, i)) {
        sensitiveFill = true;
      }
    }
    for (const selector of p.clicks) await guardedClick(ctx, page, p, selector);
    target =
      p.clicks[p.clicks.length - 1] ??
      p.fills[p.fills.length - 1]?.selector ??
      autoLogin?.submitSelector;
  }

  // Довернуть к цели — только если экран тот же (как в функции).
  if (target && page.url() === urlBefore) {
    await page
      .evaluate(scrollTargetIntoCenterSource(target))
      .catch(() => false);
  }
  const budget = Math.min(FOREIGN_SETTLE_CEILING_MS, leftMs());
  if (budget > 0) {
    await settleForeignFrame(
      (src) => page.evaluate(src),
      { now: () => Date.now(), sleep },
      budget,
    );
  }
  const collected = await collect(page, p.allowedOrigin);
  assertInside(ctx, page);

  await page.evaluate(FRAME_FREEZE_SOURCE).catch(() => undefined);
  let video: Buffer | null = null;
  try {
    const preview = await previewJpeg(page);
    const size = VIEWPORT_SIZE[p.viewport];
    await ctx.uploadArtifact({
      idx: 0,
      data: preview,
      contentType: 'image/jpeg',
      width: size.width,
      height: size.height,
    });
    if (p.videoFrame) video = await videoFramePng(ctx, page, leftMs);
    if (video) {
      await ctx.uploadArtifact({
        idx: 1,
        data: video,
        contentType: 'image/png',
        width: size.width * 2,
        height: size.height * 2,
      });
    }
  } finally {
    await page.evaluate(FRAME_RELEASE_SOURCE).catch(() => undefined);
  }

  // Ответ под ключ генератора: полный адрес (с query — по нему идёт
  // следующий раунд) и новая сессия. Сессия не влезла — без неё (как
  // потеря jar'а в функции), адрес остаётся.
  const full = new URL(page.url());
  full.hash = '';
  let cookiesJson: string | null = null;
  try {
    cookiesJson = harvestJar(
      (await ctx.jb.context.cookies()) as PwCookie[],
      p.allowedHosts,
    );
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log.warn('сессия раунда не снялась');
  }
  const sealReply = (cookies: string | null): string | null => {
    const body = Buffer.from(
      `{"url":${JSON.stringify(full.toString())},"cookies":${cookies ?? 'null'}}`,
      'utf8',
    );
    try {
      return sealForWorker(p.replyKey, body, exploreReplyAad(p));
    } catch {
      return null;
    } finally {
      body.fill(0);
    }
  };
  let reply = sealReply(cookiesJson);
  if (reply && reply.length > WORKER_LIMITS.sessionSealedChars) {
    ctx.log.warn('сессия раунда не влезла в потолок — не сдана');
    reply = sealReply(null);
  }
  const u = new URL(page.url());
  const budgetBytes =
    WORKER_LIMITS.resultBytes - (reply?.length ?? 0) - RESULT_MARGIN;
  const elements = fitElements(
    collected.elements
      .map(toExploreElement)
      .filter((e): e is ExploreElement => e !== null),
    budgetBytes,
  );
  return {
    currentUrl: `${u.origin}${u.pathname}`,
    elements,
    looksLikeLogin: collected.looksLikeLogin === true,
    screenshot: 0,
    videoFrame: video ? 1 : null,
    reply,
    sensitiveFill,
    autoLogin,
  };
}
