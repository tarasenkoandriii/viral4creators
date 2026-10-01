/**
 * Роли кабинета и права по продукту (ТЗ помощника §3.2, QA-ТЗ §1.5).
 *
 *  - роль кабинета: `owner | manager | operator`;
 *  - `productRoles`: `qa: admin|viewer|none`, `assist: manager|operator|none`,
 *    `assistAdmin: owner|employee|none` — ОТДЕЛЬНОЕ право на «Админку»
 *    (К-9): `assist` к данным «Админки» не даёт ничего.
 *
 * Умолчание для всех, кроме владельца кабинета, — `none`. Разбор строгий:
 * неизвестное значение в JSON базы — `none`, а не «что-то похожее».
 */

export const ACCOUNT_ROLES = ['owner', 'manager', 'operator'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const PRODUCT_ROLE_VALUES = {
  qa: ['admin', 'viewer', 'none'],
  assist: ['manager', 'operator', 'none'],
  assistAdmin: ['owner', 'employee', 'none'],
} as const;

export type ProductKey = keyof typeof PRODUCT_ROLE_VALUES;
export type ProductRoles = {
  [K in ProductKey]: (typeof PRODUCT_ROLE_VALUES)[K][number];
};

export const NO_PRODUCT_ROLES: ProductRoles = {
  qa: 'none',
  assist: 'none',
  assistAdmin: 'none',
};

/** Владелец кабинета — всё во всех продуктах (§3.2: «Всё»). */
export const OWNER_PRODUCT_ROLES: ProductRoles = {
  qa: 'admin',
  assist: 'manager',
  assistAdmin: 'owner',
};

export function parseAccountRole(v: unknown): AccountRole | null {
  return typeof v === 'string' &&
    (ACCOUNT_ROLES as readonly string[]).includes(v)
    ? (v as AccountRole)
    : null;
}

export function parseProductRoles(v: unknown): ProductRoles {
  const o =
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const out = { ...NO_PRODUCT_ROLES } as Record<ProductKey, string>;
  for (const key of Object.keys(PRODUCT_ROLE_VALUES) as ProductKey[]) {
    const allowed = PRODUCT_ROLE_VALUES[key] as readonly string[];
    if (typeof o[key] === 'string' && allowed.includes(o[key] as string)) {
      out[key] = o[key] as string;
    }
  }
  return out as ProductRoles;
}

/**
 * Права по продукту на вход: строгая проверка (400 вместо «тихо `none`»):
 * опечатка владельца в приглашении не должна молча лишить человека прав.
 * `null` — значение недопустимо.
 */
export function validateProductRolesInput(v: unknown): ProductRoles | null {
  if (v === undefined) return { ...NO_PRODUCT_ROLES };
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(key in PRODUCT_ROLE_VALUES)) return null;
    const allowed = PRODUCT_ROLE_VALUES[key as ProductKey] as readonly string[];
    if (typeof o[key] !== 'string' || !allowed.includes(o[key] as string)) {
      return null;
    }
  }
  return parseProductRoles(o);
}

/** Участник, как его видят гварды и сервисы. */
export interface AccountMembership {
  accountId: string;
  memberId: string;
  telegramId: bigint;
  role: AccountRole;
  productRoles: ProductRoles;
}

/** Требование маршрута к правам по продукту: `{ assistAdmin: ['owner'] }`. */
export type ProductRoleRequirement = {
  [K in ProductKey]?: ReadonlyArray<ProductRoles[K]>;
};

/**
 * Пропускает ли участник требование. Владелец кабинета — всегда (его права
 * «Всё» не зависят от того, что лежит в JSON). Несколько ключей — ВСЕ
 * должны выполниться.
 */
export function satisfiesProductRoles(
  m: Pick<AccountMembership, 'role' | 'productRoles'>,
  req: ProductRoleRequirement,
): boolean {
  if (m.role === 'owner') return true;
  return (Object.keys(req) as ProductKey[]).every((key) => {
    const allowed = req[key] as readonly string[] | undefined;
    return !!allowed && allowed.includes(m.productRoles[key]);
  });
}

/**
 * Готовые требования — чтобы модули помощника (Э1+) не писали списки
 * руками в каждом контроллере.
 *
 * `…/knowledge/admin/*`, `admin-mode*`, `connectors*`, `action-log*`,
 * `?mode=admin` — только `assistAdmin` (§3.2, К-9). Оператор и менеджер
 * «Сайта» получают 403.
 */
export const REQUIRE_ASSIST_ADMIN_OWNER: ProductRoleRequirement = {
  assistAdmin: ['owner'],
};
export const REQUIRE_ASSIST_ADMIN_ANY: ProductRoleRequirement = {
  assistAdmin: ['owner', 'employee'],
};
export const REQUIRE_ASSIST_MANAGER: ProductRoleRequirement = {
  assist: ['manager'],
};
export const REQUIRE_ASSIST_ANY: ProductRoleRequirement = {
  assist: ['manager', 'operator'],
};
