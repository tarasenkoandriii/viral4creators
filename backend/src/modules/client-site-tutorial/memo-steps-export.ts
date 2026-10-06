/**
 * Шаги одобренной обучалки → источник черновика мемо помощника (Э6-тер (к),
 * ТЗ помощника §5-бис.17 п.6 «Шаги обучалки», аудит §5-бис.18 м-16).
 *
 * ЧИСТЫЙ модуль: строка черновика — только чтение, ни расшифровки, ни
 * чтения данных входа. Что уходит в sites-backend и чего не уходит НИКОГДА:
 *
 *  - только черновик, привязанный к ЭТОМУ сайту помощника (`clientSiteId`),
 *    одобренный оператором (`APPROVED`) и снятый в режиме A (хост
 *    подтверждён в кабинете сайтов, Ш1). Режим B («сайт не подтверждён»,
 *    решение 02.10) — не источник; чужой сайт отвечает как несуществующий;
 *  - `goto` → `navigate` — только ПУТЬ (без query и фрагмента: там бывают
 *    токены и ПД) и только на хосте черновика (доменный замок §8.1);
 *  - `click` → селектор (элемент Ш4 найдёт sites-backend по своей карте);
 *  - `fill` → селектор и ВИД поля по селектору — значение не уходит
 *    никогда (слот без значения);
 *  - вход отбрасывается целиком: раунд `/login` (секретное поле без
 *    значения), ввод в поле, похожее на пароль/код (`isSensitiveSelector`),
 *    маркер живого входа (раунд из одного `assertVisible`, §7.4.5) — и всё,
 *    что было ДО последнего такого раунда (многоэкранные формы входа:
 *    сначала e-mail, потом пароль). Мемо такого ролика — только для
 *    закрытой зоны (`requiresLogin`), прогон — в браузере владельца;
 *  - проверки (`waitFor`, `assertVisible`, `assertText` — у последнего
 *    есть значение) и `triggerPaidOperation` — не шаги мемо.
 */
import { CAPTURE_VIEWPORT } from '../tutorial-runner/tutorial-video-assembly';
import {
  draftRequiresLogin,
  isSensitiveSelector,
  type DraftLoginFacts,
} from '../client-site-media/requires-login';

export const MEMO_EXPORT_MAX_STEPS = 30;
const SELECTOR_MAX = 200;
const PATH_MAX = 300;
/** Как `PATH_MASK_RE` sites-backend (маска пути шага мемо), без `*`. */
const SAFE_PATH = /^\/[A-Za-z0-9\-._~%!$&'(),;=:@/]*$/;
/** Ниже — телефонная вёрстка (как `mobile` карты Ш4). */
const MOBILE_MAX_WIDTH = 767;

export type MemoExportField = 'text' | 'email' | 'phone' | 'number';

export type MemoExportStep =
  | { kind: 'navigate'; path: string }
  | { kind: 'click'; selector: string }
  | { kind: 'fill'; selector: string; field: MemoExportField };

export interface MemoStepsExport {
  draftId: string;
  siteId: string;
  /** Название ролика (правит владелец; sites-backend чистит сам). */
  title: string | null;
  /** Хост черновика (нижний регистр) — sites-backend сверит со своими подтверждёнными. */
  host: string;
  /** Путь первой страницы мемо или null (после входа адрес не записан). */
  startPath: string | null;
  /** Путь последней страницы (предложение цели) или null. */
  endPath: string | null;
  view: 'mobile' | 'desktop';
  requiresLogin: boolean;
  steps: MemoExportStep[];
  /** Сколько шагов не ушло и почему (числа, без содержимого). */
  dropped: { login: number; foreign: number; other: number };
}

export type MemoExportRefusal =
  | 'not_found'
  | 'not_approved'
  | 'mode_b'
  | 'no_steps';

export interface MemoExportDraft extends DraftLoginFacts {
  id: string;
  status: string;
  siteMode: string | null;
  clientSiteId: string | null;
  stepsPerRound?: number[] | null;
  title?: string | null;
}

/** Вид поля по селектору — без значения (оно сюда не передаётся вовсе). */
export function fieldKindOf(selector: string): MemoExportField {
  if (/e-?mail/i.test(selector)) return 'email';
  if (/phone|tel\b|tel[^a-z]|mobile/i.test(selector)) return 'phone';
  if (/qty|quantity|count|amount|number|кільк|колич/i.test(selector))
    return 'number';
  return 'text';
}

function pathOf(raw: unknown, origin: string): string | null | 'foreign' {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.origin !== origin) return 'foreign';
  const p = u.pathname.replace(/\/+$/, '') || '/';
  return p.length <= PATH_MAX && SAFE_PATH.test(p) ? p : null;
}

type Raw = Record<string, unknown>;

/** Раунды по `stepsPerRound`; не сходится с `steps` — каждый шаг сам по себе. */
function roundsOf(steps: Raw[], perRound: unknown): Raw[][] {
  const sizes = Array.isArray(perRound)
    ? perRound.filter((n): n is number => Number.isInteger(n) && n > 0)
    : [];
  if (
    sizes.length === (Array.isArray(perRound) ? perRound.length : -1) &&
    sizes.reduce((a, b) => a + b, 0) === steps.length
  ) {
    const out: Raw[][] = [];
    let i = 0;
    for (const n of sizes) {
      out.push(steps.slice(i, i + n));
      i += n;
    }
    return out;
  }
  return steps.map((s) => [s]);
}

/** Раунд входа: секретное поле, поле пароля/кода или маркер живого входа. */
export function isLoginRound(round: Raw[]): boolean {
  if (round.length === 1 && round[0].kind === 'assertVisible') return true;
  return round.some(
    (s) =>
      s.kind === 'fill' &&
      (typeof s.value !== 'string' ||
        s.value === '' ||
        typeof s.selector !== 'string' ||
        isSensitiveSelector(s.selector)),
  );
}

export function exportMemoSteps(
  d: MemoExportDraft | null,
  siteId: string,
):
  | { ok: true; value: MemoStepsExport }
  | { ok: false; reason: MemoExportRefusal } {
  // Чужой сайт — как несуществующий (не оракул «такой черновик есть»).
  if (!d || !d.clientSiteId || d.clientSiteId !== siteId)
    return { ok: false, reason: 'not_found' };
  if (d.status !== 'APPROVED') return { ok: false, reason: 'not_approved' };
  if (d.siteMode !== 'A') return { ok: false, reason: 'mode_b' };
  let origin: string;
  let host: string;
  try {
    const u = new URL(d.baseUrl);
    origin = u.origin;
    host = u.hostname.toLowerCase();
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  const all = (Array.isArray(d.steps) ? d.steps : []).filter(
    (s): s is Raw => !!s && typeof s === 'object' && !Array.isArray(s),
  );
  const rounds = roundsOf(all, d.stepsPerRound);
  let lastLogin = -1;
  rounds.forEach((r, i) => {
    if (isLoginRound(r)) lastLogin = i;
  });
  const dropped = { login: 0, foreign: 0, other: 0 };
  const steps: MemoExportStep[] = [];
  let startPath: string | null = null;
  rounds.forEach((round, i) => {
    if (i <= lastLogin) {
      dropped.login += round.length;
      return;
    }
    for (const s of round) {
      if (steps.length >= MEMO_EXPORT_MAX_STEPS) {
        dropped.other++;
        continue;
      }
      if (s.kind === 'goto') {
        const p = pathOf(s.route, origin);
        if (p === 'foreign') dropped.foreign++;
        else if (!p) dropped.other++;
        else {
          if (!steps.length && startPath === null) startPath = p;
          steps.push({ kind: 'navigate', path: p });
        }
      } else if (
        s.kind === 'click' &&
        typeof s.selector === 'string' &&
        s.selector.length > 0 &&
        s.selector.length <= SELECTOR_MAX
      ) {
        steps.push({ kind: 'click', selector: s.selector });
      } else if (
        s.kind === 'fill' &&
        typeof s.selector === 'string' &&
        s.selector.length > 0 &&
        s.selector.length <= SELECTOR_MAX &&
        !isSensitiveSelector(s.selector)
      ) {
        // Значение — НЕ читается и не уходит: только вид поля.
        steps.push({
          kind: 'fill',
          selector: s.selector,
          field: fieldKindOf(s.selector),
        });
      } else dropped.other++;
    }
  });
  if (!steps.some((s) => s.kind !== 'navigate'))
    return { ok: false, reason: 'no_steps' };
  const end = pathOf(d.lastUrl, origin);
  const title =
    typeof d.title === 'string' && d.title.trim()
      ? d.title.replace(/\s+/g, ' ').trim().slice(0, 120)
      : null;
  return {
    ok: true,
    value: {
      draftId: d.id,
      siteId,
      title,
      host,
      startPath,
      endPath: end && end !== 'foreign' ? end : null,
      view: CAPTURE_VIEWPORT.width <= MOBILE_MAX_WIDTH ? 'mobile' : 'desktop',
      requiresLogin: lastLogin >= 0 || draftRequiresLogin(d),
      steps,
      dropped,
    },
  };
}
