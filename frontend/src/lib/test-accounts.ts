/**
 * Экран «Тестовые учётные записи» мастера обучалки (Э-С Ш2) — правила
 * формы без React (проверяются скриптом `scripts/test-accounts.test.ts`).
 *
 * Пароль — только на запись: форма правки всегда начинается с пустого
 * поля, пустое значение означает «не менять» и в запрос не уходит.
 */
import type {
  SiteTestAccount,
  TestAccountPayload,
  TestAccountProduct,
} from '../types/test-accounts';

export const ROLE_HINTS = ['guest', 'customer', 'manager', 'admin'] as const;
export const LIFETIME_DAYS = [7, 30, 90] as const;

export interface TestAccountForm {
  label: string;
  role: string;
  plan: string;
  username: string;
  password: string;
  hostIds: string[];
  products: TestAccountProduct[];
  /**
   * Продукты учётки, которыми этот экран не управляет (`assist-admin` —
   * разрешается в реестре TMA «Сайта»). В запрос не уходят — сервер их
   * сохраняет сам, — но считаются в «хотя бы один продукт» (аудит захода
   * 10, P3-3: учётку только с `assist-admin` иначе не сохранить).
   */
  otherProducts: string[];
  lifetimeDays: number | null;
  confirmedTestAccount: boolean;
}

export type TestAccountFormError =
  | 'labelRequired'
  | 'hostRequired'
  | 'productRequired'
  | 'confirmRequired';

export function emptyTestAccountForm(
  defaultHostId: string | null
): TestAccountForm {
  return {
    label: '',
    role: '',
    plan: '',
    username: '',
    password: '',
    hostIds: defaultHostId ? [defaultHostId] : [],
    products: ['tutorial'],
    otherProducts: [],
    lifetimeDays: 90,
    confirmedTestAccount: false,
  };
}

/** Форма правки: пароль ПУСТОЙ (старый не знаем и не показываем), срок — не менять. */
export function formFromAccount(a: SiteTestAccount): TestAccountForm {
  return {
    label: a.label,
    role: a.role ?? '',
    plan: a.plan ?? '',
    username: a.username ?? '',
    password: '',
    hostIds: [...a.hostIds],
    products: a.products.filter(
      (p): p is TestAccountProduct => p === 'tutorial' || p === 'qa'
    ),
    otherProducts: a.products.filter((p) => p !== 'tutorial' && p !== 'qa'),
    lifetimeDays: null,
    confirmedTestAccount: a.confirmedTestAccount,
  };
}

const orNull = (v: string) => (v.trim() ? v.trim() : null);

/**
 * Тело запроса или ошибка формы. Новая учётка требует галочку «это
 * тестовый аккаунт»; пустой пароль не уходит никогда.
 */
export function testAccountPayload(
  form: TestAccountForm,
  opts: { isNew: boolean }
): { payload: TestAccountPayload } | { error: TestAccountFormError } {
  if (!form.label.trim()) return { error: 'labelRequired' };
  if (form.hostIds.length === 0) return { error: 'hostRequired' };
  if (form.products.length === 0 && form.otherProducts.length === 0) {
    return { error: 'productRequired' };
  }
  if (opts.isNew && !form.confirmedTestAccount) {
    return { error: 'confirmRequired' };
  }
  const payload: TestAccountPayload = {
    label: form.label.trim(),
    role: orNull(form.role),
    plan: orNull(form.plan),
    username: orNull(form.username),
    hostIds: [...new Set(form.hostIds)],
    products: [...new Set(form.products)],
    confirmedTestAccount: form.confirmedTestAccount,
  };
  if (form.password) payload.password = form.password;
  if (form.lifetimeDays !== null) payload.lifetimeDays = form.lifetimeDays;
  return { payload };
}

/** Подписи продуктов учётки (словарь `clientSiteTestAccounts`). */
export interface ProductLabels {
  productTutorial: string;
  productQa: string;
  productAssistAdmin: string;
}

/**
 * Подпись продукта в карточке учётки. Ш3 (12): `assist-admin` (обход
 * «Админки» браузерным воркером — разрешается в реестре TMA «Сайта», не
 * здесь) раньше показывался сырым кодом. Неизвестный будущий продукт —
 * как есть: лучше код, чем пропавшая строка.
 */
export function productLabel(product: string, t: ProductLabels): string {
  switch (product) {
    case 'tutorial':
      return t.productTutorial;
    case 'qa':
      return t.productQa;
    case 'assist-admin':
      return t.productAssistAdmin;
    default:
      return product;
  }
}

export function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export function statusTone(status: string): 'success' | 'warning' | 'danger' {
  return status === 'active'
    ? 'success'
    : status === 'frozen'
      ? 'warning'
      : 'danger';
}

/** Ключ подсказки роли или `null` — свободный текст показывается как есть. */
export function roleHintKey(
  role: string | null
): (typeof ROLE_HINTS)[number] | null {
  return role && (ROLE_HINTS as readonly string[]).includes(role)
    ? (role as (typeof ROLE_HINTS)[number])
    : null;
}
