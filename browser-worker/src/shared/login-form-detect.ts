// СГЕНЕРИРОВАНО scripts/sync-worker-shared.mjs — не править.
// Источник: backend/src/modules/client-site-tutorial/login-form-detect.ts. Правка — в источнике, затем
// `node scripts/sync-worker-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Поля формы входа для учётки из реестра сайта (Э-С Ш2-хвост (3)).
 *
 * Учётку, заведённую руками в кабинете, обучалка знает как «логин +
 * пароль» без селекторов: где на странице поле логина, где пароля и какая
 * кнопка отправляет форму, генератор находит сам — по разведке страницы
 * (`collectPageExploration`: тип поля, `autocomplete`, подпись, имя,
 * порядок в документе). Чистая функция: зовётся внутри раунда браузера
 * (`chromium-page-explorer.ts`) на элементах ТОЙ страницы, где будет ввод,
 * и в тестах — без браузера.
 *
 * Правила — консервативные: сомнение даёт «не нашли» (человек укажет поля
 * сам, `pick`), а не угаданный ввод в чужое поле. Пароль — ТОЛЬКО в
 * `input[type=password]` (повторно это проверяет браузер перед вводом:
 * пароль в видимом текстовом поле попал бы в кадр ролика).
 */
import type { PageElement } from './page-exploration.types';

/** Поля, указанные человеком вручную (запасной путь, «укажите поля»). */
export interface LoginFieldPick {
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

export interface LoginFieldsFound {
  /** `null` — у учётки нет логина или форма из одного пароля. */
  usernameSelector: string | null;
  passwordSelector: string;
  submitSelector: string;
}

export type LoginFieldKind = 'username' | 'password' | 'submit';

/** Отдельным именем: копия у воркера (sync-worker-shared) форматируется
 *  другой версией prettier, а пересечение внутри объединения они пишут
 *  по-разному. */
type LoginFieldsOk = { ok: true } & LoginFieldsFound;
type LoginFieldsMissing = { ok: false; missing: LoginFieldKind[] };

export type LoginFieldsResult = LoginFieldsOk | LoginFieldsMissing;

const USER_WORDS =
  /(user|login|e-?mail|mail|phone|account|логин|почт|пошт|телефон|аккаунт|акаунт|користувач|пользовател|benutzer|usuario|correo)/i;
const CONFIRM_WORDS =
  /(confirm|repeat|again|retype|повтор|ещё раз|еще раз|ще раз|wiederhol|confirmar|repetir)/i;
const NEW_WORDS = /(new|нов|neues|nueva)/i;
const NOT_USER_WORDS =
  /(search|поиск|пошук|suche|buscar|promo|coupon|купон|промокод|captcha|капч)/i;
const SUBMIT_WORDS =
  /(log ?in|sign ?in|войти|вход|увійти|вхід|anmelden|einloggen|iniciar|entrar|continue|продолжить|продовжити|далее|далі|weiter|siguiente|submit|отправить|надіслати)/i;
const NOT_SUBMIT_WORDS =
  /(sign ?up|register|регистр|реєстр|forgot|забыл|забули|reset|сброс|скинути|google|facebook|apple|github|microsoft|telegram|linkedin|twitter|vk\b|show|hide|показать|показати|скрыть|сховати|cancel|отмена|скасувати|back|назад|zurück|olvid|regist)/i;
const TEXT_TYPES = new Set(['', 'text', 'email', 'tel']);

function textOf(el: PageElement): string {
  return [el.label, el.name, el.visibleText, el.selector]
    .filter(Boolean)
    .join(' ');
}

function isPassword(el: PageElement): boolean {
  return el.tag === 'input' && el.type === 'password';
}

function isTextInput(el: PageElement): boolean {
  return el.tag === 'input' && TEXT_TYPES.has(el.type ?? '');
}

function isSubmitLike(el: PageElement): boolean {
  if (el.tag === 'button') return true;
  return (
    el.tag === 'input' &&
    (el.type === 'submit' || el.type === 'image' || el.type === 'button')
  );
}

function pickPassword(
  elements: PageElement[],
  pick: LoginFieldPick,
): number | null {
  if (pick.passwordSelector !== undefined) {
    const i = elements.findIndex((e) => e.selector === pick.passwordSelector);
    return i >= 0 && isPassword(elements[i]) ? i : null;
  }
  const all = elements
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => isPassword(e));
  const current = all.filter(({ e }) => e.autocomplete === 'current-password');
  if (current.length === 1) return current[0].i;
  if (current.length > 1) return null;
  // Форма регистрации или смены пароля (новый + повтор) — не вход.
  const plain = all.filter(
    ({ e }) =>
      e.autocomplete !== 'new-password' &&
      !CONFIRM_WORDS.test(textOf(e)) &&
      !NEW_WORDS.test(`${e.label ?? ''} ${e.name ?? ''}`),
  );
  return plain.length === 1 ? plain[0].i : null;
}

function pickUsername(
  elements: PageElement[],
  pw: number,
  pick: LoginFieldPick,
): number | null {
  if (pick.usernameSelector !== undefined) {
    const i = elements.findIndex((e) => e.selector === pick.usernameSelector);
    return i >= 0 && i !== pw && isTextInput(elements[i]) ? i : null;
  }
  let best: { i: number; score: number } | null = null;
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (!isTextInput(e) || NOT_USER_WORDS.test(textOf(e))) continue;
    let score = 0;
    if (e.autocomplete === 'username' || e.autocomplete === 'email') {
      score += 10;
    }
    if (e.type === 'email') score += 4;
    if (USER_WORDS.test(textOf(e))) score += 3;
    if (e.type === 'tel') score += 1;
    // Поле логина почти всегда СТОИТ ПЕРЕД паролем той же формы.
    if (i < pw) score += 2;
    else score -= 2;
    if (score <= 0) continue;
    // Ничья — ближайшее к паролю.
    if (
      !best ||
      score > best.score ||
      (score === best.score && Math.abs(pw - i) < Math.abs(pw - best.i))
    ) {
      best = { i, score };
    }
  }
  return best?.i ?? null;
}

function pickSubmit(
  elements: PageElement[],
  pw: number,
  pick: LoginFieldPick,
): number | null {
  if (pick.submitSelector !== undefined) {
    const i = elements.findIndex((e) => e.selector === pick.submitSelector);
    return i >= 0 && (isSubmitLike(elements[i]) || elements[i].tag === 'a')
      ? i
      : null;
  }
  let best: { i: number; score: number } | null = null;
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (!isSubmitLike(e) || e.danger) continue;
    const text = `${e.visibleText ?? ''} ${e.label ?? ''} ${e.name ?? ''}`;
    if (NOT_SUBMIT_WORDS.test(text)) continue;
    let score = 0;
    if (e.type === 'submit') score += 3;
    else if (e.tag === 'button' && !e.type) score += 2;
    if (SUBMIT_WORDS.test(text) || SUBMIT_WORDS.test(e.selector)) score += 4;
    // Кнопка формы — после пароля; кнопки шапки — до.
    if (i > pw) score += 2;
    else score -= 3;
    if (score <= 0) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && Math.abs(i - pw) < Math.abs(best.i - pw))
    ) {
      best = { i, score };
    }
  }
  return best?.i ?? null;
}

/**
 * Найти поля входа на странице. `needUsername` — у учётки есть логин (без
 * него ищется только пароль и кнопка). `pick` — что человек указал сам;
 * указанное проверяется (пароль — только поле пароля), не угадывается.
 */
export function findLoginFields(
  elements: PageElement[],
  opts: { needUsername: boolean; pick?: LoginFieldPick },
): LoginFieldsResult {
  const pick = opts.pick ?? {};
  const pw = pickPassword(elements, pick);
  if (pw === null) {
    return { ok: false, missing: ['password'] };
  }
  const missing: LoginFieldKind[] = [];
  const user = opts.needUsername ? pickUsername(elements, pw, pick) : null;
  if (opts.needUsername && user === null) missing.push('username');
  const submit = pickSubmit(elements, pw, pick);
  if (submit === null) missing.push('submit');
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    usernameSelector: user === null ? null : elements[user].selector,
    passwordSelector: elements[pw].selector,
    submitSelector: elements[submit as number].selector,
  };
}

/**
 * Источник для `page.evaluate`: поле по селектору — НАСТОЯЩЕЕ поле пароля
 * (`input`, тип `password` и по атрибуту, и по свойству)? Строкой (как
 * `page-exploration.ts`), селектор — JSON-литералом. Именно этот признак
 * разрешает ввод пароля из реестра: в любом другом поле он был бы виден на
 * кадре ролика.
 */
export function passwordFieldSource(selector: string): string {
  return `(() => {
  try {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.tagName.toLowerCase() !== 'input') return false;
    const attr = (el.getAttribute('type') || '').toLowerCase();
    const prop = String(el.type || '').toLowerCase();
    return attr === 'password' && prop === 'password';
  } catch (e) {
    return false;
  }
})()`;
}

/** Отказ «не нашли поля входа» — 422 с кодом и тем, чего не хватило. */
export const LOGIN_FIELDS_NOT_FOUND = 'LOGIN_FIELDS_NOT_FOUND';
